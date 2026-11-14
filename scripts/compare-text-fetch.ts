// @ts-nocheck
/**
 * compare-text-fetch.ts
 *
 * 双跑灰度比对：本地 PG vs 云端 PG 的文本类采集结果（纯只读，不写任何数据）。
 *
 * 切换判据：云端采集器跑起来后，按 source type 比对条数、正文平均长度、
 * 短正文（<200 字，通常意味着抓取降级）数量，以及 content_hash 差集。
 * 两者接近即可停掉本地文本采集；「仅云端」多出来的通常是云端直连成功的补采。
 *
 * 用法（必须在 backend/ 下执行，才能解析到 node_modules）：
 *   cd backend && bun run ../scripts/compare-text-fetch.ts
 *   cd backend && bun run ../scripts/compare-text-fetch.ts --days=3
 *
 * 环境变量同 sync-pg-to-cloud.ts：LOCAL_DB_URL / CLOUD_DB_URL（SSH 隧道 15432）。
 */
import postgres from 'postgres';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
(() => {
  try {
    const p = join(__dirname, '..', 'backend', '.env');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 0) continue;
        const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim();
        if (k && !process.env[k]) process.env[k] = v;
      }
    }
  } catch { /* ignore */ }
  try {
    const p = join(__dirname, '..', 'backend', '.env.json');
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf-8'));
      for (const [k, v] of Object.entries(cfg)) {
        if (typeof v === 'string' && !process.env[k]) process.env[k] = v;
      }
    }
  } catch { /* ignore */ }
})();

const LOCAL_DB = process.env.LOCAL_DB_URL || process.env.DATABASE_URL || '';
const CLOUD_DB = process.env.CLOUD_DB_URL || '';
if (!LOCAL_DB || !CLOUD_DB) {
  console.error('缺少 LOCAL_DB_URL / DATABASE_URL 或 CLOUD_DB_URL');
  process.exit(1);
}

const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS = Math.max(1, Math.min(30, Number(daysArg?.split('=')[1] || 1) || 1));

// 与 cloud-collector.ts 的 CLOUD_TEXT_TYPES 保持一致
const TEXT_TYPES = [
  'rss', 'rss-feed', 'rss_news', 'wechat', 'weibo', 'xueqiu',
  'rmrb', 'dapenti', 'xwlb', 'magazine', 'news', 'web', 'aggregation', 'import',
];

const INTERVAL = `${DAYS} days`;

async function collect(sql: any) {
  const rows = await sql`
    SELECT COALESCE(s.type, '(unknown)') AS type,
           count(*)::int AS n,
           count(*) FILTER (WHERE a.content IS NULL OR length(a.content) < 200)::int AS short_content,
           COALESCE(round(avg(length(a.content)))::int, 0) AS avg_len
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.fetched_at >= (NOW() - ${INTERVAL}::interval)
      AND LOWER(COALESCE(s.type, '')) = ANY(${TEXT_TYPES})
    GROUP BY 1 ORDER BY n DESC
  `;
  const hashes = await sql`
    SELECT a.content_hash
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.fetched_at >= (NOW() - ${INTERVAL}::interval)
      AND LOWER(COALESCE(s.type, '')) = ANY(${TEXT_TYPES})
  `;
  return {
    byType: new Map(rows.map((r: any) => [r.type, r])),
    hashes: new Set<string>(hashes.map((h: any) => h.content_hash)),
  };
}

const local = postgres(LOCAL_DB, { max: 2 });
const cloud = postgres(CLOUD_DB, { max: 2, connect_timeout: 10 });

try {
  const [l, c] = await Promise.all([collect(local), collect(cloud)]);
  const types = [...new Set([...l.byType.keys(), ...c.byType.keys()])].sort();

  console.log(`\n=== 最近 ${DAYS} 天文本类采集比对（本地 vs 云端）===`);
  console.log(
    '类型'.padEnd(18) + '本地'.padStart(8) + '云端'.padStart(8) + '差值'.padStart(8) +
    '本地均长'.padStart(11) + '云端均长'.padStart(11) + '云端短正文'.padStart(13)
  );
  console.log('-'.repeat(77));
  for (const t of types) {
    const a: any = l.byType.get(t) || { n: 0, avg_len: 0, short_content: 0 };
    const b: any = c.byType.get(t) || { n: 0, avg_len: 0, short_content: 0 };
    console.log(
      String(t).padEnd(18) + String(a.n).padStart(8) + String(b.n).padStart(8) +
      String(b.n - a.n).padStart(8) + String(a.avg_len).padStart(11) +
      String(b.avg_len).padStart(11) + String(b.short_content).padStart(13)
    );
  }

  const onlyLocal = [...l.hashes].filter(h => !c.hashes.has(h));
  const onlyCloud = [...c.hashes].filter(h => !l.hashes.has(h));
  const shared = [...l.hashes].filter(h => c.hashes.has(h)).length;

  console.log('-'.repeat(77));
  console.log(`content_hash 交集 ${shared} | 仅本地 ${onlyLocal.length} | 仅云端 ${onlyCloud.length}`);
  if (onlyLocal.length) console.log(`仅本地示例: ${onlyLocal.slice(0, 3).join(', ')}`);
  if (onlyCloud.length) console.log(`仅云端示例: ${onlyCloud.slice(0, 3).join(', ')}`);
  console.log('\n判据说明：短正文(<200字)只对长文源有意义 —— rmrb / dapenti / xwlb / wechat / rss-feed / magazine。');
  console.log('rss_news、weibo 本身多为摘要或短动态，短正文属正常，不应据此判定抓取降级。');
  console.log('若长文源在云端短正文明显偏高，先检查 wechat-service 是否可用（微信正文四层降级）。\n');
} catch (e: any) {
  console.error('比对失败:', e.message);
  process.exitCode = 1;
} finally {
  await local.end();
  await cloud.end();
}
