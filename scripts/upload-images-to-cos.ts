/**
 * 批量上传本地图片到 COS，并更新数据库中的引用路径
 *
 * 用法：
 *   bun run scripts/upload-images-to-cos.ts
 *   bun run scripts/upload-images-to-cos.ts --dry-run  (不写库，只预览)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ====== COS 配置（凭据只从环境变量 / backend/.env.json 读取，禁止硬编码）======
import { createHash } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';

function loadCosConfig() {
  let fileCfg: Record<string, string> = {};
  try {
    const p = join(__dirname, '..', 'backend', '.env.json');
    if (existsSync(p)) fileCfg = JSON.parse(readFileSync(p, 'utf-8'));
  } catch { /* ignore */ }
  const pick = (k: string) => process.env[k] || fileCfg[k] || '';
  const cfg = {
    secretId: pick('COS_SECRET_ID'),
    secretKey: pick('COS_SECRET_KEY'),
    bucket: pick('COS_BUCKET'),
    region: pick('COS_REGION'),
  };
  if (!cfg.secretId || !cfg.secretKey || !cfg.bucket || !cfg.region) {
    throw new Error('缺少 COS 配置：请设置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION');
  }
  return cfg;
}

const COS_CONFIG = loadCosConfig();

const COS_BASE = `https://${COS_CONFIG.bucket}.cos.${COS_CONFIG.region}.myqcloud.com`;
const IMAGES_DIR = join(__dirname, '..', 'backend', 'data', 'images');

// ====== SQL ======
const sql = postgres(process.env.DATABASE_URL || 'postgres://linhu@localhost:5432/linhu');

const isDryRun = process.argv.includes('--dry-run');

function uploadToCOS(key: string, body: Buffer): Promise<string | null> {
  const client = new COS({ SecretId: COS_CONFIG.secretId, SecretKey: COS_CONFIG.secretKey });
  return new Promise((resolve) => {
    client.putObject(
      { Bucket: COS_CONFIG.bucket, Region: COS_CONFIG.region, Key: key, Body: body, ContentLength: body.length },
      (err: any) => resolve(err ? null : `${COS_BASE}/${key}`)
    );
  });
}

async function main() {
  console.log(`=== COS 图片上传 ===`);
  console.log(`Bucket: ${COS_CONFIG.bucket}`);
  console.log(`Region: ${COS_CONFIG.region}`);
  console.log(`Dry-run: ${isDryRun}`);
  console.log(`Images dir: ${IMAGES_DIR}`);
  console.log();

  // 1. 扫描所有子目录下的图片
  const subdirs = readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log(`发现 ${subdirs.length} 个子目录: ${subdirs.join(', ')}`);
  console.log();

  let totalUploaded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // 2. 遍历每个子目录上传
  for (const subdir of subdirs) {
    const dirPath = join(IMAGES_DIR, subdir);
    const files = readdirSync(dirPath).filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
    console.log(`[${subdir}] ${files.length} 个文件`);

    for (const file of files) {
      const localPath = join(dirPath, file);
      const key = `images/${subdir}/${file}`;
      const cosUrl = `${COS_BASE}/${key}`;

      // 检查是否已存在
      if (existsSync(localPath)) {
        const body = readFileSync(localPath);
        const size = body.length;
        const ext = extname(file).toLowerCase();
        const contentType = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png', '.gif': 'image/gif',
          '.webp': 'image/webp', '.svg': 'image/svg+xml',
        }[ext] || 'application/octet-stream';

        if (isDryRun) {
          console.log(`  [DRY] ${key} → ${cosUrl} (${size} bytes)`);
          totalSkipped++;
          continue;
        }

        const result = await uploadToCOS(key, body);
        if (result) {
          totalUploaded++;
          if (totalUploaded % 100 === 0) console.log(`  ... ${totalUploaded} 个已上传`);
        } else {
          totalErrors++;
          console.error(`  ❌ ${key} 上传失败`);
        }
      }
    }
  }

  console.log();
  console.log(`=== 上传结果 ===`);
  console.log(`上传: ${totalUploaded}`);
  console.log(`跳过(DRY): ${totalSkipped}`);
  console.log(`失败: ${totalErrors}`);

  // 3. 更新数据库引用
  if (!isDryRun && totalUploaded > 0) {
    console.log();
    console.log(`=== 更新数据库 ===`);

    // 将 content 中的 /api/images/xxx 替换为 COS URL
    const result = await sql`
      UPDATE articles
      SET content = regexp_replace(
        content,
        '/api/images/([^/]+)/([^\\s)\\]>]+)',
        ${COS_BASE} || '/images/' || '\1' || '/' || '\2',
        'g'
      )
      WHERE content LIKE '%/api/images/%'
    `;
    console.log(`已更新文章: ${result.count} 篇`);
  }

  await sql.end();
  console.log(`完成!`);
}

main().catch(err => { console.error(err); process.exit(1); });
