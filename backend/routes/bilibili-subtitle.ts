/**
 * B站视频字幕/转录路由
 *
 * 功能：
 * - POST /api/bilibili/subtitle → 下载字幕或转录视频
 *   1. 先尝试通过 yt-dlp 直接下载已有字幕
 *   2. 无字幕则调用 bili-transcribe.sh 下载音频 + whisper.cpp 转录
 *   3. 结果存入 articles.extra.subtitle 字段
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { execSync, exec } from 'child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveArticleFile, hashString } from '../file-storage.js';

// 脚本路径
const BILI_TRANSCRIBE_SH = join(
  process.env.HOME || '/root',
  '.workbuddy/skills/bilibili/scripts/bili-transcribe.sh'
);

export function createBilibiliSubtitleRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ===== 检查视频是否有原生字幕 =====
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
        // 检查输出中是否有字幕语言列表（无字幕时输出包含 "has no subtitles"）
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
        // yt-dlp 失败时保守返回无字幕
        return c.json({ hasSubs: false, subLangs: [], cached: false, checkError: e.message });
      }
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

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

      // 验证是 B 站文章
      if (!article.source_type?.startsWith('bilibili')) {
        return c.json({ error: '仅支持 B 站文章' }, 400);
      }

      const videoUrl = article.url;
      if (!videoUrl) return c.json({ error: '文章无视频链接' }, 400);

      // 2. 检查是否已有缓存
      const extra = article.extra || {};
      if (extra.subtitle) {
        return c.json({ ok: true, subtitle: extra.subtitle, cached: true });
      }

      // 创建临时输出目录
      const outDir = join(tmpdir(), `bili-sub-${articleId}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });

      let transcriptText = '';

      // 3. 先尝试直接下载已有字幕
      try {
        const subDir = join(outDir, 'subs');
        mkdirSync(subDir, { recursive: true });
        const subOutput = execSync(
          `yt-dlp --write-subs --sub-langs all --skip-download -o "${subDir}/sub" "${videoUrl}" 2>&1`,
          { timeout: 30_000, encoding: 'utf-8' }
        );
        // 查找生成的字幕文件
        const subFiles = readdirSync(subDir).filter(f => f.endsWith('.srt') || f.endsWith('.ass') || f.endsWith('.vtt'));
        if (subFiles.length > 0 && subFiles[0]) {
          // 读取第一个字幕文件
          const srtContent = readFileSync(join(subDir, subFiles[0]), 'utf-8');
          // 从 SRT 提取纯文本
          transcriptText = srtToText(srtContent);
          console.log(`[B站字幕] 直接从视频下载字幕成功: ${videoUrl}`);
        }
      } catch (e: any) {
        console.log(`[B站字幕] 无可下载的字幕，准备转录: ${(e.message || '').slice(0, 100)}`);
      }

      // 4. 无字幕 => 转录
      if (!transcriptText) {
        console.log(`[B站字幕] 开始转录: ${videoUrl}`);
        const scriptPath = BILI_TRANSCRIBE_SH;
        if (!existsSync(scriptPath)) {
          return c.json({ error: `转录脚本不存在: ${scriptPath}` }, 500);
        }

        await new Promise<void>((resolve, reject) => {
          exec(
            `"${scriptPath}" "${videoUrl}" "${outDir}"`,
            { timeout: 30 * 60 * 1000 }, // 30 分钟超时
            (error, stdout, stderr) => {
              if (error) {
                console.error('[B站字幕] 转录错误:', stderr);
                reject(new Error(error.message || '转录失败'));
                return;
              }
              console.log('[B站字幕] 转录完成:', stdout.slice(0, 200));
              resolve();
            }
          );
        });

        // 查找生成的文字稿文件（*_文字稿.md）
        const files = readdirSync(outDir);
        const transcriptFile = files.find(f => f.endsWith('_文字稿.md'));
        if (!transcriptFile) {
          // 尝试找 .txt 文件
          const txtFile = files.find(f => f.endsWith('.txt') && !f.endsWith('.wav'));
          if (txtFile) {
            transcriptText = readFileSync(join(outDir, txtFile), 'utf-8');
          } else {
            return c.json({ error: '转录脚本未生成文字稿文件' }, 500);
          }
        } else {
          transcriptText = readFileSync(join(outDir, transcriptFile), 'utf-8');
        }
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
        console.error(`[B站字幕] OB 更新失败 [id=${articleId}]:`, e.message);
      }

      // 清理临时目录
      try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }

      return c.json({ ok: true, subtitle: transcriptText, cached: false });
    } catch (e: any) {
      console.error('[B站字幕] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
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
