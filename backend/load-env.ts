/**
 * 环境配置预加载（必须作为 index.ts 的第一个 import）
 *
 * 为什么需要独立模块：ESM 的依赖模块会先于入口模块求值。原先写在 index.ts
 * 顶部的 IIFE 虽然位置靠前，但 jintiankansha.ts / crawler.ts / translate.ts
 * 等模块的顶层常量（JTK_USER、WECHAT_SERVICE_URL、DEEPSEEK_API_KEY ...）在
 * IIFE 执行前就已经固定了，导致从 .env.json 注入的云端配置读不到。
 * 抽成第一个 import 后，本模块最先求值，配置对所有模块可见。
 *
 * 加载顺序（先到先得不覆盖）：已存在的 process.env > 按下列路径依次合并。
 * 云端：容器把 /opt/infohub/.env.json 挂到 /.env.json。
 * 本地：backend/.env.json、backend/.env 由 dotenv/config 处理。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  join(process.cwd(), '.env.json'),
  join(here, '.env.json'),
  join(here, '..', '.env.json'),
  '/.env.json',
  join(homedir(), '.infohub', '.env.json'),
];

for (const file of candidates) {
  try {
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && !process.env[key]) process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[load-env] 跳过 ${file}: ${(e as Error).message}`);
  }
}
