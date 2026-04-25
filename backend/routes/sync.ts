/**
 * 同步与统计路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { syncAllFiles } from '../file-storage.js';

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

  // 全量同步：将数据库所有文章导出为本地文件
  // 修复：使用分页查询函数替代原始 SQL 字符串
  router.post('/files', async (c) => {
    const startMs = Date.now();
    try {
      const result = await syncAllFiles(
        async (offset: number, limit: number) => {
          return sql`
            SELECT a.id, a.title, a.content, a.url, a.published_at, a.category, a.tags, a.author, a.is_read, a.is_starred,
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
      return c.json({ ok: true, ...result, duration_ms: durationMs });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 统计信息
  router.get('/stats', async (c) => {
    const [totalResult] = await sql`SELECT COUNT(*)::int AS total FROM articles`;
    const [todayResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE published_at >= CURRENT_DATE`;
    const [unreadResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_read = FALSE`;
    const [starredResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_starred = TRUE`;

    const sourceStats = await sql`
      SELECT s.id, s.name, s.icon, s.type, s.enabled, s.last_fetch, s.parent_id,
             COUNT(a.id)::int AS article_count,
             COUNT(CASE WHEN a.published_at >= CURRENT_DATE THEN 1 END)::int AS today_count,
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

  // 采集日志（参数化查询，无 SQL 注入）
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
