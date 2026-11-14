// @ts-nocheck
/**
 * 云端文本类采集器（COLLECTOR_MODE=true 时启用）
 *
 * === 本地 / 云端脱钩后的职责边界 ===
 * 云端：只跑文本类源，直接写云端 PG，是文本数据的权威源；原文额外归档到 COS。
 * 本地：只跑音视频类源，写本地 PG，经 scripts/sync-pg-to-cloud.ts 单向同步到云端 PG。
 * 两地唯一互动：PG 同步。云端不再通过 Tailscale 回源 Mac 取图片。
 *
 * 本采集器刻意不复用 runDailyFetch：
 *  - 不跑 Phase2（翻译 / 转录 / 字幕，属本地音视频后处理）
 *  - 不写 Obsidian（由 OB_WRITE_ENABLED=false 控制）
 *  - 不触发 pushToCloud（云端自身就是同步终点）
 *
 * 采集仍走 /api/fetch/* HTTP 路由以复用成熟的抓取与入库逻辑，
 * 请求带 X-Internal-Fetch 头，由 index.ts 的 cloudGuard 回环旁路放行。
 */
import type { Sql } from 'postgres';
import { fetchAllJtkSources } from './jintiankansha.js';
import { archiveArticles, type ArchiveEntry } from '../storage/cos-archive.js';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api';
const INTERNAL_TOKEN = process.env.INTERNAL_FETCH_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// 云端负责的文本类来源类型（COS 归档白名单）。
// 实测本地 sources.type 分布：rss_news(12.1w) / rss-feed / wechat / weibo / xueqiu /
// rmrb / dapenti / xwlb 为文本；bilibili / podcast-channel / youtube-updates /
// twitter-updates 为音视频，由本地采集后经 PG 同步到云端展示，不在此归档。
const CLOUD_TEXT_TYPES = new Set([
  'rss', 'rss-feed', 'rss_news', 'wechat', 'weibo', 'xueqiu',
  'rmrb', 'dapenti', 'xwlb', 'magazine', 'news', 'web', 'aggregation', 'import',
]);

export interface CloudSourceResult {
  source: string;
  ok: boolean;
  inserted: number;
  error?: string;
}

export interface CloudFetchReport {
  startedAt: string;
  hourBj: number;
  sources: CloudSourceResult[];
  archived: { uploaded: number; failed: number; skipped: number; candidates: number };
}

/** 北京时间字段，不依赖容器 TZ */
function bjParts(offsetMs = 0) {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetMs);
  const dash = d.toISOString().slice(0, 10);
  return { hour: d.getUTCHours(), dash, compact: dash.replace(/-/g, '') };
}

/** 距下一次北京时间 HH:10 的毫秒数 */
function msUntilNextRun(): number {
  const nowBj = Date.now() + 8 * 3600_000;
  const d = new Date(nowBj);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 10, 0, 0);
  let delta = target - nowBj;
  if (delta <= 0) delta += 3600_000;
  return delta;
}

