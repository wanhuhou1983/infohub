// @ts-nocheck
/**
 * 爬虫服务模块
 * 
 * 从 routes/fetch.ts 拆分出来的文章抓取相关功能
 * 包含：MinerU 全文抓取、微信公众号 Spider 抓取
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIDER_DIR = process.env.SPIDER_DIR || path.resolve(__dirname, '../../wechat-article-spider');
const PYTHON_CMD = path.join(SPIDER_DIR, '.venv/bin/python3');
const MINERU_SCRIPT = process.env.MINERU_SCRIPT || path.join(
  process.env.HOME || '/root', '.workbuddy/skills/mineru-extract/scripts/mineru_extract.py'
);

// ============ 辅助函数：去除正文末尾的评论区 ============
export function stripCommentSection(content: string): string {
  // 按行分割，逐行扫描
  const lines = content.split('\n');
  const commentMarkers = [
    /^#+\s*(网友评论|热门评论|全部评论|评论|评论区|发表评论|我来说两句)/,
    /^\*\*(网友评论|热门评论|全部评论|评论|评论区)\*\*/,
    /^【(网友评论|热门评论|精彩评论|评论)】/,
    /^分享到[：:]/,
    /^(网友评论|全部评论|热门评论)\s*$/,
  ];

  let cutIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const marker of commentMarkers) {
      if (marker.test(line)) {
        cutIndex = i;
        break;
      }
    }
    if (cutIndex >= 0) break;
  }

  if (cutIndex >= 0) {
    return lines.slice(0, cutIndex).join('\n').trim();
  }
  return content;
}

// ============ 辅助函数：调用 MinerU 抓取正文 ============
export async function crawlArticleContent(articleUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [MINERU_SCRIPT, articleUrl, '--model', 'MinerU-HTML', '--print'];
    const proc = spawn('python3', args, {
      cwd: path.dirname(MINERU_SCRIPT),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // 🔒 Bug 1 修复：添加 30 秒超时，防止进程永久挂起
    // 🛡️ 遗留隐患 3：SIGTERM 后加 3 秒 SIGKILL 兜底
    const timeout = setTimeout(() => {
      console.warn(`[MinerU] 超时，强制终止: ${articleUrl}`);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 3000);
      resolve(null);
    }, 30000);

    const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB 上限
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) { proc.kill('SIGKILL'); stdout = stdout.slice(0, MAX_OUTPUT); }
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !stdout.trim()) {
        console.error(`MinerU error: ${stderr}`);
        resolve(null);
        return;
      }
      // 清理 MinerU 输出的图片格式，转换为 __IMG__ 标记
      let content = stdout
        .replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, '__IMG__$1__IMG__')
        .replace(/<img.*?src=["'](https?:\/\/[^"']+)["'].*?>/g, '__IMG__$1__IMG__');
      // 去除评论区
      content = stripCommentSection(content);
      resolve(content);
    });
  });
}

