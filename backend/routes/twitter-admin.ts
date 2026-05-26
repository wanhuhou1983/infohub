/**
 * Twitter/X 账号管理路由
 *
 * 功能：
 * - GET   /api/twitter-admin/accounts        → 获取已添加的 X 账号列表
 * - POST  /api/twitter-admin/accounts        → 添加 X 账号
 * - DELETE /api/twitter-admin/accounts/:id   → 删除 X 账号
 * - PATCH /api/twitter-admin/accounts/:id/toggle → 切换启用/禁用
 * - POST  /api/twitter-admin/refresh         → 采集已启用账号的最新推文
 *
 * 数据来源：Nitter RSS（无需 Twitter API Key）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../file-storage.js';
import { cleanHtmlToText } from '../services/parser.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';
import RssParser from 'rss-parser';

/** VPS Worker 配置 */
const BILI_SERVICE_URL = process.env.BILI_SERVICE_URL || 'http://bili-service:8979';
const TWITTER_COOKIES = process.env.TWITTER_COOKIES || '';  // Format: "ct0=xxx; auth_token=xxx"

/** Nitter 实例列表，用于容错回退 */
const NITTER_INSTANCES = [
  'nitter.net',
  'nitter.fly.dev',
  'nitter.poast.org',
  'nitter.lonelystream.com',
  'nitter.1d4.us',
];

interface NitterItem {
  title?: string;
  link?: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
  guid?: string;
  creator?: string;
  'dc:creator'?: string;
  categories?: string[];
  enclosure?: { url?: string };
}

/** HTML 解码 */
function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * 通过 VPS Playwright 浏览器采集 x.com 推文
 */
async function fetchPlaywrightTweets(handle: string): Promise<any[]> {
  // 调用本地 bili-service 的 Playwright Twitter 采集端点
  const resp = await fetch(`${BILI_SERVICE_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'twitter',
      handle,
      max_tweets: 20,
      cookies: TWITTER_COOKIES,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!resp.ok) throw new Error(`本地 Playwright 采集返回 ${resp.status}`);

  const data: any = await resp.json();
  if (!data.ok || !data.tweets || data.tweets.length === 0) {
    throw new Error('本地 Playwright 采集无结果');
  }

  // 将采集格式转换为内部格式（与旧格式兼容）
  return data.tweets.map((t: any) => {
    const text = t.text || '';
    const statsStr = [
      t.stats?.replies ? `${t.stats.replies} replies` : '',
      t.stats?.retweets ? `${t.stats.retweets} retweets` : '',
      t.stats?.likes ? `${t.stats.likes} likes` : '',
      t.stats?.views ? `${t.stats.views} views` : '',
    ].filter(Boolean).join(' | ');

    const imgHtml = (t.images || []).map((url: string) => `<img src="${url}">`).join('\n');

    const content = [text, statsStr, imgHtml].filter(Boolean).join('\n\n');

    const tweetId = t.id || t.url?.split('/status/').pop() || '';

    return {
      title: text.slice(0, 100),
      link: t.url || `https://x.com/${handle}/status/${tweetId}`,
      pubDate: t.timestamp || new Date().toISOString(),
      content,
      contentSnippet: text.slice(0, 200),
      guid: tweetId,
    };
  });
}

/**
 * 尝试获取 Twitter 账号的推文
 * 三阶回退：Playwright 浏览器采集 → VPS Nitter RSS 代理 → 直连 Nitter
 */
