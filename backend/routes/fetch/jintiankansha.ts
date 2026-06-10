// @ts-nocheck
/**
 * 「今天看啥」采集路由
 *
 * 通过 jintiankansha.me API 获取订阅专栏的 RSS 内容
 * 支持来源：公众号、小宇宙(播客)、微博、B站、雪球
 *
 * API:
 *   1. GET /api3/query/my_columns?page=N&user=&token=  → 获取订阅专栏列表
 *   2. GET /api3/query/column/rss?user=&token=&slug=    → 获取专栏 RSS 链接
 *   3. RSS 链接 → 标准 RSS/Atom 解析 → 入库
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import RssParser from 'rss-parser';
import { saveArticleFile, hashString, processImages } from '../../file-storage.js';
import { cleanHtmlToText } from '../../services/parser.js';
import { classifyByFeed, extractTags } from '../../services/classifier.js';
import { isEnglish, translateTitle, translateToChinese, createConcurrencyPool } from '../../services/translate.js';
import { crawlArticleContent, crawlWechatArticle } from '../../services/crawler.js';

// ============ API 配置 ============
const JTKS_API_BASE = 'http://www.jintiankansha.me/api3/query';
const JTKS_USER = '85657238@qq.com';
const JTKS_TOKEN = 'PxbH4Pz9Qn';

interface Column {
  source: string;
  name: string;
  slug: string;
  desc: string;
  image: string;
}

interface FetchResult {
  source: string;
  slug: string;
  name: string;
  fetched: number;
  inserted: number;
  translated: number;
  error?: string;
}

// ============ API 调用函数 ============

/** 获取所有订阅专栏 */
async function getSubscribedColumns(): Promise<Column[]> {
  const allColumns: Column[] = [];
  let page = 1;

  while (true) {
    const url = `${JTKS_API_BASE}/my_columns?page=${page}&token=${JTKS_TOKEN}&user=${JTKS_USER}`;
    console.log(`[JTKS] 获取专栏列表 page=${page}...`);

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json() as any;

    if (data.status !== 'success' || !Array.isArray(data.data) || data.data.length === 0) {
      break;
    }

    allColumns.push(...data.data.map((c: any) => ({
      source: c.source || '',
      name: c.name || '',
      slug: c.slug || '',
      desc: c.desc || '',
      image: c.image || '',
    })));

    page++;
  }

  console.log(`[JTKS] 共获取 ${allColumns.length} 个专栏`);
  return allColumns;
}

/** 获取专栏的 RSS 链接 */
async function getColumnRssLink(slug: string): Promise<string | null> {
  const url = `${JTKS_API_BASE}/column/rss?token=${JTKS_TOKEN}&user=${JTKS_USER}&slug=${slug}`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json() as any;

    if (data.status === 'success' && data.data?.rss_link) {
      return data.data.rss_link;
    }

    if (data.status === 'error') {
      console.warn(`[JTKS] 获取 RSS 链接失败: ${slug} - ${data.data?.message || '未知错误'}`);
    }

    return null;
  } catch (e: any) {
    console.error(`[JTKS] 获取 RSS 链接异常: ${slug} - ${e.message}`);
    return null;
  }
}

// ============ RSS 解析和入库 ============

/**
 * 解析单个 RSS feed 并入库
 * 复用与 rss.ts 相同的逻辑
 */
