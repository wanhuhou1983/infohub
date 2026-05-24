// @ts-nocheck
/**
 * AI 资讯采集路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { hashString, processImages } from '../../file-storage.js';
import { classifyByFeed, extractTags } from '../../services/classifier.js';

export function createAiNewsRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ AI 资讯采集 ============
  router.post('/ai', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const sourceId = body?.sourceId || 0;
      const authToken = body?.authorization || body?.auth || '';
      if (!sourceId) return c.json({ ok: false, error: '缺少 sourceId' }, 400);

      const [source] = await sql`SELECT id, name, config FROM sources WHERE id = ${sourceId} AND LOWER(type) = 'ai'`;
      if (!source) return c.json({ ok: false, error: `未找到源: ${sourceId}` }, 404);

      const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : (source.config || {});
      const apiUrl = cfg.api_url || cfg.url || '';
      if (!apiUrl) return c.json({ ok: false, error: 'AI 源未配置 API URL' }, 400);

      const resp = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0', ...(cfg.api_key ? { 'Authorization': `Bearer ${cfg.api_key}` } : {}) }, signal: AbortSignal.timeout(60000) });
      const data: any[] = await resp.json();
      if (!Array.isArray(data)) return c.json({ ok: false, error: 'API 返回格式无效' }, 500);

      let inserted = 0;
      for (const item of (data || []).slice(0, cfg.max_items || 50)) {
        const title = item.title?.trim() || '(无标题)';
        const url = item.url || item.link || '';
        const publishedAt = item.published_at || item.pubDate || item.isoDate || new Date().toISOString();
        let content = item.content || item.description || item.summary || '';
        const contentHash = hashString(url || title + publishedAt);
        try { content = await processImages(content, 'ai'); } catch { /* ignore */ }

        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},${url},${publishedAt},${classifyByFeed(source.name)},${extractTags(title, source.name)},${contentHash},NOW(),'') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) { inserted++; }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched: data.length, inserted });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  return router;
}
