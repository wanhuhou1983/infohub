/**
 * COS 上传快速测试
 * 手动上传一张图到 COS，验证配置和 SDK 是否正常工作
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 读取 COS 配置
function loadCosConfig() {
  // 1. 优先 .env.json
  const envFile = join(__dirname, '..', '.env.json');
  if (existsSync(envFile)) {
    const env = JSON.parse(readFileSync(envFile, 'utf-8'));
    if (env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION) {
      return { secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION };
    }
  }

  // 2. 回退 ~/.cos/cos.conf
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
    if (cfg.secret_id && cfg.secret_key && cfg.bucket && cfg.region) {
      return { secretId: cfg.secret_id, secretKey: cfg.secret_key, bucket: cfg.bucket, region: cfg.region };
    }
  }

  return null;
}

const cfg = loadCosConfig();
if (!cfg) {
  console.error('❌ 未找到 COS 配置');
  process.exit(1);
}

console.log('✅ COS 配置已加载:', cfg.bucket, cfg.region);

// 找一张测试图
const testImagesDir = join(__dirname, '..', 'data', 'images', 'rss');
const files = [];
for (const f of ['d61ab4f382e2ce07.jpg', '858a1b647d1290ff.jpg', '445498b2587d44c8.jpg']) {
  const p = join(testImagesDir, f);
  if (existsSync(p)) { files.push(p); break; }
}

if (files.length === 0) {
  console.error('❌ 未找到测试图片');
  process.exit(1);
}

const testFile = files[0];
const buffer = readFileSync(testFile);
const key = `images/test/${Date.now()}.jpg`;

console.log(`📤 上传测试图片: ${testFile}`);
console.log(`   COS 路径: ${key}`);

const client = new COS({ SecretId: cfg.secretId, SecretKey: cfg.secretKey });

client.putObject({
  Bucket: cfg.bucket,
  Region: cfg.region,
  Key: key,
  Body: buffer,
  ContentLength: buffer.length,
}, (err, data) => {
  if (err) {
    console.error('❌ COS 上传失败:', err.message || String(err));
    process.exit(1);
  }

  const cosUrl = `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com/${key}`;
  console.log('✅ COS 上传成功!');
  console.log(`   URL: ${cosUrl}`);

  // 验证可访问
  fetch(cosUrl, { method: 'HEAD' }).then(res => {
    console.log(`   HTTP ${res.status}: ${res.ok ? '✅ 可访问' : '❌ 不可访问'}`);
    if (res.ok) {
      console.log('🎉 COS 配置和上传均正常!');
    }
  }).catch(e => {
    console.warn(`   ⚠️ 验证请求失败: ${e.message}`);
  });
});
