/**
 * B站 UP 主管理路由
 * 
 * 功能：
 * - GET /api/bilibili-admin/accounts  → 获取已添加的 UP 主列表
 * - POST /api/bilibili-admin/accounts → 手动添加 UP 主
 * - DELETE /api/bilibili-admin/accounts/:id → 删除 UP 主
 * - PATCH /api/bilibili-admin/accounts/:id/toggle → 切换启用/禁用
 * - POST /api/bilibili-admin/refresh → 采集已启用 UP 主的最新视频
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { hashString, saveArticleFile, processImages } from '../file-storage.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

export function createBilibiliAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的 UP 主列表 ============
  router.get('/accounts', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const accounts = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'mid' AS mid,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_video_at
        FROM sources s
        WHERE s.type = 'bilibili' AND s.parent_id = ${bilibiliSource.id}
        ORDER BY s.enabled DESC, s.name ASC
      `;

      return c.json({ 
        accounts: accounts.map(a => ({
          id: a.id,
          name: a.name,
          mid: a.mid,
          enabled: a.enabled,
          latest_video_at: a.latest_video_at,
        })), 
        total: accounts.length 
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 手动添加 UP 主 ============
  router.post('/accounts', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const body = await c.req.json();
      let { name, mid, url } = body;

      // 如果提供了 URL，尝试提取 mid
      if (url && !mid) {
        // 支持的 URL 格式:
        // https://space.bilibili.com/20211965
        // https://space.bilibili.com/20211965/
        // https://space.bilibili.com/20211965?spm_id_from=xxx
        const match = url.match(/space\.bilibili\.com\/(\d+)/);
        if (match) {
          mid = match[1];
        }
      }

      if (!mid) {
        return c.json({ error: '请提供 UP 主 mid 或 space 链接' }, 400);
      }

      // 如果没有提供名称，通过 API 获取
      if (!name) {
        try {
          const infoResp = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=true`);
          if (infoResp.ok) {
            const infoData = await infoResp.json() as any;
            if (infoData.code === 0 && infoData.data?.card) {
              name = infoData.data.card.name || `UP主 ${mid}`;
            }
          }
        } catch (e) {
          // 忽略 API 错误，使用默认名称
        }
      }

      name = name || `UP主 ${mid}`;

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources 
        WHERE type = 'bilibili' AND parent_id = ${bilibiliSource.id} AND config->>'mid' = ${mid}
      `;
      if (existing) {
        return c.json({ error: '该 UP 主已存在' }, 400);
      }

      // 插入新 UP 主（默认禁用）
      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
        VALUES (${name}, 'bilibili', ${bilibiliSource.id}, ${sql.json({ mid })}, false, NOW())
        RETURNING id, name, mid
      `;

      return c.json({ ok: true, account: { id: inserted.id, name: inserted.name, mid, enabled: false } });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 删除 UP 主 ============
  router.delete('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const [deleted] = await sql`
      DELETE FROM sources WHERE id = ${id} AND type = 'bilibili'
      RETURNING id
    `;
    if (!deleted) return c.json({ error: 'UP 主不存在' }, 404);

    return c.json({ ok: true });
  });

  // ============ 切换单个 UP 主启用 / 禁用 ============
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

  // ============ 采集已启用 UP 主的最新视频 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [bilibiliSource] = await sql`SELECT id FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      // 获取已启用的 UP 主
      const enabledAccounts = await sql`
        SELECT id, name, config->>'mid' AS mid
        FROM sources
        WHERE type = 'bilibili' AND parent_id = ${bilibiliSource.id} AND enabled = true
      `;

      if (enabledAccounts.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 UP 主', inserted: 0 });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const account of enabledAccounts) {
        const mid = account.mid;
        const name = account.name;

        try {
          // 调用 B 站 API 获取 UP 主视频列表
          const archiveResp = await fetch(
            `https://api.bilibili.com/x/space/arc/search?mid=${mid}&pn=1&ps=10&jsonp=jsonp`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          
          if (!archiveResp.ok) {
            errors.push(`${name}: API ${archiveResp.status}`);
            continue;
          }

          const archiveData = await archiveResp.json() as any;
          if (archiveData.code !== 0 || !archiveData.data?.list?.vlist) {
            errors.push(`${name}: ${archiveData.message || '无视频数据'}`);
            continue;
          }

          const videos = archiveData.data.list.vlist;

          for (const video of videos) {
            try {
              const bvid = video.bvid;
              const title = video.title;
              const videoUrl = `https://www.bilibili.com/video/${bvid}`;
              const contentHash = hashString(videoUrl);

              // 检查是否已存在
              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              const publishedAt = new Date(video.created * 1000).toISOString();
              const description = video.description || '';
              const author = name;

              // 尝试获取更完整的视频信息
              let content = `${title}\n\n${description}\n\n👀 ${video.play} | ❤️ ${video.comment}`;

              const category = classifyByFeed(name);
              const tags = extractTags(title + ' ' + description.slice(0, 200), name);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${account.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, content, {
                  id: newId, title, source_type: 'bilibili',
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

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${bilibiliSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${bilibiliSource.id}, 'B站UP主采集', 'success', ${inserted},
          ${`已启用 ${enabledAccounts.length} 个 UP 主，获取 ${totalFetched} 个视频，入库 ${inserted} 个${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        enabledCount: enabledAccounts.length,
        fetched: totalFetched,
        inserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [bilibiliSource] = await sql`SELECT id FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (bilibiliSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${bilibiliSource.id}, 'B站UP主采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 采集"稍后再看"列表 ============
  router.post('/refresh-watch-later', async (c) => {
    const startMs = Date.now();

    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const sessdata = bilibiliSource.config?.sessdata;
      if (!sessdata) return c.json({ error: '未配置 SESSDATA，请先配置 B站 Cookie' }, 400);

      // 获取稍后再看列表
      const resp = await fetch('https://api.bilibili.com/x/v2/history/toview', {
        headers: { 'Cookie': `SESSDATA=${sessdata}`, 'User-Agent': 'Mozilla/5.0' }
      });
      
      if (!resp.ok) return c.json({ error: `API ${resp.status}` }, 400);
      
      const data = await resp.json() as any;
      if (data.code !== 0) return c.json({ error: data.message }, 400);

      const list = data.data?.list || [];
      if (list.length === 0) {
        return c.json({ ok: true, message: '稍后再看为空', inserted: 0 });
      }

      // 查找"稍后再看"子源
      const [watchLaterSource] = await sql`
        SELECT id FROM sources WHERE parent_id = ${bilibiliSource.id} AND config->>'subtype' = 'watch_later' LIMIT 1
      `;
      if (!watchLaterSource) return c.json({ error: '未找到稍后再看子源' }, 400);

      let inserted = 0;
      const errors: string[] = [];

      for (const item of list) {
        try {
          const bvid = item.bvid;
          const title = item.title;
          const videoUrl = `https://www.bilibili.com/video/${bvid}`;
          const contentHash = hashString(videoUrl + '_watch_later');

          // 检查是否已存在
          const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
          if (existing) continue;

          const publishedAt = new Date(item.pubdate * 1000).toISOString();
          const description = item.desc || '';
          const author = item.owner?.name || '';

          let content = `${title}\n\n${description}\n\n👀 ${item.stat?.view || 0} | ❤️ ${item.stat?.like || 0}`;

          const category = classifyByFeed('B站稍后再看');
          const tags = extractTags(title + ' ' + description.slice(0, 200), 'B站稍后再看');

          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, is_watch_later)
            VALUES (${watchLaterSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, true)
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;

          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            await saveArticleFile(newId, content, {
              id: newId, title, source_type: 'bilibili',
              source_name: '稍后再看', url: videoUrl, published_at: publishedAt,
              category, tags, author, is_read: false, is_starred: false,
              is_watch_later: true
            });
          }
        } catch (e: any) {
          if (e.code !== '23505') errors.push(e.message);
        }
      }

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${bilibiliSource.id}, 'B站稍后再看采集', 'success', ${inserted},
          ${`获取 ${list.length} 条，入库 ${inserted} 个${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs})
      `;

      return c.json({ ok: true, fetched: list.length, inserted, errors: errors.length ? errors : undefined });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 采集"收藏夹"列表 ============
  router.post('/refresh-favorites', async (c) => {
    const startMs = Date.now();

    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const sessdata = bilibiliSource.config?.sessdata;
      if (!sessdata) return c.json({ error: '未配置 SESSDATA，请先配置 B站 Cookie' }, 400);

      // 获取用户信息获取 mid
      const navResp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'Cookie': `SESSDATA=${sessdata}`, 'User-Agent': 'Mozilla/5.0' }
      });
      
      if (!navResp.ok) return c.json({ error: `获取用户信息失败: ${navResp.status}` }, 400);
      
      const navData = await navResp.json() as any;
      if (navData.code !== 0) return c.json({ error: navData.message }, 400);
      
      const mid = navData.data.mid;

      // 获取收藏夹列表
      const favListResp = await fetch(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`, {
        headers: { 'Cookie': `SESSDATA=${sessdata}`, 'User-Agent': 'Mozilla/5.0' }
      });
      
      if (!favListResp.ok) return c.json({ error: `获取收藏夹列表失败: ${favListResp.status}` }, 400);
      
      const favListData = await favListResp.json() as any;
      if (favListData.code !== 0) return c.json({ error: favListData.message }, 400);

      const favList = favListData.data?.list || [];
      if (favList.length === 0) {
        return c.json({ ok: true, message: '没有收藏夹', inserted: 0 });
      }

      // 查找"收藏"子源
      const [favoritesSource] = await sql`
        SELECT id FROM sources WHERE parent_id = ${bilibiliSource.id} AND config->>'subtype' = 'favorites' LIMIT 1
      `;
      if (!favoritesSource) return c.json({ error: '未找到收藏子源' }, 400);

      let totalInserted = 0;
      const errors: string[] = [];

      // 遍历每个收藏夹，获取内容
      for (const fav of favList) {
        const mediaId = fav.id;
        
        // 获取收藏夹内容（每页 30 条，取第一页演示）
        const favContentResp = await fetch(
          `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=1&ps=30`,
          { headers: { 'Cookie': `SESSDATA=${sessdata}`, 'User-Agent': 'Mozilla/5.0' } }
        );
        
        if (!favContentResp.ok) {
          errors.push(`收藏夹 ${fav.title}: API ${favContentResp.status}`);
          continue;
        }
        
        const favContentData = await favContentResp.json() as any;
        if (favContentData.code !== 0) {
          errors.push(`收藏夹 ${fav.title}: ${favContentData.message}`);
          continue;
        }

        const medials = favContentData.data?.medias || [];
        
        for (const item of medials) {
          try {
            const bvid = item.bvid;
            const title = item.title;
            const videoUrl = `https://www.bilibili.com/video/${bvid}`;
            const contentHash = hashString(videoUrl + '_favorites');

            // 检查是否已存在
            const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
            if (existing) continue;

            const publishedAt = new Date(item.pubtime * 1000).toISOString();
            const description = item.desc || '';
            const author = item.owner?.name || '';

            let content = `${title}\n\n${description}\n\n👀 ${item.stat?.view || 0} | ❤️ ${item.stat?.like || 0}\n\n📁 收藏夹: ${fav.title}`;

            const category = classifyByFeed('B站收藏');
            const tags = extractTags(title + ' ' + description.slice(0, 200), 'B站收藏');

            const insertedRows = await sql`
              INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, is_starred)
              VALUES (${favoritesSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, true)
              ON CONFLICT (content_hash) DO NOTHING
              RETURNING id
            `;

            if (insertedRows.length > 0) {
              totalInserted++;
              const newId = insertedRows[0]!.id;
              await saveArticleFile(newId, content, {
                id: newId, title, source_type: 'bilibili',
                source_name: '收藏', url: videoUrl, published_at: publishedAt,
                category, tags, author, is_read: false, is_starred: true,
              });
            }
          } catch (e: any) {
            if (e.code !== '23505') errors.push(e.message);
          }
        }
      }

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${bilibiliSource.id}, 'B站收藏采集', 'success', ${totalInserted},
          ${`${favList.length} 个收藏夹，入库 ${totalInserted} 个${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs})
      `;

      return c.json({ ok: true, favCount: favList.length, inserted: totalInserted, errors: errors.length ? errors : undefined });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}