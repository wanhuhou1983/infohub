/**
 * 播客频道管理路由（RSS 模式）
 *
 * 所有播客统一使用付费 RSS feed，不再走平台 API（喜马拉雅/蜻蜓/小宇宙）。
 * 采集由调度器统一通过 /fetch/rss 处理（scheduler.ts line 190）。
 *
 * - GET  /api/podcast-admin/channels       获取已添加的播客列表
 * - POST /api/podcast-admin/channels       添加播客（name + feed_url）
 * - DELETE /api/podcast-admin/channels/:id  删除
 * - PATCH /api/podcast-admin/channels/:id/toggle  启用/禁用
 * - POST /api/podcast-admin/sync           手动触发 RSS 采集
 * - POST /api/podcast-admin/audio-info     获取剧集音频 URL
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function createPodcastAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的播客列表 ============
  router.get('/channels', async (c) => {
    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ channels: [], total: 0 });

      const channels = await sql`
        SELECT id, name, enabled, config->>'feed_url' AS feed_url, config->>'platform' AS platform
        FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id}
        ORDER BY enabled DESC, name ASC
      `;

      return c.json({
        channels: channels.map(ch => ({
          id: ch.id,
          name: ch.name,
          feed_url: ch.feed_url || '',
          platform: ch.platform || 'rss',
          enabled: ch.enabled,
        })),
        total: channels.length,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 添加播客频道（RSS feed） ============
  router.post('/channels', async (c) => {
    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ error: '播客信息源未配置' }, 400);

      const body = await c.req.json();
      const { name, feedUrl } = body;

      if (!name) return c.json({ error: '请输入播客名称' }, 400);
      if (!feedUrl) return c.json({ error: '请输入 RSS feed URL' }, 400);

      // 检查是否已存在同名频道
      const [existing] = await sql`
        SELECT id FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id} AND name = ${name}
      `;
      if (existing) return c.json({ error: '该播客频道已存在' }, 400);

      const config = { feed_url: feedUrl, platform: 'rss' };

      const [inserted] = await sql`
        INSERT INTO sources (name, type, icon, parent_id, config, enabled, created_at)
        VALUES (${name}, 'podcast-channel', '🎧', ${podcastSource.id}, ${sql.json(config)}, true, NOW())
        RETURNING id, name, config
      `;

      return c.json({
        ok: true,
        channel: {
          id: inserted!.id,
          name: inserted!.name,
          feed_url: feedUrl,
          platform: 'rss',
          enabled: true,
        },
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 更新播客 feed_url ============
  router.patch('/channels/:id', async (c) => {
    try {
      const id = Number(c.req.param('id'));
      if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

      const body = await c.req.json();
      const { feedUrl } = body;
      if (!feedUrl) return c.json({ error: '请提供 feed_url' }, 400);

      const [updated] = await sql`
        UPDATE sources SET config = ${sql.json({ feed_url: feedUrl, platform: 'rss' })}, updated_at = NOW()
        WHERE id = ${id} AND type = 'podcast-channel'
        RETURNING id
      `;
      if (!updated) return c.json({ error: '播客频道不存在' }, 404);

      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 删除播客频道 ============
  router.delete('/channels/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const [deleted] = await sql`
      DELETE FROM sources WHERE id = ${id} AND type = 'podcast-channel'
      RETURNING id
    `;
    if (!deleted) return c.json({ error: '播客频道不存在' }, 404);

    return c.json({ ok: true });
  });

  // ============ 切换启用/禁用 ============
  router.patch('/channels/:id/toggle', async (c) => {
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

  // ============ 手动触发 RSS 播客采集 ============
  router.post('/sync', async (c) => {
    const startMs = Date.now();

    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ error: '播客信息源未配置' }, 400);

      const enabledChannels = await sql`
        SELECT id, name, config->>'feed_url' AS feed_url
        FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id} AND enabled = true
          AND config->>'feed_url' IS NOT NULL
      `;

      if (enabledChannels.length === 0) {
        return c.json({ ok: true, message: '没有已启用且配置了 feed_url 的播客频道', inserted: 0 });
      }

      // Call /fetch/rss for each channel (internal HTTP, same as scheduler)
      let totalFetched = 0;
      let totalInserted = 0;
      const errors: string[] = [];

      for (const channel of enabledChannels) {
        if (!channel.feed_url) continue;
        try {
          const resp = await fetch('http://127.0.0.1:3002/api/fetch/rss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedUrl: channel.feed_url, sourceName: channel.name, feedType: 'podcast-channel' }),
            signal: AbortSignal.timeout(120000),
          });
          const data: any = await resp.json();
          if (data.ok) {
            totalFetched += data.fetched || 0;
            totalInserted += data.inserted || 0;
          } else {
            errors.push(`${channel.name}: ${data.error || '未知错误'}`);
          }
        } catch (e: any) {
          errors.push(`${channel.name}: ${e.message}`);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${podcastSource.id}`;
      const durationMs = Date.now() - startMs;

      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${podcastSource.id}, '播客 RSS 采集', 'success', ${totalInserted},
          ${`${enabledChannels.length} 个频道，获取 ${totalFetched} 条，入库 ${totalInserted}` +
            (errors.length ? '，错误: ' + errors.join('; ') : '')},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        channelCount: enabledChannels.length,
        fetched: totalFetched,
        inserted: totalInserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 获取播客剧集音频 URL ============
  router.post('/audio-info', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      const [article] = await sql`
        SELECT a.url, a.extra, a.title
        FROM articles a
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      const extra = (typeof article.extra === 'string' ? JSON.parse(article.extra) : article.extra) || {};

      // RSS podcast: use enclosure URL from extra
      if (extra.audio_url) {
        return c.json({
          ok: true,
          audio_url: extra.audio_url,
          duration: extra.duration || '',
          title: article.title,
          cover_url: extra.cover_url || '',
        });
      }

      // Fallback: return play page URL
      return c.json({
        ok: true,
        audio_url: null,
        play_page_url: article.url || '',
        message: '请在播放页面收听',
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
