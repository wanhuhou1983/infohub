// @ts-nocheck
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OB_DIR = process.env.OB_DIR || '/obsidian';

// ============ State ============
let _lastRunAt: string | null = null;
let _lastRunStatus: 'running' | 'success' | 'error' | null = null;
let _lastRunError: string | null = null;
let _isRunning = false;

// ============ Helper: call internal API ============
async function fetchApi(path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (adminToken) {
    headers['Authorization'] = `Bearer ${adminToken}`;
  }
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    return await resp.json();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ============ Types ============
interface FetchResult {
  source: string;
  success: boolean;
  inserted: number;
  fetched?: number;
  error?: string;
}

interface SourceTitles {
  wechat: Map<string, string[]>;
  bilibili: Array<{ title: string; author: string }>;
  podcast: Array<{ title: string; channel: string }>;
  youtube: Array<{ title: string; channel: string }>;
  twitter: number;
  rss: number;
}

// ============ Phase 1: Parallel Fetch ============
async function phase1ParallelFetch(sql: Sql): Promise<FetchResult[]> {
  const now = new Date();
  const todayCompact = now.toISOString().slice(0, 10).replace(/-/g, '');
  const todayDash = now.toISOString().slice(0, 10);

  const fetches: Promise<FetchResult>[] = [
    fetchApi('/fetch/rmrb', { date: todayDash })
      .then(r => ({ source: '人民日报', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error })),
    fetchApi('/fetch/xwlb', { date: todayCompact })
      .then(r => ({ source: '新闻联播', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error })),
    fetchApi('/fetch/penti', { date: todayCompact })
      .then(r => ({ source: '喷嚏图卦', success: !!r.ok, inserted: r.inserted || 0, error: r.error })),
    fetchApi('/wechat-admin/refresh')
      .then(r => ({ source: '公众号', success: !!r.ok, inserted: r.inserted || 0, error: r.error })),
    fetchApi('/bilibili-admin/refresh')
      .then(r => ({ source: 'B站', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error })),
    fetchApi('/twitter-admin/refresh')
      .then(r => ({ source: 'X/推特', success: !!r.ok, inserted: r.inserted || 0, error: r.error })),
    fetchApi('/youtube-admin/refresh')
      .then(r => ({ source: 'YouTube', success: !!r.ok, inserted: r.inserted || 0, error: r.error })),
    fetchApi('/podcast-admin/sync')
      .then(r => ({ source: '播客', success: !!r.ok, inserted: r.inserted || 0, error: r.error })),
  ];

  // RSS: query enabled sources, then fetch each
  let rssAgg: FetchResult = { source: 'RSS', success: true, inserted: 0 };
  try {
    const rssSources = await sql`
      SELECT id, name, config->>'feed_url' AS feed_url
      FROM sources
      WHERE enabled = true AND LOWER(type) IN ('rss', 'podcast-channel')
    `;
    const rssFetches = rssSources
      .filter(s => s.feed_url)
      .map(s =>
        fetchApi('/fetch/rss', { feedUrl: s.feed_url, sourceName: s.name })
          .then(r => ({ inserted: r.inserted || 0, ok: !!r.ok, error: r.error }))
      );
    const rssResults = await Promise.all(rssFetches);
    rssAgg = {
      source: 'RSS',
      success: rssResults.every(r => r.ok),
      inserted: rssResults.reduce((sum, r) => sum + r.inserted, 0),
      error: rssResults.filter(r => r.error).map((r: any) => r.error).join('; ') || undefined,
    };
  } catch (e: any) {
    rssAgg = { source: 'RSS', success: false, inserted: 0, error: e.message };
  }

  const results: FetchResult[] = [];
  const settled = await Promise.allSettled(fetches);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      results.push({ source: '(unknown)', success: false, inserted: 0, error: s.reason?.message || String(s.reason) });
    }
  }
  results.push(rssAgg);
  return results;
}

