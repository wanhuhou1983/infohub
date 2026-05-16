/**
 * YouTube 视频字幕下载路由
 *
 * 功能：
 * - POST /api/youtube/subtitle/check → 检查视频是否有原生字幕
 * - POST /api/youtube/subtitle       → 下载字幕并存入 extra.subtitle
 *
 * 依赖：yt-dlp（已安装，B站字幕也依赖它）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveArticleFile } from '../file-storage.js';

/**
 * 从 YouTube URL 中提取 videoId
 * 支持格式：https://www.youtube.com/watch?v=xxx 或 https://youtu.be/xxx
 */
function extractVideoId(url: string): string | null {
  const match = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?&]+)/);
  return match ? (match[1] ?? null) : null;
}

/**
 * 将 SRT 格式转换为纯文本（去除序号和时间轴）
 */
function srtToText(srt: string): string {
  return srt
    .replace(/\d+\n\d{2}:\d{2}:\d{2}[,\\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,\\.]\d{3}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

export function createYoutubeSubtitleRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ===== 检查视频是否有字幕 =====
  router.post('/subtitle/check', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      const [article] = await sql`
        SELECT a.url, a.extra FROM articles a
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      const videoUrl = article.url;
      if (!videoUrl) return c.json({ error: '文章无视频链接' }, 400);

      // 检查是否已有缓存字幕
      const extra = article.extra || {};
      if (extra.subtitle) {
        return c.json({ hasSubs: true, cached: true, message: '已缓存字幕' });
      }

      // 用 yt-dlp --list-subs 快速检查字幕可用性
      try {
        const output = execSync(
          `yt-dlp --list-subs --skip-download "${videoUrl}" 2>&1`,
          { timeout: 30_000, encoding: 'utf-8' }
        );
        const hasNoSubs = /has no subtitles/i.test(output);
        // 提取字幕语言
        const subLangs: string[] = [];
        const langLines = output.split('\n').filter(line => /^\s{2,}\S/.test(line) && !line.includes('---'));
        if (!hasNoSubs && langLines.length > 0) {
          langLines.forEach(line => {
            const lang = line.trim().split(/\s{2,}/)[0];
            if (lang) subLangs.push(lang);
          });
        }
        return c.json({ hasSubs: !hasNoSubs && subLangs.length > 0, subLangs, cached: false });
      } catch (e: any) {
        return c.json({ hasSubs: false, subLangs: [], cached: false, checkError: e.message });
      }
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ===== 下载字幕 =====
  router.post('/subtitle', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      // 1. 获取文章
      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 验证是 YouTube 文章
      if (!article.source_type?.startsWith('youtube')) {
        return c.json({ error: '仅支持 YouTube 文章' }, 400);
      }

      const videoUrl = article.url;
      if (!videoUrl) return c.json({ error: '文章无视频链接' }, 400);

      // 2. 检查是否已有缓存
      const extra = article.extra || {};
      if (extra.subtitle) {
        return c.json({ ok: true, subtitle: extra.subtitle, cached: true });
      }

      // 创建临时输出目录
      const outDir = join(tmpdir(), `yt-sub-${articleId}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });

      let transcriptText = '';

      // 3. 用 yt-dlp 下载字幕
      try {
        const subDir = join(outDir, 'subs');
        mkdirSync(subDir, { recursive: true });
        const subOutput = execSync(
          `yt-dlp --write-subs --sub-langs all --skip-download -o "${subDir}/sub" "${videoUrl}" 2>&1`,
          { timeout: 60_000, encoding: 'utf-8' }
        );
        // 查找生成的字幕文件（优先选中文，其次英文，再取第一个）
        const subFiles = readdirSync(subDir).filter(
          f => f.endsWith('.srt') || f.endsWith('.ass') || f.endsWith('.vtt')
        );
        if (subFiles.length > 0) {
          // 优先选中文或英文
          const preferred = subFiles.find(f => /\.(zh|chi|cn|en)\b/i.test(f)) || subFiles[0];
          if (preferred) {
            const srtContent = readFileSync(join(subDir, preferred), 'utf-8');
            transcriptText = srtToText(srtContent);
            console.log(`[YouTube字幕] 下载成功: ${videoUrl} → ${preferred}`);
          }
        }
      } catch (e: any) {
        console.log(`[YouTube字幕] 下载失败: ${(e.message || '').slice(0, 150)}`);
        // 清理临时目录后返回错误
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return c.json({ error: `字幕下载失败: ${e.message || '未知错误'}` }, 500);
      }

      if (!transcriptText) {
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
        return c.json({ error: '该视频没有可用字幕（尝试使用自动生成字幕，但 yt-dlp 不支持直接下载自动字幕）' }, 404);
      }

      // 5. 存入数据库缓存
      await sql`
        UPDATE articles
        SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{subtitle}', ${sql.json(transcriptText)})
        WHERE id = ${articleId}
      `;

      // 6. 更新 OB 文件中的衍生区块
      try {
        const [updatedArticle] = await sql`
          SELECT a.*, s.name AS source_name, s.type AS source_type
          FROM articles a LEFT JOIN sources s ON a.source_id = s.id
          WHERE a.id = ${articleId}
        `;
        if (updatedArticle) {
          await saveArticleFile(articleId, updatedArticle.content || '', {
            id: articleId,
            title: updatedArticle.title,
            source_type: updatedArticle.source_type || 'unknown',
            source_name: updatedArticle.source_name || '',
            url: updatedArticle.url,
            published_at: updatedArticle.published_at,
            category: updatedArticle.category,
            tags: updatedArticle.tags || [],
            author: updatedArticle.author,
            is_read: updatedArticle.is_read,
            is_starred: updatedArticle.is_starred,
            content_hash: updatedArticle.content_hash,
            extra: updatedArticle.extra,
          });
        }
      } catch (e: any) {
        console.error(`[YouTube字幕] OB 更新失败 [id=${articleId}]:`, e.message);
      }

      // 清理临时目录
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }

      return c.json({ ok: true, subtitle: transcriptText, cached: false });
    } catch (e: any) {
      console.error('[YouTube字幕] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
