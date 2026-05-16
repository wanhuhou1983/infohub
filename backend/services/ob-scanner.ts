/**
 * OB→PG 扫描引擎
 * 
 * 扫描 Obsidian 仓库目录，解析 Markdown frontmatter，
 * 三级降级匹配 PG 记录，将 OB 端的修改（tags/is_read/is_starred）写回 PG。
 * 
 * ── 匹配优先级（三级降级）──
 * 一级：content_hash 精确匹配 articles.content_hash
 * 二级：id 精确匹配 articles.id
 * 三级：url 精确匹配 articles.url
 * 
 * ── 字段同步规则 ──
 * 可推送：tags（双向合并）、is_read、is_starred（以 OB 为准）
 * 不推送：content、title、published_at、author（以 PG 为主）
 */

import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';

// 从 file-storage.ts 获取 OB 仓库目录（与 file-storage.ts 保持一致）
import { getObDir } from '../file-storage.js';
const OB_DIR = getObDir();

// 排除的目录名（非文章目录）
const EXCLUDED_DIRS = new Set([
  '.obsidian', '.trash', '工作日志', '_templates',
  'node_modules', '.git',
]);

// ============ 类型定义 ============

export interface ObFileMeta {
  filePath: string;
  /** 从 frontmatter 解析的原始值 */
  frontmatter: Record<string, any>;
  /** 从 frontmatter 提取的关键字段 */
  id?: number;
  content_hash?: string;
  url?: string;
  title: string;
  tags: string[];
  is_read?: boolean;
  is_starred?: boolean;
  sync_version?: number;
}

export interface MatchResult {
  matched: boolean;
  pgRow: any | null;
  matchLevel: number; // 1=content_hash, 2=id, 3=url, 0=无匹配
}

export interface PushResult {
  status: 'skipped' | 'updated' | 'conflict' | 'no_match' | 'error';
  matchLevel: number;
  changes: string[];
  error?: string;
}

export interface DiffItem {
  filePath: string;
  obFields: Record<string, any>;
  pgFields: Record<string, any>;
  matchLevel: number;
  matchStatus: 'matched' | 'no_match';
  changedFields: string[];
}

export interface DiffReport {
  totalObFiles: number;
  matched: number;
  noMatch: number;
  diffItems: DiffItem[];
  summary: {
    totalChanges: number;
    tagsChanged: number;
    statusChanged: number;
  };
}

// ============ 扫描 ============

/**
 * 递归扫描 OB 目录，返回所有 Markdown 文件的 frontmatter 元数据
 * 跳过排除目录和没有有效 frontmatter 的文件
 */
export function scanObFiles(): ObFileMeta[] {
  const results: ObFileMeta[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat: any;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry) && !entry.startsWith('.')) {
          walk(fullPath);
        }
      } else if (stat.isFile() && entry.endsWith('.md')) {
        const meta = parseFile(fullPath);
        if (meta) results.push(meta);
      }
    }
  }

  walk(OB_DIR);
  return results;
}

/**
 * 解析单个 Markdown 文件，提取 frontmatter
 */
export function parseFile(filePath: string): ObFileMeta | null {
  // 路径遍历防护：必须解析到 OB_DIR 内部
  try {
    const realPath = realpathSync(filePath);
    const obReal = realpathSync(getObDir());
    if (!realPath.startsWith(obReal + '/') && realPath !== obReal) {
      console.warn('[ob-scanner] 路径越界拦截:', filePath);
      return null;
    }
  } catch {
    return null; // 文件不存在或权限不足
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (!content.startsWith('---')) return null;

    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return null;

    const fmText = content.slice(3, endIdx).trim();
    const frontmatter: Record<string, any> = {};

    for (const line of fmText.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let val: any = line.slice(colonIdx + 1).trim();
      if (!val) continue;

      if (val.startsWith('[') && val.endsWith(']')) {
        try {
          val = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          val = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
        }
      } else if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^\d+$/.test(val)) val = Number(val);
      else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

      frontmatter[key] = val;
    }

    // 必须有 id 或 content_hash 或 url 才能匹配
    if (!frontmatter.id && !frontmatter.content_hash && !frontmatter.url) return null;

    return {
      filePath,
      frontmatter,
      id: frontmatter.id ? Number(frontmatter.id) : undefined,
      content_hash: frontmatter.content_hash || undefined,
      url: frontmatter.url || undefined,
      title: frontmatter.title || '',
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      is_read: typeof frontmatter.is_read === 'boolean' ? frontmatter.is_read : undefined,
      is_starred: typeof frontmatter.is_starred === 'boolean' ? frontmatter.is_starred : undefined,
      sync_version: frontmatter.sync_version !== undefined ? Number(frontmatter.sync_version) : undefined,
    };
  } catch {
    return null;
  }
}

// ============ 匹配 ============

/**
 * 三级降级匹配：content_hash → id → url
 * 返回匹配结果和匹配级别
 */
export async function matchToPg(
  obMeta: ObFileMeta,
  sql: Sql
): Promise<MatchResult> {
  // 一级：content_hash 精确匹配
  if (obMeta.content_hash) {
    const [row] = await sql`
      SELECT * FROM articles WHERE content_hash = ${obMeta.content_hash} LIMIT 1
    `;
    if (row) return { matched: true, pgRow: row, matchLevel: 1 };
  }

  // 二级：id 精确匹配
  if (obMeta.id) {
    const [row] = await sql`
      SELECT * FROM articles WHERE id = ${obMeta.id} LIMIT 1
    `;
    if (row) return { matched: true, pgRow: row, matchLevel: 2 };
  }

  // 三级：url 精确匹配
  if (obMeta.url) {
    const [row] = await sql`
      SELECT * FROM articles WHERE url = ${obMeta.url} LIMIT 1
    `;
    if (row) return { matched: true, pgRow: row, matchLevel: 3 };
  }

  return { matched: false, pgRow: null, matchLevel: 0 };
}

