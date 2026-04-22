/**
 * 本地文件存储 + 图床上传模块
 * 
 * 安全修复：
 * - 图床 Token 不再硬编码默认值，强制从环境变量读取
 * - 图片缓存持久化到本地 JSON 文件，重启不丢失
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ============ 配置 ============

const DATA_DIR = process.env.DATA_DIR || join(import.meta.dir, '..', 'data');
const IMGBED_URL = process.env.IMGBED_URL || 'http://localhost:8085/api/';
const IMGBED_BASE = process.env.IMGBED_BASE || 'http://localhost:8085';
// 安全：强制从环境变量读取，无默认值
const IMGBED_TOKEN = process.env.IMGBED_TOKEN ?? '';
const CACHE_FILE = join(DATA_DIR, '.img_cache.json');

// 图片 URL 缓存：远程 URL -> 图床 URL
// 启动时从本地 JSON 加载，上传后持久化
let imgCache = new Map<string, string>();

// 延迟加载缓存（首次使用时读取）
let cacheLoaded = false;

function ensureCacheLoaded(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      imgCache = new Map(Object.entries(data));
    }
  } catch {
    imgCache = new Map();
  }
}

function persistCache(): void {
  try {
    const obj: Record<string, string> = {};
    imgCache.forEach((v, k) => { obj[k] = v; });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf-8');
  } catch (e: any) {
    console.error('图片缓存持久化失败:', e.message);
  }
}

/**
 * 标准化日期为 ISO 格式 (YYYY-MM-DDTHH:mm:ss)
 */
function normalizeDate(val: string | null | undefined): string {
  if (!val) return '';
  const str = String(val);
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 19);
  }
  return str.slice(0, 19);
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
}

// ============ 公开函数 ============

/**
 * 将文章保存为本地 Markdown 文件
 * 同时返回处理后的内容（图片已上传到图床），供调用方更新数据库
 */
export async function saveArticleFile(
  articleId: number,
  content: string,
  meta: ArticleMeta
): Promise<{ filePath: string | null; processedContent: string }> {
  try {
    // 1. 处理图片：上传到图床，替换 URL
    const processedContent = await processImages(content);

    // 2. 确定子目录
    const subdir = getSubdir(meta.source_type);

    // 3. 生成安全的文件名
    const filename = sanitizeFilename(meta);
    const dirPath = join(DATA_DIR, subdir);
    const filePath = join(dirPath, filename);

    // 4. 组装 Markdown 内容
    const md = buildMarkdown(processedContent, meta);

    // 5. 确保目录存在并写入
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(filePath, md, 'utf-8');

    // 6. 更新索引
    updateIndex(articleId, filePath);

    return { filePath, processedContent };
  } catch (e: any) {
    console.error(`saveArticleFile error [id=${articleId}]:`, e.message);
    return { filePath: null, processedContent: content };
  }
}

/**
 * 获取文章的本地文件路径
 */
export function getArticleFilePath(articleId: number): string | null {
  const indexPath = join(DATA_DIR, 'index.json');
  if (!existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    return index[String(articleId)] || null;
  } catch {
    return null;
  }
}

/**
 * 检查文章是否已有本地文件
 */
export function hasArticleFile(articleId: number): boolean {
  const path = getArticleFilePath(articleId);
  return path !== null && existsSync(path);
}

/**
 * MD5 哈希（使用 Node.js 标准 crypto，兼容 Bun/Node）
 */
