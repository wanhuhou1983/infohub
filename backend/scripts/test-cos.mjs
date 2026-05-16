/**
 * COS 上传快速测试（放在 backend/ 下以正确解析 cos SDK）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCosConfig() {
  const envFile = join(__dirname, '..', '.env.json');
  if (existsSync(envFile)) {
    const env = JSON.parse(readFileSync(envFile, 'utf-8'));
    if (env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION) {
      return { secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION };
    }
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
    if (cfg.secret_id && cfg.secret_key && cfg.bucket && cfg.region) {
      return { secretId: cfg.secret_id, secretKey: cfg.secret_key, bucket: cfg.bucket, region: cfg.region };
    }
  }
  return null;
}

const cfg = loadCosConfig();
if (!cfg) { console.error('❌ 未找到 COS 配置'); process.exit(1); }
console.log('✅ COS 配置:', cfg.bucket, cfg.region);

const dir = join(__dirname, '..', '..', 'data', 'images', 'rss');
const file = ['d61ab4f382e2ce07.jpg', '858a1b647d1290ff.jpg', '445498b2587d44c8.jpg']
  .map(f => join(dir, f)).find(existsSync);
if (!file) { console.error('❌ 未找到测试图'); process.exit(1); }

const buf = readFileSync(file);
const key = `images/test/${Date.now()}.jpg`;
console.log(`📤 ${file} → cos://${cfg.bucket}/${key}`);

const client = new COS({ SecretId: cfg.secretId, SecretKey: cfg.secretKey });
client.putObject({
  Bucket: cfg.bucket, Region: cfg.region, Key: key, Body: buf,
}, (err) => {
  if (err) { console.error('❌ 失败:', err.message); process.exit(1); }
  const url = `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com/${key}`;
  console.log(`✅ 成功: ${url}`);
  fetch(url, { method: 'HEAD' }).then(r =>
    console.log(`   HTTP ${r.status} ${r.ok ? '✅' : '❌'}`)
  );
});
