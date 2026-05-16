/**
 * 本地→云端数据同步脚本
 * 
 * 方案A：本地直连云端 PG，推送增量数据
 * 
 * 用法：
 *   bun run scripts/cloud-push.ts                  # 推送最近 8 天数据
 *   SYNC_DAYS=3 bun run scripts/cloud-push.ts      # 推送最近 3 天
 * 
 * 环境变量（在 .env.json 或环境变量中配置）：
 *   DATABASE_URL        — 本地 PG 连接串（已有）
 *   CLOUD_DATABASE_URL  — 云端 PG 连接串（新增，必填）
 *   SYNC_DAYS           — 推送最近 N 天数据（默认 8，保证 7 天覆盖）
 * 
 * 流程：
 *   1. 读本地 PG：最近 N 天的 articles + 所有 sources
 *   2. 写云端 PG：UPSERT articles + sources
 *   3. 云端清理：DELETE fetched_at < 7天前
 */

import 'dotenv/config';
import postgres from 'postgres';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载 .env.json
try {
  const envJsonPath = join(__dirname, '..', '..', '.env.json');
  if (existsSync(envJsonPath)) {
    const envConfig = JSON.parse(readFileSync(envJsonPath, 'utf-8'));
    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === 'string' && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch { /* ignore */ }

const LOCAL_DB_URL = process.env.DATABASE_URL!;
const CLOUD_DB_URL = process.env.CLOUD_DATABASE_URL!;
const SYNC_DAYS = Number(process.env.SYNC_DAYS || '8');

if (!LOCAL_DB_URL) {
  console.error('❌ DATABASE_URL 未配置');
  process.exit(1);
}
if (!CLOUD_DB_URL) {
  console.error('❌ CLOUD_DATABASE_URL 未配置（云端 PG 连接串）');
  process.exit(1);
}

async function main() {
  const localSql = postgres(LOCAL_DB_URL);
  const cloudSql = postgres(CLOUD_DB_URL);

  try {
    console.log(`[同步] 开始推送最近 ${SYNC_DAYS} 天数据到云端...`);

    // 1. 同步 sources（全量，因为 sources 数据量小）
    console.log('[同步] 读取本地 sources...');
    const sources = await localSql`
      SELECT id, name, type, icon, description, config, enabled, parent_id, last_fetch
      FROM sources
      ORDER BY id
    `;
    console.log(`[同步] 本地 sources: ${sources.length} 条`);

    let sourcesUpserted = 0;
    for (const src of sources) {
      await cloudSql`
        INSERT INTO sources (id, name, type, icon, description, config, enabled, parent_id, last_fetch, created_at, updated_at)
        VALUES (${src.id}, ${src.name}, ${src.type}, ${src.icon || ''}, ${src.description}, ${cloudSql.json(src.config || {})}, ${src.enabled}, ${src.parent_id}, ${src.last_fetch}, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          icon = EXCLUDED.icon,
          description = EXCLUDED.description,
          config = EXCLUDED.config,
          enabled = EXCLUDED.enabled,
          parent_id = EXCLUDED.parent_id,
          last_fetch = EXCLUDED.last_fetch,
          updated_at = NOW()
      `;
      sourcesUpserted++;
    }
    console.log(`[同步] sources 同步完成: ${sourcesUpserted} 条`);

    // 2. 同步 articles（最近 N 天）
    console.log(`[同步] 读取本地最近 ${SYNC_DAYS} 天 articles...`);
    const articles = await localSql`
      SELECT source_id, title, content, summary, url, author, published_at, fetched_at, category, tags, extra, content_hash
      FROM articles
      WHERE fetched_at > NOW() - ${SYNC_DAYS + ' days'}::interval
      ORDER BY fetched_at DESC
    `;
    console.log(`[同步] 本地待同步 articles: ${articles.length} 条`);

    let articlesUpserted = 0;
    const batchSize = 50;
    for (let i = 0; i < articles.length; i += batchSize) {
      const batch = articles.slice(i, i + batchSize);
      for (const art of batch) {
        await cloudSql`
          INSERT INTO articles (source_id, title, content, summary, url, author, published_at, fetched_at, category, tags, extra, content_hash)
          VALUES (${art.source_id}, ${art.title}, ${art.content}, ${art.summary}, ${art.url}, ${art.author}, ${art.published_at}, ${art.fetched_at}, ${art.category}, ${art.tags}, ${cloudSql.json(art.extra || {})}, ${art.content_hash})
          ON CONFLICT (content_hash) DO UPDATE SET
            title = EXCLUDED.title,
            content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            url = EXCLUDED.url,
            author = EXCLUDED.author,
            published_at = EXCLUDED.published_at,
            category = EXCLUDED.category,
            tags = EXCLUDED.tags,
            extra = EXCLUDED.extra
        `;
        articlesUpserted++;
      }
      if (i + batchSize < articles.length) {
        process.stdout.write(`\r[同步] articles 进度: ${i + batch.length}/${articles.length}`);
      }
    }
    console.log(`\n[同步] articles 同步完成: ${articlesUpserted} 条`);

    // 3. 云端清理 7 天前的数据
    console.log('[同步] 清理云端 7 天前数据...');
    const artDel = await cloudSql`DELETE FROM articles WHERE fetched_at < NOW() - interval '7 days'`;
    const logDel = await cloudSql`DELETE FROM fetch_logs WHERE started_at < NOW() - interval '7 days'`;
    console.log(`[同步] 清理完成: articles=${artDel.count}, logs=${logDel.count}`);

    // 4. 状态报告
    const [cloudStats] = await cloudSql`
      SELECT count(*) as total, max(fetched_at) as latest FROM articles
    `;
    if (cloudStats) {
      console.log(`\n[同步] ✅ 完成！云端 articles: ${cloudStats.total} 条, 最新: ${cloudStats.latest}`);
    } else {
      console.log('\n[同步] ✅ 完成！云端无数据');
    }

  } catch (err) {
    console.error('[同步] ❌ 失败:', err);
    process.exit(1);
  } finally {
    await localSql.end();
    await cloudSql.end();
  }
}

main();
