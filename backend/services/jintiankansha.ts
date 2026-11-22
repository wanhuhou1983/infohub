// @ts-nocheck
/**
 * jintiankansha.me Unified Fetcher
 *
 * API client for WeChat public account discovery via 今天看啥 API.
 * Replaces the old WEFLOW-based approach.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { crawlWechatArticle } from './crawler.js';
import { saveArticleFile, hashString } from '../file-storage.js';
import { createConcurrencyPool } from './translate.js';

// ============ Config ============
const JTK_BASE = 'http://www.jintiankansha.me/api3';
const JTK_USER = process.env.JTK_USER || '';
const JTK_TOKEN = process.env.JTK_TOKEN || '';
const JTK_ARTICLES_PER_COLUMN = 20; // 每次每个专栏最多抓 20 篇（防止积压遗漏）
const JTK_STALENESS_THRESHOLD_HOURS = 36; // 超过此时间无新文章则触发补偿采集
const JTK_STALENESS_FETCH_COUNT = 50;     // 补偿采集时取的文章数
const JTK_PAGE_SIZE = 20;

function checkJtkConfig() {
  if (!JTK_USER || !JTK_TOKEN) {
    throw new Error('JTK_USER or JTK_TOKEN not configured — set in .env');
  }
}

// ============ Types ============
interface JtkColumn {
  slug: string;
  name: string;
  source: string;
  image?: string;
  desc?: string;
}

interface JtkArticle {
  name: string; title?: string; author: string;
  original_url: string; publish_time: string;
  image?: string; description?: string;
}

export interface JtkFetchResult {
  total: number; inserted: number; skipped: number; errors: number;
  sourceBreakdown?: { source: string; count: number }[];
}

// Source type -> PG parent category mapping
// NOTE: parentId must be looked up after DB migration (9大类 restructure)
const SOURCE_MAP: Record<string, { type: string; parentId: number }> = {
  '公众号':       { type: 'wechat',   parentId: 3 },    // 微信公众号
  'B站投稿视频':  { type: 'bilibili', parentId: 2939 }, // 哔哩哔哩
  '微博':         { type: 'weibo',    parentId: 2943 }, // 微博
  '雪球动态':     { type: 'xueqiu',   parentId: 2942 }, // 雪球
  '小宇宙':       { type: 'podcast-channel', parentId: 2941 }, // 播客
};

// ============ API Client ============
async function jtkApi(pathQuery: string, retries = 1): Promise<any> {
  checkJtkConfig();
  const sep = pathQuery.includes('?') ? '&' : '?';
  const url = `${JTK_BASE}${pathQuery}${sep}token=${encodeURIComponent(JTK_TOKEN)}&user=${encodeURIComponent(JTK_USER)}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 503 && retries > 0) {
      // JTK 限流，等 1s 后重试
      await new Promise(r => setTimeout(r, 1000));
      return jtkApi(pathQuery, retries - 1);
    }
    if (!resp.ok) throw new Error(`JTK ${resp.status}: ${pathQuery}`);
    const json = await resp.json();
    if (json.status !== 'success') {
      throw new Error(`JTK API error: ${json.data?.message || 'unknown'}`);
    }
    return json.data;
  } catch (e: any) {
    if (retries > 0 && (e.message?.includes('503') || e.name === 'TimeoutError')) {
      await new Promise(r => setTimeout(r, 1000));
      return jtkApi(pathQuery, retries - 1);
    }
    throw e;
  }
}

/**
 * 获取所有订阅专栏列表（分页）
 */
export async function fetchAllColumns(): Promise<JtkColumn[]> {
  const all: JtkColumn[] = [];
  let page = 1;
  while (true) {
    const cols: JtkColumn[] = await jtkApi(`/query/my_columns?page=${page}&limit=${JTK_PAGE_SIZE}`);
    if (!cols || cols.length === 0) break;
    all.push(...cols);
    if (cols.length < JTK_PAGE_SIZE) break;
    page++;
  }
  return all;
}

/**
 * 获取某个专栏的最近文章
 * @param slug 专栏标识
 * @param limit 取文章数，默认 JTK_ARTICLES_PER_COLUMN
 */
async function fetchColumnArticles(slug: string, limit: number = JTK_ARTICLES_PER_COLUMN): Promise<JtkArticle[]> {
  try {
    const articles: JtkArticle[] = await jtkApi(`/query/get_topics_by_one_column?slug=${slug}&limit=${limit}`);
    return articles || [];
  } catch (e: any) {
    console.error(`[JTK] fetch failed for ${slug}: ${e.message}`);
    return [];
  }
}

