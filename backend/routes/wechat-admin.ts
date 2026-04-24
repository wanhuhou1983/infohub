/**
 * 公众号管理路由（WeFlow 账号管理后台）
 * 
 * 功能：
 * - GET /api/wechat-admin/accounts  → 获取 WeFlow 公众号列表 + DB 启用状态
 * - POST /api/wechat-admin/refresh  → 同步公众号列表 + 采集已启用的文章
 * - PATCH /api/wechat-admin/accounts/:id/toggle → 切换单个公众号启用/禁用
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { crawlWechatArticle } from './fetch.js';
import { saveArticleFile, hashString, processImages } from '../file-storage.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

export function createWechatAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有公众号列表（WeFlow + DB 状态合并） ============

  /**
   * 从 WeFlow 获取所有会话列表，与数据库中的公众号子源合并，
   * 返回每个账号的 gh_id、displayName、当前启用状态。
   * 如果 WeFlow 有新账号但 DB 中没有，自动创建为禁用状态。
   */
  router.get('/accounts', async (c) => {
    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // 获取 WeFlow 会话列表
      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allSessions: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.username?.startsWith('gh_'));

      // 获取 DB 中已有的 WeFlow 路子源（只认 gh_id，不按名称匹配）
      const dbSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources
        WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const dbByGhId = new Map<string, any>();
      for (const s of dbSources) {
        if (s.gh_id) dbByGhId.set(s.gh_id, s);
      }

      // 合并：确保 WeFlow 每个账号都在 DB 中有记录，只按 gh_id 匹配
      let newlyCreated = 0;
      for (const session of allSessions) {
        const existing = dbByGhId.get(session.username);
        if (!existing) {
          await sql`
            INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
            VALUES (${session.displayName}, 'wechat', ${wechatSource.id}, ${sql.json({ gh_id: session.username })}, false, NOW())
          `;
          newlyCreated++;
        }
      }

      // 重新读取（包含新创建的）
      const updatedSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources
        WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const updatedByGhId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.gh_id) updatedByGhId.set(s.gh_id, s);
      }

      // 组装响应（只按 gh_id 匹配）
      const accounts = allSessions.map((s: any) => {
        const db = updatedByGhId.get(s.username);
        return {
          gh_id: s.username,
          displayName: s.displayName,
          enabled: !!db?.enabled,
          db_id: db?.id || null,
        };
      });

      return c.json({ accounts, total: accounts.length, newlyCreated });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 切换单个公众号启用 / 禁用 ============

  router.patch('/accounts/:id/toggle', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled === true;

    const [updated] = await sql`
      UPDATE sources SET enabled = ${enabled}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, enabled
    `;
    if (!updated) return c.json({ error: 'Source not found' }, 404);

    return c.json(updated);
  });

  // ============ 刷新公众号列表 + 采集已启用的文章 ============

  /**
   * 1. 从 WeFlow 同步最新公众号列表，新账号自动创建为禁用状态
   * 2. 对已启用的公众号采集最新文章
   */
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);
      const wechatLimit = Math.min(Math.max(Number(config.wechat_limit) || 5, 1), 50);
      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // Step 1: 获取 WeFlow 会话列表
      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allSessions: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.username?.startsWith('gh_'));

      // Step 2: 获取 DB 现有子源（只认 gh_id）
      const existingSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const existingByGhId = new Map<string, any>();
      for (const s of existingSources) {
        if (s.gh_id) existingByGhId.set(s.gh_id, s);
      }

      // Step 3: 新增不存在的公众号（默认禁用），只按 gh_id 匹配
      let newlyAdded = 0;
      for (const session of allSessions) {
        const existing = existingByGhId.get(session.username);
        if (!existing) {
          await sql`
            INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
            VALUES (${session.displayName}, 'wechat', ${wechatSource.id}, ${sql.json({ gh_id: session.username })}, false, NOW())
          `;
          newlyAdded++;
        }
      }

      // Step 4: 重新读取（获取完整状态）
      const updatedSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const sourceByGhId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.gh_id) sourceByGhId.set(s.gh_id, s);
      }

      // Step 5: 筛选已启用的公众号
      const enabledAccounts = allSessions.filter((s: any) => {
        const db = sourceByGhId.get(s.username);
        return !!db?.enabled;
      });

      // Step 6: 逐个已启用的公众号采集文章
      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const session of enabledAccounts) {
        const ghId = session.username;
        const displayName = session.displayName;
        const dbSource = sourceByGhId.get(session.username) || sourceByName.get(session.displayName);

        try {
          const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${ghId}&limit=${wechatLimit}`, { headers });
          if (!msgsResp.ok) {
            errors.push(`${displayName}: messages API ${msgsResp.status}`);
            continue;
          }
          const msgsData = await msgsResp.json() as any;
          const messages = msgsData.messages || [];

          for (const msg of messages) {
            try {
              const rawContent = msg.rawContent || '';
              const urlMatches = [...rawContent.matchAll(/<url><!\[CDATA\[(.*?)\]\]><\/url>/g)];
              const articleUrl = urlMatches.map(m => m[1]).find((u: string) => u && u.includes('mp.weixin.qq.com'));
              if (!articleUrl) continue;

              const titleMatch = rawContent.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
              const rawTitle = titleMatch?.[1] || '';

              const contentHash = hashString(articleUrl);

              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              console.log(`🕷️ 抓取: [${displayName}] ${rawTitle || articleUrl}`);
              const article = await crawlWechatArticle(articleUrl);

              const title = rawTitle || (article?.title && article.title !== '无标题' ? article.title : '') || displayName;
              const publishedAt = msg.createTime ? new Date(msg.createTime * 1000).toISOString() : new Date().toISOString();
              const author = displayName;

              let content = article?.content || `${title}\n\n来源：${displayName}\n链接：${articleUrl}`;
              try { content = await processImages(content); } catch (e: any) { /* ignore */ }

              const category = classifyByFeed(displayName);
              const tags = extractTags(title + ' ' + content.slice(0, 200), displayName);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${dbSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${articleUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, content, {
                  id: newId, title, source_type: 'wechat',
                  source_name: displayName, url: articleUrl, published_at: publishedAt,
                  category, tags, author, is_read: false, is_starred: false,
                });
              }
              totalFetched++;
            } catch (e: any) {
              if (e.code !== '23505') {
                errors.push(`${displayName}: ${e.message}`);
              }
            }
          }
        } catch (e: any) {
          errors.push(`${displayName}: ${e.message}`);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${wechatSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${wechatSource.id}, '公众号管理刷新', 'success', ${inserted},
          ${`同步 ${allSessions.length} 个公众号（新增 ${newlyAdded} 个），已启用 ${enabledAccounts.length} 个，获取 ${totalFetched} 条，入库 ${inserted} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        newlyAdded,
        enabledCount: enabledAccounts.length,
        totalAccounts: allSessions.length,
        fetched: totalFetched,
        inserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [wechatSource] = await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (wechatSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${wechatSource.id}, '公众号管理刷新', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
