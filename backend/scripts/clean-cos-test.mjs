// 清理 COS 上的测试文件
import COS from 'cos-nodejs-sdk-v5';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

function loadCosConfig() {
  const envFile = join(root, '.env.json');
  if (existsSync(envFile)) {
    const env = JSON.parse(readFileSync(envFile, 'utf-8'));
    if (env.COS_SECRET_ID) return env;
  }
  const confPath = join(homedir(), '.cos', 'cos.conf');
  const text = readFileSync(confPath, 'utf-8');
  const cfg = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('[') || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    cfg[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return cfg;
}

const cfg = loadCosConfig();
const client = new COS({ SecretId: cfg.secret_id, SecretKey: cfg.secret_key });

client.getBucket({ Bucket: cfg.bucket, Region: cfg.region, Prefix: 'images/test/' }, (err, data) => {
  if (err) { console.error('list error:', err.message); return; }
  const objects = (data.Contents || []).map(o => ({ Key: o.Key }));
  if (objects.length === 0) { console.log('无测试文件'); return; }
  console.log('删除', objects.length, '个测试文件');
  client.deleteMultipleObject({ Bucket: cfg.bucket, Region: cfg.region, Objects: objects }, (err2) => {
    if (err2) console.error('delete error:', err2.message);
    else console.log('✅ 已清理');
  });
});