// ============ Phase 2: Query Today's Titles ============
async function queryTodayTitles(sql: Sql): Promise<SourceTitles> {
  const today = new Date().toISOString().slice(0, 10);

  const wechat = new Map<string, string[]>();
  const bilibili: Array<{ title: string; author: string }> = [];
  const podcast: Array<{ title: string; channel: string }> = [];
  const youtube: Array<{ title: string; channel: string }> = [];
  let twitter = 0;
  let rss = 0;

  try {
    // Wechat articles today
    const wcRows = await sql`
      SELECT a.title, s.name AS source_name
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND s.type = 'wechat'
      ORDER BY s.name, a.published_at
    `;
    for (const r of wcRows) {
      const list = wechat.get(r.source_name) || [];
      list.push(r.title);
      wechat.set(r.source_name, list);
    }

    // Bilibili articles today
    const biliRows = await sql`
      SELECT a.title, a.author
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND LOWER(s.type) LIKE 'bilibili%'
    `;
    for (const r of biliRows) {
      bilibili.push({ title: r.title, author: r.author || '' });
    }

    // Podcast articles today
    const podRows = await sql`
      SELECT a.title, s.name AS channel
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND s.type = 'podcast-channel'
    `;
    for (const r of podRows) {
      podcast.push({ title: r.title, channel: r.channel });
    }

    // YouTube articles today
    const ytRows = await sql`
      SELECT a.title, a.author AS channel
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND LOWER(s.type) LIKE 'youtube%'
    `;
    for (const r of ytRows) {
      youtube.push({ title: r.title, channel: r.channel || '' });
    }

    // Twitter count today
    const twRows = await sql`
      SELECT COUNT(*)::int AS cnt FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND LOWER(s.type) LIKE 'twitter%'
    `;
    twitter = twRows[0]?.cnt || 0;

    // RSS count today
    const rssRows = await sql`
      SELECT COUNT(*)::int AS cnt FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
        AND LOWER(s.type) IN ('rss', 'podcast-channel')
    `;
    rss = rssRows[0]?.cnt || 0;

  } catch (e: any) {
    console.error('[scheduler] queryTodayTitles error:', e.message);
  }

  return { wechat, bilibili, podcast, youtube, twitter, rss };
}

// ============ Phase 3: Anomaly Detection ============
async function detectAnomalies(sql: Sql): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lines: string[] = [];

  try {
    const todayCounts = await sql`
      SELECT s.name, COUNT(*)::int AS cnt
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${today}
      GROUP BY s.name
    `;
    const yesterdayCounts = await sql`
      SELECT s.name, COUNT(*)::int AS cnt
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.published_at::date = ${yesterday}
      GROUP BY s.name
    `;

    const yMap = new Map<string, number>();
    for (const r of yesterdayCounts) yMap.set(r.name, r.cnt);

    for (const t of todayCounts) {
      const yCnt = yMap.get(t.name) || 0;
      if (yCnt > 0 && t.cnt < yCnt * 0.5) {
        lines.push(`- ${t.name}: 今日${t.cnt}篇（昨日${yCnt}篇）— ⚠️ 可能源失效`);
      }
    }

    // Also check sources that had articles yesterday but zero today
    const todayNames = new Set(todayCounts.map(r => r.name));
    for (const [name, cnt] of yMap) {
      if (cnt >= 2 && !todayNames.has(name)) {
        lines.push(`- ${name}: 今日0篇（昨日${cnt}篇）— ⚠️ 可能源失效`);
      }
    }
  } catch (e: any) {
    console.error('[scheduler] detectAnomalies error:', e.message);
  }

  return lines;
}

// ============ Phase 4: Build Markdown Report ============
function buildReport(
  fetchResults: FetchResult[],
  titles: SourceTitles,
  anomalies: string[],
  todayTotal: number,
  yesterdayTotal: number,
): string {
  const todayDash = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# 📋 更新日志 ${todayDash}`);
  lines.push('');

  // 报刊杂志
  lines.push('## 报刊杂志');
  lines.push('| 信息源 | 新增 | 状态 |');
  lines.push('|--------|------|------|');
  for (const r of fetchResults) {
    if (['人民日报', '新闻联播', '喷嚏图卦'].includes(r.source)) {
      lines.push(`| ${r.source} | ${r.inserted} | ${r.success ? '✅' : '❌'} |`);
    }
  }
  lines.push('');

  // 公众号
  const wechatEntries = [...titles.wechat.entries()];
  const wechatTotal = wechatEntries.reduce((s, [, ts]) => s + ts.length, 0);
  lines.push(`## 公众号（${wechatTotal}篇）`);
  if (wechatEntries.length === 0) {
    const wcResult = fetchResults.find(r => r.source === '公众号');
    lines.push(wcResult?.success ? '无新增' : `❌ ${wcResult?.error || '采集失败'}`);
  } else {
    for (const [name, ts] of wechatEntries) {
      lines.push(`- ${name}: ${ts.map(t => `《${t}》`).join(' ')}`);
    }
  }
  lines.push('');

  // B站
  lines.push(`## B站（${titles.bilibili.length}篇）`);
  if (titles.bilibili.length === 0) {
    const biliResult = fetchResults.find(r => r.source === 'B站');
    lines.push(biliResult?.success ? '无新增' : `❌ ${biliResult?.error || '采集失败'}`);
  } else {
    for (const b of titles.bilibili) {
      lines.push(`- 【${b.title}】— ${b.author}`);
    }
  }
  lines.push('');

  // 播客
  lines.push(`## 播客（${titles.podcast.length}集）`);
  if (titles.podcast.length === 0) {
    const podResult = fetchResults.find(r => r.source === '播客');
    lines.push(podResult?.success ? '无新增' : `❌ ${podResult?.error || '采集失败'}`);
  } else {
    for (const p of titles.podcast) {
      lines.push(`- 【${p.title}】— ${p.channel}`);
    }
  }
  lines.push('');

  // Twitter
  const twResult = fetchResults.find(r => r.source === 'X/推特');
  lines.push(`## X/推特（${titles.twitter}条）`);
  if (titles.twitter > 0) {
    lines.push(`新增 ${titles.twitter} 条 ✅`);
  } else {
    lines.push(twResult?.success ? '无新增' : `❌ ${twResult?.error || '采集失败'}`);
  }
  lines.push('');

  // YouTube
  lines.push(`## YouTube（${titles.youtube.length}篇）`);
  if (titles.youtube.length === 0) {
    const ytResult = fetchResults.find(r => r.source === 'YouTube');
    lines.push(ytResult?.success ? '无新增' : `❌ ${ytResult?.error || '采集失败'}`);
  } else {
    for (const y of titles.youtube) {
      lines.push(`- 【${y.title}】— ${y.channel}`);
    }
  }
  lines.push('');

  // RSS
  const rssResult = fetchResults.find(r => r.source === 'RSS');
  lines.push(`## RSS（${titles.rss}篇）`);
  if (titles.rss > 0) {
    lines.push(`新增 ${titles.rss} 篇 ✅`);
  } else {
    lines.push(rssResult?.success ? '无新增' : `❌ ${rssResult?.error || '采集失败'}`);
  }
  lines.push('');

  // 异常检测
  lines.push('## ⚠️ 异常检测');
  if (anomalies.length === 0) {
    lines.push('- 无异常');
  } else {
    lines.push(...anomalies);
  }
  lines.push('');

  // 趋势
  lines.push('## 📊 趋势');
  const diff = todayTotal - yesterdayTotal;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  lines.push(`- 昨日总数: ${yesterdayTotal} → 今日: ${todayTotal}（${diffStr}）`);

  return lines.join('\n');
}

