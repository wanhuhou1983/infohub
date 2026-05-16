/**
 * 云端数据同步接收端点
 * 
 * 仅在 CLOUD_MODE=true 时注册
 * 接收本地 Mac 推送的增量 articles + sources 数据
 * 使用 SYNC_TOKEN 认证（独立于 ADMIN_TOKEN）
 * 
 * 端点：
 * - POST /api/cloud-sync/push    — 接收增量数据推送
 * - POST /api/cloud-sync/cleanup — 清理 7 天前的数据
 * - GET  /api/cloud-sync/status  — 同步状态
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { timingSafeEqual } from 'node:crypto';

export function createCloudSyncRoutes(sql: Sql): Hono {
  const router = new Hono();

  // SYNC_TOKEN 认证中间件
  router.use('*', async (c, next) => {
    const syncToken = process.env.SYNC_TOKEN;
    if (!syncToken) {
      return c.json({ error: 'SYNC_TOKEN 未配置' }, 500);
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: '缺少 SYNC_TOKEN 认证' }, 401);
    }

    const token = authHeader.slice(7);
    const tokenBuf = Buffer.from(token);
    const syncBuf = Buffer.from(syncToken);
    if (tokenBuf.length !== syncBuf.length || !timingSafeEqual(tokenBuf, syncBuf)) {
      return c.json({ error: 'SYNC_TOKEN 无效' }, 401);
    }

    return next();
  });

  /**
   * POST /api/cloud-sync/push
   * 接收本地推送的增量数据
   * 
   * body: {
   *   sources: [{ id, name, type, icon, description, config, enabled, parent_id }],  // 可选
   *   articles: [{ source_id, title, content, summary, url, author, published_at, fetched_at, category, tags, extra, content_hash }],
   *   deletes?: string[]  // content_hash 列表，云端主动删除
   * }
   */
  router.post('/push', async (c) => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid body' }, 400);
    }

    const result = { sources_upserted: 0, articles_upserted: 0, articles_deleted: 0 };

    // 1. 同步 sources（增量 UPSERT）
    if (Array.isArray(body.sources) && body.sources.length > 0) {
      for (const src of body.sources) {
        if (!src.id) continue;
        await sql`
          INSERT INTO sources (id, name, type, icon, description, config, enabled, parent_id, last_fetch, created_at, updated_at)
          VALUES (${src.id}, ${src.name}, ${src.type}, ${src.icon || ''}, ${src.description || null}, ${sql.json(src.config || {})}, ${src.enabled !== false}, ${src.parent_id || null}, ${src.last_fetch || null}, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            icon = EXCLUDED.icon,
            description = EXCLUDED.description,
            config = EXCLUDED.config,
            enabled = EXCLUDED.enabled,
            parent_id = EXCLUDED.parent_id,
            last_fetch = EXCLUDED.last_fetch,
            updated_at = NOW()
        `;
        result.sources_upserted++;
      }
    }

    // 2. 同步 articles（增量 UPSERT by content_hash）
    if (Array.isArray(body.articles) && body.articles.length > 0) {
      for (const art of body.articles) {
        if (!art.content_hash) continue;
        await sql`
          INSERT INTO articles (source_id, title, content, summary, url, author, published_at, fetched_at, category, tags, extra, content_hash)
          VALUES (${art.source_id}, ${art.title}, ${art.content || null}, ${art.summary || null}, ${art.url || null}, ${art.author || null}, ${art.published_at || null}, ${art.fetched_at || null}, ${art.category || null}, ${art.tags || '{}'}, ${sql.json(art.extra || {})}, ${art.content_hash})
          ON CONFLICT (content_hash) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            url = EXCLUDED.url,
            author = EXCLUDED.author,
            published_at = EXCLUDED.published_at,
            category = EXCLUDED.category,
            tags = EXCLUDED.tags,
            extra = EXCLUDED.extra
        `;
        result.articles_upserted++;
      }
    }

    // 3. 处理删除请求
    if (Array.isArray(body.deletes) && body.deletes.length > 0) {
      const hashes = body.deletes;
      const delResult = await sql`DELETE FROM articles WHERE content_hash = ANY(${hashes})`;
      result.articles_deleted = delResult.count;
    }

    return c.json({ ok: true, ...result });
  });

  /**
   * POST /api/cloud-sync/cleanup
   * 清理 7 天前的 articles + fetch_logs
   */
  router.post('/cleanup', async (c) => {
    const rawDays = c.req.query('days') || '7';
    const parsed = Number(rawDays);
    const cutoffDays = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 365)) : 7;
    
    const artResult = await sql`
      DELETE FROM articles WHERE fetched_at < NOW() - (${cutoffDays} || ' days')::interval
    `;
    const logResult = await sql`
      DELETE FROM fetch_logs WHERE started_at < NOW() - (${cutoffDays} || ' days')::interval
    `;

    return c.json({
      ok: true,
      deleted_articles: artResult.count,
      deleted_logs: logResult.count,
      cutoff_days: cutoffDays,
    });
  });

  /**
   * GET /api/cloud-sync/status
   * 返回云端数据状态概览
   */
  router.get('/status', async (c) => {
    const [stats] = await sql`
      SELECT 
        (SELECT count(*) FROM articles) as total_articles,
        (SELECT count(*) FROM articles WHERE fetched_at > NOW() - interval '7 days') as recent_articles,
        (SELECT count(*) FROM sources) as total_sources,
        (SELECT max(fetched_at) FROM articles) as last_article_time
    `;

    if (!stats) return c.json({ cloud_mode: true, total_articles: 0, recent_7d_articles: 0, total_sources: 0, last_article_time: null });

    return c.json({
      cloud_mode: true,
      total_articles: Number(stats.total_articles),
      recent_7d_articles: Number(stats.recent_articles),
      total_sources: Number(stats.total_sources),
      last_article_time: stats.last_article_time,
    });
  });

  return router;
}
