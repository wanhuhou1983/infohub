// @ts-nocheck
/**
 * 文本类采集原文的 COS 归档
 *
 * 定位：原始副本，不参与展示。前端仍从云端 PG 的 /api/articles 读取。
 * 用途：灾备、重放/回灌、双跑灰度比对、正文完整率抽查。
 *
 * key 规则：articles/{北京时间日期}/{content_hash}.json
 * 同一个 content_hash 重复归档会覆盖同一对象，天然幂等。
 */
import { uploadToCOS } from './cos-storage.js';

export interface ArchiveEntry {
  id?: number;
  source_id?: number;
  source_name?: string | null;
  source_type?: string | null;
  title: string;
  content?: string | null;
  summary?: string | null;
  url?: string | null;
  author?: string | null;
  published_at?: string | Date | null;
  fetched_at?: string | Date | null;
  category?: string | null;
  tags?: string[] | null;
  extra?: Record<string, any> | null;
  content_hash: string;
}

export interface ArchiveResult {
  attempted: number;
  uploaded: number;
  skipped: number;
  failed: number;
  keys: string[];
}

/** 归档开关，默认开启；显式设为 'false' 时关闭 */
export function isCosArchiveEnabled(): boolean {
  return process.env.COS_ARCHIVE_ENABLED !== 'false';
}

/** 返回北京时间 YYYY-MM-DD，不依赖容器 TZ */
export function beijingDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function buildArchiveKey(entry: ArchiveEntry): string {
  const date = beijingDate(entry.fetched_at ? new Date(entry.fetched_at) : new Date());
  return `articles/${date}/${entry.content_hash}.json`;
}

export async function archiveArticles(entries: ArchiveEntry[]): Promise<ArchiveResult> {
  const result: ArchiveResult = {
    attempted: entries.length, uploaded: 0, skipped: 0, failed: 0, keys: [],
  };

  if (!isCosArchiveEnabled()) {
    result.skipped = entries.length;
    return result;
  }

  for (const entry of entries) {
    if (!entry || !entry.content_hash) {
      result.skipped++;
      continue;
    }
    try {
      const key = buildArchiveKey(entry);
      const payload = JSON.stringify({
        schema: 'infohub.article.v1',
        archived_at: new Date().toISOString(),
        ...entry,
      }, null, 2);
      const url = await uploadToCOS(key, Buffer.from(payload, 'utf-8'), 'application/json; charset=utf-8');
      if (url) {
        result.uploaded++;
        result.keys.push(key);
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}
