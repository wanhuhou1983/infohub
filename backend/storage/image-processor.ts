/**
 * 图片处理模块
 *
 * 职责：图片下载、本地缓存、URL 替换、图床 fallback
 */

import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { getCosBaseUrl, uploadToCOS } from './cos-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
export const IMAGES_DIR = join(DATA_DIR, 'images');

export function getImagesDir(): string { return IMAGES_DIR; }

// ============ Obsidian 附件目录 ============
function getObAttachmentsDir(): string {
  return process.env.OB_ATTACHMENTS_DIR || '/obsidian/附件';
}
export function getObImagesDir(): string { return getObAttachmentsDir(); }

// ============ 图片 URL 缓存 ============

const CACHE_FILE = join(DATA_DIR, '.img_cache.json');
let imgCache = new Map<string, string>();
let cacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

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

function persistCache(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const obj = Object.fromEntries(imgCache);
      await mkdir(DATA_DIR, { recursive: true });
      const tempFile = `${CACHE_FILE}.tmp`;
      await writeFile(tempFile, JSON.stringify(obj), 'utf-8');
      await rename(tempFile, CACHE_FILE);
    } catch (e: any) {
      console.error('图片缓存持久化失败:', e.message);
    }
  }, 1000);
}

// ============ 目录映射 ============

function getSubdir(sourceType: string): string {
  switch (sourceType) {
    case 'xwlb': return 'xwlb';
    case 'wechat': return 'wechat';
    case 'rss': return 'rss';
    default: return sourceType;
  }
}

// ============ 正则工具 ============

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============ COS URL 转换 ============

function localUrlToCosUrl(localUrl: string): string | null {
  const baseUrl = getCosBaseUrl();
  if (!baseUrl) return null;
  const pathPart = localUrl.replace(/^\/api\/images\//, 'images/');
  return `${baseUrl}/${pathPart}`;
}

// ============ 图片下载与保存 ============

async function downloadAndSaveImage(imageUrl: string, sourceType: string): Promise<string | null> {
  try {
    const imgResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
        'Referer': 'https://mp.weixin.qq.com/',
      },
    });
    if (!imgResponse.ok) return null;

    const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await imgResponse.arrayBuffer());

    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('gif') ? 'gif'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('svg') ? 'svg'
      : 'jpg';

    const hash = createHash('md5').update(buffer).digest('hex').slice(0, 16);
    const filename = `${hash}.${ext}`;

    const subdir = getSubdir(sourceType);
    const dirPath = join(IMAGES_DIR, subdir);
    const filePath = join(dirPath, filename);

    const localUrl = `/api/images/${subdir}/${filename}`;

    // 保存到 Web 图片目录（用于 API 图片服务）
    if (!existsSync(filePath)) {
      await mkdir(dirPath, { recursive: true });
      await writeFile(filePath, buffer);
    }

    // 同时保存到 Obsidian 附件目录（用于 OB 本地图片显示）
    const obAttachDir = join(getObAttachmentsDir(), subdir);
    const obFilePath = join(obAttachDir, filename);
    if (!existsSync(obFilePath)) {
      await mkdir(obAttachDir, { recursive: true });
      await writeFile(obFilePath, buffer);
    }

    const cosKey = `images/${subdir}/${filename}`;
    const cosUrl = await uploadToCOS(cosKey, buffer);
    if (cosUrl) return cosUrl;

    return localUrl;
  } catch (e: any) {
    console.error(`downloadAndSaveImage error:`, e.message);
    return null;
  }
}

// ============ 主入口：处理内容中的图片 ============

/**
 * 处理内容中的图片：下载到本地存储 + 上传腾讯云 COS，替换为 COS URL
 */
export async function processImages(content: string, sourceType = 'rss'): Promise<string> {
  await ensureCacheLoaded();

  let result = content;

  const imgPattern = /__IMG__(.+?)__IMG__/g;
  const mdImgPattern = /(!\[(.*?)\])\((.+?)\)/g;

  const imgUrls = new Map<string, string>();
  for (const match of result.matchAll(imgPattern)) {
    const originalUrl = match[1]!;
    if (originalUrl.startsWith('http://localhost:8085') || originalUrl.startsWith('https://localhost:8085')) continue;

    const cachedPath = imgCache.get(originalUrl);
    if (cachedPath) {
      imgUrls.set(originalUrl, cachedPath);
    } else {
      imgUrls.set(originalUrl, '');
    }
  }

  const mdImgUrls = new Map<string, { alt: string; replacement: string }>();
  for (const match of result.matchAll(mdImgPattern)) {
    const altText = match[2] || '';
    const originalUrl = match[3]!;
    if (originalUrl.startsWith('http://localhost:8085') || originalUrl.startsWith('https://localhost:8085')) continue;
    if (originalUrl.startsWith('data:')) continue;

    const cachedPath = imgCache.get(originalUrl);
    if (cachedPath) {
      mdImgUrls.set(originalUrl, { alt: altText, replacement: `![${altText}](${cachedPath})` });
    } else {
      mdImgUrls.set(originalUrl, { alt: altText, replacement: '' });
    }
  }

  if (imgUrls.size === 0 && mdImgUrls.size === 0) return result;

  let cacheChanged = false;

  for (const [originalUrl, replacement] of imgUrls) {
    if (replacement) continue;
    try {
      const localPath = await downloadAndSaveImage(originalUrl, sourceType);
      if (localPath) {
        imgCache.set(originalUrl, localPath);
        cacheChanged = true;
        imgUrls.set(originalUrl, localPath);
      }
    } catch (e: any) {
      console.error(`图片下载失败 [${originalUrl}]:`, e.message);
    }
  }

  for (const [originalUrl, data] of mdImgUrls) {
    if (data.replacement) continue;
    try {
      const localPath = await downloadAndSaveImage(originalUrl, sourceType);
      if (localPath) {
        imgCache.set(originalUrl, localPath);
        cacheChanged = true;
        mdImgUrls.set(originalUrl, { alt: data.alt, replacement: `![${data.alt}](${localPath})` });
      }
    } catch (e: any) {
      console.error(`图片下载失败 [${originalUrl}]:`, e.message);
    }
  }

  if (cacheChanged) persistCache();

  for (const [originalUrl, replacement] of imgUrls) {
    if (replacement) {
      const regex = new RegExp(`__IMG__${escapeRegex(originalUrl)}__IMG__`, 'g');
      result = result.replace(regex, replacement);
    }
  }
  for (const [originalUrl, data] of mdImgUrls) {
    if (data.replacement) {
      const regex = new RegExp(`(!\\[)(.*?)(\\]\\(${escapeRegex(originalUrl)}\\))`, 'g');
      result = result.replace(regex, data.replacement);
    } else {
      // 图片下载失败时保留原始 URL，不删除（例如 WeChat mmbiz.qpic.cn 下载可能失败）
      const regex = new RegExp(`(!\[)(.*?)(\]\(${escapeRegex(originalUrl)}\))`, 'g');
      result = result.replace(regex, `$1$2(${originalUrl})`);
    }
  }

  // 在所有图片下载/上传/缓存替换完成后，将本地路径转为 COS URL
  const cosBase = getCosBaseUrl();
  if (cosBase) {
    result = result.replace(
      /(\/api\/images\/([^\s)\]]+))/g,
      (_, localPath) => `${cosBase}/images/${localPath.replace(/^\/api\/images\//, '')}`
    );
  }

  return result;
}