async function fetchApi(path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ADMIN_TOKEN) headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`;
  if (INTERNAL_TOKEN) headers['X-Internal-Fetch'] = INTERNAL_TOKEN;
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

let _running = false;

/** 跑一轮文本类采集 */
export async function runCloudTextFetch(sql: Sql): Promise<CloudFetchReport> {
  if (_running) throw new Error('cloud text fetch is already running');
  _running = true;
  const startedAt = new Date();
  try {
  const today = bjParts();
  const yesterday = bjParts(-86400_000);
  const sources: CloudSourceResult[] = [];
  const tasks: Promise<void>[] = [];

  // 人民日报：10 点后出当天版面，无新增则回退昨天
  if (today.hour >= 10) {
    tasks.push((async () => {
      let r = await fetchApi('/fetch/rmrb', { date: today.dash });
      if (!r.inserted) r = await fetchApi('/fetch/rmrb', { date: yesterday.dash });
      sources.push({ source: '人民日报', ok: !!r.ok, inserted: r.inserted || 0, error: r.error });
    })());
  }

  // 新闻联播：21 点后出当天完整文字稿
  if (today.hour >= 21) {
    tasks.push((async () => {
      let r = await fetchApi('/fetch/xwlb', { date: today.compact });
      if (!r.inserted) r = await fetchApi('/fetch/xwlb', { date: yesterday.compact });
      sources.push({ source: '新闻联播', ok: !!r.ok, inserted: r.inserted || 0, error: r.error });
    })());
  }

  // 喷嚏图卦：18 点后更新
  if (today.hour >= 18) {
    tasks.push((async () => {
      let r = await fetchApi('/fetch/penti', { date: today.compact });
      if (!r.inserted) r = await fetchApi('/fetch/penti', { date: yesterday.compact });
      sources.push({ source: '喷嚏图卦', ok: !!r.ok, inserted: r.inserted || 0, error: r.error });
    })());
  }

  // 今天看啥 API：云端只采文本类专栏（公众号/微博/雪球动态），
  // B站投稿与小宇宙播客仍归本地音视频链路。
  tasks.push((async () => {
    try {
      const r = await fetchAllJtkSources(sql, ['公众号', '微博', '雪球动态']);
      sources.push({
        source: '公众号(JTK)', ok: r.errors === 0, inserted: r.inserted,
        error: r.errors > 0 ? `${r.errors} columns failed` : undefined,
      });
    } catch (e: any) {
      sources.push({ source: '公众号(JTK)', ok: false, inserted: 0, error: e.message });
    }
  })());

  // RSS 文本源（播客频道 podcast-channel 仍归本地）
  if (process.env.CLOUD_RSS_ENABLED !== 'false') {
    tasks.push((async () => {
      try {
        const feeds = await sql`
          SELECT id, name, config->>'feed_url' AS feed_url
          FROM sources
          WHERE enabled = true AND LOWER(type) IN ('rss', 'rss-feed', 'rss_news')
        `;
        let inserted = 0, errors = 0;
        for (const f of feeds) {
          if (!f.feed_url) continue;
          const r = await fetchApi('/fetch/rss', { feedUrl: f.feed_url, sourceName: f.name });
          inserted += r.inserted || 0;
          if (!r.ok) errors++;
        }
        sources.push({
          source: 'RSS', ok: errors === 0, inserted,
          error: errors > 0 ? `${errors} feeds failed` : undefined,
        });
      } catch (e: any) {
        sources.push({ source: 'RSS', ok: false, inserted: 0, error: e.message });
      }
    })());
  }

  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    if (s.status === 'rejected') {
      sources.push({ source: '(unknown)', ok: false, inserted: 0, error: s.reason?.message || String(s.reason) });
    }
  }

  // 本轮新增文章归档到 COS。
  // 用数据库侧 NOW() 比较，避开 timestamp without time zone 与 JS Date 的时区错位；
  // 归档 key 由 content_hash 决定，重复归档幂等。
  let archived = { uploaded: 0, failed: 0, skipped: 0, candidates: 0 };
  try {
    const rows = await sql`
      SELECT a.id, a.source_id, a.title, a.content, a.summary, a.url, a.author,
             a.published_at, a.fetched_at, a.category, a.tags, a.extra, a.content_hash,
             s.name AS source_name, s.type AS source_type
      FROM articles a LEFT JOIN sources s ON s.id = a.source_id
      WHERE a.fetched_at >= (NOW() - INTERVAL '1 hour')
      ORDER BY a.id
    `;
    const textRows = rows.filter((r: any) => CLOUD_TEXT_TYPES.has(String(r.source_type || '').toLowerCase()));
    const result = await archiveArticles(textRows as ArchiveEntry[]);
    archived = {
      uploaded: result.uploaded, failed: result.failed, skipped: result.skipped,
      candidates: textRows.length,
    };
    console.log(`[cloud-collector] COS 归档 ${result.uploaded}/${textRows.length} 篇（跳过非文本类 ${rows.length - textRows.length} 篇）`);
  } catch (e: any) {
    console.error(`[cloud-collector] COS 归档失败: ${e.message}`);
  }

  // 采集日志
  try {
    for (const s of sources) {
      await sql`
        INSERT INTO fetch_logs (action, status, articles_count, detail, started_at, duration_ms)
        VALUES ('cloud_text_fetch', ${s.ok ? 'success' : 'error'}, ${s.inserted},
                ${(s.error || 'ok').slice(0, 500)}, ${startedAt.toISOString()},
                ${Date.now() - startedAt.getTime()})
      `;
    }
  } catch (e: any) {
    console.error(`[cloud-collector] 写 fetch_logs 失败: ${e.message}`);
  }

    return {
      startedAt: startedAt.toISOString(),
      hourBj: today.hour,
      sources,
      archived,
    };
  } finally {
    _running = false;
  }
}

/** 启动云端每小时调度（北京时间 HH:10） */
export function startCloudCollector(sql: Sql): void {
  const schedule = () => {
    const delay = msUntilNextRun();
    console.log(`[cloud-collector] 下次采集约 ${Math.round(delay / 60000)} 分钟后`);
    setTimeout(async () => {
      try {
        const report = await runCloudTextFetch(sql);
        const detail = report.sources.map(s => `${s.source}×${s.inserted}`).join(' ');
        console.log(`[cloud-collector] 本轮完成 | ${detail} | COS ${report.archived.uploaded}`);
      } catch (e: any) {
        console.error(`[cloud-collector] 本轮失败: ${e.message}`);
      }
      schedule();
    }, delay);
  };

  schedule();
  // 启动 30s 后补跑一次，覆盖容器重启期间的遗漏；content_hash 去重保证幂等
  setTimeout(() => {
    runCloudTextFetch(sql).catch(e => console.error(`[cloud-collector] 启动补采失败: ${e.message}`));
  }, 30_000);
}