// ============ Process single column ============
async function fetchColumn(
  sql: Sql, col: JtkColumn, articleLimit?: number,
): Promise<{ total: number; inserted: number; skipped: number }> {
  const mapping = SOURCE_MAP[col.source];
  if (!mapping) {
    console.warn(`[JTK] Unknown source type: "${col.source}" for ${col.name}`);
    return { total: 0, inserted: 0, skipped: 0 };
  }

  // Ensure child source exists in DB
  let sourceId: number;
  const existing = await sql`SELECT id FROM sources WHERE type = ${mapping.type} AND name = ${col.name} AND parent_id = ${mapping.parentId}`;
  if (existing.length > 0) {
    sourceId = existing[0].id;
  } else {
    const ins = await sql`
      INSERT INTO sources (name, type, parent_id, icon, enabled, config)
      VALUES (${col.name}, ${mapping.type}, ${mapping.parentId}, '', true, ${JSON.stringify({ slug: col.slug, jtk_type: col.source })})
      RETURNING id`;
    sourceId = ins[0].id;
    console.log(`[JTK] Created source #${sourceId}: ${col.name} (${mapping.type})`);
  }

  const articles = await fetchColumnArticles(col.slug, articleLimit);
  if (articles.length === 0) return { total: 0, inserted: 0, skipped: 0 };

  let inserted = 0, skipped = 0;

  for (const a of articles) {
    const url = a.original_url || '';
    if (!url) { skipped++; continue; }

    // 用 content_hash 去重
    const contentHash = createHash('md5').update(url).digest('hex');
    const dup = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash}`;
    if (dup.length > 0) { skipped++; continue; }

    const title = (a.name || a.title || '').replace(/\u0000/g, '');
    const author = (a.author || '').replace(/\u0000/g, '');

    let publishedAt: string | null = null;
    const pt = a.publish_time;
    if (pt && pt.length >= 14) {
      publishedAt = `${pt.slice(0,4)}-${pt.slice(4,6)}-${pt.slice(6,8)}T${pt.slice(8,10)}:${pt.slice(10,12)}:${pt.slice(12,14)}+08:00`;
    }

    let content = '';
    // WeChat: 用 crawlWechatArticle 抓正文（已有四层降级含 Playwright）
    if (mapping.type === 'wechat' && url.includes('mp.weixin.qq.com')) {
      try {
        const crawled = await crawlWechatArticle(url);
        if (crawled) content = crawled.content;
      } catch (e: any) {
        console.error(`[JTK] Crawl error ${url}: ${e.message}`);
      }
    }
    // 其他类型：用标题+URL兜底
    if (!content) {
      content = `${title}\n\n来源：${col.name}\n链接：${url}`;
    }
    content = content.replace(/\u0000/g, '');

    try {
      const extra: Record<string, any> = {};
      if (a.image) extra.image = a.image;
      if (a.description) extra.description = a.description;

      const result = await sql`
        INSERT INTO articles (source_id, title, url, author, content, content_hash, published_at, fetched_at, extra)
        VALUES (${sourceId}, ${title}, ${url}, ${author}, ${content || ''}, ${contentHash},
          ${publishedAt ? publishedAt.replace('T',' ').slice(0,19) : null}, (NOW() AT TIME ZONE 'Asia/Shanghai'), ${JSON.stringify(extra)}::jsonb)
        RETURNING id`;
      const articleId = result[0]?.id;
      inserted++;

      // 调用 saveArticleFile 下载图片并替换 __IMG__ 标记
      if (articleId) {
        try {
          const { processedContent } = await saveArticleFile(articleId, content || '', {
            id: articleId, title, source_type: mapping.type, source_name: col.name,
            url, published_at: publishedAt, category: null, tags: [], author,
            is_read: false, is_starred: false,
          });
          // 将处理后的内容（图片已下载+URL已替换）回写到数据库
          if (processedContent && processedContent !== content) {
            try {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${articleId}`;
            } catch (ue: any) {
              console.error(`[JTK] content回写失败 ${articleId}: ${ue.message}`);
            }
          }
        } catch (e: any) {
          console.error(`[JTK] saveArticleFile failed for ${articleId}: ${e.message}`);
        }
      }
      const preview = title.length > 50 ? title.slice(0,47)+'...' : title;
      console.log(`[JTK] ${col.name}: "${preview}" (${content.length}ch)`);
    } catch (e: any) {
      console.error(`[JTK] Insert "${title}": ${e.message}`);
      skipped++;
    }
  }
  return { total: articles.length, inserted, skipped };
}