// ============ 推送 ============

/**
 * 将单个 OB 文件的修改推送到 PG
 * 
 * 同步字段：
 * - tags：取并集（保留 PG 系统标签 + OB 用户手加标签）
 * - is_read：以 OB 为准
 * - is_starred：以 OB 为准
 * 
 * 不同步的字段（以 PG 为准）：
 * - content, title, published_at, author, category
 */
export async function pushToPg(
  obMeta: ObFileMeta,
  sql: Sql
): Promise<PushResult> {
  try {
    const { matched, pgRow, matchLevel } = await matchToPg(obMeta, sql);
    if (!matched || !pgRow) {
      return { status: 'no_match', matchLevel: 0, changes: [] };
    }

    const changes: string[] = [];

    // 1. tags：取并集
    const pgTags: string[] = pgRow.tags || [];
    const obTags: string[] = obMeta.tags || [];
    const mergedTags = [...new Set([...pgTags, ...obTags])];
    if (JSON.stringify(pgTags) !== JSON.stringify(mergedTags)) {
      changes.push(`tags: [${pgTags.join(', ')}] → [${mergedTags.join(', ')}]`);
    }

    // 2. is_read：以 OB 为准（仅在 OB 有值时）
    let newIsRead = pgRow.is_read;
    if (typeof obMeta.is_read === 'boolean' && obMeta.is_read !== pgRow.is_read) {
      newIsRead = obMeta.is_read;
      changes.push(`is_read: ${pgRow.is_read} → ${obMeta.is_read}`);
    }

    // 3. is_starred：以 OB 为准
    let newIsStarred = pgRow.is_starred;
    if (typeof obMeta.is_starred === 'boolean' && obMeta.is_starred !== pgRow.is_starred) {
      newIsStarred = obMeta.is_starred;
      changes.push(`is_starred: ${pgRow.is_starred} → ${obMeta.is_starred}`);
    }

    // 如果没有变化，跳过
    if (changes.length === 0) {
      return { status: 'skipped', matchLevel, changes: [] };
    }

    // 执行更新
    await sql`
      UPDATE articles
      SET tags = ${mergedTags},
          is_read = ${newIsRead},
          is_starred = ${newIsStarred}
      WHERE id = ${pgRow.id}
    `;

    return { status: 'updated', matchLevel, changes };
  } catch (e: any) {
    return { status: 'error', matchLevel: 0, changes: [], error: e.message };
  }
}

// ============ 差异报告 ============

/**
 * 生成 OB ↔ PG 的差异报告
 * 对比每个文件的 frontmatter 与 PG 记录，列出有差异的字段
 */
export async function diffReport(sql: Sql): Promise<DiffReport> {
  const obFiles = scanObFiles();
  const diffItems: DiffItem[] = [];
  let matched = 0;
  let noMatch = 0;

  for (const obFile of obFiles) {
    const { matched: isMatched, pgRow, matchLevel } = await matchToPg(obFile, sql);

    if (!isMatched || !pgRow) {
      noMatch++;
      diffItems.push({
        filePath: obFile.filePath,
        obFields: obFile.frontmatter,
        pgFields: {},
        matchLevel: 0,
        matchStatus: 'no_match',
        changedFields: ['（未匹配到 PG 记录）'],
      });
      continue;
    }

    matched++;

    // 逐字段对比
    const changedFields: string[] = [];
    const obTags: string[] = obFile.tags || [];
    const pgTags: string[] = pgRow.tags || [];
    const mergedTags = [...new Set([...pgTags, ...obTags])];
    if (JSON.stringify(pgTags) !== JSON.stringify(mergedTags)) {
      changedFields.push(`tags: PG=[${pgTags.join(', ')}] OB=[${obTags.join(', ')}] → [${mergedTags.join(', ')}]`);
    }

    if (typeof obFile.is_read === 'boolean' && obFile.is_read !== pgRow.is_read) {
      changedFields.push(`is_read: PG=${pgRow.is_read} OB=${obFile.is_read}`);
    }

    if (typeof obFile.is_starred === 'boolean' && obFile.is_starred !== pgRow.is_starred) {
      changedFields.push(`is_starred: PG=${pgRow.is_starred} OB=${obFile.is_starred}`);
    }

    if (changedFields.length > 0) {
      diffItems.push({
        filePath: obFile.filePath,
        obFields: obFile.frontmatter,
        pgFields: {
          tags: pgTags,
          is_read: pgRow.is_read,
          is_starred: pgRow.is_starred,
        },
        matchLevel,
        matchStatus: 'matched',
        changedFields,
      });
    }
  }

  const tagsChanged = diffItems.filter(d => d.changedFields.some(f => f.startsWith('tags'))).length;
  const statusChanged = diffItems.filter(d => d.changedFields.some(f => f.startsWith('is_'))).length;

  return {
    totalObFiles: obFiles.length,
    matched,
    noMatch,
    diffItems,
    summary: {
      totalChanges: diffItems.length,
      tagsChanged,
      statusChanged,
    },
  };
}
