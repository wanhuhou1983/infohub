/**
 * 本地文件存储 + 图床上传模块
 * 
 * 安全修复：
 * - 图床 Token 不再硬编码默认值，强制从环境变量读取
 * - 图片缓存持久化到本地 JSON 文件，重启不丢失
 */

import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';  // existsSync 启动检查 + readFileSync 仅 getEnvConfig 使用（一次性）
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 兼容 Bun/Node 的 __dirname 替代方案
const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ 配置 ============

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

// 运行时配置：优先从 .env.json 读取，其次 process.env
let _envConfig: Record<string, string> | null = null;

function getEnvConfig(): Record<string, string> {
  if (!_envConfig) {
    try {
      const envFile = join(__dirname, '..', '.env.json');
      // 注：此处保留同步读取，因为 getEnvConfig 在 getter 函数中高频调用，
      // 且仅在首次调用时执行（_envConfig 为 null 时），对事件循环无实质影响
      if (existsSync(envFile)) {
        _envConfig = JSON.parse(readFileSync(envFile, 'utf-8'));
      }
    } catch { /* ignore */ }
    _envConfig = _envConfig || {};
  }
  return _envConfig;
}

/** 使环境配置缓存失效，下次读取时重新加载 .env.json */
export function invalidateEnvCache(): void { _envConfig = null; }

function envOrFile(key: string, fallback: string): string {
  const fileVal = getEnvConfig()[key];
  return fileVal || process.env[key] || fallback;
}

// 🔒 Bug fix：改为 getter 函数，env 热更新后立即生效（不再用 const 固化）
function getImgbedUrl() { return envOrFile('IMGBED_URL', 'http://localhost:8085/api/'); }
function getImgbedBase() { return envOrFile('IMGBED_BASE', 'http://localhost:8085'); }
// 安全：强制从环境变量读取，无默认值
function getImgbedToken() { return envOrFile('IMGBED_TOKEN', ''); }
const CACHE_FILE = join(DATA_DIR, '.img_cache.json');

// 图片 URL 缓存：远程 URL -> 图床 URL
// 启动时从本地 JSON 加载，上传后持久化
let imgCache = new Map<string, string>();

// 延迟加载缓存（首次使用时读取）
let cacheLoaded = false;

// 防抖定时器：合并短时间内多次缓存写入
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// 🔒 index.json 并发保护：使用内存 Map + 防抖持久化
let indexMap = new Map<string, string>();
let indexLoaded = false;
let indexPersistTimer: ReturnType<typeof setTimeout> | null = null;

// 🔒 Bug fix：改为 async，不再用同步 I/O 阻塞事件循环
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

// 🔒 Bug fix：防抖内改为异步写入，不再阻塞事件循环
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

// 🔒 Bug fix：改为 async，不再用同步 I/O 阻塞事件循环
async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const data = await readFile(CACHE_FILE, 'utf-8');
    imgCache = new Map(Object.entries(JSON.parse(data)));
  } catch {
    imgCache = new Map();
  }
}

// 🔒 Bug fix：防抖内改为异步写入，不再阻塞事件循环
function persistCache(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const obj = Object.fromEntries(imgCache);
      await mkdir(DATA_DIR, { recursive: true });
      // 原子写入：先写临时文件，再重命名覆盖，防止并发写入损坏
      const tempFile = `${CACHE_FILE}.tmp`;
      await writeFile(tempFile, JSON.stringify(obj), 'utf-8');
      await rename(tempFile, CACHE_FILE);
    } catch (e: any) {
      console.error('图片缓存持久化失败:', e.message);
    }
  }, 1000);
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
  is_watch_later?: boolean;
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

    // 5. 确保目录存在并写入（🔒 异步 I/O，不阻塞事件循环）
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, md, 'utf-8');

    // 6. 更新索引（🔒 异步等待）
    await updateIndex(articleId, filePath);

    return { filePath, processedContent };
  } catch (e: any) {
    console.error(`saveArticleFile error [id=${articleId}]:`, e.message);
    return { filePath: null, processedContent: content };
  }
}

/**
 * 获取文章的本地文件路径（🔒 异步，不阻塞事件循环）
 */
export async function getArticleFilePath(articleId: number): Promise<string | null> {
  await ensureIndexLoaded();
  const path = indexMap.get(String(articleId));
  return path && existsSync(path) ? path : null;
}

/**
 * 检查文章是否已有本地文件（🔒 异步）
 */