async function parseAndStoreRssFeed(
  sql: any,
  rssUrl: string,
  sourceId: number,
  sourceName: string,
  sourceType: string,
): Promise<{ fetched: number; inserted: number; translated: number }> {
  const rssParser = new RssParser({
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml',
    },
  });

  let feed: any;
  try {
    feed = await rssParser.parseURL(rssUrl);
  } catch (e: any) {
    try {
      const resp = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      feed = await rssParser.parseString(xml);
    } catch (e2: any) {
      console.error(`[JTKS] RSS 解析失败: ${rssUrl} - ${e2.message}`);
      return { fetched: 0, inserted: 0, translated: 0 };
    }
  }

  const items = feed?.items || [];
  if (items.length === 0) return { fetched: 0, inserted: 0, translated: 0 };

  const limit = createConcurrencyPool(3);
  let inserted = 0;
  let translated = 0;

  const results = await Promise.all(items.map((item: any) => limit(async () => {
    try {
      const title = item.title || '无标题';
      const url = item.link || item.guid || '';
      if (!url) return { inserted: false, translated: false };

      const rssContent = cleanHtmlToText(item.content || item.contentSnippet || item.summary || '');
      const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
      const author = item.creator || item.author || sourceName;

      const enclosureUrl = item.enclosure?.url || '';
      const enclosureType = item.enclosure?.type || '';
      const enclosureLength = item.enclosure?.length || '';

      const contentHash = hashString(url);

      // 全文抓取 — 微信用专用爬虫（四层降级），其他用通用 MinerU
      let fullContent = rssContent;
      if (url) {
        try {
          let fetchedContent: string | null = null;
          if (url.includes('mp.weixin.qq.com')) {
            // 微信公众号专用四层降级：Playwright → Python Spider → cheerio → og:description
            const wechatResult = await crawlWechatArticle(url);
            if (wechatResult?.content && wechatResult.content.length > 20) {
              fetchedContent = wechatResult.content;
            }
          } else {
            fetchedContent = await crawlArticleContent(url);
          }
          if (fetchedContent && fetchedContent.length > rssContent.length) {
            fullContent = fetchedContent;
          }
        } catch { /* ignore */ }
      }

      // 图片处理
      try {
        fullContent = await processImages(fullContent, 'jintiankansha');
      } catch (e: any) {
        console.error(`[JTKS] 图片处理失败: ${e.message}`);
      }

      // 翻译
      let finalTitle = title;
      let finalContent = fullContent;
      let didTranslate = false;
      const needTranslate = isEnglish(fullContent) || isEnglish(title);
      if (needTranslate) {
        try {
          if (isEnglish(title)) {
            const tTitle = await translateTitle(title);
            if (tTitle !== title) {
              finalTitle = `${tTitle} [${title}]`;
            }
          }
          if (isEnglish(fullContent)) {
            const tContent = await translateToChinese(fullContent);
            if (tContent !== fullContent) {
              finalContent = `【中文翻译】\n${tContent}\n\n---\n【English Original】\n${fullContent}`;
              didTranslate = true;
            }
          }
        } catch (e: any) {
          console.error(`[JTKS] 翻译失败: ${title.slice(0, 30)}... - ${e.message}`);
        }
      }

      const category = classifyByFeed(sourceName);
      const tags = extractTags(finalTitle + ' ' + finalContent.slice(0, 200), sourceName);

      const extraData: Record<string, any> = {};
      if (enclosureUrl) {
        extraData.audio_url = enclosureUrl;
        if (enclosureType) extraData.audio_type = enclosureType;
        if (enclosureLength) extraData.audio_length = enclosureLength;
      }

      const insertedRows = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
        VALUES (${sourceId}, ${finalTitle}, ${finalContent}, ${finalContent.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, ${sql.json(extraData)})
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      if (insertedRows.length > 0) {
        const newId = insertedRows[0]!.id;
        const { processedContent } = await saveArticleFile(newId, finalContent, {
          id: newId, title: finalTitle, source_type: sourceType,
          source_name: sourceName, url, published_at: publishedAt,
          category, tags, author, is_read: false, is_starred: false,
        });
        if (processedContent !== finalContent) {
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
        }
        return { inserted: true, translated: didTranslate };
      }

      return { inserted: false, translated: false };
    } catch (e: any) {
      if (e.code !== '23505') console.error('[JTKS] 文章入库失败:', e.message);
      return { inserted: false, translated: false };
    }
  })));

  for (const r of results) {
    if (r.inserted) inserted++;
    if (r.translated) translated++;
  }

  await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;

  return { fetched: items.length, inserted, translated };
}

/** 确保 source 存在于数据库中，不存在则自动创建 */
async function ensureSource(
  sql: any,
  name: string,
  platform: string,
  feedUrl: string,
): Promise<{ id: number; created: boolean }> {
  // 平台映射到 source type
  let sourceType = 'jintiankansha';
  if (platform === '公众号') sourceType = 'wechat';
  else if (platform === '小宇宙') sourceType = 'podcast-channel';
  else if (platform === 'B站投稿视频') sourceType = 'bilibili';
  else if (platform === '微博') sourceType = 'weibo';
  else if (platform === '雪球动态') sourceType = 'xueqiu';

  // 查找已有 source
  const [existing] = await sql`
    SELECT id FROM sources
    WHERE name = ${name} AND type = ${sourceType}
    LIMIT 1
  `;

  if (existing) {
    // 更新 feed_url（可能已变化）
    await sql`
      UPDATE sources SET config = ${sql.json({ feed_url: feedUrl })}, enabled = true
      WHERE id = ${existing.id}
    `;
    return { id: existing.id, created: false };
  }

  // 新建 source
  const [newSource] = await sql`
    INSERT INTO sources (name, type, config, enabled, last_fetch)
    VALUES (${name}, ${sourceType}, ${sql.json({ feed_url: feedUrl, platform })}, true, NULL)
    RETURNING id
  `;

  console.log(`[JTKS] 新建 source: ${name} (type=${sourceType}, id=${newSource.id})`);
  return { id: newSource.id, created: true };
}

