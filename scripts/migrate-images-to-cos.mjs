/**
 * 批量将本地 data/images/{source}/ 图片迁移到腾讯云 COS
 * 同时更新 OB Markdown 文件、数据库 content 列、图片缓存 .img_cache.json
 *
 * 用法：
 *   node scripts/migrate-images-to-cos.mjs                # 迁移所有 source
 *   node scripts/migrate-images-to-cos.mjs wechat          # 只迁移 wechat
 *   node scripts/migrate-images-to-cos.mjs rss wechat      # 迁移 rss 和 wechat
 *
 * 依赖：cos-nodejs-sdk-v5（安装于 backend/node_modules/）
 */

import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..', '..', 'infohub');
const BACKEND_DIR = join(PROJECT_DIR, 'backend');
const DATA_DIR = join(PROJECT_DIR, 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');
const CACHE_FILE = join(DATA_DIR, '.img_cache.json');
const OB_DIR = '/Users/wuhuahui/Documents/infohub';
const DB_URL = 'postgres://infohub:infohub123@localhost:5433/infohub';

// 从 ~/.cos/cos.conf 读取 COS 配置
function loadCosConfig() {
  const confPath = join(process.env.HOME, '.cos', 'cos.conf');
  if (!existsSync(confPath)) throw new Error('~/.cos/cos.conf not found');
  const text = readFileSync(confPath, 'utf-8');
  const config = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('[') || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    config[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return {
    secretId: config.secret_id,
    secretKey: config.secret_key,
    bucket: config.bucket,
    region: config.region,
  };
}

const COS_CFG = loadCosConfig();
const COS_BASE = `https://${COS_CFG.bucket}.cos.${COS_CFG.region}.myqcloud.com`;
const cosClient = new COS({ SecretId: COS_CFG.secretId, SecretKey: COS_CFG.secretKey });

function cosUpload(key, body) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_CFG.bucket, Region: COS_CFG.region,
      Key: key, Body: body, ContentLength: body.length,
    }, (err) => err ? reject(err) : resolve(`${COS_BASE}/${key}`));
  });
}

async function uploadImages(sourceDir) {
  const files = await readdir(sourceDir);
  const images = files.filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
  console.log(`  发现 ${images.length} 张图片`);

  const urlMap = {}; // localUrl -> cosUrl
  let ok = 0, fail = 0;

  for (let i = 0; i < images.length; i++) {
    const f = images[i];
    const localUrl = `/api/images/${sourceDir.name}/${f}`;
    const cosKey = `images/${sourceDir.name}/${f}`;
    try {
      const buf = await readFile(join(sourceDir.path, f));
      await cosUpload(cosKey, buf);
      urlMap[localUrl] = `${COS_BASE}/${cosKey}`;
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ❌ ${f}: ${e.message || e}`);
    }
    if ((i + 1) % 50 === 0 || i === images.length - 1) {
      process.stdout.write(`  进度: ${i + 1}/${images.length} (${ok}成功 ${fail}失败)\r`);
    }
  }
  console.log();
  return urlMap;
}

async function updateCache(urlMap) {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf-8')); } catch {}
  let added = 0;
  for (const [k, v] of Object.entries(urlMap)) {
    if (!cache[k]) { cache[k] = v; added++; }
    // 也升级已有缓存值
    for (const [orig, cached] of Object.entries(cache)) {
      if (cached === k) { cache[orig] = v; }
    }
  }
  const tmp = CACHE_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(cache));
  await rename(tmp, CACHE_FILE);
  console.log(`  缓存更新: ${added} 新增`);
}

async function updateObFiles(urlMap) {
  if (!existsSync(OB_DIR)) { console.log('  OB 目录不存在，跳过'); return; }
  const entries = await readdir(OB_DIR, { withFileTypes: true });
  let total = 0, updated = 0, replaced = 0;

  async function walk(dir) {
    const files = await readdir(dir, { withFileTypes: true });
    for (const f of files) {
      const fp = join(dir, f.name);
      if (f.isDirectory()) { await walk(fp); continue; }
      if (!f.name.endsWith('.md')) continue;
      total++;
      let content = await readFile(fp, 'utf-8');
      let changed = false;
      for (const [local, cos] of Object.entries(urlMap)) {
        const re = new RegExp(local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        if (re.test(content)) {
          content = content.replace(re, cos);
          changed = true;
          replaced++;
        }
      }
      if (changed) { await writeFile(fp, content); updated++; }
    }
  }
  await walk(OB_DIR);
  console.log(`  OB: ${total}文件, ${updated}更新, ${replaced}处替换`);
}

async function updateDb(urlMap) {
  const sql = postgres(DB_URL);
  try {
    const rows = await sql`
      SELECT id, content FROM articles WHERE content LIKE ANY(${Object.keys(urlMap).map(u => '%' + u + '%')})
    `;
    let updated = 0;
    for (const r of rows) {
      let c = r.content;
      for (const [local, cos] of Object.entries(urlMap)) {
        c = c.replaceAll(local, cos);
      }
      if (c !== r.content) {
        await sql`UPDATE articles SET content = ${c} WHERE id = ${r.id}`;
        updated++;
      }
    }
    console.log(`  数据库: ${updated}篇更新`);
  } finally { await sql.end(); }
}

async function main() {
  const sources = process.argv.slice(2);
  const all = sources.length === 0;

  const dirs = await readdir(IMAGES_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (!all && !sources.includes(d.name)) continue;
    console.log(`\n📂 ${d.name}/`);
    const urlMap = await uploadImages(d);
    if (Object.keys(urlMap).length === 0) continue;
    await updateCache(urlMap);
    await updateObFiles(urlMap);
    await updateDb(urlMap);
  }
  console.log('\n✅ 完成');
}

main().catch(e => { console.error(e); process.exit(1); });
