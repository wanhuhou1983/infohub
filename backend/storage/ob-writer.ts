/**
 * OB（Obsidian）仓库写入模块
 *
 * 职责：Markdown 文件生成、OB 仓库文件写入、PG↔OB 双向同步、全量同步
 */

import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { processImages } from './image-processor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ OB 仓库目录 ============

const OB_DIR = (() => {
  try {
    const envFile = join(__dirname, '..', '.env.json');
    if (existsSync(envFile)) {
      const cfg = JSON.parse(readFileSync(envFile, 'utf-8'));
      if (cfg.OB_DIR) return cfg.OB_DIR;
    }
  } catch {}
  return process.env.OB_DIR || '/Users/wuhuahui/Documents/infohub';
})();

export function getObDir(): string {
  try {
    const envFile = join(__dirname, '..', '.env.json');
    if (existsSync(envFile)) {
      const cfg = JSON.parse(readFileSync(envFile, 'utf-8'));
      if (cfg.OB_DIR) return cfg.OB_DIR;
    }
  } catch {}
  return process.env.OB_DIR || '/Users/wuhuahui/Documents/infohub';
}

// ============ index.json 管理（article_id → filepath 映射） ============

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
let indexMap = new Map<string, string>();
let indexLoaded = false;
let indexPersistTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureIndexLoaded(): Promise<void> {
  if (indexLoaded) return;
  indexLoaded = true;
  const indexPath = join(DATA_DIR, 'index.json');
  try {
    const data = await readFile(indexPath, 'utf-8');
    indexMap = new Map(Object.entries(JSON.parse(data)));
  } catch {
    indexMap = new Map();
  }
}

function persistIndex(): void {
  if (indexPersistTimer) clearTimeout(indexPersistTimer);
  indexPersistTimer = setTimeout(async () => {
    try {
      const obj = Object.fromEntries(indexMap);
      await mkdir(DATA_DIR, { recursive: true });
      const indexPath = join(DATA_DIR, 'index.json');
      const tempFile = `${indexPath}.tmp`;
      await writeFile(tempFile, JSON.stringify(obj, null, 2), 'utf-8');
      await rename(tempFile, indexPath);
    } catch (e: any) {
      console.error('索引持久化失败:', e.message);
    }
  }, 1000);
}

async function updateIndex(articleId: number, filePath: string): Promise<void> {
  await ensureIndexLoaded();
  indexMap.set(String(articleId), filePath);
  persistIndex();
}

// ============ 类型 ============

export interface ArticleMeta {
  id: number;
  title: string;
  source_type: string;
  source_name: string;
  url: string | null;
  published_at: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_watch_later?: boolean;
  content_hash?: string;
  sync_version?: number;
  extra?: Record<string, any> | null;  // PG articles.extra JSONB，含衍生内容
}

// ============ 衍生内容常量 ============

/** 衍生内容区块定义：key = extra 中的字段名，heading = OB 中显示的标题 */
const EXTRA_FIELD_ORDER: Array<{ key: string; heading: string }> = [
  { key: 'ai_translation', heading: '🌐 AI 翻译' },
  { key: 'ai_analysis', heading: '🤖 AI 解读' },
  { key: 'subtitle_analysis', heading: '📝 字幕解读' },
  { key: 'subtitle', heading: '📄 完整字幕/转录' },
];

// ============ 辅助函数 ============

export function normalizeDate(val: string | null | undefined): string {
  if (!val) return '';
  const str = String(val);
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 19);
  }
  return str.slice(0, 19);
}

/** MD5 哈希 */
export function hashString(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

/** 获取文章的本地文件路径 */
export async function getArticleFilePath(articleId: number): Promise<string | null> {
  await ensureIndexLoaded();
  const path = indexMap.get(String(articleId));
  return path && existsSync(path) ? path : null;
}

/** 检查文章是否已有本地文件 */
export async function hasArticleFile(articleId: number): Promise<boolean> {
  return (await getArticleFilePath(articleId)) !== null;
}

// ============ Frontmatter 解析 ============

export function parseObFrontmatter(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  if (!content.startsWith('---')) return result;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return result;

  const fmText = content.slice(3, endIdx).trim();
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
    }
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\d+$/.test(val)) val = Number(val);
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

    result[key] = val;
  }

  return result;
}