export async function hasArticleFile(articleId: number): Promise<boolean> {
  return (await getArticleFilePath(articleId)) !== null;
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
    .replace(/\s+/g, '_');

  // 按字节截断，中文每字3字节，避免总文件名超255字节
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

  const sourcePart = meta.source_name
    ? meta.source_name.replace(/[\/\\:*?"<>|\n\r]/g, '').slice(0, 10)
    : '';

  // 🔒 修复：加入文章 ID 避免同名文件冲突
  const idPart = String(meta.id);
  const parts = sourcePart ? [dateStr, sourcePart, idPart, titlePart] : [dateStr, idPart, titlePart];
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
 * 🔒 修复：先收集所有唯一 URL，批量处理后用全局正则替换
 */
export async function processImages(content: string): Promise<string> {
  await ensureCacheLoaded();

  // 收集所有需要处理的图片 URL
  const imgPattern = /__IMG__(.+?)__IMG__/g;
  const mdImgPattern = /(!\[(.*?)\])\((.+?)\)/g;

  // 收集 __IMG__ 格式的 URL
  const imgUrls = new Map<string, string>(); // originalUrl -> replacement
  for (const match of content.matchAll(imgPattern)) {
    const originalUrl = match[1]!;
    if (originalUrl.startsWith(getImgbedBase())) continue;

    const cachedUrl = imgCache.get(originalUrl);
    if (cachedUrl) {
      imgUrls.set(originalUrl, `__IMG__${cachedUrl}__IMG__`);
    } else {
      imgUrls.set(originalUrl, ''); // 标记需要上传
    }
  }

  // 收集 Markdown 格式的 URL
  const mdImgUrls = new Map<string, { alt: string; replacement: string }>();
  for (const match of content.matchAll(mdImgPattern)) {
    const altText = match[2] || '';
    const originalUrl = match[3]!;
    if (originalUrl.startsWith(getImgbedBase()) || originalUrl.startsWith('data:')) continue;

    const cachedUrl = imgCache.get(originalUrl);
    if (cachedUrl) {
      mdImgUrls.set(originalUrl, { alt: altText, replacement: `![${altText}](${cachedUrl})` });
    } else {
      mdImgUrls.set(originalUrl, { alt: altText, replacement: '' }); // 标记需要上传
    }
  }

  if (imgUrls.size === 0 && mdImgUrls.size === 0) return content;

  let cacheChanged = false;

  // 上传未缓存的图片
  for (const [originalUrl, replacement] of imgUrls) {
    if (replacement) continue; // 已有缓存
    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        cacheChanged = true;
        imgUrls.set(originalUrl, `__IMG__${imgbedUrl}__IMG__`);
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  for (const [originalUrl, data] of mdImgUrls) {
    if (data.replacement) continue; // 已有缓存
    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        cacheChanged = true;
        mdImgUrls.set(originalUrl, { alt: data.alt, replacement: `![${data.alt}](${imgbedUrl})` });
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  // 持久化缓存
  if (cacheChanged) persistCache();

  // 全局替换
  let result = content;
  for (const [originalUrl, replacement] of imgUrls) {
    if (replacement) {
      const regex = new RegExp(`__IMG__${escapeRegex(originalUrl)}__IMG__`, 'g');
      result = result.replace(regex, replacement);
    }
  }
  for (const [originalUrl, data] of mdImgUrls) {
    if (data.replacement) {
      // 🔒 修复：提前取值，避免 lambda 内二次查 Map 得到 undefined
      const newUrl = imgCache.get(originalUrl) ?? originalUrl;
      const regex = new RegExp(`(!\\[)(.*?)(\\]\\(${escapeRegex(originalUrl)}\\))`, 'g');
      result = result.replace(regex, (_, prefix, alt) => `${prefix}${alt}](${newUrl})`);
    }
  }

  return result;
}

// 辅助：转义正则特殊字符
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 上传图片到 EasyImages 图床
 */
async function uploadToImgbed(imageUrl: string): Promise<string | null> {
  const imgbedToken = getImgbedToken();
  const imgbedUrl = getImgbedUrl();
  const imgbedBase = getImgbedBase();

  if (!imgbedToken) {
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
    formData.append('token', imgbedToken);

    const uploadResp = await fetch(imgbedUrl, {
      method: 'POST',
      body: formData,
    });

    if (!uploadResp.ok) return null;

    const result = await uploadResp.json() as any;
    if (result && result.result === 'success' && result.url) {
      const fullUrl = result.url.startsWith('http') ? result.url : `${imgbedBase}${result.url}`;
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
 * 🔒 修复：使用内存 Map + 防抖持久化，避免并发竞态
 */
// 🔒 Bug fix：改为 async，ensureIndexLoaded 不再同步阻塞
async function updateIndex(articleId: number, filePath: string): Promise<void> {
  await ensureIndexLoaded();
  indexMap.set(String(articleId), filePath);
  persistIndex();
}
