import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// ============ 配置 ============

const DATA_DIR = process.env.DATA_DIR || join(import.meta.dir, '..', 'data');
const IMGBED_URL = process.env.IMGBED_URL || 'http://localhost:8085/api/';
const IMGBED_BASE = process.env.IMGBED_BASE || 'http://localhost:8085';
const IMGBED_TOKEN = process.env.IMGBED_TOKEN || '1c17b11693cb5ec63859b091c5b9c1b2';

// 图片 URL 缓存：远程 URL -> 图床 URL（避免重复上传）
const imgCache = new Map<string, string>();

/**
 * 标准化日期为 ISO 格式 (YYYY-MM-DDTHH:mm:ss)
 */
function normalizeDate(val: string | null | undefined): string {
  if (!val) return '';
  const str = String(val);
  // 尝试解析为 Date
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 19);
  }
  // 回退：直接截取
  return str.slice(0, 19);
}

// ============ 目录结构 ============
// data/
// ├── xwlb/2026-04-22_标题.md
// ├── rss/feed名_标题.md
// ├── wechat/公号名_标题.md
// └── index.json  (article_id -> filepath 映射)

interface ArticleMeta {
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
  // 格式: 日期_标题前30字.md
  const pubStr = meta.published_at ? String(meta.published_at) : '';
  let dateStr: string;
  // 尝试从 published_at 提取 YYYY-MM-DD 格式
  const isoMatch = pubStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    dateStr = isoMatch[1] + isoMatch[2] + isoMatch[3];
  } else {
    dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  let titlePart = (meta.title || 'untitled')
    .replace(/[\/\\:*?"<>|\n\r]/g, '')  // 去掉非法字符
    .replace(/\s+/g, '_')
    .slice(0, 40);

  // 如果有 source_name，加入
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

  // 将 __IMG__url__IMG__ 转为 Markdown 图片语法
  const mdContent = content.replace(/__IMG__(.+?)__IMG__/g, (_, url) => {
    return `![](${url})`;
  });

  return `---\n${fmLines}\n---\n\n# ${meta.title}\n\n${mdContent}\n`;
}

/**
 * 处理内容中的图片：上传到 EasyImages 图床，替换为图床 URL
 */
async function processImages(content: string): Promise<string> {
  // 处理 __IMG__url__IMG__ 格式的图片标记
  const imgPattern = /__IMG__(.+?)__IMG__/g;
  const matches = [...content.matchAll(imgPattern)];

  // 也处理 Markdown 图片语法 ![](url)
  const mdImgPattern = /!\[\]\((.+?)\)/g;
  const mdMatches = [...content.matchAll(mdImgPattern)];

  if (matches.length === 0 && mdMatches.length === 0) return content;

  let result = content;

  // 处理 __IMG__ 格式
  for (const match of matches) {
    const originalUrl = match[1];

    // 检查缓存
    if (imgCache.has(originalUrl)) {
      result = result.replace(match[0], `__IMG__${imgCache.get(originalUrl)}__IMG__`);
      continue;
    }

    // 如果已经是图床 URL，跳过
    if (originalUrl.startsWith(IMGBED_BASE)) continue;

    // 上传到图床
    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        result = result.replace(match[0], `__IMG__${imgbedUrl}__IMG__`);
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  // 处理 Markdown ![](url) 格式（如 kindle4rss 代理的图片）
  for (const match of mdMatches) {
    const originalUrl = match[1];

    // 跳过已经是图床的 URL
    if (originalUrl.startsWith(IMGBED_BASE)) continue;

    // 跳过 data URI
    if (originalUrl.startsWith('data:')) continue;

    // 检查缓存
    if (imgCache.has(originalUrl)) {
      result = result.replace(match[0], `![](${imgCache.get(originalUrl)})`);
      continue;
    }

    // 上传到图床
    try {
      const imgbedUrl = await uploadToImgbed(originalUrl);
      if (imgbedUrl) {
        imgCache.set(originalUrl, imgbedUrl);
        result = result.replace(match[0], `![](${imgbedUrl})`);
      }
    } catch (e: any) {
      console.error(`图片上传失败 [${originalUrl}]:`, e.message);
    }
  }

  return result;
}

/**
 * 上传图片到 EasyImages 图床
 */
async function uploadToImgbed(imageUrl: string): Promise<string | null> {
  try {
    // 1. 下载图片
    const imgResponse = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
    });
    if (!imgResponse.ok) return null;

    const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
    const blob = await imgResponse.blob();

    // 2. 确定文件扩展名
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('gif') ? 'gif'
      : contentType.includes('webp') ? 'webp'
      : 'jpg';

    const filename = `infohub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // 3. 上传到 EasyImages (字段名: image, token 作为 POST 参数)
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
      // EasyImages 返回相对路径如 /uploads/2026/04/22/xxx.png
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

/**
 * 全量同步：从数据库导出所有文章到本地文件
 * 传入 sql 查询函数
 */
export async function syncAllFiles(
  queryFn: (sql: string) => Promise<any[]>,
  updateFn?: (id: number, content: string) => Promise<void>
): Promise<{ total: number; synced: number; errors: number }> {
  let total = 0;
  let synced = 0;
  let errors = 0;

  // 分批查询，避免一次性加载太多
  const batchSize = 100;
  let offset = 0;

  while (true) {
    const rows = await queryFn(
      `SELECT a.id, a.title, a.content, a.url, a.published_at, a.category, a.tags, a.author, a.is_read, a.is_starred,
              s.name AS source_name, s.type AS source_type
       FROM articles a
       LEFT JOIN sources s ON a.source_id = s.id
       ORDER BY a.id
       LIMIT ${batchSize} OFFSET ${offset}`
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      total++;
      if (!row.content || row.content.length < 10) {
        // 正文太短，跳过（懒加载后再次同步会补上）
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
        // 如果图片被替换了，更新 DB
        if (processedContent !== row.content) {
          // 需要通过回调更新 DB（避免 file-storage 直接依赖数据库连接）
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

    // 如果这批不满，说明到末尾了
    if (rows.length < batchSize) break;
  }

  return { total, synced, errors };
}