// ============ 辅助函数：调用 wechat-article-spider v2.0 (Playwright + markdownify) 抓取正文 ============
export async function crawlWechatArticle(articleUrl: string): Promise<{ title: string; content: string; author: string; publishDate: string } | null> {
  // Node.js fetch fallback: try direct HTTP extraction first (no Python dependency)
  // WeChat articles are public and can be parsed from HTML
  try {
    const resp = await fetch(articleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    });
    if (resp.ok) {
      const html = await resp.text();
      const titleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/);
      const authorMatch = html.match(/<span[^>]*id="js_author_name"[^>]*>([^<]+)<\/span>/);
      const dateMatch = html.match(/<em[^>]*id="publish_time"[^>]*>([^<]+)<\/em>/);
      const descMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/);

      // Extract content: find the js_content div (WeChat's rich text container)
      const contentMatch = html.match(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>/);
      let content = '';
      if (contentMatch) {
        content = contentMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')       // <br> → newline
          .replace(/<[^>]+>/g, '')                 // strip all HTML tags
          .replace(/\n{3,}/g, '\n\n')           // collapse multiple newlines
          .replace(/&nbsp;/g, ' ')                 // HTML entities
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .trim();
      }

      const title = titleMatch?.[1]?.replace(/^\d+[：:]\s*/, '') || '';
      const author = authorMatch?.[1]?.trim() || '';
      const publishDate = dateMatch?.[1]?.trim() || '';
      const summary = descMatch?.[1] || '';

      if (resp.ok) {
        console.log(`[WeChat fetch] OK: ${title.slice(0, 40)}`);
        return { title, content: content || summary, author, publishDate };
      }
    }
  } catch (e: any) {
    console.warn('[WeChat fetch] HTML fallback failed, trying spider:', e.message);
  }

  // Python spider fallback
  return new Promise((resolve) => {
    const outputDir = path.join(SPIDER_DIR, 'output');

    // 记录运行前的 output 目录内容
    let before: Set<string> = new Set();
    try {
      before = new Set(readdirSync(outputDir));
    } catch { /* output dir may not exist yet */ }

    const args = ['scripts/main.py', articleUrl];
    const proc = spawn(PYTHON_CMD, args, {
      cwd: SPIDER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';

    // 120 秒超时（v2.0 需要启动 Firefox，首次较慢）
    const timeout = setTimeout(() => {
      console.warn(`[WeChat Spider v2] 超时，强制终止: ${articleUrl}`);
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 3000);
      resolve(null);
    }, 120000);

    proc.stdout.on('data', () => { /* ignore, progress info */ });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`Wechat spider v2 error: ${stderr}`);
        resolve(null);
        return;
      }

      try {
        // v2.0 输出格式: output/<safe_title>/<safe_title>.md
        const now = new Set(readdirSync(outputDir));
        const newDirs = [...now].filter(d => !before.has(d) && statSync(path.join(outputDir, d)).isDirectory());
        // 按修改时间排序，取最新的
        newDirs.sort((a, b) => statSync(path.join(outputDir, b)).mtimeMs - statSync(path.join(outputDir, a)).mtimeMs);

        if (newDirs.length === 0) {
          // fallback: 全局搜索最新 .md
          const fallback = readdirSync(outputDir)
            .filter(d => statSync(path.join(outputDir, d)).isDirectory())
            .map(d => ({ dir: d, mtime: statSync(path.join(outputDir, d)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (fallback.length === 0) { resolve(null); return; }
          newDirs.push(fallback[0]!.dir);
        }

        const articleDir = newDirs[0]!;
        const mdFile = path.join(outputDir, articleDir, `${articleDir}.md`);
        if (!existsSync(mdFile)) { resolve(null); return; }

        const content = readFileSync(mdFile, 'utf-8');

        // 解析 v2.0 YAML frontmatter
        let title = '';
        let author = '';
        let publishDate = '';
        let body = content;

        if (content.startsWith('---')) {
          const endIdx = content.indexOf('---', 3);
          if (endIdx > 0) {
            const fm = content.slice(3, endIdx).trim();
            body = content.slice(endIdx + 3).trim();

            for (const line of fm.split('\n')) {
              const tMatch = line.match(/^title:\s*"(.*)"\s*$/);
              if (tMatch) { title = tMatch[1]!; continue; }
              const aMatch = line.match(/^author:\s*"(.*)"\s*$/);
              if (aMatch) { author = aMatch[1]!; continue; }
              const dMatch = line.match(/^date:\s*"(.*)"\s*$/);
              if (dMatch) { publishDate = dMatch[1]!; continue; }
            }
          }
        }

        // fallback: 从正文提取标题
        if (!title) {
          const h1Match = body.match(/^#\s+(.+)$/m);
          title = h1Match?.[1] || '无标题';
        }

        // ===== 处理 v2.0 本地图片 =====
        // v2.0 输出图片路径为相对路径: images/xxx.png
        // 需要迁移到 InfoHub 的图床存储目录，并替换为 /api/images/wechat/xxx
        const imgDirInOutput = path.join(outputDir, articleDir, 'images');
        if (existsSync(imgDirInOutput)) {
          const INFOHUB_IMAGES_DIR = path.resolve(SPIDER_DIR, '..', 'infohub', 'data', 'images', 'wechat');
          mkdirSync(INFOHUB_IMAGES_DIR, { recursive: true });

          // 匹配 ![](images/xxx) 格式
          const imgRefRegex = /(!\[.*?\])\(images\/([^)]+)\)/g;
          body = body.replace(imgRefRegex, (match: string, prefix: string, imgFile: string) => {
            const localPath = path.join(imgDirInOutput, imgFile);
            if (!existsSync(localPath)) return match; // 保留原始引用，跳过无法找到的文件

            try {
              const buffer = readFileSync(localPath);
              const hash = createHash('md5').update(buffer).digest('hex').slice(0, 16);
              // 推断扩展名
              const ext = imgFile.endsWith('.png') ? 'png'
                : imgFile.endsWith('.gif') ? 'gif'
                : imgFile.endsWith('.webp') ? 'webp'
                : imgFile.endsWith('.jpeg') ? 'jpeg'
                : imgFile.endsWith('.jpg') ? 'jpg'
                : 'png'; // 默认
              const filename = `${hash}.${ext}`;
              const destPath = path.join(INFOHUB_IMAGES_DIR, filename);

              if (!existsSync(destPath)) {
                writeFileSync(destPath, buffer);
              }
              return `${prefix}(/api/images/wechat/${filename})`;
            } catch {
              return match; // 保留原始引用
            }
          });
        }

        resolve({
          title: title || '无标题',
          content: body,
          author: author || '',
          publishDate: publishDate || '',
        });
      } catch (e: any) {
        console.error(`Parse v2 markdown error: ${e.message}`);
        resolve(null);
      }
    });
  });
}
