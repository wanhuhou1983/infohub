/**
 * 将 data/images/wechat/ 中的所有图片上传到腾讯云 COS，
 * 然后更新：
 * 1. OB markdown 文件：/api/images/wechat/xxx → COS URL
 * 2. 数据库 content 列：/api/images/wechat/xxx → COS URL
 * 3. 图片缓存 .img_cache.json：添加 wechat 图片的 COS URL 映射
 *
 * 用法：node scripts/migrate-wechat-images-to-cos.mjs
 */

import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const DATA_DIR = join(PROJECT_DIR, 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');
const WECHAT_IMAGES_DIR = join(IMAGES_DIR, 'wechat');
const CACHE_FILE = join(DATA_DIR, '.img_cache.json');
const OB_DIR = '/Users/wuhuahui/Documents/infohub';
const DB_URL = 'postgres://infohub:infohub123@localhost:5433/infohub';

// COS 配置 — 从 .env.json 读取（避免密钥硬编码）
function loadCosConfig() {
  const envPath = join(PROJECT_DIR, '.env.json');
  if (existsSync(envPath)) {
    const env = JSON.parse(readFileSync(envPath, 'utf-8'));
    return {
      secretId: env.COS_SECRET_ID,
      secretKey: env.COS_SECRET_KEY,
      bucket: env.COS_BUCKET,
      region: env.COS_REGION,
    };
  }
  // fallback: 环境变量
  return {
    secretId: process.env.COS_SECRET_ID,
    secretKey: process.env.COS_SECRET_KEY,
    bucket: process.env.COS_BUCKET || 'wanhuhou-1300445858',
    region: process.env.COS_REGION || 'ap-shanghai',
  };
}
const cosConfig = loadCosConfig();
const COS_BASE_URL = `https://${cosConfig.bucket}.cos.${cosConfig.region}.myqcloud.com`;

// COS SDK（需与后端一致）
import COS from 'cos-nodejs-sdk-v5';
const cosClient = new COS({ SecretId: cosConfig.secretId, SecretKey: cosConfig.secretKey });

function cosUpload(key, body) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: body,
      ContentLength: body.length,
    }, (err, data) => {
      if (err) reject(err);
      else resolve(`${COS_BASE_URL}/${key}`);
    });
  });
}

