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

// ============ Config ============
const JTK_BASE = 'http://www.jintiankansha.me/api3';
const JTK_USER = process.env.JTK_USER || '';
const JTK_TOKEN = process.env.JTK_TOKEN || '';
const JTK_ARTICLES_PER_COLUMN = 8; // 每次每个专栏最多抓 8 篇
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
const SOURCE_MAP: Record<string, { type: string; parentId: number }> = {
  '公众号':       { type: 'wechat',   parentId: 3 },
  'B站投稿视频':  { type: 'bilibili', parentId: 4 },
  '微博':         { type: 'weibo',    parentId: 9 },
  '雪球动态':     { type: 'xueqiu',   parentId: 8 },
  '小宇宙':       { type: 'podcast-channel', parentId: 5 },
};

// ============ API Client ============
async function jtkApi(pathQuery: string): Promise<any> {
  checkJtkConfig();
  const sep = pathQuery.includes('?') ? '&' : '?';
  const url = `${JTK_BASE}${pathQuery}${sep}token=${encodeURIComponent(JTK_TOKEN)}&user=${encodeURIComponent(JTK_USER)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`JTK ${resp.status}: ${pathQuery}`);
  const json = await resp.json();
  if (json.status !== 'success') {
    throw new Error(`JTK API error: ${json.data?.message || 'unknown'}`);
  }
  return json.data;
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
 */
async function fetchColumnArticles(slug: string): Promise<JtkArticle[]> {
  try {
    const articles: JtkArticle[] = await jtkApi(`/query/get_topics_by_one_column?slug=${slug}&limit=${JTK_ARTICLES_PER_COLUMN}`);
    return articles || [];
  } catch (e: any) {
    console.error(`[JTK] fetch failed for ${slug}: ${e.message}`);
    return [];
  }
}

// ============ Process single column ============
async function fetchColumn(
  sql: Sql, col: JtkColumn,
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

  const articles = await fetchColumnArticles(col.slug);
  if (articles.length === 0) return { total: 0, inserted: 0, skipped: 0 };

  let inserted = 0, skipped = 0;

  for (const a of articles) {
    const url = a.original_url || '';
    if (!url) { skipped++; continue; }

    // 用 content_hash 去重
    const contentHash = createHash('md5').update(url).digest('hex');
    const dup = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash}`;
    if (dup.length > 0) { skipped++; continue; }

    const title = a.name || a.title || '';
    const author = a.author || '';

    let publishedAt: string | null = null;
    const pt = a.publish_time;
    if (pt && pt.length >= 14) {
      publishedAt = `${pt.slice(0,4)}-${pt.slice(4,6)}-${pt.slice(6,8)}T${pt.slice(8,10)}:${pt.slice(10,12)}:${pt.slice(12,14)}+08:00`;
    }

    let content = '';
    // WeChat: 用 crawlWechatArticle 抓正文（已有四层降级含 Playwright）
    if (mapping.type === 'wechat' && url.includes('mp.weixin.qq.com')) {
      try {
        const result = await crawlWechatArticle(url);
        if (result) content = result.content;
      } catch (e: any) {
        console.error(`[JTK] Crawl error ${url}: ${e.message}`);
      }
    }
    // 其他类型：用标题+URL兜底
    if (!content) {
      content = `${title}\n\n来源：${col.name}\n链接：${url}`;
    }

    try {
      const extra: Record<string, any> = {};
      if (a.image) extra.image = a.image;
      if (a.description) extra.description = a.description;

      const result = await sql`
        INSERT INTO articles (source_id, title, url, author, content, content_hash, published_at, fetched_at, extra)
        VALUES (${sourceId}, ${title}, ${url}, ${author}, ${content || ''}, ${contentHash},
          ${publishedAt || null}::timestamptz, NOW(), ${JSON.stringify(extra)}::jsonb)
        RETURNING id`;
      const articleId = result[0]?.id;
      inserted++;

      // 调用 saveArticleFile 下载图片并替换 __IMG__ 标记
      if (articleId) {
        try {
          await saveArticleFile(articleId, content || '', {
            id: articleId, title, source_type: mapping.type, source_name: col.name,
            url, published_at: publishedAt, category: null, tags: [], author,
            is_read: false, is_starred: false,
          });
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

// ============ Main ============
/**
 * 从今天看啥 API 抓取所有专栏的最新文章。
 * 目前专注于微信公众号 (type=wechat)，其他类型已由调度器独立处理。
 */
export async function fetchAllJtkSources(sql: Sql): Promise<JtkFetchResult> {
  console.log('[JTK] Fetching all columns...');
  let columns: JtkColumn[];
  try {
    columns = await fetchAllColumns();
  } catch (e: any) {
    console.error(`[JTK] Columns: ${e.message}`);
    return { total: 0, inserted: 0, skipped: 0, errors: 1 };
  }
  console.log(`[JTK] Got ${columns.length} columns`);

  let total = 0, inserted = 0, skipped = 0, errors = 0;
  const sourceBreakdown: { source: string; count: number }[] = [];

  for (const col of columns) {
    try {
      const r = await fetchColumn(sql, col);
      total += r.total;
      inserted += r.inserted;
      skipped += r.skipped;
      if (r.inserted > 0) {
        sourceBreakdown.push({ source: col.name, count: r.inserted });
      }
    } catch (e: any) {
      console.error(`[JTK] ${col.name}: ${e.message}`);
      errors++;
    }
    // 稍等以免触发频次限制
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[JTK] Done: ${total} total, ${inserted} new, ${skipped} dup, ${errors} err`);
  return { total, inserted, skipped, errors, sourceBreakdown };
}