// ============ 主采集流程 ============

async function fetchAllColumns(sql: any): Promise<FetchResult[]> {
  // 1. 获取所有订阅专栏
  const columns = await getSubscribedColumns();
  if (columns.length === 0) {
    console.warn('[JTKS] 没有获取到任何专栏');
    return [];
  }

  const results: FetchResult[] = [];

  for (const col of columns) {
    const result: FetchResult = {
      source: col.source,
      slug: col.slug,
      name: col.name,
      fetched: 0,
      inserted: 0,
      translated: 0,
    };

    try {
      // 2. 获取 RSS 链接
      const rssUrl = await getColumnRssLink(col.slug);
      if (!rssUrl) {
        result.error = '无法获取 RSS 链接';
        results.push(result);
        continue;
      }

      console.log(`[JTKS] ${col.name} (${col.source}) → RSS: ${rssUrl.slice(0, 80)}...`);

      // 3. 确保 source 存在
      const { id: sourceId, created } = await ensureSource(sql, col.name, col.source, rssUrl);

      // 4. 解析 RSS 并入库
      const { fetched, inserted, translated } = await parseAndStoreRssFeed(
        sql, rssUrl, sourceId, col.name, 'jintiankansha',
      );

      result.fetched = fetched;
      result.inserted = inserted;
      result.translated = translated;

      if (created) {
        console.log(`[JTKS] ✓ ${col.name}: ${inserted}/${fetched} 新增（新建源）`);
      } else {
        console.log(`[JTKS] ✓ ${col.name}: ${inserted}/${fetched} 新增`);
      }
    } catch (e: any) {
      result.error = e.message;
      console.error(`[JTKS] ✗ ${col.name}: ${e.message}`);
    }

    results.push(result);

    // API 限速：每列之间间隔 500ms
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return results;
}

// ============ 路由 ============

export function createJintiankanshaRoutes(sql: Sql): Hono {
  const router = new Hono();

  // POST /fetch/jintiankansha — 采集所有订阅专栏
  router.post('/jintiankansha', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const specificSlug = body?.slug || '';

      if (specificSlug) {
        // 采集单个专栏
        const rssUrl = await getColumnRssLink(specificSlug);
        if (!rssUrl) {
          return c.json({ ok: false, error: `无法获取专栏 ${specificSlug} 的 RSS 链接` }, 404);
        }

        // 需要专栏名称，从列列表查找
        const allColumns = await getSubscribedColumns();
        const col = allColumns.find(c => c.slug === specificSlug);
        const name = col?.name || specificSlug;
        const platform = col?.source || '';

        const { id: sourceId } = await ensureSource(sql, name, platform, rssUrl);
        const { fetched, inserted, translated } = await parseAndStoreRssFeed(
          sql, rssUrl, sourceId, name, 'jintiankansha',
        );

        return c.json({ ok: true, slug: specificSlug, name, fetched, inserted, translated });
      }

      // 采集全部专栏
      const results = await fetchAllColumns(sql);

      const totalFetched = results.reduce((s, r) => s + r.fetched, 0);
      const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
      const totalTranslated = results.reduce((s, r) => s + r.translated, 0);
      const errors = results.filter(r => r.error).map(r => `${r.name}: ${r.error}`);

      return c.json({
        ok: true,
        columns: results.length,
        totalFetched,
        totalInserted,
        totalTranslated,
        errors: errors.length > 0 ? errors : undefined,
        results,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // GET /fetch/jintiankansha/columns — 获取订阅专栏列表（不采集）
  router.get('/jintiankansha/columns', async (c) => {
    try {
      const columns = await getSubscribedColumns();
      return c.json({
        ok: true,
        count: columns.length,
        columns: columns.map(c => ({
          source: c.source,
          name: c.name,
          slug: c.slug,
          desc: c.desc,
        })),
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