// ============ 目录映射 ============

export function getObSubdir(meta: ArticleMeta): string {
  const st = meta.source_type;
  switch (st) {
    case 'xwlb': return '报刊杂志/新闻联播';
    case 'rmrb': return '报刊杂志/人民日报';
    case 'magazine': {
      // 根据 source_name 分流到不同子目录
      const magName = meta.source_name || '';
      if (magName.includes('喷嚏图卦')) return '报刊杂志/喷嚏图卦';
      if (magName.includes('财新')) return '报刊杂志/财新周刊';
      if (magName.includes('The Economist')) return '报刊杂志/The Economist';
      if (magName.includes('Economist')) return '报刊杂志/The Economist';
      // 其他杂志按名称拼音排序的子目录
      const sanitized = sanitizeDirName(magName);
      return sanitized ? join('报刊杂志', sanitized) : '报刊杂志/喷嚏图卦';
    }
    case 'tencent': return '报刊杂志/腾讯新闻';
    case 'wechat': {
      const name = normalizeWechatAccount(meta.source_name);
      return join('微信公众号', name || '未分类');
    }
    case 'rss': {
      const name = sanitizeDirName(meta.source_name);
      return join('RSS订阅', name);
    }
    case 'bilibili-updates': {
      const name = sanitizeDirName(meta.source_name);
      return join('哔哩哩哔', '更新', name);
    }
    case 'bilibili-watch-later': return '哔哩哩哔/稍后再看';
    case 'bilibili-favorites': return '哔哩哩哔/收藏';
    case 'youtube-updates': return 'YouTube';
    case 'youtube-watch-later': return 'YouTube';
    case 'youtube-favorites': return 'YouTube';
    case 'twitter-updates': {
      const name = sanitizeDirName(meta.source_name);
      return join('twitter-updates', name);
    }
    case 'podcast-channel': {
      const name = sanitizeDirName(meta.source_name);
      return join('podcast-channel', name);
    }
    default: return st;
  }
}

export function normalizeWechatAccount(name: string): string {
  const n = (name || '').replace(/^微信公众号[-_]/, '').trim();
  return n || name || '未分类';
}

