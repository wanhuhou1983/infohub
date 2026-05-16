/**
 * 历史图片迁移脚本：将 data/images/ 中已有图片补传到腾讯云 COS
 * 
 * 用法:
 *   node scripts/migrate-images-to-cos.mjs            # 仅上传（不修改 Markdown）
 *   node scripts/migrate-images-to-cos.mjs --dry-run  # 模拟运行，不实际上传
 *   node scripts/migrate-images-to-cos.mjs --update-ob # 上传 + 更新 OB 中的 URL
 *   node scripts/migrate-images-to-cos.mjs --update-ob --dry-run  # 模拟
 * 
 * 工作流:
 *   1. 遍历 data/images/{source}/ 下所有图片
 *   2. 对每张图：headObject 检查 COS 是否存在 → 不存在则 putObject 上传
 *   3. 生成映射文件 data/.cos_migration.json（本地路径 → COS URL）
 *   4. 可选：扫描 OB 中的 .md 文件，将 /api/images/ 路径替换为 COS URL
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data');
const IMAGES_DIR = join(DATA_DIR, 'images');
const OB_DIR = '/Users/wuhuahui/Documents/infohub';
const MIGRATION_MAP_FILE = join(DATA_DIR, '.cos_migration.json');

// ====== COS 配置 ======
function loadCosConfig() {
  const envFile = join(ROOT, '.env.json');
  if (existsSync(envFile)) {
    const env = JSON.parse(readFileSync(envFile, 'utf-8'));
    if (env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION)
      return { secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION };
  }
  const confPath = join(homedir(), '.cos', 'cos.conf');
  if (existsSync(confPath)) {
    const text = readFileSync(confPath, 'utf-8');
    const cfg = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('[') || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      cfg[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    if (cfg.secret_id && cfg.secret_key && cfg.bucket && cfg.region)
      return { secretId: cfg.secret_id, secretKey: cfg.secret_key, bucket: cfg.bucket, region: cfg.region };
  }
  return null;
}

// ====== 辅助 ======
function getCosBaseUrl(cfg) {
  return `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
}

function getCosKey(source, filename) {
  return `images/${source}/${filename}`;
}

function getLocalUrl(source, filename) {
  return `/api/images/${source}/${filename}`;
}

function getCosUrl(cfg, source, filename) {
  return `${getCosBaseUrl(cfg)}/images/${source}/${filename}`;
}

// 检查 COS 上是否已存在
function headObject(client, cfg, key) {
  return new Promise((resolve) => {
    client.headObject({ Bucket: cfg.bucket, Region: cfg.region, Key: key }, (err) => {
      resolve(!err); // 无错误 = 存在
    });
  });
}

// 上传到 COS
function putObject(client, cfg, key, buffer) {
  return new Promise((resolve, reject) => {
    client.putObject({
      Bucket: cfg.bucket, Region: cfg.region, Key: key, Body: buffer,
    }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ====== 主流程 ======
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const updateOb = args.includes('--update-ob');

  console.log('=== 历史图片 COS 迁移脚本 ===\n');

  // 1. 加载配置
  const cfg = loadCosConfig();
  if (!cfg) { console.error('❌ 未找到 COS 配置'); process.exit(1); }
  console.log(`📋 COS: ${cfg.bucket} @ ${cfg.region}`);
  console.log(`📋 OB:  ${OB_DIR}`);
  console.log(`📋 模式: ${dryRun ? '🔍 DRY RUN（不上传）' : '🚀 正式上传'}${updateOb ? ' + 更新 OB Markdown' : ''}\n`);

  // 2. 扫描本地图片
  const entries = []; // { source, filename, filePath, size }
  const sources = await readdir(IMAGES_DIR, { withFileTypes: true });
  for (const src of sources) {
    if (!src.isDirectory() || src.name.startsWith('.')) continue;
    const dirPath = join(IMAGES_DIR, src.name);
    const files = await readdir(dirPath);
    for (const f of files) {
      if (f.startsWith('.') || f === '.img_cache.json') continue;
      const fp = join(dirPath, f);
      const stat = existsSync(fp) ? { size: 0 } : null;
      if (stat) {
        entries.push({ source: src.name, filename: f, filePath: fp, size: 0 });
      }
    }
  }

  console.log(`📊 共 ${entries.length} 张图片待处理`);

  // 统计
  const bySource = {};
  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }
  for (const [s, c] of Object.entries(bySource)) {
    console.log(`   ${s}: ${c} 张`);
  }
  console.log('');

  if (entries.length === 0) {
    console.log('✅ 没有需要上传的图片');
    return;
  }

  // 3. 初始化 COS 客户端
  const client = new COS({ SecretId: cfg.secretId, SecretKey: cfg.secretKey });

  // 4. 逐张处理
  const results = { skipped: 0, uploaded: 0, failed: 0 };
  const mapping = {}; // localUrl -> cosUrl

  // 加载已有的映射（支持断点续传）
  let existingMapping = {};
  if (existsSync(MIGRATION_MAP_FILE)) {
    try {
      existingMapping = JSON.parse(readFileSync(MIGRATION_MAP_FILE, 'utf-8'));
      const alreadyDone = Object.keys(existingMapping).length;
      if (alreadyDone > 0) {
        console.log(`📋 已有 ${alreadyDone} 条映射记录（断点续传）`);
      }
    } catch {}
  }
  Object.assign(mapping, existingMapping);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const cosKey = getCosKey(e.source, e.filename);
    const localUrl = getLocalUrl(e.source, e.filename);
    const cosUrl = getCosUrl(cfg, e.source, e.filename);

    // 如果映射中已有，跳过
    if (mapping[localUrl]) {
      results.skipped++;
      continue;
    }

    // 检查 COS 上是否已存在
    if (!dryRun) {
      const exists = await headObject(client, cfg, cosKey);
      if (exists) {
        mapping[localUrl] = cosUrl;
        results.skipped++;
        process.stdout.write(`\r⏭️  跳过 (已存在): ${cosKey}        `);
        continue;
      }
    }

    // 上传
    if (dryRun) {
      console.log(`🔍 [DRY] 将上传: ${cosKey}`);
      mapping[localUrl] = cosUrl; // 模拟映射
      results.uploaded++;
    } else {
      try {
        const buffer = readFileSync(e.filePath);
        await putObject(client, cfg, cosKey, buffer);
        mapping[localUrl] = cosUrl;
        results.uploaded++;
        process.stdout.write(`\r📤 上传 (${i + 1}/${entries.length}): ${cosKey} (${results.uploaded} new, ${results.skipped + results.failed} skipped/failed)`);
      } catch (err) {
        results.failed++;
        process.stdout.write(`\r❌ 失败: ${cosKey} - ${err.message}`);
      }
    }

    // 每 50 张保存一次映射（防中断丢进度）
    if (!dryRun && results.uploaded > 0 && results.uploaded % 50 === 0) {
      mkdirSync(dirname(MIGRATION_MAP_FILE), { recursive: true });
      writeFileSync(MIGRATION_MAP_FILE, JSON.stringify(mapping, null, 2));
    }
  }

  console.log('\n');

  // 5. 保存最终映射
  if (!dryRun) {
    mkdirSync(dirname(MIGRATION_MAP_FILE), { recursive: true });
    writeFileSync(MIGRATION_MAP_FILE, JSON.stringify(mapping, null, 2));
    console.log(`💾 映射已保存: ${MIGRATION_MAP_FILE}`);
  }

  console.log(`\n📊 结果:`);
  console.log(`   ✅ 已上传:   ${results.uploaded}`);
  console.log(`   ⏭️  已跳过:   ${results.skipped}`);
  console.log(`   ❌ 失败:     ${results.failed}`);
  console.log(`   📋 映射总数: ${Object.keys(mapping).length}`);

  // 6. 可选：更新 OB 中的 Markdown URL
  if (updateOb) {
    console.log('\n=== 更新 OB Markdown → COS URL ===\n');
    await updateObMarkdown(cfg, mapping, dryRun);
  }

  console.log('\n✅ 完成!');
}

// ====== OB Markdown URL 替换 ======
async function updateObMarkdown(cfg, mapping, dryRun) {
  // 收集 OB 下所有 .md 文件
  const mdFiles = [];
  async function walkDir(dir) {
    try {
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(dir, item.name);
        if (item.isDirectory()) {
          if (!item.name.startsWith('.')) await walkDir(fullPath);
        } else if (item.name.endsWith('.md')) {
          mdFiles.push(fullPath);
        }
      }
    } catch {}
  }

  console.log('扫描 OB 目录...');
  await walkDir(OB_DIR);
  console.log(`📄 共 ${mdFiles.length} 个 .md 文件\n`);

  let totalReplaced = 0;
  let filesChanged = 0;

  for (const filePath of mdFiles) {
    let content = await readFile(filePath, 'utf-8');
    let changed = false;

    // 遍历映射，逐个替换
    for (const [localUrl, cosUrl] of Object.entries(mapping)) {
      if (content.includes(localUrl)) {
        const regex = new RegExp(escapeRegex(localUrl), 'g');
        content = content.replace(regex, cosUrl);
        changed = true;
      }
    }

    if (changed) {
      filesChanged++;
      // 统计替换了多少处
      let count = 0;
      for (const [localUrl] of Object.entries(mapping)) {
        const escaped = localUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = content.match(new RegExp(escaped, 'g'));
        if (match) count += match.length;
      }
      totalReplaced += count;

      if (!dryRun) {
        await writeFile(filePath, content, 'utf-8');
      }

      const relPath = relative(OB_DIR, filePath);
      console.log(`   ${dryRun ? '🔍 [DRY]' : '📝'} ${relPath} (${count} 处)`);
    }
  }

  console.log(`\n📊 OB Markdown 更新:`);
  console.log(`   📄 修改文件: ${filesChanged}`);
  console.log(`   🔗 替换 URL: ${totalReplaced}`);
  if (dryRun) {
    console.log('   ℹ️  这是 DRY RUN，未实际修改文件');
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch(e => {
  console.error('脚本异常:', e);
  process.exit(1);
});
