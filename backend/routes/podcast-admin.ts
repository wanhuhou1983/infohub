/**
 * 播客频道管理路由
 *
 * 功能：
 * - GET   /api/podcast-admin/channels       → 获取已添加的播客列表
 * - POST  /api/podcast-admin/channels       → 添加播客频道
 * - DELETE /api/podcast-admin/channels/:id  → 删除播客频道
 * - PATCH /api/podcast-admin/channels/:id/toggle → 切换启用/禁用
 * - GET   /api/podcast-admin/platforms      → 获取支持的平台列表（来自 musicdl）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * musicdl 支持的播客/音频平台列表
 * 来自 musicdl v2.11.3 的 REGISTERED_MODULES
 */
const PODCAST_PLATFORMS = [
  { id: 'XimalayaMusicClient', name: '喜马拉雅', icon: '🔊' },
  { id: 'LizhiMusicClient', name: '荔枝 FM', icon: '🎤' },
  { id: 'QingtingMusicClient', name: '蜻蜓 FM', icon: '📻' },
  { id: 'LRTSMusicClient', name: '懒人听书', icon: '📖' },
  { id: 'FMAMusicClient', name: 'FMA 电台', icon: '🎵' },
  { id: 'GDStudioMusicClient', name: 'GD 工作室', icon: '🎙️' },
  { id: 'NeteaseMusicClient', name: '网易云音乐', icon: '🎶' },
  { id: 'SpotifyMusicClient', name: 'Spotify', icon: '🟢' },
  { id: 'SoundCloudMusicClient', name: 'SoundCloud', icon: '☁️' },
  { id: 'AppleMusicClient', name: 'Apple Music', icon: '🍎' },
  { id: 'BilibiliMusicClient', name: 'Bilibili 音乐', icon: '📺' },
  { id: 'YouTubeMusicClient', name: 'YouTube Music', icon: '▶️' },
  { id: 'DeezerMusicClient', name: 'Deezer', icon: '🎧' },
  { id: 'QobuzMusicClient', name: 'Qobuz', icon: '🔷' },
  { id: 'TIDALMusicClient', name: 'TIDAL', icon: '🌊' },
  { id: 'JooxMusicClient', name: 'JOOX', icon: '🎼' },
  { id: 'KKWSMusicClient', name: 'KKBOX', icon: '🎵' },
  { id: 'KugouMusicClient', name: '酷狗音乐', icon: '🐶' },
  { id: 'KuwoMusicClient', name: '酷我音乐', icon: '🎧' },
  { id: 'MiguMusicClient', name: '咪咕音乐', icon: '📱' },
  { id: 'QQMusicClient', name: 'QQ 音乐', icon: '🐧' },
  { id: 'QianqianMusicClient', name: '千千音乐', icon: '🎵' },
  { id: 'XiaoyuzhouMusicClient', name: '小宇宙', icon: '🌌' },
];

