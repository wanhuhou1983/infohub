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
    try {
      const envFile = join(__dirname, '..', '.env.json');
      if (existsSync(envFile)) {
        _envConfig = JSON.parse(readFileSync(envFile, 'utf-8'));
      }
    } catch { /* ignore */ }
    _envConfig = _envConfig || {};
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
export async function uploadToCOS(key: string, body: Buffer): Promise<string | null> {
  const client = getCosClient();
  const cfg = loadCosConfig();
  if (!client || !cfg) return null;

  return new Promise((resolve) => {
    client.putObject(
      {
        Bucket: cfg.bucket,
        Region: cfg.region,
        Key: key,
        Body: body,
        ContentLength: body.length,
      },
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
