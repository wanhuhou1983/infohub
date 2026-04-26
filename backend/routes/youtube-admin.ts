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
import { getValidAccessToken } from './google-auth.js';

/** 解码 YouTube API 返回的 HTML 实体（如 &amp; &#39; &quot;） */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

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
        WHERE s.type = 'youtube-updates' AND s.parent_id = ${updatesSource[0]!.id}
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

      // 如果没有提供名称，通过 YouTube API 获取频道信息
      if (!name) {
        try {
          const [ytSrc] = await sql`SELECT config->>'apiKey' AS api_key FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
          const apiKey = ytSrc?.api_key;
          if (apiKey) {
            const chResp = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${apiKey}`,
              { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) }
            );
            if (chResp.ok) {
              const chData = await chResp.json() as any;
              if (chData.items?.[0]?.snippet?.title) {
                name = chData.items[0].snippet.title;
              }
            }
          }
        } catch (_) {
          // 忽略 API 错误
        }
      }

      name = name || `YouTuber ${channelId}`;

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources 
        WHERE type = 'youtube-updates' AND parent_id = ${updatesSource[0]!.id} AND config->>'channelId' = ${channelId}
      `;
      if (existing) {
        return c.json({ error: '该 UP 主已存在' }, 400);
      }

      // 插入新 UP 主（默认禁用）
      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
        VALUES (${name}, 'youtube-updates', ${updatesSource[0]!.id}, ${sql.json({ channelId })}, false, NOW())
        RETURNING id, name, config
      `;

      return c.json({ ok: true, upper: { id: inserted!.id, name: inserted!.name, channelId, enabled: false } });
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

  // ============ 获取我关注的频道（需要 Google OAuth） ============
  router.get('/subscriptions', async (c) => {
    const accessToken = await getValidAccessToken(sql);
    if (!accessToken) {
      return c.json({ error: '未授权 Google 账号，请先在系统设置中完成 Google OAuth 授权' }, 401);
    }

    try {
      const subscriptions: any[] = [];
      let nextPageToken = '';

      // 循环获取所有订阅（YouTube API 每次最多返回 50 个）
      do {
        const url = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('mine', 'true');
        url.searchParams.set('maxResults', '50');
        if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);

        const resp = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!resp.ok) {
          const err = await resp.json() as any;
          return c.json({ error: `YouTube API 错误: ${err.error?.message || resp.status}` }, 400);
        }

        const data = await resp.json() as any;
        for (const item of data.items || []) {
          const snippet = item.snippet;
          subscriptions.push({
            channelId: snippet.resourceId?.channelId,
            title: snippet.title,
            description: snippet.description,
            thumbnail: snippet.thumbnails?.default?.url || '',
          });
        }

        nextPageToken = data.nextPageToken || '';
      } while (nextPageToken);

      return c.json({ subscriptions, total: subscriptions.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 导入关注的频道到 UP 主列表 ============
  router.post('/import-subscriptions', async (c) => {
    try {
      const body = await c.req.json();
      const { channelIds } = body;

      if (!Array.isArray(channelIds) || channelIds.length === 0) {
        return c.json({ error: '请选择要导入的频道' }, 400);
      }

      const [youtubeSource] = await sql`SELECT id FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (!youtubeSource) return c.json({ error: 'YouTube 信息源未配置' }, 400);

      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'youtube-updates' AND parent_id = ${youtubeSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ error: 'YouTube "更新"源未配置' }, 400);

      // 获取每个频道的详情（获取 channelId 对应的名称）
      const accessToken = await getValidAccessToken(sql);
      const imported: string[] = [];
      const skipped: string[] = [];

      for (const channelId of channelIds) {
        // 检查是否已存在
        const [existing] = await sql`
          SELECT id FROM sources
          WHERE type = 'youtube-updates' AND parent_id = ${updatesSource[0]!.id} AND config->>'channelId' = ${channelId}
        `;
        if (existing) {
          skipped.push(channelId);
          continue;
        }

        let name = `频道 ${channelId}`;

        // 如果有 accessToken，获取频道名称
        if (accessToken) {
          try {
            const chResp = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${process.env.YOUTUBE_API_KEY || ''}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            if (chResp.ok) {
              const chData = await chResp.json() as any;
              if (chData.items?.[0]?.snippet?.title) {
                name = chData.items[0].snippet.title;
              }
            }
          } catch (_) { /* ignore */ }
        }

        await sql`
          INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
          VALUES (${name}, 'youtube-updates', ${updatesSource[0]!.id}, ${sql.json({ channelId })}, false, NOW())
        `;
        imported.push(name);
      }

      return c.json({ ok: true, imported: imported.length, skipped: skipped.length, names: imported });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 采集已启用 UP 主的最新视频 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [youtubeSource] = await sql`SELECT id, config FROM sources WHERE type = 'youtube' AND parent_id IS NULL LIMIT 1`;
      if (!youtubeSource) return c.json({ error: 'YouTube 信息源未配置' }, 400);

      const apiKey = youtubeSource.config?.apiKey;
      if (!apiKey) return c.json({ error: 'YouTube API Key 未配置，请先在数据库 sources 表（id=1530）的 config 字段中添加 apiKey' }, 400);

      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'youtube-updates' AND parent_id = ${youtubeSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ error: 'YouTube "更新"源未配置' }, 400);

      const enabledUppers = await sql`
        SELECT id, name, config->>'channelId' AS channel_id
        FROM sources
        WHERE type = 'youtube-updates' AND parent_id = ${updatesSource[0]!.id} AND enabled = true
      `;

      if (enabledUppers.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 UP 主', inserted: 0 });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const upper of enabledUppers) {
        const channelId = upper.channel_id;
        const name = upper.name;

        try {
          // 调用 YouTube Search API 获取频道最新视频
          const searchResp = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=date&maxResults=10&type=video&key=${apiKey}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          
          if (!searchResp.ok) {
            errors.push(`${name}: API ${searchResp.status}`);
            continue;
          }

          const searchData = await searchResp.json() as any;
          if (searchData.error) {
            errors.push(`${name}: ${searchData.error.message || 'API 错误'}`);
            continue;
          }

          const items = searchData.items || [];
          if (items.length === 0) {
            errors.push(`${name}: 无视频数据`);
            continue;
          }

          // 为每个视频获取详细信息（播放量、描述等）
          for (const item of items) {
            try {
              const videoId = item.id?.videoId;
              if (!videoId) continue;

              const title = decodeHtmlEntities(item.snippet?.title || '');
              const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
              const contentHash = hashString(videoUrl);

              // 检查是否已存在
              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              const publishedAt = item.snippet?.publishedAt || new Date().toISOString();
              const description = decodeHtmlEntities(item.snippet?.description || '');
              const author = name;
              const thumbnailUrl = item.snippet?.thumbnails?.high?.url || '';

              // 获取视频详细信息（播放量、点赞数等）
              let stats = '';
              try {
                const videoResp = await fetch(
                  `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}&key=${apiKey}`,
                  { headers: { 'User-Agent': 'Mozilla/5.0' } }
                );
                if (videoResp.ok) {
                  const videoData = await videoResp.json() as any;
                  if (videoData.items?.[0]) {
                    const statsData = videoData.items[0].statistics;
                    stats = `👁️ ${statsData.viewCount || 0} 观看 | 👍 ${statsData.likeCount || 0} | 💬 ${statsData.commentCount || 0}`;
                  }
                }
              } catch (e) {
                // 忽略详细信息获取失败
              }

              // 构建内容
              let content = `${title}\n\n${description}\n\n${stats}`;
              if (thumbnailUrl) {
                content = `![缩略图](${thumbnailUrl})\n\n${content}`;
              }

              const category = classifyByFeed(name);
              const tags = extractTags(title + ' ' + description.slice(0, 200), name);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${upper.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, content, {
                  id: newId, title, source_type: 'youtube',
                  source_name: name, url: videoUrl, published_at: publishedAt,
                  category, tags, author, is_read: false, is_starred: false,
                });
              }
              totalFetched++;
            } catch (e: any) {
              if (e.code !== '23505') {
                errors.push(`${name}: ${e.message}`);
              }
            }
          }
        } catch (e: any) {
          errors.push(`${name}: ${e.message}`);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${youtubeSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${youtubeSource.id}, 'YouTube UP主采集', 'success', ${inserted},
          ${`已启用 ${enabledUppers.length} 个 UP 主，获取 ${totalFetched} 个视频，入库 ${inserted} 个${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
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
