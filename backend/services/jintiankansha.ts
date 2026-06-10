// @ts-nocheck
/**
 * jintiankansha.me Unified Fetcher
 * 
 * Single API client for wechat/bilibili/xueqiu/weibo discovery.
 * Paginates my_columns to get all subscribed sources.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import type { Sql } from 'postgres';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ Config ============
const JTK_BASE = 'http://www.jintiankansha.me/api3';
const JTK_USER = process.env.JTK_USER || '85657238@qq.com';
const JTK_TOKEN = process.env.JTK_TOKEN || 'PxbH4Pz9Qn';
const JTK_ARTICLES_PER_COLUMN = 5;
const JTK_PAGE_SIZE = 20;

// Python crawler script path
const SCRIPT_DIR = path.resolve(__dirname, '..', '..', 'scripts');
const WX_CRAWLER = process.platform === 'win32'
  ? path.join(SCRIPT_DIR, 'jtk_crawl_wx.py')
  : path.join(SCRIPT_DIR, 'jtk_crawl_wx.py');

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
interface JtkFetchResult {
  total: number; inserted: number; skipped: number; errors: number;
}

// Source type -> PG parent category mapping
const SOURCE_MAP: Record<string, { type: string; parentId: number }> = {
  '公众号':       { type: 'wechat',   parentId: 3 },
  'B站投稿视频':  { type: 'bilibili', parentId: 4 },
  '微博':         { type: 'weibo',    parentId: 9 },
  '雪球动态':     { type: 'xueqiu',   parentId: 8 },
  '小宇宙':    { type: 'podcast-channel', parentId: 5 },
};

// ============ API Client ============
async function jtkApi(pathQuery: string): Promise<any> {
  const sep = pathQuery.includes('?') ? '&' : '?';
  const url = `${JTK_BASE}${pathQuery}${sep}token=${JTK_TOKEN}&user=${JTK_USER}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`JTK ${resp.status}: ${pathQuery}`);
  const json = await resp.json();
  return json.data;
}

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


// ============ Xyz Audio Extractor ============
async function crawlXiaoyuzhouAudio(episodeUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'scrape_xiaoyuzhou_audio.py');
    const proc = spawn(pythonExe, [scriptPath, episodeUrl], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number | null) => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result.audio_url || null);
      } catch {
        if (stderr) console.error(`[JTK] Audio py: ${stderr.slice(0,200)}`);
        resolve(null);
      }
    });
    proc.on('error', (err: Error) => {
      console.error(`[JTK] Audio spawn: ${err.message}`);
      resolve(null);
    });
  });
}





async function fetchColumnArticles(slug: string): Promise<JtkArticle[]> {
  try {
    const articles: JtkArticle[] = await jtkApi(`/query/get_topics_by_one_column?slug=${slug}&limit=${JTK_ARTICLES_PER_COLUMN}`);
    return articles || [];
  } catch (e: any) {
    console.error(`[JTK] fetch failed for ${slug}: ${e.message}`);
    return [];
  }
}

// ============ WeChat crawler via Python subprocess ============
async function crawlWechatContent(wxUrl: string): Promise<{ content: string; title: string; author: string } | null> {
  return new Promise((resolve) => {
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonExe, [WX_CRAWLER, wxUrl], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number | null) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.content && result.content.length > 0) resolve(result);
        else resolve(null);
      } catch {
        if (stderr) console.error(`[JTK] Python err: ${stderr.slice(0,200)}`);
        resolve(null);
      }
    });
    proc.on('error', (err: Error) => {
      console.error(`[JTK] Python spawn: ${err.message}`);
      resolve(null);
    });
  });
}

// ============ Process single column ============
async function fetchColumn(
  sql: Sql, col: JtkColumn, limit: number
): Promise<{ total: number; inserted: number; skipped: number }> {
  const mapping = SOURCE_MAP[col.source];
  if (!mapping) {
    console.warn(`[JTK] Unknown source type: "${col.source}" for ${col.name}`);
    return { total: 0, inserted: 0, skipped: 0 };
  }

  // Ensure child source exists
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

    const dup = await sql`SELECT id FROM articles WHERE url = ${url}`;
    if (dup.length > 0) { skipped++; continue; }

    const title = a.name || a.title || '';
    const author = a.author || '';

    let publishedAt: string | null = null;
    const pt = a.publish_time;
    if (pt && pt.length >= 14) {
      publishedAt = `${pt.slice(0,4)}-${pt.slice(4,6)}-${pt.slice(6,8)}T${pt.slice(8,10)}:${pt.slice(10,12)}:${pt.slice(12,14)}+08:00`;
    }

    let content = '';

    // WeChat: crawl full content
    if (mapping.type === 'wechat' && url.includes('mp.weixin.qq.com')) {
      try {
        const result = await crawlWechatContent(url);
        if (result) content = result.content;
      } catch (e: any) {
        console.error(`[JTK] Crawl error ${url}: ${e.message}`);
      }
    }

    const contentHash = createHash('md5').update(content || url).digest('hex');

    try {
      // Podcast: extract audio URL from xiaoyuzhou page
      let audioUrl: string | null = null;
      if (mapping.type === 'podcast-channel' && url.includes('xiaoyuzhoufm.com')) {
        audioUrl = await crawlXiaoyuzhouAudio(url);
      }

      const extra: Record<string, any> = {};
      if (a.image) extra.image = a.image;
      if (a.description) extra.description = a.description;
      if (audioUrl) extra.audio_url = audioUrl;

      await sql`
        INSERT INTO articles (source_id, title, url, author, content, content_hash, published_at, fetched_at, extra)
        VALUES (${sourceId}, ${title}, ${url}, ${author}, ${content || ''}, ${contentHash},
          ${publishedAt ? sql.unsafe(`'${publishedAt}'::timestamptz`) : null},
          NOW(), ${JSON.stringify(extra)}::jsonb)`;
      inserted++;
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
export async function fetchAllJtkSources(sql: Sql): Promise<JtkFetchResult> {
  console.log('[JTK] Fetching all columns...');
  let columns: JtkColumn[];
  try { columns = await fetchAllColumns(); }
  catch (e: any) { console.error(`[JTK] Columns: ${e.message}`); return { total:0, inserted:0, skipped:0, errors:1 }; }
  console.log(`[JTK] Got ${columns.length} columns`);

  let total = 0, inserted = 0, skipped = 0, errors = 0;
  for (const col of columns) {
    try {
      const r = await fetchColumn(sql, col, JTK_ARTICLES_PER_COLUMN);
      total += r.total; inserted += r.inserted; skipped += r.skipped;
    } catch (e: any) {
      console.error(`[JTK] ${col.name}: ${e.message}`); errors++;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[JTK] Done: ${total} fetched, ${inserted} new, ${skipped} dup, ${errors} err`);
  return { total, inserted, skipped, errors };
}
