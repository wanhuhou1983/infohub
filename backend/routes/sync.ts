/**
 * 同步与统计路由
 * 
 * v2: 新增双向同步端点
 * - POST /reconcile  — PG→OB 全量校准
 * - POST /push       — OB→PG 全量推送
 * - GET  /diff       — 双向差异报告
 * - POST /push-file  — 单文件推送
 * - POST /files      — 全量同步（legacy，同 reconcile）
 */

import { Hono } from 'hono';
import { resolve } from 'node:path';
import type { Sql } from 'postgres';
import { syncAllFiles, getObDir } from '../file-storage.js';
import {
  scanObFiles,
  pushToPg,
  diffReport,
} from '../services/ob-scanner.js';

export function createSyncRoutes(sql: Sql): Hono {
  const router = new Hono();

  // WeFlow 健康检查
  router.get('/weflow-status', async (c) => {
    try {
      const [wechatSource] = await sql`SELECT config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ online: false, error: '公众号信息源未配置' });

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ online: false, error: 'WeFlow Token 未配置' });

      const resp = await fetch(`${weflowUrl}/api/v1/sessions?limit=1`, {
        headers: { 'Authorization': `Bearer ${weflowToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return c.json({ online: false, error: `API 返回 ${resp.status}` });
      return c.json({ online: true, url: weflowUrl });
    } catch (e: any) {
      if (e.name === 'AbortError' || e.code === 'ECONNREFUSED') {
        return c.json({ online: false, error: 'WeFlow 服务未启动或端口未监听' });
      }
      return c.json({ online: false, error: e.message });
    }
  });

  // ============ PG → OB 校准 ============

  /**
   * POST /api/sync/files (legacy)
   * 全量同步：将数据库所有文章导出为 OB Markdown 文件
   * 已自动包含合并逻辑（saveArticleFile 的读前合并）
   */
  router.post('/files', async (c) => {
    const startMs = Date.now();
    try {
      const result = await syncAllFiles(
        async (offset: number, limit: number) => {
          return sql`
            SELECT a.id, a.title, a.content, a.url, a.published_at, a.category, a.tags, a.author, a.is_read, a.is_starred, a.content_hash,
                   s.name AS source_name, s.type AS source_type
            FROM articles a
            LEFT JOIN sources s ON a.source_id = s.id
            ORDER BY a.id
            LIMIT ${limit} OFFSET ${offset}
          `;
        },
        async (id: number, content: string) => {
          await sql`UPDATE articles SET content = ${content} WHERE id = ${id}`;
        }
      );
      const durationMs = Date.now() - startMs;
      return c.json({ ok: true, ...result, duration_ms: durationMs, direction: 'pg→ob' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  /**
   * POST /api/sync/reconcile
   * PG→OB 全量校准（同 /files，更语义化的名称）
   * 支持 ?dry_run=true 只报告不写入
   * 支持 ?source_id=N 只校准特定来源
   */
  router.post('/reconcile', async (c) => {
    const { dry_run, source_id } = c.req.query();
    const startMs = Date.now();

    if (dry_run === 'true') {
      // 干跑：只统计差异，不写入
      let totalPG = 0;
      if (source_id) {
        const [count] = await sql`SELECT COUNT(*)::int AS c FROM articles WHERE source_id = ${Number(source_id)}`;
        totalPG = count?.c ?? 0;
      } else {
        const [count] = await sql`SELECT COUNT(*)::int AS c FROM articles`;
        totalPG = count?.c ?? 0;
      }
      return c.json({
        ok: true,
        direction: 'pg→ob',
        mode: 'dry_run',
        estimated: totalPG,
        message: `将检查 ${totalPG} 篇 PG 文章并写入 OB，saveArticleFile 会自动合并 OB 端修改`,
      });
    }

    try {
      const result = await syncAllFiles(
        async (offset: number, limit: number) => {
          if (source_id) {
            return sql`
              SELECT a.id, a.title, a.content, a.url, a.published_at, a.category, a.tags, a.author, a.is_read, a.is_starred, a.content_hash,
                     s.name AS source_name, s.type AS source_type
              FROM articles a
              LEFT JOIN sources s ON a.source_id = s.id
              WHERE a.source_id = ${Number(source_id)}
              ORDER BY a.id
              LIMIT ${limit} OFFSET ${offset}
            `;
          }
          return sql`
            SELECT a.id, a.title, a.content, a.url, a.published_at, a.category, a.tags, a.author, a.is_read, a.is_starred, a.content_hash,
                   s.name AS source_name, s.type AS source_type
            FROM articles a
            LEFT JOIN sources s ON a.source_id = s.id
            ORDER BY a.id
            LIMIT ${limit} OFFSET ${offset}
          `;
        },
        async (id: number, content: string) => {
          await sql`UPDATE articles SET content = ${content} WHERE id = ${id}`;
        }
      );
      const durationMs = Date.now() - startMs;
      return c.json({ ok: true, ...result, duration_ms: durationMs, direction: 'pg→ob' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ OB → PG 推送 ============

  /**
   * GET /api/sync/diff
   * 扫描 OB 目录并与 PG 对比，返回差异报告
   * 支持 ?compact=true 只返回摘要不返回全部 diff 项
   */
  router.get('/diff', async (c) => {
    const { compact } = c.req.query();
    const startMs = Date.now();

    try {
      const report = await diffReport(sql);
      const durationMs = Date.now() - startMs;

      if (compact === 'true') {
        return c.json({
          ok: true,
          duration_ms: durationMs,
          totalObFiles: report.totalObFiles,
          matched: report.matched,
          noMatch: report.noMatch,
          summary: report.summary,
          diffItems: report.diffItems.slice(0, 20), // 只返回前 20 条
        });
      }

      return c.json({
        ok: true,
        duration_ms: durationMs,
        ...report,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  /**
   * POST /api/sync/push
   * 扫描 OB 目录，将 OB 端修改（tags/is_read/is_starred）推送到 PG
   * 支持 ?dry_run=true 只报告不写入
   */
  router.post('/push', async (c) => {
    const { dry_run } = c.req.query();
    const startMs = Date.now();

    if (dry_run === 'true') {
      const report = await diffReport(sql);
      return c.json({ ok: true, direction: 'ob→pg', mode: 'dry_run',
        totalObFiles: report.totalObFiles, matched: report.matched,
        noMatch: report.noMatch, summary: report.summary,
        duration_ms: Date.now() - startMs });
    }

    try {
      // 1. 扫描 OB 文件
      const obFiles = scanObFiles();

      // 2. 逐一匹配并推送到 PG
      let matched = 0;
      let updated = 0;
      let skipped = 0;
      let noMatch = 0;
      let errors = 0;
      const details: any[] = [];

      for (const obFile of obFiles) {

        const result = await pushToPg(obFile, sql);
        switch (result.status) {
          case 'updated':
            updated++;
            matched++;
            details.push({
              file: obFile.filePath,
              changes: result.changes,
              matchLevel: result.matchLevel,
            });
            break;
          case 'skipped':
            skipped++;
            matched++;
            break;
          case 'no_match':
            noMatch++;
            break;
          case 'error':
            errors++;
            details.push({
              file: obFile.filePath,
              error: result.error,
            });
            break;
        }
      }

      const durationMs = Date.now() - startMs;

      return c.json({
        ok: true,
        direction: 'ob→pg',
        totalObFiles: obFiles.length,
        matched,
        updated,
        skipped,
        noMatch,
        errors,
        details: details.slice(0, 100), // 限制返回条数
        duration_ms: durationMs,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  /**
   * POST /api/sync/push-file
   * 推送单个 OB 文件到 PG
   * 参数：{ path: "..." }
   */
  router.post('/push-file', async (c) => {
    try {
      const body = await c.req.json();
      if (!body || !body.path) {
        return c.json({ error: '请提供 path 参数' }, 400);
      }

      // 路径遍历防护：校验 path 须在 OB_DIR 内
      const obDirReal = resolve(getObDir());
      const requestedReal = resolve(body.path);
      if (!requestedReal.startsWith(obDirReal + '/')) {
        return c.json({ error: '路径越界' }, 400);
      }

      // 解析单个文件
      const { parseFile } = await import('../services/ob-scanner.js');
      const obMeta = parseFile(body.path);
      if (!obMeta) {
        return c.json({ error: '无法解析文件 frontmatter 或缺少匹配字段' }, 400);
      }

      const result = await pushToPg(obMeta, sql);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 统计信息 ============

  router.get('/stats', async (c) => {
    const [totalResult] = await sql`SELECT COUNT(*)::int AS total FROM articles`;
    const [todayResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE fetched_at >= CURRENT_DATE`;
    const [unreadResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_read = FALSE`;
    const [starredResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_starred = TRUE`;

    const sourceStats = await sql`
      SELECT s.id, s.name, s.icon, s.type, s.enabled, s.last_fetch, s.parent_id,
             COUNT(a.id)::int AS article_count,
             COUNT(CASE WHEN a.fetched_at >= CURRENT_DATE THEN 1 END)::int AS today_count,
             COUNT(CASE WHEN a.is_read = FALSE THEN 1 END)::int AS unread_count
      FROM sources s
      LEFT JOIN articles a ON a.source_id = s.id
      GROUP BY s.id, s.name, s.icon, s.type, s.enabled, s.last_fetch, s.parent_id
      ORDER BY s.id
    `;

    return c.json({
      totalArticles: totalResult?.total ?? 0,
      todayArticles: todayResult?.total ?? 0,
      unreadArticles: unreadResult?.total ?? 0,
      starredArticles: starredResult?.total ?? 0,
      sources: sourceStats,
    });
  });

  // 每日采集汇总
  router.get('/logs/daily-summary', async (c) => {
    try {
      // 今日总览
      const [todayTotal] = await sql`
        SELECT 
          COUNT(*)::int AS total_runs,
          COALESCE(SUM(articles_count), 0)::int AS total_articles,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS success_runs,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int AS failed_runs
        FROM fetch_logs
        WHERE started_at >= CURRENT_DATE
      `;

      // 按来源分组
      const bySource = await sql`
        SELECT 
          fl.source_id,
          s.name AS source_name,
          s.icon AS source_icon,
          COUNT(*)::int AS total_runs,
          SUM(CASE WHEN fl.status = 'success' THEN 1 ELSE 0 END)::int AS success_count,
          SUM(CASE WHEN fl.status = 'error' THEN 1 ELSE 0 END)::int AS failed_count,
          COALESCE(SUM(fl.articles_count), 0)::int AS total_articles
        FROM fetch_logs fl
        LEFT JOIN sources s ON fl.source_id = s.id
        WHERE fl.started_at >= CURRENT_DATE
        GROUP BY fl.source_id, s.name, s.icon
        ORDER BY total_articles DESC
      `;

      return c.json({
        date: new Date().toISOString().slice(0, 10),
        total: todayTotal || { total_runs: 0, total_articles: 0, success_runs: 0, failed_runs: 0 },
        by_source: bySource,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 采集日志
  router.get('/logs', async (c) => {
    const { source_id, limit = '30' } = c.req.query();
    const numLimit = Math.min(Math.max(Number(limit) || 30, 1), 200);

    let logs: any[];
    if (source_id) {
      const sid = Number(source_id);
      if (isNaN(sid) || sid <= 0) return c.json({ error: 'Invalid source_id' }, 400);
      logs = await sql`
        SELECT fl.*, s.name AS source_name, s.icon AS source_icon
        FROM fetch_logs fl
        LEFT JOIN sources s ON fl.source_id = s.id
        WHERE fl.source_id = ${sid}
        ORDER BY fl.started_at DESC
        LIMIT ${numLimit}
      `;
    } else {
      logs = await sql`
        SELECT fl.*, s.name AS source_name, s.icon AS source_icon
        FROM fetch_logs fl
        LEFT JOIN sources s ON fl.source_id = s.id
        ORDER BY fl.started_at DESC
        LIMIT ${numLimit}
      `;
    }
    return c.json(logs);
  });

  return router;
}