async function uploadAllImages() {
  console.log('📂 扫描本地公众号图片...');
  const files = await readdir(WECHAT_IMAGES_DIR);
  const imageFiles = files.filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
  console.log(`  发现 ${imageFiles.length} 张图片`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const urlMap = {}; // localPath -> cosUrl

  for (let i = 0; i < imageFiles.length; i++) {
    const filename = imageFiles[i];
    const localPath = `/api/images/wechat/${filename}`;
    const cosKey = `images/wechat/${filename}`;
    const cosUrl = `${COS_BASE_URL}/${cosKey}`;
    const filePath = join(WECHAT_IMAGES_DIR, filename);

    try {
      const buffer = await readFile(filePath);
      const cosUrlResult = await cosUpload(cosKey, buffer);
      urlMap[localPath] = cosUrl;
      uploaded++;
      if ((i + 1) % 50 === 0) {
        console.log(`  进度: ${i + 1}/${imageFiles.length} (${uploaded} 上传, ${skipped} 跳过, ${failed} 失败)`);
      }
    } catch (e) {
      failed++;
      console.error(`  ❌ 上传失败 [${filename}]:`, e.message || e);
    }
  }

  console.log(`\n✅ COS 上传完成：${uploaded} 成功, ${skipped} 跳过, ${failed} 失败`);
  return urlMap;
}

async function updateImageCache(urlMap) {
  console.log('\n📝 更新图片缓存...');
  let cache = {};
  try {
    const data = await readFile(CACHE_FILE, 'utf-8');
    cache = JSON.parse(data);
  } catch { /* 不存在或已损坏 */ }

  let added = 0;
  for (const [localPath, cosUrl] of Object.entries(urlMap)) {
    if (!cache[localPath]) {
      cache[localPath] = cosUrl;
      added++;
    }
  }

  // 也需要反向添加：原始 URL -> COS URL（缓存中可能存的是原始URL -> /api/images/...）
  // 但我们只需要将 /api/images/wechat/xxx -> COS URL 写回即可
  // 实际上缓存 key 可能是原始微信图片URL，value 是 /api/images/wechat/xxx
  // 我们先只把 /api/images/wechat/xxx 的 value 提升为 COS URL
  let upgraded = 0;
  for (const [origKey, cachedVal] of Object.entries(cache)) {
    if (cachedVal.startsWith('/api/images/wechat/') && urlMap[cachedVal]) {
      cache[origKey] = urlMap[cachedVal];
      upgraded++;
    }
  }

  const tmpFile = `${CACHE_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(cache, null, 2));
  await rename(tmpFile, CACHE_FILE);
  console.log(`  缓存更新：${added} 新增, ${upgraded} 升级为 COS URL`);
}

async function updateObFiles(urlMap) {
  console.log('\n📂 扫描 OB 仓库中的公众号 Markdown 文件...');
  const wechatDir = join(OB_DIR, '微信公众号');
  if (!existsSync(wechatDir)) {
    console.log('  公众号目录不存在，跳过');
    return;
  }

  const accounts = await readdir(wechatDir);
  let totalFiles = 0;
  let updatedFiles = 0;
  let totalReplacements = 0;

  for (const account of accounts) {
    const accountPath = join(wechatDir, account);
    try {
      const stat = existsSync(accountPath);
      if (!stat) continue;
      const files = await readdir(accountPath);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        totalFiles++;
        const filePath = join(accountPath, file);
        let content = await readFile(filePath, 'utf-8');
        let changed = false;

        // 替换所有 /api/images/wechat/xxx 为 COS URL
        for (const [localPath, cosUrl] of Object.entries(urlMap)) {
          const regex = new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          if (regex.test(content)) {
            content = content.replace(regex, cosUrl);
            changed = true;
            totalReplacements++;
          }
        }

        if (changed) {
          await writeFile(filePath, content, 'utf-8');
          updatedFiles++;
        }
      }
    } catch (e) {
      console.error(`  读取 ${accountPath} 失败:`, e.message);
    }
  }

  console.log(`  OB 文件：${totalFiles} 扫描, ${updatedFiles} 更新, ${totalReplacements} 处替换`);
}

async function updateDatabase(urlMap) {
  console.log('\n🗄️  更新数据库 content 列...');
  const sql = postgres(DB_URL);

  try {
    // 找出所有包含 /api/images/wechat/ 的 wechat 文章
    const rows = await sql`
      SELECT id, content FROM articles
      WHERE source_id IN (SELECT id FROM sources WHERE type = 'wechat')
        AND content LIKE '%/api/images/wechat/%'
    `;
    console.log(`  数据库中找到 ${rows.length} 篇含本地图片路径的文章`);

    let updated = 0;
    for (const row of rows) {
      let newContent = row.content;
      let changed = false;

      for (const [localPath, cosUrl] of Object.entries(urlMap)) {
        const regex = new RegExp(localPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        if (regex.test(newContent)) {
          newContent = newContent.replace(regex, cosUrl);
          changed = true;
        }
      }

      if (changed) {
        await sql`
          UPDATE articles SET content = ${newContent} WHERE id = ${row.id}
        `;
        updated++;
      }
    }

    console.log(`  数据库更新：${updated} 篇`);
  } finally {
    await sql.end();
  }
}

async function cleanupOldArticles() {
  console.log('\n🗑️  清理旧版无正文的重复文章...');
  const sql = postgres(DB_URL);

  try {
    // 找出所有旧版摘要文章（content < 300 字符）且有新版（同标题同source，content > 300）
    const result = await sql`
      DELETE FROM articles a
      WHERE a.source_id IN (SELECT id FROM sources WHERE type = 'wechat')
        AND (a.content IS NULL OR length(a.content) < 300)
        AND EXISTS (
          SELECT 1 FROM articles b
          WHERE b.source_id IN (SELECT id FROM sources WHERE type = 'wechat')
            AND b.title = a.title
            AND b.source_id = a.source_id
            AND b.id > a.id
            AND length(b.content) > 300
        )
      RETURNING id, title
    `;
    console.log(`  已删除 ${result.length} 篇旧版重复文章:`);
    for (const r of result.slice(0, 10)) {
      console.log(`    - id=${r.id} "${r.title}"`);
    }
    if (result.length > 10) {
      console.log(`    ... 还有 ${result.length - 10} 篇`);
    }
  } finally {
    await sql.end();
  }
}

async function main() {
  console.log('🚀 开始将公众号图片迁移到腾讯云 COS\n');
  console.log('='.repeat(60));

  // 1. 上传所有图片到 COS
  const urlMap = await uploadAllImages();
  if (Object.keys(urlMap).length === 0) {
    console.log('⚠️  没有图片上传，中止后续步骤');
    return;
  }

  // 2. 更新图片缓存
  await updateImageCache(urlMap);

  // 3. 更新 OB 文件
  await updateObFiles(urlMap);

  // 4. 更新数据库
  await updateDatabase(urlMap);

  // 5. 清理旧版重复文章
  await cleanupOldArticles();

  console.log('\n' + '='.repeat(60));
  console.log('✅ 全部完成！');
  console.log(`  上传 COS: ${Object.keys(urlMap).length} 张图片`);
  console.log(`  COS 基础 URL: ${COS_BASE_URL}`);
}

main().catch(e => {
  console.error('\n❌ 脚本出错:', e);
  process.exit(1);
});
