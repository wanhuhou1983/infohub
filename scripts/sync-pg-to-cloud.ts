/**
 * sync-pg-to-cloud.ts
 * 
 * 本地 PG → 云端 PG 增量同步脚本
 * 通过 SSH 隧道直连云端 PG，高效同步 sources + articles
 * 
 * 用法：
 *   bun scripts/sync-pg-to-cloud.ts              # 增量同步（默认）
 *   bun scripts/sync-pg-to-cloud.ts --full        # 全量同步
 *   bun scripts/sync-pg-to-cloud.ts --dry-run     # 预览（不写入）
 *   bun scripts/sync-pg-to-cloud.ts --full --dry-run
 * 
 * 环境变量：
 *   LOCAL_DB_URL   本地 PG 连接串（默认从 .env.json 读取）
 *   CLOUD_DB_URL   云端 PG 连接串（默认通过 SSH 隧道 localhost:15432）
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
