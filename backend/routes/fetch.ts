/**
 * 采集路由（新闻联播 + RSS）
 * 
 * 修复：
 * - 错误处理：使用 PostgreSQL 错误码 23505 识别唯一键冲突
 * - RSS N+1 查询：批量预查 source name
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../file-storage.js';
import { parseXWLBListHtml, cleanHtmlToText } from '../services/parser.js';
import { classifyByTitle, classifyByFeed, extractTags, extractXWLBTags } from '../services/classifier.js';

export function createFetchRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 新闻联播采集 ============

  router.post('/xwlb', async (c) => {
    const { date } = await c.req.json().catch(() => ({}));
    const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startMs = Date.now();

    try {
      const [xwlbSource] = await sql`SELECT id FROM sources WHERE type = 'xwlb' LIMIT 1`;
      if (!xwlbSource) return c.json({ error: '新闻联播信息源未配置' }, 400);

      const url = `https://tv.cctv.com/lm/xwlb/day/${targetDate}.shtml`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CCTV 页面返回 ${response.status}`);
      const html = await response.text();

      // 用 cheerio 解析
      const parsedArticles = parseXWLBListHtml(html, targetDate);

      let inserted = 0;
      for (const art of parsedArticles) {
        const category = classifyByTitle(art.title);
        const tags = extractXWLBTags(art.title);

        try {
          const contentHash = hashString(art.title + 'xwlb');
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
            VALUES (${xwlbSource.id}, ${art.title}, '（完整内容请查看原文）', ${art.title}, ${art.url}, ${art.publishedAt}, ${category}, ${tags}, ${contentHash}, NOW())
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          // 🐛 修复：只有真正插入才计数
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            const { processedContent } = await saveArticleFile(newId, '（完整内容请查看原文）', {
              id: newId, title: art.title, source_type: 'xwlb',
              source_name: '新闻联播', url: art.url, published_at: art.publishedAt,
              category, tags, author: null, is_read: false, is_starred: false,
            });
            if (processedContent !== '（完整内容请查看原文）') {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
            }
          }
        } catch (e: any) {
          // 使用 PostgreSQL 错误码识别唯一键冲突，而非字符串匹配
          if (e.code !== '23505') console.error('XWLB insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${xwlbSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${xwlbSource.id}, '每日采集', 'success', ${inserted}, ${`获取 ${targetDate} 文字稿成功，共 ${parsedArticles.length} 条新闻，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: parsedArticles.length, inserted, date: targetDate });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [xwlbSource] = await sql`SELECT id FROM sources WHERE type = 'xwlb' LIMIT 1`;
      if (xwlbSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${xwlbSource.id}, '每日采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ RSS 同步（Miniflux） ============

  router.post('/rss', async (c) => {
    const { feed_id, limit = 100 } = await c.req.json().catch(() => ({}));
    // 🔒 修复：limit 参数上限校验，防止超大查询
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const startMs = Date.now();

    try {
      const [rssSource] = await sql`SELECT id, config FROM sources WHERE type = 'rss' LIMIT 1`;
      if (!rssSource) return c.json({ error: 'RSS 信息源未配置' }, 400);

      const config = rssSource.config || {};
      const minifluxUrl = config.miniflux_url || process.env.MINIFLUX_URL || 'http://localhost:8084';
      const minifluxUser = config.miniflux_user || process.env.MINIFLUX_USER;
      const minifluxPass = config.miniflux_pass || process.env.MINIFLUX_PASS;

      if (!minifluxUser || !minifluxPass) {
        return c.json({ error: 'Miniflux 凭证未配置，请设置 MINIFLUX_USER 和 MINIFLUX_PASS 环境变量' }, 400);
      }

      const auth = Buffer.from(`${minifluxUser}:${minifluxPass}`).toString('base64');
      let entriesUrl = `${minifluxUrl}/v1/entries?limit=${safeLimit}&order=published_at&direction=desc`;
      if (feed_id) entriesUrl += `&feed_id=${Number(feed_id)}`;

      const response = await fetch(entriesUrl, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      if (!response.ok) throw new Error(`Miniflux API 返回 ${response.status}`);

      const data = await response.json() as any;
      const entries = data.entries || [];

      // 获取 feeds 列表
      const feedsResp = await fetch(`${minifluxUrl}/v1/feeds`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      const feeds = feedsResp.ok ? await feedsResp.json() as any[] : [];
      const feedMap = new Map<number, { title: string; feed_url: string }>();
      for (const f of feeds) {
        feedMap.set(f.id, { title: f.title, feed_url: f.feed_url });
      }

      // 为每个 Miniflux feed 创建子信息源
      const feedSourceMap = new Map<number, number>();
      const seenFeedIds = new Set<number>();
      for (const entry of entries) {
        const mfFeedId = entry.feed?.id;
        if (!mfFeedId || seenFeedIds.has(mfFeedId)) continue;
        seenFeedIds.add(mfFeedId);

        const feedInfo = feedMap.get(mfFeedId);
        const feedName = feedInfo?.title || entry.feed?.title || `RSS Feed #${mfFeedId}`;
        const feedUrl = feedInfo?.feed_url || '';

        const isWechat = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
        const isMagazine = feedUrl.includes('caixin') && !feedUrl.includes('caixinwang');  // 杂志类 RSS（排除财新网）
        let feedType = 'rss';
        let parentId = rssSource.id;

        if (isWechat) {
          feedType = 'wechat';
          parentId = (await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`)[0]?.id;
        } else if (isMagazine) {
          feedType = 'magazine';
          parentId = (await sql`SELECT id FROM sources WHERE type = 'magazine' AND parent_id IS NULL LIMIT 1`)[0]?.id;
        }

        const [existing] = await sql`
          SELECT id FROM sources WHERE type = ${feedType} AND config->>'miniflux_feed_id' = ${String(mfFeedId)}
        `;
        if (existing) {
          feedSourceMap.set(mfFeedId, existing.id);
        } else {
          const [created] = await sql`
            INSERT INTO sources (name, type, icon, config, enabled, parent_id)
            VALUES (${feedName}, ${feedType}, ${feedType === 'wechat' ? '💬' : (feedType === 'magazine' ? '🗞️' : '📡')}, ${JSON.stringify({ miniflux_feed_id: String(mfFeedId), feed_url: feedUrl })}, true, ${parentId})
            RETURNING id
          `;
          feedSourceMap.set(mfFeedId, created!.id);
        }
      }

      // 🐛 修复 N+1：批量预查所有需要的 source name
      const sourceIds = [...feedSourceMap.values()];
      const sourceRows = sourceIds.length > 0
        ? await sql`SELECT id, name FROM sources WHERE id = ANY(${sourceIds}::int[])`
        : [];
      const sourceNameMap = new Map<number, string>();
      for (const row of sourceRows) {
        sourceNameMap.set(row.id, row.name);
      }

      // 写入文章
      let inserted = 0;
      for (const entry of entries) {
        try {
          const mfFeedId = entry.feed?.id;
          const sourceId = mfFeedId ? feedSourceMap.get(mfFeedId) : rssSource.id;
          if (!sourceId) continue;

          const title = entry.title || '无标题';
          const url = entry.url || '';
          const content = cleanHtmlToText(entry.content || entry.description || '');
          const publishedAt = entry.published_at || new Date().toISOString();
          const author = entry.author || '';

          const feedTitle = entry.feed?.title || '';
          const category = classifyByFeed(feedTitle);
          const tags = extractTags(title + ' ' + content.slice(0, 200), feedTitle);

          const feedUrl = entry.feed?.feed_url || '';
          const isWechat2 = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
          const isMagazine2 = feedUrl.includes('caixin') && !feedUrl.includes('caixinwang');
          const feedType2 = isWechat2 ? 'wechat' : (isMagazine2 ? 'magazine' : 'rss');
          
          // 使用预查的 Map 取 source name，不再循环内查询
          const feedName = sourceNameMap.get(sourceId) || feedTitle;

          const contentHash = hashString(url || (title + 'rss'));
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
            VALUES (${sourceId}, ${title}, ${content}, ${content.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          // 🐛 修复：只有真正插入才计数
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            const { processedContent } = await saveArticleFile(newId, content, {
              id: newId, title, source_type: feedType2,
              source_name: feedName, url, published_at: publishedAt,
              category, tags, author, is_read: false, is_starred: false,
            });
            if (processedContent !== content) {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
            }
          }
        } catch (e: any) {
          // 使用 PostgreSQL 错误码识别唯一键冲突
          if (e.code !== '23505') console.error('RSS insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${rssSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${rssSource.id}, 'RSS同步', 'success', ${inserted}, ${`从Miniflux同步 ${entries.length} 条，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: entries.length, inserted });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [rssSource] = await sql`SELECT id FROM sources WHERE type = 'rss' LIMIT 1`;
      if (rssSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${rssSource.id}, 'RSS同步', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 微信公众号同步（复用 Miniflux） ============

  router.post('/wechat', async (c) => {
    const startMs = Date.now();

    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const minifluxUrl = config.miniflux_url || process.env.MINIFLUX_URL || 'http://localhost:8084';
      const minifluxUser = config.miniflux_user || process.env.MINIFLUX_USER;
      const minifluxPass = config.miniflux_pass || process.env.MINIFLUX_PASS;

      if (!minifluxUser || !minifluxPass) {
        return c.json({ error: 'Miniflux 凭证未配置，请设置 MINIFLUX_USER 和 MINIFLUX_PASS 环境变量' }, 400);
      }

      const auth = Buffer.from(`${minifluxUser}:${minifluxPass}`).toString('base64');

      // 获取所有 wechat 子源的 miniflux_feed_id
      const wechatFeeds = await sql`
        SELECT id, name, config->>'miniflux_feed_id' AS mf_feed_id FROM sources
        WHERE type = 'wechat' AND parent_id = ${wechatSource.id} AND config->>'miniflux_feed_id' IS NOT NULL
      `;

      if (wechatFeeds.length === 0) {
        return c.json({ ok: true, fetched: 0, inserted: 0, message: '没有公众号子源' });
      }

      // 构建 feed_id → source_id 映射
      const feedSourceMap = new Map<number, number>();
      const validFeedIds = new Set<number>();
      for (const f of wechatFeeds) {
        if (f.mf_feed_id) {
          const mfId = Number(f.mf_feed_id);
          feedSourceMap.set(mfId, f.id);
          validFeedIds.add(mfId);
        }
      }

      // 获取全部最近条目，然后只处理 wechat feed 的
      // 🔒 修复：limit 参数化，支持调用方传入（默认 200，上限 500）
      const wechatLimit = Math.min(Math.max(Number(wechatSource.config?.wechat_limit) || 200, 1), 500);
      let entriesUrl = `${minifluxUrl}/v1/entries?limit=${wechatLimit}&order=published_at&direction=desc`;

      const response = await fetch(entriesUrl, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      if (!response.ok) throw new Error(`Miniflux API 返回 ${response.status}`);

      const data = await response.json() as any;
      const allEntries = data.entries || [];

      // 过滤出 wechat feed 的条目
      const entries = allEntries.filter((e: any) => e.feed?.id && validFeedIds.has(e.feed.id));

      // 批量预查 source name
      const sourceIds = [...feedSourceMap.values()];
      const sourceRows = sourceIds.length > 0
        ? await sql`SELECT id, name FROM sources WHERE id = ANY(${sourceIds}::int[])`
        : [];
      const sourceNameMap = new Map<number, string>();
      for (const row of sourceRows) {
        sourceNameMap.set(row.id, row.name);
      }

      let inserted = 0;
      for (const entry of entries) {
        try {
          const mfFeedId = entry.feed?.id;
          const sourceId = mfFeedId ? feedSourceMap.get(mfFeedId) : null;
          if (!sourceId) continue;

          const title = entry.title || '无标题';
          const url = entry.url || '';
          const content = cleanHtmlToText(entry.content || entry.description || '');
          const publishedAt = entry.published_at || new Date().toISOString();
          const author = entry.author || '';
          const feedTitle = sourceNameMap.get(sourceId) || '';

          const category = classifyByFeed(feedTitle);
          const tags = extractTags(title + ' ' + content.slice(0, 200), feedTitle);

          const contentHash = hashString(url || (title + 'wechat'));
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
            VALUES (${sourceId}, ${title}, ${content}, ${content.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          // 🐛 修复：只有真正插入才计数
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            const { processedContent } = await saveArticleFile(newId, content, {
              id: newId, title, source_type: 'wechat',
              source_name: feedTitle, url, published_at: publishedAt,
              category, tags, author, is_read: false, is_starred: false,
            });
            if (processedContent !== content) {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
            }
          }
        } catch (e: any) {
          if (e.code !== '23505') console.error('Wechat insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${wechatSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${wechatSource.id}, '公众号同步', 'success', ${inserted}, ${`同步 ${entries.length} 条公众号文章，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: entries.length, inserted });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [wechatSource] = await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (wechatSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${wechatSource.id}, '公众号同步', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
