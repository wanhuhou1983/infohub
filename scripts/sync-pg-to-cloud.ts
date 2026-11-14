/**
 * sync-pg-to-cloud.ts
 *
 * 本地 PG → 云端 PG 增量同步脚本（本地 / 云端脱钩后两地唯一的互动通道）
 *
 * 职责边界：
 *   云端 = 文本类采集与权威数据（自行写云端 PG + COS 归档）
 *   本地 = 音视频类采集整理（写本地 PG）
 *   本脚本只负责把本地音视频类文章单向推到云端 PG 供展示，
 *   绝不能用本地的文本类旧记录覆盖云端新采集的文本数据。
 *
 * 用法：
 *   bun scripts/sync-pg-to-cloud.ts              # 增量同步（默认）
 *   bun scripts/sync-pg-to-cloud.ts --full        # 全量同步
 *   bun scripts/sync-pg-to-cloud.ts --dry-run     # 预览（不写入）
 *   bun scripts/sync-pg-to-cloud.ts --full --dry-run
 *
 * 环境变量：
 *   LOCAL_DB_URL        本地 PG 连接串（默认从 .env.json 读取）
 *   CLOUD_DB_URL        云端 PG 连接串（默认通过 SSH 隧道 localhost:15432）
 *   SYNC_ARTICLE_TYPES  逗号分隔的 sources.type 白名单。默认已收窄为本地负责的
 *                       本地负责的类型：bilibili,podcast-channel,youtube-updates,
 *                       twitter-updates,magazine 以及 rss/rss-feed/rss_news。
 *                       云端自行采集的 wechat/weibo/xueqiu/rmrb/dapenti/xwlb
 *                       绝不在白名单内，否则会覆盖云端新数据。
 *                       设为 all 时临时恢复全量同步（仅用于灾备回灌）。
 */