async function fetchNitterFeed(handle: string): Promise<any[]> {
  const rssParser = new RssParser({
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
    customFields: {
      item: ['dc:creator'],
    },
  });

  // ── 第一阶：VPS Playwright 浏览器采集 ──
  try {
    const items = await fetchPlaywrightTweets(handle);
    if (items.length > 0) return items;
  } catch (e: any) {
    console.warn(`[Twitter] Playwright 采集失败，回退 RSS: ${e.message}`);
  }

  // ── 第二阶：VPS Worker Nitter RSS 代理 ──
  try {
    const resp = await fetch(`${BILI_SERVICE_URL}/twitter/rss/${encodeURIComponent(handle)}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (data.ok && data.xml) {
        const feed = await rssParser.parseString(data.xml);
        if (feed.items && feed.items.length > 0) {
          return feed.items;
        }
      }
    }
    console.warn(`[Twitter] VPS Worker RSS 代理无结果，回退直连: ${handle}`);
  } catch (e: any) {
    console.warn(`[Twitter] VPS Worker RSS 代理失败，回退直连: ${e.message}`);
  }

  // ── 第三阶：本地直连 Nitter ──
  let lastError: string = '';

  for (const instance of NITTER_INSTANCES) {
    const url = `https://${instance}/${handle}/rss`;
    try {
      const feed = await rssParser.parseURL(url);
      if (feed.items && feed.items.length > 0) {
        return feed.items;
      }
    } catch (e: any) {
      lastError = `${instance}: ${e.message}`;
      continue;
    }
  }

  throw new Error(`所有 Nitter 实例均失败: ${lastError}`);
}

/**
 * 通过 Nitter 推断用户显示名称
 * 优先通过 VPS Worker 代理，失败后回退到本地直连
 */
async function inferUserName(handle: string): Promise<string | null> {
  // ── 优先：VPS Worker ──
  try {
    const resp = await fetch(`${BILI_SERVICE_URL}/twitter/user-info/${encodeURIComponent(handle)}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (data.ok && data.feedTitle) {
        const match = data.feedTitle.match(/^(.+?)\s*\(@/);
        if (match) return match[1]!.trim();
      }
    }
  } catch {
    // fallback to direct
  }

  // ── 回退：直连 Nitter ──
  try {
    const rssParser = new RssParser({ timeout: 10000 });
    const feed = await rssParser.parseURL(`https://nitter.net/${handle}/rss`);
    if (feed.title) {
      const match = feed.title.match(/^(.+?)\s*\(@/);
      if (match) return match[1]!.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function createTwitterAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的 X 账号列表 ============
  router.get('/accounts', async (c) => {
    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ accounts: [], total: 0 });

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ accounts: [], total: 0 });

      const accounts = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'handle' AS handle,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_tweet_at
        FROM sources s
        WHERE s.type = 'twitter-updates' AND s.parent_id = ${updatesSource[0]!.id}
        ORDER BY s.enabled DESC, s.name ASC
      `;

      return c.json({
        accounts: accounts.map(a => ({
          id: a.id,
          name: a.name,
          handle: a.handle,
          enabled: a.enabled,
          latest_tweet_at: a.latest_tweet_at,
        })),
        total: accounts.length,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 手动添加 X 账号 ============
  router.post('/accounts', async (c) => {
    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ error: 'Twitter/X 信息源未配置' }, 400);

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ error: 'Twitter/X "更新"源未配置' }, 400);

      const body = await c.req.json();
      let { handle, name } = body;

      if (!handle) {
        return c.json({ error: '请提供 X 账号 handle（不含 @）' }, 400);
      }

      // 去掉 @ 前缀
      handle = handle.replace(/^@/, '').trim();

      // 如果没有提供名称，尝试从 Nitter 推断
      if (!name) {
        const inferred = await inferUserName(handle);
        name = inferred || `@${handle}`;
      }

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources
        WHERE type = 'twitter-updates' AND parent_id = ${updatesSource[0]!.id} AND config->>'handle' = ${handle}
      `;
      if (existing) {
        return c.json({ error: `账号 @${handle} 已存在` }, 400);
      }

      // 插入新账号（默认禁用）
      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
        VALUES (${name}, 'twitter-updates', ${updatesSource[0]!.id}, ${sql.json({ handle })}, false, NOW())
        RETURNING id, name, config
      `;

      return c.json({
        ok: true,
        account: {
          id: inserted!.id,
          name: inserted!.name,
          handle,
          enabled: false,
        },
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 删除 X 账号 ============
  router.delete('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const [deleted] = await sql`
      DELETE FROM sources WHERE id = ${id} AND type = 'twitter-updates'
      RETURNING id
    `;
    if (!deleted) return c.json({ error: '账号不存在' }, 404);

    return c.json({ ok: true });
  });

  // ============ 切换单个账号启用/禁用 ============
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

  // ============ 采集已启用账号的最新推文 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ error: 'Twitter/X 信息源未配置' }, 400);

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ error: 'Twitter/X "更新"源未配置' }, 400);

      const enabledAccounts = await sql`
        SELECT id, name, config->>'handle' AS handle
        FROM sources
        WHERE type = 'twitter-updates' AND parent_id = ${updatesSource[0]!.id} AND enabled = true
      `;

      if (enabledAccounts.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 X 账号', inserted: 0 });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const account of enabledAccounts) {
        const handle = account.handle;
        const name = account.name;

        try {
          const items = await fetchNitterFeed(handle);
          if (items.length === 0) {
            errors.push(`${name}: 无推文数据`);
            continue;
          }

          for (const item of items) {
            try {
              const rawTitle = item.title || '';
              const rawContent = item.content || item.contentSnippet || rawTitle || '';
              const guid = item.guid || item.link || '';
              const tweetId = guid.split('/').pop() || guid;
              const pubDate = item.pubDate || new Date().toISOString();

              // 清洗标题和内容
              const title = cleanHtmlToText(decodeHtml(rawTitle));
              const contentText = cleanHtmlToText(decodeHtml(rawContent));

              // 提取额外的推文信息（转发/点赞/回复数）
              let extraMeta = '';
              const statsMatch = rawContent.match(/([\d,]+)\s*(retweet|reply|like|favorite)s?/gi);
              if (statsMatch) {
                extraMeta = '\n\n' + statsMatch.join(' | ');
              }

              // 构建正文
              let fullContent = contentText;
              if (extraMeta) fullContent += extraMeta;

              // 尝试提取图片 URL（Nitter 的 description 中包含图片链接）
              const imgRegex = /<img\s+[^>]*src\s*=\s*"([^"]+)"[^>]*>/gi;
              let imgMatch;
              const imgUrls: string[] = [];
              while ((imgMatch = imgRegex.exec(rawContent)) !== null) {
                const url = imgMatch[1];
                if (url && !url.includes('/emoji/') && !url.includes('profile')) {
                  imgUrls.push(url);
                }
              }
              if (imgUrls.length > 0) {
                fullContent += '\n\n![图片](' + imgUrls[0] + ')';
              }

              // 去重 key
              const contentHash = hashString('twitter_' + tweetId);
              const tweetUrl = `https://x.com/${handle}/status/${tweetId}`;

              // 检查是否已存在
              const [existing] = await sql`
                SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1
              `;
              if (existing) {
                totalFetched++;
                continue;
              }

              const category = classifyByFeed(name);
              const tags = extractTags(title + ' ' + contentText.slice(0, 200), name);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${account.id}, ${title.slice(0, 500)}, ${fullContent.slice(0, 10000)}, ${title.slice(0, 200)}, ${tweetUrl}, ${pubDate}, ${category}, ${tags}, ${contentHash}, NOW(), ${name})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, fullContent, {
                  id: newId,
                  title,
                  source_type: 'twitter-updates',
                  source_name: name,
                  url: tweetUrl,
                  published_at: pubDate,
                  category,
                  tags,
                  author: name,
                  is_read: false,
                  is_starred: false,
                });
              }
              totalFetched++;
            } catch (e: any) {
              if (e.code !== '23505') {
                errors.push(`${name}(推文): ${e.message}`);
              }
            }
          }
        } catch (e: any) {
          errors.push(`${name}: ${e.message}`);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${twitterSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${twitterSource.id}, 'X账号推文采集', 'success', ${inserted},
          ${`已启用 ${enabledAccounts.length} 个账号，获取 ${totalFetched} 条推文，入库 ${inserted} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
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
      const [twitterSource] = await sql`SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1`;
      if (twitterSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${twitterSource.id}, 'X账号推文采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