export function hashString(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

/**
 * 全量同步：从数据库导出所有文章到本地文件
 * 改用分页查询函数替代原始 SQL 字符串
 */
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

// ============ 内部函数 ============

function getSubdir(sourceType: string): string {
  switch (sourceType) {
    case 'xwlb': return 'xwlb';
    case 'wechat': return 'wechat';
    case 'rss': return 'rss';
    default: return sourceType;
  }
}

function sanitizeFilename(meta: ArticleMeta): string {
  const pubStr = meta.published_at ? String(meta.published_at) : '';
  let dateStr: string;
  const isoMatch = pubStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    dateStr = isoMatch[1] + isoMatch[2] + isoMatch[3];
  } else {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  let titlePart = (meta.title || 'untitled')
    .replace(/[\/\\:*?"<>|\n\r]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40);

  const sourcePart = meta.source_name
    ? meta.source_name.replace(/[\/\\:*?"<>|\n\r]/g, '').slice(0, 15)
    : '';

  const parts = sourcePart ? [dateStr, sourcePart, titlePart] : [dateStr, titlePart];
  return parts.join('_') + '.md';
}

function buildMarkdown(content: string, meta: ArticleMeta): string {
  const frontmatter: Record<string, any> = {
    id: meta.id,
    source: meta.source_name,
    source_type: meta.source_type,
    url: meta.url || '',
    published_at: normalizeDate(meta.published_at),
    category: meta.category || '',
    tags: meta.tags || [],
    author: meta.author || '',
    is_read: meta.is_read,
    is_starred: meta.is_starred,
  };

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

  return `---\n${fmLines}\n---\n\n# ${meta.title}\n\n${mdContent}\n`;
}

/**
 * 处理内容中的图片：上传到 EasyImages 图床，替换为图床 URL
 */
async function processImages(content: string): Promise<string> {
  ensureCacheLoaded();

  const imgPattern = /__IMG__(.+?)__IMG__/g;
  const matches = [...content.matchAll(imgPattern)];
  const mdImgPattern = /!\[\]\((.+?)\)/g;
  const mdMatches = [...content.matchAll(mdImgPattern)];

  if (matches.length === 0 && mdMatches.length === 0) return content;

  let result = content;
  let cacheChanged = false;

  // 处理 __IMG__ 格式
  for (const match of matches) {
    const originalUrl = match[1]!;
    const cachedUrl = imgCache.get(originalUrl);

    if (cachedUrl) {
      result = result.replace(match[0], `__IMG__${cachedUrl}__IMG__`);
      continue;
    }

    if (originalUrl.startsWith(IMGBED_BASE)) continue;

    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        cacheChanged = true;
        result = result.replace(match[0], `__IMG__${imgbedUrl}__IMG__`);
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  // 处理 Markdown ![](url) 格式
  for (const match of mdMatches) {
    const originalUrl = match[1]!;

    if (originalUrl.startsWith(IMGBED_BASE)) continue;
    if (originalUrl.startsWith('data:')) continue;

    const cachedUrl = imgCache.get(originalUrl);
    if (cachedUrl) {
      result = result.replace(match[0], `![](${cachedUrl})`);
      continue;
    }

    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        cacheChanged = true;
        result = result.replace(match[0], `![](${imgbedUrl})`);
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  // 持久化缓存
  if (cacheChanged) persistCache();

  return result;
}

/**
 * 上传图片到 EasyImages 图床
 */
async function uploadToImgbed(imageUrl: string): Promise<string | null> {
  if (!IMGBED_TOKEN) {
    console.error('图床 Token 未配置，跳过图片上传');
    return null;
  }

  try {
    const imgResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
    });
    if (!imgResponse.ok) return null;

    const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
    const blob = await imgResponse.blob();

    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('gif') ? 'gif'
      : contentType.includes('webp') ? 'webp'
      : 'jpg';

    const filename = `infohub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const formData = new FormData();
    formData.append('image', blob, filename);
    formData.append('token', IMGBED_TOKEN);

    const uploadResp = await fetch(IMGBED_URL, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResp.ok) return null;

    const result = await uploadResp.json() as any;
    if (result && result.result === 'success' && result.url) {
      const fullUrl = result.url.startsWith('http') ? result.url : `${IMGBED_BASE}${result.url}`;
      return fullUrl;
    }

    return null;
  } catch (e: any) {
    console.error(`uploadToImgbed error:`, e.message);
    return null;
  }
}

/**
 * 更新索引文件 (article_id -> filepath)
 */
function updateIndex(articleId: number, filePath: string): void {
  const indexPath = join(DATA_DIR, 'index.json');
  let index: Record<string, string> = {};

  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf-8'));
    } catch {
      index = {};
    }
  }

  index[String(articleId)] = filePath;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}