export function createPodcastAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取支持的平台列表 ============
  router.get('/platforms', async (c) => {
    return c.json({ platforms: PODCAST_PLATFORMS });
  });

  // ============ 获取所有已添加的播客列表 ============
  router.get('/channels', async (c) => {
    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ channels: [], total: 0 });

      const channels = await sql`
        SELECT id, name, enabled, config->>'platform' AS platform, config->>'url' AS url, config->>'playlistUrl' AS playlist_url
        FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id}
        ORDER BY enabled DESC, name ASC
      `;

      return c.json({
        channels: channels.map(ch => ({
          id: ch.id,
          name: ch.name,
          platform: ch.platform || '',
          url: ch.url || '',
          playlist_url: ch.playlist_url || '',
          enabled: ch.enabled,
        })),
        total: channels.length,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 添加播客频道 ============
  router.post('/channels', async (c) => {
    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ error: '播客信息源未配置' }, 400);

      const body = await c.req.json();
      const { name, platform, url, playlistUrl } = body;

      if (!name) return c.json({ error: '请输入播客名称' }, 400);

      // 检查是否已存在同名频道
      const [existing] = await sql`
        SELECT id FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id} AND name = ${name}
      `;
      if (existing) return c.json({ error: '该播客频道已存在' }, 400);

      const config: Record<string, string> = {};
      if (platform) config.platform = platform;
      if (url) config.url = url;
      if (playlistUrl) config.playlistUrl = playlistUrl;

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
          platform: platform || '',
          url: url || '',
          playlist_url: playlistUrl || '',
          enabled: true,
        },
      });
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

  // ============ 同步播客频道（采集已启用的播客剧集） ============
  router.post('/sync', async (c) => {
    const startMs = Date.now();

    try {
      const [podcastSource] = await sql`
        SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1
      `;
      if (!podcastSource) return c.json({ error: '播客信息源未配置' }, 400);

      const enabledChannels = await sql`
        SELECT id, name, config->>'platform' AS platform, config->>'url' AS url
        FROM sources
        WHERE type = 'podcast-channel' AND parent_id = ${podcastSource.id} AND enabled = true
      `;

      if (enabledChannels.length === 0) {
        return c.json({ ok: true, message: '没有已启用的播客频道', inserted: 0 });
      }

      const { execSync } = await import('child_process');
      const scriptPath = new URL('../../scripts/fetch_podcast_episodes.py', import.meta.url).pathname;
      const venvPath = new URL('../../.venv311/bin/python3', import.meta.url);
      const pythonBin = existsSync(venvPath) ? venvPath.pathname : (process.platform === 'win32' ? 'python' : 'python3');

      let totalInserted = 0;
      let totalSkipped = 0;
      let errors: string[] = [];

      for (const channel of enabledChannels) {
        // 跳过 RSS 播客（使用 RSS 同步机制，不通过 Python 脚本）
        if (channel.platform === 'rss') {
          continue;
        }

        if (!channel.platform || !channel.url) {
          errors.push(`${channel.name}: 缺少 platform 或 url`);
          continue;
        }

        // 规范化平台名（前端 mapping 为 musicdl 模块名，Python 脚本用短名）
        const platformMap: Record<string, string> = {
          'XimalayaMusicClient': 'ximalaya',
          'QingtingMusicClient': 'qingting',
          'XiaoyuzhouMusicClient': 'xiaoyuzhou',
        };
        const normalizedPlatform = platformMap[channel.platform] || channel.platform;

        let page = 1;
        let hasMore = true;
        let channelInserted = 0;
        let channelSkipped = 0;

        let consecutiveSkipped = 0; // 连续跳过计数，用于提前停止

        while (hasMore) {
          try {
            const result = execSync(
              `"${pythonBin}" "${scriptPath}" --platform "${normalizedPlatform}" --url "${channel.url.replace(/"/g, '\\"')}" --page ${page}`,
              { timeout: 30000, encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            if (data.error) {
              errors.push(`${channel.name} (第${page}页): ${data.error}`);
              break;
            }

            const episodes = data.episodes || [];
            if (episodes.length === 0) break;

            let pageInserted = 0;
            let pageSkipped = 0;

            for (const ep of episodes) {
              // 生成唯一 content_hash：source_id + external_id
              const contentHash = createHash('md5')
                .update(`${channel.id}_${ep.external_id}`)
                .digest('hex');

              const publishedAt = ep.published_at
                ? sql`${ep.published_at}::timestamptz AT TIME ZONE 'Asia/Shanghai'`
                : sql`NOW()`;

              try {
                const insertResult = await sql`
                  INSERT INTO articles (source_id, title, content, summary, url, author, published_at, category, tags, content_hash, external_id, extra)
                  VALUES (
                    ${channel.id},
                    ${ep.title},
                    ${ep.description || ''},
                    ${ep.description || ''},
                    ${ep.url || ''},
                    ${ep.author || channel.name},
                    ${publishedAt},
                    'podcast',
                    ${['podcast', channel.name]},
                    ${contentHash},
                    ${ep.external_id},
                    ${sql.json({ duration: ep.duration, duration_display: ep.duration_display, cover_url: ep.cover_url, platform: channel.platform })}
                  )
                  ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL
                  DO NOTHING
                `;
                const affectedCount = insertResult?.count ?? 0;
                if (affectedCount > 0) {
                  pageInserted++;
                } else {
                  pageSkipped++;
                }
              } catch (insertErr: any) {
                console.error(`[播客] 插入失败: ${channel.name} - ${ep.title}: ${insertErr.message}`);
              }
            }

            channelInserted += pageInserted;
            channelSkipped += pageSkipped;

            // 如果整页全部跳过（即已存在），连续计数+1，达到3页则提前停止
            if (pageSkipped > 0 && pageInserted === 0) {
              consecutiveSkipped++;
              if (consecutiveSkipped >= 3) {
                hasMore = false; // 已经连续3页全部是已有数据，后面都是旧的
              }
            } else {
              consecutiveSkipped = 0;
            }

            // 检查是否还有更多页
            if (hasMore) {
              hasMore = data.has_more === true;
            }
            page++;
          } catch (e: any) {
            errors.push(`${channel.name} (第${page}页): ${e.message}`);
            break;
          }
        }

        totalInserted += channelInserted;
        totalSkipped += channelSkipped;
        console.log(`[播客] ${channel.name}: 新增 ${channelInserted}, 跳过 ${channelSkipped}`);
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${podcastSource.id}`;
      const durationMs = Date.now() - startMs;

      const detailParts: string[] = [];
      detailParts.push(`处理 ${enabledChannels.length} 个频道`);
      detailParts.push(`新增 ${totalInserted} 集`);
      if (totalSkipped > 0) detailParts.push(`跳过 ${totalSkipped} 集（已存在）`);
      if (errors.length > 0) detailParts.push(`错误: ${errors.join('; ')}`);

      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${podcastSource.id}, '播客同步', 'success', ${totalInserted},
          ${detailParts.join('，')},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        enabledCount: enabledChannels.length,
        inserted: totalInserted,
        skipped: totalSkipped,
        errors: errors.length ? errors : undefined,
        duration_ms: durationMs,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [podcastSource] = await sql`SELECT id FROM sources WHERE type = 'podcast' AND parent_id IS NULL LIMIT 1`;
      if (podcastSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${podcastSource.id}, '播客同步', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
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
        SELECT a.url, a.extra, a.title, s.config->>'platform' AS channel_platform
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      const extra = article.extra || {};
      const platform = extra.platform || article.channel_platform || 'XimalayaMusicClient';
      const trackUrl = article.url || '';

      // 如果文章已有 audio_url（如 RSS 播客的 enclosure），直接返回
      if (extra.audio_url) {
        return c.json({
          ok: true,
          audio_url: extra.audio_url,
          duration: extra.duration || '',
          title: article.title,
          cover_url: extra.cover_url || '',
        });
      }

      if (!trackUrl) return c.json({ error: '文章没有播放链接' }, 400);

      // 喜马拉雅：调用 Python 脚本获取音频 URL
      if (platform === 'XimalayaMusicClient' || platform === 'ximalaya') {
        const { execSync } = await import('child_process');
        const scriptPath = new URL('../../scripts/podcast_audio.py', import.meta.url).pathname;
        const venvPath = new URL('../../.venv311/bin/python3', import.meta.url);
        const pythonBin = existsSync(venvPath) ? venvPath.pathname : (process.platform === 'win32' ? 'python' : 'python3');

        const result = execSync(
          `"${pythonBin}" "${scriptPath}" --url "${trackUrl.replace(/"/g, '\\"')}"`,
          { timeout: 20000, encoding: 'utf-8' }
        );
        const data = JSON.parse(result);
        if (!data.ok) return c.json({ error: data.error || '获取音频 URL 失败' }, 500);
        return c.json({
          ok: true,
          audio_url: data.audio_url,
          duration: data.duration,
          title: data.track_name || article.title,
          cover_url: data.cover_url || extra.cover_url || '',
        });
      }

      // 其他平台：返回播放页 URL，前端用 iframe 或新窗口打开
      return c.json({
        ok: true,
        audio_url: null,
        play_page_url: trackUrl,
        platform,
        message: '该平台暂不支持直接获取音频流，将打开播放页',
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 搜索播客频道 ============
  router.get('/search', async (c) => {
    const keyword = c.req.query('q');
    const page = parseInt(c.req.query('page') || '1', 10);

    if (!keyword || !keyword.trim()) {
      return c.json({ error: '请输入搜索关键词' }, 400);
    }

    try {
      const { execSync } = await import('child_process');
      const scriptPath = new URL('../../scripts/search_podcast.py', import.meta.url).pathname;
      const venvPath = new URL('../../.venv311/bin/python3', import.meta.url);
      const pythonBin = existsSync(venvPath) ? venvPath.pathname : (process.platform === 'win32' ? 'python' : 'python3');
      const result = execSync(
        `"${pythonBin}" "${scriptPath}" "${keyword.replace(/"/g, '\\"')}" ${page}`,
        { timeout: 20000, encoding: 'utf-8' }
      );
      const data = JSON.parse(result);
      return c.json(data);
    } catch (e: any) {
      // 尝试解析 stderr 中的 JSON
      try {
        const match = e.stderr?.match(/\{.*\}/s);
        if (match) return c.json(JSON.parse(match[0]));
      } catch {}
      return c.json({ error: `搜索失败: ${e.message}` }, 500);
    }
  });

  return router;
}