// ============ Staleness Detection ============
/**
 * 检查某个 source 是否"过期"（最近一篇文章距今超过阈值）。
 * 返回需要补偿采集的文章数，null 表示无需补偿。
 */
async function checkStaleness(sql: Sql, col: JtkColumn): Promise<number | null> {
  const mapping = SOURCE_MAP[col.source];
  if (!mapping) return null;

  const rows = await sql`
    SELECT MAX(fetched_at) as last_fetched
    FROM articles a
    JOIN sources s ON a.source_id = s.id
    WHERE s.type = ${mapping.type} AND s.name = ${col.name}
  `;
  const lastFetched = rows[0]?.last_fetched;
  if (!lastFetched) return JTK_STALENESS_FETCH_COUNT; // 从未采过，触发首次全量

  const ageMs = Date.now() - new Date(lastFetched).getTime();
  const ageHours = ageMs / 3600_000;
  if (ageHours >= JTK_STALENESS_THRESHOLD_HOURS) {
    console.log(`[JTK] Staleness: ${col.name} 上次入库 ${Math.round(ageHours)}h 前，触发补偿采集`);
    return JTK_STALENESS_FETCH_COUNT;
  }
  return null;
}

// ============ Main ============
/**
 * 从今天看啥 API 抓取所有专栏的最新文章。
 * 并发采集（最多5个专栏同时跑），并对长期未更新的专栏自动补偿。
 */
/**
 * @param allowedSources 可选，只采集指定来源类型的专栏（如 ['公众号']）。
 *   不传则采集全部专栏，保持本地全功能模式的行为。
 */
export async function fetchAllJtkSources(sql: Sql, allowedSources?: string[]): Promise<JtkFetchResult> {
  console.log('[JTK] Fetching all columns...');
  let columns: JtkColumn[];
  try {
    columns = await fetchAllColumns();
  } catch (e: any) {
    console.error(`[JTK] Columns: ${e.message}`);
    return { total: 0, inserted: 0, skipped: 0, errors: 1 };
  }
  if (allowedSources && allowedSources.length > 0) {
    columns = columns.filter(c => allowedSources.includes(c.source));
    console.log(`[JTK] 已按来源过滤: ${allowedSources.join(',')}`);
  }
  console.log(`[JTK] Got ${columns.length} columns`);

  // 先检测每个专栏是否需要 staleness 补偿
  const tasks: { col: JtkColumn; limit: number | undefined }[] = [];
  for (const col of columns) {
    let limit: number | undefined = undefined;
    try {
      const staleLimit = await checkStaleness(sql, col);
      if (staleLimit) limit = staleLimit;
    } catch {
      // staleness 检测失败不阻塞正常采集
    }
    tasks.push({ col, limit });
  }

  const staleCount = tasks.filter(t => t.limit).length;
  if (staleCount > 0) {
    console.log(`[JTK] ${staleCount} 个专栏触发补偿采集`);
  }

  // 并发采集，最多 3 个专栏同时（JTK API 对高频请求返回 503）
  const pool = createConcurrencyPool(3);
  let total = 0, inserted = 0, skipped = 0, errors = 0;
  const sourceBreakdown: { source: string; count: number }[] = [];

  const results = await Promise.allSettled(
    tasks.map(({ col, limit }) => pool(async () => {
      const r = await fetchColumn(sql, col, limit);
      // 每个专栏之间留 300ms 间隔，降低 JTK 503 概率
      await new Promise(resolve => setTimeout(resolve, 300));
      return r;
    }))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      total += r.value.total;
      inserted += r.value.inserted;
      skipped += r.value.skipped;
      if (r.value.inserted > 0) {
        sourceBreakdown.push({ source: tasks[i].col.name, count: r.value.inserted });
      }
    } else {
      console.error(`[JTK] ${tasks[i].col.name}: ${r.reason?.message || r.reason}`);
      errors++;
    }
  }

  console.log(`[JTK] Done: ${total} total, ${inserted} new, ${skipped} dup, ${errors} err`);
  return { total, inserted, skipped, errors, sourceBreakdown };
}
