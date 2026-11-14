/**
 * COS（腾讯云对象存储）模块
 * 
 * 职责：环境配置加载、COS 客户端管理、文件上传
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import COS from 'cos-nodejs-sdk-v5';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ 环境配置 ============

let _envConfig: Record<string, string> | null = null;

function getEnvConfig(): Record<string, string> {
  if (!_envConfig) {
    const merged: Record<string, string> = {};
    // 云端把 /opt/infohub/.env.json 挂到 /.env.json（镜像 WORKDIR=/app，
    // 原路径 /app/.env.json 在云端并不存在），因此这里要覆盖多个候选位置。
    const candidates = [
      join(__dirname, '..', '.env.json'),
      join(__dirname, '.env.json'),
      '/.env.json',
      join(process.cwd(), '.env.json'),
    ];
    for (const file of candidates) {
      try {
        if (!existsSync(file)) continue;
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && !merged[key]) merged[key] = value;
        }
      } catch { /* ignore 单个文件解析失败，不影响其他来源 */ }
    }
    // 真实环境变量（docker -e / --env-file）优先级最高
    for (const key of ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']) {
      if (process.env[key]) merged[key] = process.env[key]!;
    }
    _envConfig = merged;
  }
  return _envConfig;
}

export function invalidateEnvCache(): void { _envConfig = null; }

// ============ COS 配置 ============

interface CosConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
}

let _cosClient: any = null;
let _cosConfig: CosConfig | null = null;

function loadCosConfig(): CosConfig | null {
  if (_cosConfig) return _cosConfig;

  const env = getEnvConfig();
  if (env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION) {
    _cosConfig = {
      secretId: env.COS_SECRET_ID,
      secretKey: env.COS_SECRET_KEY,
      bucket: env.COS_BUCKET,
      region: env.COS_REGION,
    };
    return _cosConfig;
  }

  try {
    const cosConfPath = join(homedir(), '.cos', 'cos.conf');
    if (!existsSync(cosConfPath)) return null;
    const confText = readFileSync(cosConfPath, 'utf-8');
    const lines = confText.split('\n');
    const config: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      config[key] = val;
    }
    if (config.secret_id && config.secret_key && config.bucket && config.region) {
      _cosConfig = {
        secretId: config.secret_id,
        secretKey: config.secret_key,
        bucket: config.bucket,
        region: config.region,
      };
      return _cosConfig;
    }
  } catch {
    // ignore
  }

  return null;
}

function getCosClient(): any {
  if (_cosClient) return _cosClient;
  const cfg = loadCosConfig();
  if (!cfg) return null;
  try {
    _cosClient = new COS({
      SecretId: cfg.secretId,
      SecretKey: cfg.secretKey,
    });
    return _cosClient;
  } catch {
    return null;
  }
}

/**
 * 上传文件到 COS
 * @returns 成功返回 COS URL，失败返回 null
 */
export async function uploadToCOS(key: string, body: Buffer, contentType?: string): Promise<string | null> {
  const client = getCosClient();
  const cfg = loadCosConfig();
  if (!client || !cfg) return null;

  const params: any = {
    Bucket: cfg.bucket,
    Region: cfg.region,
    Key: key,
    Body: body,
    ContentLength: body.length,
  };
  if (contentType) params.ContentType = contentType;

  return new Promise((resolve) => {
    client.putObject(
      params,
      (err: any) => {
        if (err) {
          resolve(null);
        } else {
          resolve(`https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com/${key}`);
        }
      }
    );
  });
}

export function getCosBaseUrl(): string {
  const cfg = loadCosConfig();
  if (!cfg) return '';
  return `https://${cfg.bucket}.cos.${cfg.region}.myqcloud.com`;
}

export function invalidateCosCache(): void { _cosClient = null; _cosConfig = null; }
