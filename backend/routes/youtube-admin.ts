/**
 * YouTube UP 主管理路由
 * 
 * 功能：
 * - GET /api/youtube-admin/uppers  → 获取已添加的 UP 主列表
 * - POST /api/youtube-admin/uppers → 手动添加 UP 主
 * - DELETE /api/youtube-admin/uppers/:id → 删除 UP 主
 * - PATCH /api/youtube-admin/uppers/:id/toggle → 切换启用/禁用
 * - POST /api/youtube-admin/refresh → 采集已启用 UP 主的最新视频
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { hashString, saveArticleFile } from '../file-storage.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

export function createYoutubeAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的 UP 主列表 ============
  router.get('/uppers', async (c) => {
    try {
      const [youtubeSource] = await sql`SELECT id, config FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (!youtubeSource) return c.json({ error: 'YouTube 信息源未配置' }, 400);

      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'youtube-updates' AND parent_id = ${youtubeSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ uppers: [], total: 0 });

      const uppers = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'channelId' AS channel_id,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_video_at
        FROM sources s
        WHERE s.type = 'youtube-updates' AND s.parent_id = ${updatesSource[0].id}
        ORDER BY s.enabled DESC, s.name ASC
      `;

      return c.json({ 
        uppers: uppers.map(a => ({
          id: a.id,
          name: a.name,
          channel_id: a.channel_id,
          enabled: a.enabled,
          latest_video_at: a.latest_video_at,
        })), 
        total: uppers.length 
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 手动添加 UP 主 ============
  router.post('/uppers', async (c) => {
    try {
      const [youtubeSource] = await sql`SELECT id FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (!youtubeSource) return c.json({ error: 'YouTube 信息源未配置' }, 400);

      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'youtube-updates' AND parent_id = ${youtubeSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ error: 'YouTube "更新"源未配置' }, 400);

      const body = await c.req.json();
      let { name, channelId, url } = body;

      // 如果提供了 URL，尝试提取 channelId
      if (url && !channelId) {
        const match = url.match(/youtube\.com\/(?:channel\/|c\/|@)([^/?\s]+)/);
        if (match) channelId = match[1];
      }

      if (!channelId) {
        return c.json({ error: '请提供 UP 主 channelId 或 YouTube 频道链接' }, 400);
      }

      name = name || `YouTuber ${channelId}`;

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources 
        WHERE type = 'youtube-updates' AND parent_id = ${updatesSource[0].id} AND config->>'channelId' = ${channelId}
      `;
      if (existing) {
        return c.json({ error: '该 UP 主已存在' }, 400);
      }

      // 插入新 UP 主（默认禁用）
      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
        VALUES (${name}, 'youtube-updates', ${updatesSource[0].id}, ${sql.json({ channelId })}, false, NOW())
        RETURNING id, name, config
      `;

      return c.json({ ok: true, upper: { id: inserted.id, name: inserted.name, channelId, enabled: false } });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 删除 UP 主 ============
  router.delete('/uppers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const [deleted] = await sql`
      DELETE FROM sources WHERE id = ${id} AND type = 'youtube-updates'
      RETURNING id
    `;
    if (!deleted) return c.json({ error: 'UP 主不存在' }, 404);

    return c.json({ ok: true });
  });

  // ============ 切换单个 UP 主启用 / 禁用 ============
  router.patch('/uppers/:id/toggle', async (c) => {
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

  // ============ 采集已启用 UP 主的最新视频 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [youtubeSource] = await sql`SELECT id FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (!youtubeSource) return c.json({ error: 'YouTube 信息源未配置' }, 400);

      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'youtube-updates' AND parent_id = ${youtubeSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ error: 'YouTube "更新"源未配置' }, 400);

      const enabledUppers = await sql`
        SELECT id, name, config->>'channelId' AS channel_id
        FROM sources
        WHERE type = 'youtube-updates' AND parent_id = ${updatesSource[0].id} AND enabled = true
      `;

      if (enabledUppers.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 UP 主', inserted: 0 });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      // TODO: 接入 YouTube Data API 或 skill 获取视频
      // 目前返回占位，等 skill 调试后再实现
      for (const upper of enabledUppers) {
        totalFetched++;
        errors.push(`${upper.name}: 待接入 YouTube API`);
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${youtubeSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${youtubeSource.id}, 'YouTube UP主采集', 'success', ${inserted},
          ${`已启用 ${enabledUppers.length} 个 UP 主，待接入 YouTube API`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        enabledCount: enabledUppers.length,
        fetched: totalFetched,
        inserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [youtubeSource] = await sql`SELECT id FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (youtubeSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${youtubeSource.id}, 'YouTube UP主采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
