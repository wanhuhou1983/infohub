/**
 * B站 UP 主管理路由
 * 
 * 功能：
 * - GET /api/bilibili-admin/accounts  → 获取已添加的 UP 主列表
 * - POST /api/bilibili-admin/accounts → 手动添加 UP 主
 * - DELETE /api/bilibili-admin/accounts/:id → 删除 UP 主
 * - PATCH /api/bilibili-admin/accounts/:id/toggle → 切换启用/禁用
 * - POST /api/bilibili-admin/refresh → 采集已启用 UP 主的最新视频
 * - POST /api/bilibili-admin/upload-to-netdisk → 下载B站视频并上传到百度网盘
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { hashString, saveArticleFile, processImages } from '../file-storage.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

// Playwright 采集脚本路径
const __moduleDir = dirname(fileURLToPath(import.meta.url));
const BILIBILI_FETCH_SCRIPT = join(__moduleDir, '..', '..', 'scripts', 'bilibili-fetch.py');

export function createBilibiliAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的 UP 主列表 ============
  router.get('/accounts', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      // Find updates source
      const [updatesSource] = await sql`SELECT id FROM sources WHERE type = 'bilibili-updates' AND parent_id = ${bilibiliSource.id} LIMIT 1`;
      if (!updatesSource) return c.json({ error: 'B站更新源未配置' }, 400);

      const accounts = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'mid' AS mid,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_video_at
        FROM sources s
        WHERE s.type = 'bilibili-updates' AND s.parent_id = ${updatesSource.id}
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

      return c.json({ ok: true, account: { id: inserted!.id, name: inserted!.name, mid, enabled: false } });
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

  // ============ 获取 SESSDATA 状态 ============
  router.get('/sessdata', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const sessdata = (bilibiliSource.config as any)?.sessdata || '';
      if (!sessdata) return c.json({ configured: false, masked: '', valid: false });

      // 验证 SESSDATA 是否有效
      let valid = false;
      try {
        const navResp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: { Cookie: `SESSDATA=${sessdata}`, 'User-Agent': 'Mozilla/5.0' }
        });
        if (navResp.ok) {
          const navData = await navResp.json() as any;
          valid = navData.code === 0 && navData.data?.isLogin === true;
        }
      } catch (_) { /* 网络错误忽略 */ }

      const masked = sessdata.length > 8 ? sessdata.slice(0, 4) + '****' + sessdata.slice(-4) : '****';
      return c.json({ configured: true, masked, valid, user: valid ? undefined : undefined });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 更新 SESSDATA ============
  router.put('/sessdata', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      const body = await c.req.json();
      const sessdata = (body.sessdata || '').trim();
      if (!sessdata) return c.json({ error: 'SESSDATA 不能为空' }, 400);

      await sql`
        UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{sessdata}', ${sessdata}::jsonb)
        WHERE id = ${bilibiliSource.id}
      `;

      return c.json({ ok: true, message: 'SESSDATA 已更新' });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 采集已启用 UP 主的最新视频 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站信息源未配置' }, 400);

      // 注意：UP 主视频采集现使用 Playwright 浏览器（绕过 B站 412 反爬 + WBI 签名）
      // SESSDATA 仅在"稍后再看"和"收藏"接口中使用，不需传入 Playwright

      // 获取已启用的 UP 主（type=bilibili-updates, parent_id=更新节点1273）
      const updatesSource = await sql`SELECT id FROM sources WHERE type = 'bilibili-updates' AND parent_id = ${bilibiliSource.id} LIMIT 1`;
      if (updatesSource.length === 0) return c.json({ error: 'B站"更新"源未配置' }, 400);

      const enabledAccounts = await sql`
        SELECT id, name, config->>'mid' AS mid
        FROM sources
        WHERE type = 'bilibili-updates' AND parent_id = ${updatesSource[0]!.id} AND enabled = true
      `;

      if (enabledAccounts.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 UP 主', inserted: 0 });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      // 延迟一秒避免操作过快
      await new Promise(r => setTimeout(r, 1000));

      for (const account of enabledAccounts) {
        const mid = account.mid;
        const name = account.name;

        try {
          // 使用 OpenCLI（复用 Chrome 登录态，天然绕过 B站反爬）
          let videos: any[];
          try {
            const cliOutput = execSync(
              `cmd /c opencli bilibili user-videos ${mid} --limit 20 -f json`,
              { encoding: 'utf-8', timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
            );
            const rawVideos = JSON.parse(cliOutput);
            // Normalize: extract bvid from url, keep other fields
            videos = (rawVideos || []).map((v: any) => ({
              bvid: (v.url || '').split('/video/')[1] || '',
              title: v.title || '',
              play: v.plays || 0,
              date: v.date || '',
              // created: approximate epoch from date string
              created: v.date ? Math.floor(new Date(v.date).getTime() / 1000) : 0,
              description: '',
              length: '',
              comment: 0,
            }));
          } catch (fetchErr: any) {
            // Fallback: try single video command for empty output corner case
            errors.push(`${name}: OpenCLI 调用失败 (${fetchErr.message})`);
            continue;
          }

          if (videos.length === 0) {
            totalFetched += 0;
            continue;
          }

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

              const extra = { duration: video.length || '' };
              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
                VALUES (${account.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, ${sql.json(extra)})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, content, {
                  id: newId, title, source_type: 'bilibili-updates',
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

      // 处理 disabled UP 主：跳过（OpenCLI 逐账号调用耗时, 200+ 账号）
      // 如需索引，取消下面 if(false) 即可
      if (false) {
      try {
        const disabledAccounts = await sql`
          SELECT id, name, config->>'mid' AS mid
          FROM sources
          WHERE type = 'bilibili-updates' AND parent_id = ${updatesSource[0]!.id} AND enabled = false
        `;
        let disabledInserted = 0;
        for (const account of disabledAccounts) {
          const mid = account.mid;
          if (!mid) continue;
          try {
            const cliOutput = execSync(
              `cmd /c opencli bilibili user-videos ${mid} --limit 20 -f json`,
              { encoding: 'utf-8', timeout: 30000, maxBuffer: 5 * 1024 * 1024 }
            );
            const rawVideos = JSON.parse(cliOutput) || [];
            const videos = rawVideos.map((v: any) => ({
              bvid: (v.url || '').split('/video/')[1] || '',
              title: v.title || '',
              created: v.date ? Math.floor(new Date(v.date).getTime() / 1000) : 0,
            }));

            for (const video of videos) {
              const bvid = video.bvid;
              const title = video.title;
              const videoUrl = `https://www.bilibili.com/video/${bvid}`;
              const contentHash = hashString(videoUrl + '_disabled');

              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) continue;

              const publishedAt = new Date(video.created * 1000).toISOString();
              await sql`
                INSERT INTO articles (source_id, title, content, url, published_at, category, tags, content_hash, fetched_at, author, extra)
                VALUES (${account.id}, ${title}, '', ${videoUrl}, ${publishedAt}, '未订阅', ${['未订阅索引']}, ${contentHash}, NOW(), ${account.name}, '{}'::jsonb)
                ON CONFLICT (content_hash) DO NOTHING
              `;
              disabledInserted++;
            }
          } catch (e) {
            // Silence errors for disabled sources
          }
        }
        if (disabledInserted > 0) {
          console.log(`[B站] 已索引 ${disabledInserted} 个未订阅 UP 主视频 URL`);
        }
      } catch (e) {
        // Silently continue
      }
      } // if(false) - disabled accounts
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

          const secs = item.duration || 0;
          const durStr = secsToStr(secs);
          const extra = durStr ? { duration: durStr } : {};
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, is_watch_later, extra)
            VALUES (${watchLaterSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, true, ${sql.json(extra)})
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;

          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            await saveArticleFile(newId, content, {
              id: newId, title, source_type: 'bilibili-watch-later',
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

            const secs = item.duration || 0;
            const durStr = secsToStr(secs);
            const extra = durStr ? { duration: durStr } : {};
            const insertedRows = await sql`
              INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, is_starred, extra)
              VALUES (${favoritesSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${videoUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, true, ${sql.json(extra)})
              ON CONFLICT (content_hash) DO NOTHING
              RETURNING id
            `;

            if (insertedRows.length > 0) {
              totalInserted++;
              const newId = insertedRows[0]!.id;
              await saveArticleFile(newId, content, {
                id: newId, title, source_type: 'bilibili-favorites',
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

  // ============ 回填已有 B 站文章的 duration ============
  router.post('/backfill-duration', async (c) => {
    try {
      // 查找所有缺少 duration 的 B 站文章
      const articles = await sql`
        SELECT id, url FROM articles
        WHERE url LIKE '%bilibili.com/video/%'
          AND (extra IS NULL OR extra = '{}'::jsonb OR extra->>'duration' IS NULL OR extra->>'duration' = '')
        ORDER BY id ASC
      `;

      if (articles.length === 0) {
        return c.json({ ok: true, message: '没有需要回填的文章', total: 0 });
      }

      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const article of articles) {
        const bvidMatch = article.url.match(/\/video\/(BV\w+)/);
        if (!bvidMatch) {
          failed++;
          continue;
        }
        const bvid = bvidMatch[1];

        try {
          const resp = await fetch(
            `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (!resp.ok) {
            errors.push(`${bvid}: HTTP ${resp.status}`);
            failed++;
            continue;
          }
          const data = await resp.json() as any;
          if (data.code !== 0) {
            errors.push(`${bvid}: ${data.message}`);
            failed++;
            continue;
          }

          const secs = data.data?.duration || 0;
          if (secs <= 0) {
            failed++;
            continue;
          }

          const durStr = secsToStr(secs);
          await sql`
            UPDATE articles SET extra = ${sql.json({ duration: durStr })}
            WHERE id = ${article.id}
          `;
          updated++;

          // 延迟 200ms 避免触发 B 站 API 限流
          await new Promise(r => setTimeout(r, 200));
        } catch (e: any) {
          errors.push(`${bvid}: ${e.message}`);
          failed++;
        }
      }

      return c.json({
        ok: true,
        total: articles.length,
        updated,
        failed,
        errors: errors.length > 0 ? errors.slice(0, 20) : undefined,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 下载 B站视频并上传到百度网盘 ============
  router.post('/upload-to-netdisk', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      // 查询文章 + 关联 source_type
      const [article] = await sql`
        SELECT a.id, a.title, a.url, s.type AS source_type
        FROM articles a
        LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 校验是否为 B站视频
      const sourceType = article.source_type || '';
      if (!sourceType.startsWith('bilibili')) {
        return c.json({ error: '非 B站视频' }, 400);
      }
      const videoUrl = article.url;
      if (!videoUrl || !videoUrl.includes('bilibili.com/video/')) {
        return c.json({ error: '文章无有效视频链接' }, 400);
      }

      // 提取 BVID
      const bvidMatch = videoUrl.match(/\/video\/(BV\w+)/);
      if (!bvidMatch) return c.json({ error: '无法提取 BVID' }, 400);
      const bvid = bvidMatch[1];
      const fullUrl = `https://www.bilibili.com/video/${bvid}`;

      // 创建临时目录
      const timestamp = Date.now();
      const tmpBase = join(tmpdir(), 'infohub-bili');
      const tmpDir = join(tmpBase, `${articleId}-${timestamp}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        // 下载视频（yt-dlp 自动合并音视频为 mp4）
        const ytDlpOutput = join(tmpDir, '%(title)s.%(ext)s');
        execSync(
          `yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${ytDlpOutput}" "${fullUrl}"`,
          { timeout: 600_000, encoding: 'utf-8', stdio: 'pipe' }
        );

        // 查找生成的 mp4 文件
        const files = readdirSync(tmpDir).filter(f => f.endsWith('.mp4'));
        if (files.length === 0) {
          throw new Error('下载完成后未找到 mp4 文件');
        }
        const mp4File = files[0]; // 取第一个（通常只有一个）
        if (!mp4File) {
          throw new Error('files 数组为空，未找到 mp4 文件');
        }
        const mp4Path = join(tmpDir, mp4File);

        // 获取文件大小
        const fileSize = statSync(mp4Path).size;

        // 上传到百度网盘（使用绝对路径避免 PATH 问题）
        const remotePath = `B站视频收藏/${mp4File}`;
        const bdpanBin = join(process.env.HOME || '/Users/wuhuahui', '.local/bin', 'bdpan');
        if (!existsSync(bdpanBin)) {
          throw new Error(`bdpan 未找到: ${bdpanBin}`);
        }
        execSync(
          `"${bdpanBin}" upload "${mp4Path}" "${remotePath}"`,
          { timeout: 600_000, encoding: 'utf-8', stdio: 'pipe' }
        );

        return c.json({
          ok: true,
          filename: mp4File,
          size: fileSize,
          message: `已收藏到百度网盘 /${remotePath}`,
        });
      } finally {
        // 确保清理临时文件
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });


  // POST /sync-following — 从 B站同步关注列表到 PG (不重复插入，默认禁用)
  router.post('/sync-following', async (c) => {
    try {
      const [bilibiliSource] = await sql`SELECT id, config FROM sources WHERE type = 'bilibili' AND parent_id IS NULL LIMIT 1`;
      if (!bilibiliSource) return c.json({ error: 'B站源未配置' }, 400);
      const sessdata = (bilibiliSource.config as any)?.sessdata || '';
      if (!sessdata) return c.json({ error: '未配置 SESSDATA，请先配置 B站 Cookie' }, 400);

      // 获取 updates 父节点
      const [updatesSource] = await sql`SELECT id FROM sources WHERE type = 'bilibili-updates' AND parent_id = ${bilibiliSource.id} LIMIT 1`;
      if (!updatesSource) return c.json({ error: 'B站更新源子节点未配置' }, 400);

      // 调用 bili-service 获取关注列表
      const resp = await fetch(process.env.BILI_SERVICE_URL || 'http://bili-service:8979', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'followings', sessdata }),
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) return c.json({ error: 'bili-service 调用失败' }, 502);
      const data = await resp.json() as any;
      if (!data.ok) return c.json({ error: data.error || 'bili-service 返回失败' }, 502);
      const followings = data.followings || [];
      if (followings.length === 0) return c.json({ ok: true, message: '关注列表为空', total: 0, added: 0, skipped: 0 });

      let added = 0;
      let skipped = 0;

      // 查询 PG 中已有的 mid 列表
      const existingMids = new Set<string>();
      const existingRows = await sql`SELECT config->>'mid' AS mid FROM sources WHERE type = 'bilibili-updates' AND parent_id = ${updatesSource.id}`;
      for (const row of existingRows) {
        const mid = (row as any).mid;
        if (mid) existingMids.add(mid);
      }

      // 批量插入不重复的 UP 主
      for (const f of followings) {
        if (existingMids.has(f.mid)) {
          skipped++;
          continue;
        }
        await sql`INSERT INTO sources (name, type, parent_id, config, enabled, created_at) VALUES (${f.name}, 'bilibili-updates', ${updatesSource.id}, ${sql.json({ mid: f.mid })}, false, NOW())`;
        added++;
      }

      return c.json({
        ok: true,
        total: followings.length,
        added,
        skipped,
        message: added > 0 ? `新增 ${added} 个 UP 主，已在 Admin 页面搜索启用` : '关注列表已是最新',
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });
  return router;
}

/**
 * 将秒数转换为 MM:SS 或 H:MM:SS 格式
 */
function secsToStr(secs: number): string {
  if (!secs || secs <= 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