/** 清理目录名中的非法字符 */
export function sanitizeDirName(name: string | null | undefined): string {
  if (!name) return '未分类';
  return name.replace(/[\/\\:*?"<>|\n\r]/g, '').trim() || '未分类';
}

// ============ 衍生内容辅助函数 ============

/** 从 extra 中提取需要写入 OB 的衍生字段 */
export function extractDerivedFields(extra?: Record<string, any> | null): Record<string, any> {
  if (!extra) return {};
  const derived: Record<string, any> = {};
  for (const { key } of EXTRA_FIELD_ORDER) {
    if (extra[key]) derived[key] = extra[key];
  }
  return derived;
}

/** 计算衍生内容版本号（基于内容哈希），无衍生字段时返回空字符串 */
export function computeExtraVersion(extra?: Record<string, any> | null): string {
  const fields = extractDerivedFields(extra);
  if (Object.keys(fields).length === 0) return '';
  return hashString(JSON.stringify(fields)).slice(0, 8);
}

/** 读取 OB frontmatter 中的 extra_fields 数组 */
function parseExtraFields(fm: Record<string, any>): string[] {
  const raw = fm.extra_fields;
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

// ============ 文件名生成 ============

export function sanitizeFilename(meta: ArticleMeta): string {
  if (meta.source_type === 'magazine') {
    let titlePart = (meta.title || 'untitled')
      .replace(/[\/\\:*?"<>|\n\r]/g, '')
      .replace(/\s+/g, '_');
    const maxTitleBytes = 60;
    let titleBytes = 0;
    let truncatedTitle = '';
    for (const ch of titlePart) {
      const charBytes = Buffer.byteLength(ch, 'utf-8');
      if (titleBytes + charBytes > maxTitleBytes) break;
      titleBytes += charBytes;
      truncatedTitle += ch;
    }
    titlePart = truncatedTitle || 'untitled';
    return `${titlePart}.md`;
  }

  const pubRaw: any = meta.published_at;
  let pubStr: string;
  if (pubRaw instanceof Date) {
    pubStr = pubRaw.toISOString();
  } else if (pubRaw) {
    pubStr = String(pubRaw);
  } else {
    pubStr = '';
  }

  let dateStr: string;
  const isoMatch = pubStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    dateStr = isoMatch[1] + isoMatch[2] + isoMatch[3];
  } else {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  let titlePart = (meta.title || 'untitled')
    .replace(/[\/\\:*?"<>|\n\r]/g, '')
    .replace(/\s+/g, '_');

  const maxTitleBytes = 60;
  let titleBytes = 0;
  let truncatedTitle = '';
  for (const ch of titlePart) {
    const charBytes = Buffer.byteLength(ch, 'utf-8');
    if (titleBytes + charBytes > maxTitleBytes) break;
    titleBytes += charBytes;
    truncatedTitle += ch;
  }
  titlePart = truncatedTitle || 'untitled';

  return `${dateStr}-${titlePart}.md`;
}

// ============ Markdown 构建 ============

export function buildMarkdown(content: string, meta: ArticleMeta): string {
  const derived = extractDerivedFields(meta.extra);
  const extraVersion = computeExtraVersion(meta.extra);
  const extraFieldKeys = Object.keys(derived).length > 0 ? Object.keys(derived) : undefined;

  const frontmatter: Record<string, any> = {
    id: meta.id,
    content_hash: meta.content_hash || '',
    url: meta.url || '',
    source: meta.source_name,
    source_type: meta.source_type,
    published_at: normalizeDate(meta.published_at),
    category: meta.category || '',
    tags: meta.tags || [],
    author: meta.author || '',
    is_read: meta.is_read,
    is_starred: meta.is_starred,
    sync_version: meta.sync_version ?? 1,
  };

  // 仅在有衍生内容时写入 extra_fields 和 extra_version
  if (extraFieldKeys && extraFieldKeys.length > 0) {
    frontmatter.extra_fields = extraFieldKeys;
    frontmatter.extra_version = extraVersion;
  }

  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map(t => `"${t}"`).join(', ')}]`;
      if (typeof v === 'boolean') return `${k}: ${v}`;
      if (typeof v === 'number') return `${k}: ${v}`;
      return `${k}: "${String(v).replace(/"/g, '\\"')}"`;
    })
    .join('\n');

  const mdContent = content.replace(/__IMG__(.+?)__IMG__/g, (_, url) => {
    return `![](${url})`;
  });

  // 将 /api/images/... 路径转换为 Obsidian 本地方件附件路径
  // 图片已同时保存到 /obsidian/附件/ 目录（见 image-processor.ts）
  const obContent = mdContent.replace(/\/api\/images\/([^\s)\]\)]+)/g, (_, imgPath) => {
    return `/附件/${imgPath}`;
  });

  // 构建正文
  let body = `# ${meta.title}\n\n${obContent}`;

  // 追加衍生内容区块
  if (Object.keys(derived).length > 0) {
    for (const { key, heading } of EXTRA_FIELD_ORDER) {
      if (derived[key]) {
        body += `\n\n---\n\n## ${heading}\n\n${derived[key]}`;
      }
    }
  }

  return `---\n${fmLines}\n---\n\n${body}\n`;
}

// ============ 保存文章文件 ============