import postgres from 'postgres';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ========== 加载 .env 和 .env.json ==========
const __dirname = dirname(fileURLToPath(import.meta.url));
(() => {
  // 1) 先加载 .env（dotenv 格式）
  try {
    const dotenvPath = join(__dirname, '..', 'backend', '.env');
    if (existsSync(dotenvPath)) {
      const raw = readFileSync(dotenvPath, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch { /* ignore */ }
  // 2) 再加载 .env.json（JSON 格式，覆盖优先）
  try {
    const p = join(__dirname, '..', 'backend', '.env.json');
    if (existsSync(p)) {
      const envConfig = JSON.parse(readFileSync(p, 'utf-8'));
      for (const [key, value] of Object.entries(envConfig)) {
        if (typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch { /* ignore */ }
})();

// ========== 配置（不再硬编码密码，全部走环境变量） ==========
const LOCAL_DB = process.env.LOCAL_DB_URL || process.env.DATABASE_URL || '';
const CLOUD_DB = process.env.CLOUD_DB_URL || '';

if (!LOCAL_DB) {
  console.error('[sync] 缺少 LOCAL_DB_URL 或 DATABASE_URL 环境变量');
  process.exit(1);
}
if (!CLOUD_DB) {
  console.error('[sync] 缺少 CLOUD_DB_URL 环境变量');
  process.exit(1);
}

// ========== 参数解析 ==========
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const DRY_RUN = args.includes('--dry-run');
// 脱钩后本地只负责音视频，默认白名单收窄为本地专属类型。
// 云端是文本类权威源，本地文本旧记录若继续同步会经 ON CONFLICT DO UPDATE 覆盖云端新数据。
// 需要临时全量同步（如灾备回灌）时显式设置 SYNC_ARTICLE_TYPES=all。
// RSS 文本也在本地采集（/api/fetch/rss 依赖翻译与播客转录等本地能力），
// 云端采集器默认不跑 RSS，因此这些类型由本地单向同步，不会与云端写入冲突。
const DEFAULT_SYNC_TYPES = 'bilibili,podcast-channel,youtube-updates,twitter-updates,magazine,rss,rss-feed,rss_news';
const rawTypes = process.env.SYNC_ARTICLE_TYPES ?? DEFAULT_SYNC_TYPES;
const SYNC_TYPES = (rawTypes === 'all' ? '' : rawTypes)
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ========== 工具 ==========
function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg: string) {
  console.log(`[${now()}] ${msg}`);
}

function err(msg: string) {
  console.error(`[${now()}] ⚠️  ${msg}`);
}

// ========== 主流程 ==========
async function main() {
  log(`同步模式: ${FULL ? '全量' : '增量'}${DRY_RUN ? ' (预览)' : ''}`);
  log(`本地 PG: ${LOCAL_DB.replace(/\/\/.*@/, '//***@')}`);
  log(`云端 PG: ${CLOUD_DB.replace(/\/\/.*@/, '//***@')}`);

  // --- 连接两个 PG ---
  let localSql: postgres.Sql | null = null;
  let cloudSql: postgres.Sql | null = null;

  try {
    localSql = postgres(LOCAL_DB, { max: 3, idle_timeout: 30 });
    cloudSql = postgres(CLOUD_DB, { max: 3, idle_timeout: 30, connect_timeout: 10 });
  } catch (e: any) {
    err(`连接失败: ${e.message}`);
    process.exit(1);
  }

  try {
    // --- 测试连接 ---
    const [localTest] = await localSql`SELECT 1 AS ok`;
    if (!localTest?.ok) throw new Error('本地 PG 连接失败');
    log('✓ 本地 PG 连接正常');

    const [cloudTest] = await cloudSql`SELECT 1 AS ok`;
    if (!cloudTest?.ok) throw new Error('云端 PG 连接失败（SSH 隧道是否已建立？ssh -L 15432:localhost:5433 ubuntu@101.35.250.154）');
    log('✓ 云端 PG 连接正常');

    // --- 初始化 sync_state 表 ---
    await cloudSql`
      CREATE TABLE IF NOT EXISTS sync_state (
        table_name   VARCHAR(50) PRIMARY KEY,
        last_sync_at TIMESTAMP NOT NULL DEFAULT NOW(),
        rows_synced  INT DEFAULT 0,
        updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;
    log('✓ sync_state 表已就绪');

    // ====== 1. 同步 sources（全量 UPSERT） ======
    log('--- 同步 sources ---');
    const localSources = await localSql`
      SELECT id, name, type, icon, description, config, enabled, parent_id, last_fetch, created_at
      FROM sources ORDER BY id
    `;
    log(`  本地 sources: ${localSources.length} 条`);

    if (DRY_RUN) {
      log(`  [DRY-RUN] 将 upsert ${localSources.length} 个 sources`);
    } else {
      let sourcesDone = 0;
      for (const src of localSources) {
        await cloudSql`
          INSERT INTO sources (id, name, type, icon, description, config, enabled, parent_id, last_fetch, created_at)
          VALUES (${src.id}, ${src.name}, ${src.type}, ${src.icon || ''}, ${src.description || null},
                  ${cloudSql.json(src.config || {})}, ${src.enabled !== false}, ${src.parent_id || null},
                  ${src.last_fetch || null}, ${src.created_at || new Date()})
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            type = EXCLUDED.type,
            icon = EXCLUDED.icon,
            description = EXCLUDED.description,
            config = EXCLUDED.config,
            enabled = EXCLUDED.enabled,
            parent_id = EXCLUDED.parent_id,
            last_fetch = EXCLUDED.last_fetch
        `;
        sourcesDone++;
      }
      log(`  ✓ sources: ${sourcesDone} 条已同步`);

      // 更新 sync_state
      await cloudSql`
        INSERT INTO sync_state (table_name, last_sync_at, rows_synced, updated_at)
        VALUES ('sources', NOW(), ${sourcesDone}, NOW())
        ON CONFLICT (table_name) DO UPDATE SET
          last_sync_at = NOW(), rows_synced = ${sourcesDone}, updated_at = NOW()
      `;
    }

    // ====== 2. 同步 articles（增量或全量 UPSERT） ======
    log('--- 同步 articles ---');

    // 查询上次同步时间
    let lastSync: Date | null = null;
    if (!FULL) {
      const [state] = await cloudSql`
        SELECT last_sync_at FROM sync_state WHERE table_name = 'articles'
      `;
      if (state?.last_sync_at) {
        lastSync = new Date(state.last_sync_at);
        log(`  上次同步: ${lastSync.toISOString()}`);
      } else {
        log('  首次同步，将执行全量');
      }
    }

    // 查询本地增量/全量文章
    // 增量条件：fetched_at > lastSync OR translated_at > lastSync（捕获后处理更新）
    let localArticles: any[];
    if (FULL || !lastSync) {
      const [count] = await localSql`SELECT COUNT(*)::int AS c FROM articles`;
      log(`  本地 articles 总数: ${count.c}`);
      localArticles = await localSql`
        SELECT source_id, title, content, summary, url, author, published_at, fetched_at,
               category, tags, extra, content_hash,
               is_read, is_starred, is_watch_later, translated_at, external_id
        FROM articles ORDER BY id
      `;
    } else {
      const [count] = await localSql`
        SELECT COUNT(*)::int AS c FROM articles
        WHERE fetched_at > ${lastSync} OR (translated_at IS NOT NULL AND translated_at > ${lastSync})
      `;
      log(`  增量 articles: ${count.c} 条 (fetched_at 或 translated_at > lastSync)`);
      localArticles = await localSql`
        SELECT source_id, title, content, summary, url, author, published_at, fetched_at,
               category, tags, extra, content_hash,
               is_read, is_starred, is_watch_later, translated_at, external_id
        FROM articles
        WHERE fetched_at > ${lastSync} OR (translated_at IS NOT NULL AND translated_at > ${lastSync})
        ORDER BY id
      `;
    }

    // 脱钩保护：只推本地负责的音视频/导入类来源，避免覆盖云端文本权威数据。
    // sources 已在第 2 步全量同步，此处用本地 sources.type 判定归属。
    if (SYNC_TYPES.length > 0) {
      const localSources = await localSql`SELECT id, type FROM sources`;
      const allowedIds = new Set<number>(
        localSources
          .filter((s: any) => SYNC_TYPES.includes(String(s.type || '').toLowerCase()))
          .map((s: any) => Number(s.id))
      );
      const before = localArticles.length;
      localArticles = localArticles.filter((a: any) => allowedIds.has(Number(a.source_id)));
      log(`  来源类型过滤 [${SYNC_TYPES.join(',')}]: ${before} -> ${localArticles.length} 条`);
    }

    log(`  待同步 articles: ${localArticles.length} 条`);

    if (DRY_RUN) {
      log(`  [DRY-RUN] 将 upsert ${localArticles.length} 篇文章`);
      if (localArticles.length > 0) {
        log(`  示例: ${localArticles[0].title?.slice(0, 60)}...`);
      }
    } else {
      let articlesDone = 0;
      const batchSize = 100;
      const totalBatches = Math.ceil(localArticles.length / batchSize);

      for (let i = 0; i < localArticles.length; i += batchSize) {
        const batch = localArticles.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        // 逐条 upsert
        for (const art of batch) {
          if (!art.content_hash) continue;
          try {
            await cloudSql`
              INSERT INTO articles (source_id, title, content, summary, url, author,
                published_at, fetched_at, category, tags, extra, content_hash,
                is_read, is_starred, is_watch_later, translated_at, external_id)
              VALUES (${art.source_id}, ${art.title}, ${art.content || null}, ${art.summary || null},
                ${art.url || null}, ${art.author || null}, ${art.published_at || null},
                ${art.fetched_at || null}, ${art.category || null}, ${art.tags || '{}'},
                ${cloudSql.json(art.extra || {})}, ${art.content_hash},
                ${art.is_read || false}, ${art.is_starred || false}, ${art.is_watch_later || false},
                ${art.translated_at || null}, ${art.external_id || null})
              ON CONFLICT (content_hash) DO UPDATE SET
                title = EXCLUDED.title,
                content = EXCLUDED.content,
                summary = EXCLUDED.summary,
                url = EXCLUDED.url,
                author = EXCLUDED.author,
                published_at = EXCLUDED.published_at,
                fetched_at = COALESCE(EXCLUDED.fetched_at, articles.fetched_at),
                category = EXCLUDED.category,
                tags = EXCLUDED.tags,
                extra = EXCLUDED.extra,
                is_read = EXCLUDED.is_read,
                is_starred = EXCLUDED.is_starred,
                is_watch_later = EXCLUDED.is_watch_later,
                translated_at = EXCLUDED.translated_at,
                external_id = EXCLUDED.external_id
            `;
            articlesDone++;
          } catch (e: any) {
            err(`  文章 ${art.content_hash.slice(0, 8)}... 同步失败: ${e.message}`);
          }
        }

        log(`  [${batchNum}/${totalBatches}] articles 进度: ${articlesDone}/${localArticles.length}`);
      }

      log(`  ✓ articles: ${articlesDone} 条已同步`);

      // 更新 sync_state
      await cloudSql`
        INSERT INTO sync_state (table_name, last_sync_at, rows_synced, updated_at)
        VALUES ('articles', NOW(), ${articlesDone}, NOW())
        ON CONFLICT (table_name) DO UPDATE SET
          last_sync_at = NOW(), rows_synced = ${articlesDone}, updated_at = NOW()
      `;
    }

    // ====== 3. 验证 ======
    if (!DRY_RUN) {
      const [cloudStats] = await cloudSql`
        SELECT 
          (SELECT COUNT(*) FROM sources) AS sources,
          (SELECT COUNT(*) FROM articles) AS articles,
          (SELECT MAX(fetched_at) FROM articles) AS latest
      `;
      log('--- 云端数据统计 ---');
      log(`  sources: ${cloudStats.sources}`);
      log(`  articles: ${cloudStats.articles}`);
      log(`  最新文章: ${cloudStats.latest || '无'}`);
    }

    log('✓ 同步完成');
  } catch (e: any) {
    err(`同步失败: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await localSql?.end();
    await cloudSql?.end();
  }
}

main();