// ============ Main Entry Point ============
export async function runDailyFetch(sql: Sql): Promise<string> {
  if (_isRunning) {
    throw new Error('Another fetch is already running');
  }
  _isRunning = true;
  _lastRunAt = new Date().toISOString();
  _lastRunStatus = 'running';
  _lastRunError = null;

  try {
    console.log('[scheduler] === Daily fetch started ===');

    // Phase 1
    console.log('[scheduler] Phase 1: Parallel fetch...');
    const fetchResults = await phase1ParallelFetch(sql);

    // Phase 2: Query today's titles
    console.log('[scheduler] Phase 2: Query titles...');
    const titles = await queryTodayTitles(sql);

    // Phase 3: Anomaly detection
    console.log('[scheduler] Phase 3: Anomaly detection...');
    const anomalies = await detectAnomalies(sql);

    // Get today/yesterday totals
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let todayTotal = 0;
    let yesterdayTotal = 0;
    try {
      const t = await sql`SELECT COUNT(*)::int AS cnt FROM articles WHERE published_at::date = ${today}`;
      todayTotal = t[0].cnt;
      const y = await sql`SELECT COUNT(*)::int AS cnt FROM articles WHERE published_at::date = ${yesterday}`;
      yesterdayTotal = y[0].cnt;
    } catch { /* ignore */ }

    // Phase 4: Build report
    console.log('[scheduler] Phase 4: Build report...');
    const markdown = buildReport(fetchResults, titles, anomalies, todayTotal, yesterdayTotal);

    // Write to OB
    try {
      const logDir = join(OB_DIR, '更新日志');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${today}.md`);
      writeFileSync(logPath, markdown, 'utf-8');
      console.log(`[scheduler] Written daily log to ${logPath}`);
    } catch (e: any) {
      console.error(`[scheduler] Failed to write OB log: ${e.message}`);
    }

    _lastRunStatus = 'success';
    console.log('[scheduler] === Daily fetch completed ===');
    return markdown;
  } catch (e: any) {
    _lastRunStatus = 'error';
    _lastRunError = e.message;
    console.error('[scheduler] Daily fetch error:', e.message);
    throw e;
  } finally {
    _isRunning = false;
  }
}

// ============ Routes ============
export function createSchedulerRoutes(sql: Sql): Hono {
  const router = new Hono();

  // POST /run — trigger daily fetch (admin auth required)
  router.post('/run', async (c) => {
    // Basic admin auth check
    const adminToken = process.env.ADMIN_TOKEN || '';
    if (adminToken) {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: '缺少 Authorization 头' }, 401);
      }
      const token = authHeader.slice(7);
      if (token !== adminToken) {
        return c.json({ error: '管理员 Token 无效' }, 403);
      }
    }

    if (_isRunning) {
      return c.json({ error: 'Another fetch is already running', startedAt: _lastRunAt }, 409);
    }

    try {
      const markdown = await runDailyFetch(sql);
      return c.json({ ok: true, log: markdown });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // GET /status — last run info
  router.get('/status', async (c) => {
    return c.json({
      isRunning: _isRunning,
      lastRunAt: _lastRunAt,
      lastRunStatus: _lastRunStatus,
      lastRunError: _lastRunError,
    });
  });

  return router;
}