export async function saveArticleFile(
  articleId: number,
  content: string,
  meta: ArticleMeta
): Promise<{ filePath: string | null; processedContent: string }> {
  try {
    if (!meta.content_hash && meta.url) {
      meta.content_hash = hashString(meta.url);
    }

    if (meta.sync_version === undefined) {
      meta.sync_version = 1;
    }

    const processedContent = await processImages(content, meta.source_type);
    const obPath = getObSubdir(meta);
    const filename = sanitizeFilename(meta);
    const dirPath = join(OB_DIR, obPath);
    let filePath = join(dirPath, filename);

    // 文件名去重
    try {
      if (existsSync(filePath) && meta.content_hash) {
        const existingRaw = await readFile(filePath, 'utf-8');
        const existingFm = parseObFrontmatter(existingRaw);
        if (existingFm && existingFm.content_hash && existingFm.content_hash !== meta.content_hash) {
          const dedupName = filename.replace(/\.md$/, `_${meta.content_hash.slice(0, 8)}.md`);
          filePath = join(dirPath, dedupName);
          console.log(`[sync] 文件名冲突，使用去重名: ${filename} → ${dedupName} (id=${articleId})`);
        }
      }
    } catch {
      // ignore
    }

    // 读前合并：检查 OB 端是否已有此文件
    let obFrontmatter: Record<string, any> | null = null;
    try {
      const existingPath = await getArticleFilePath(articleId);
      if (existingPath) {
        const existingContent = await readFile(existingPath, 'utf-8');
        obFrontmatter = parseObFrontmatter(existingContent);
      }
    } catch {
      // ignore
    }

    if (obFrontmatter && Object.keys(obFrontmatter).length > 1) {
      const obVersion = Number(obFrontmatter.sync_version) || 0;
      if (obVersion >= meta.sync_version) {
        const obTags: string[] = Array.isArray(obFrontmatter.tags) ? obFrontmatter.tags : [];
        const pgTags = meta.tags || [];
        const mergedTags = [...new Set([...pgTags, ...obTags])];
        meta.tags = mergedTags;

        if (typeof obFrontmatter.is_read === 'boolean') {
          meta.is_read = obFrontmatter.is_read;
        }
        if (typeof obFrontmatter.is_starred === 'boolean') {
          meta.is_starred = obFrontmatter.is_starred;
        }

        console.log(`[sync] 合并 OB 修改: id=${articleId}, tags=${JSON.stringify(meta.tags)}, is_read=${meta.is_read}, is_starred=${meta.is_starred}`);
      }
    }

    meta.sync_version = (obFrontmatter ? (Number(obFrontmatter.sync_version) || 0) : 0) + 1;

    const md = buildMarkdown(processedContent, meta);
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, md, 'utf-8');
    await updateIndex(articleId, filePath);

    return { filePath, processedContent };
  } catch (e: any) {
    console.error(`saveArticleFile error [id=${articleId}]:`, e.message);
    return { filePath: null, processedContent: content };
  }
}

// ============ 全量同步 ============

export async function syncAllFiles(
  pageFn: (offset: number, limit: number) => Promise<any[]>,
  updateFn?: (id: number, content: string) => Promise<void>
): Promise<{ total: number; synced: number; errors: number }> {
  let total = 0;
  let synced = 0;
  let errors = 0;

  const batchSize = 100;
  let offset = 0;

  while (true) {
    const rows = await pageFn(offset, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (!row.content || row.content.length < 10) {
        errors++;
        continue;
      }

      try {
        const { processedContent } = await saveArticleFile(row.id, row.content, {
          id: row.id,
          title: row.title,
          source_type: row.source_type || 'unknown',
          source_name: row.source_name || '',
          url: row.url,
          published_at: row.published_at,
          category: row.category,
          tags: row.tags || [],
          author: row.author,
          is_read: row.is_read,
          is_starred: row.is_starred,
          content_hash: row.content_hash,
          extra: row.extra,
        });
        if (processedContent !== row.content) {
          if (updateFn) {
            await updateFn(row.id, processedContent);
          }
        }
        synced++;
      } catch (e: any) {
        console.error(`sync file error [id=${row.id}]:`, e.message);
        errors++;
      }
    }

    offset += batchSize;
    if (rows.length < batchSize) break;
  }

  return { total, synced, errors };
}
