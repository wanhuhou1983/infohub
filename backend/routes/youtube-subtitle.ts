/**
 * YouTube 视频字幕提取路由（重写版）
 *
 * 取代旧的 yt-dlp 方案（本机未安装 yt-dlp，且不支持自动生成字幕）。
 * 新方案：
 *   1. 用 scripts/youtube_subtitle.py（youtube-transcript-api）提取字幕文本
 *      - 原生中文优先（zh-Hans / zh-CN / zh-Hant / zh-TW）
 *      - 无中文则取原文字幕（通常为英文 ASR）
 *   2. 若原文非中文，翻成中文：
 *      - 配置了 DEEPSEEK_API_KEY → 走 services/translate.ts（质量最佳）
 *      - 未配置 → 走 MyMemory 免 key 兜底（短超时，避免连不可达的本地模型挂死）
 *   3. 生成 srt（带时间轴）/ md / txt，保存到 data/subtitles/<articleId>/
 *   4. 文本写入 articles.extra.subtitle，元信息写入 extra.subtitle_files
 *
 * 端点：
 *   POST /api/youtube/subtitle/check   { article_id } → { hasSubs, subLangs, cached, needsTranslation }
 *   POST /api/youtube/subtitle         { article_id, force? } → { ok, subtitle(中文), cached, files, lang, translated, segmentCount }
 *   GET  /api/youtube/subtitle/file?article_id=N&fmt=srt|md|txt → 下载文件
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { execFileSync } from 'child_process';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { saveArticleFile } from '../file-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 项目根：backend/routes -> backend -> 项目根
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'youtube_subtitle.py');
const DATA_DIR = join(__dirname, '..', '..', 'data', 'subtitles');
// Python 解释器：优先项目 venv，可用 YT_PYTHON 覆盖，回退 python3
const PYTHON =
  process.env.YT_PYTHON ||
  join(__dirname, '..', '.venv', 'bin', 'python') ||
  'python3';

const ZH_CODES = new Set(['zh-Hans', 'zh-CN', 'zh-Hant', 'zh-TW', 'zh']);

interface Segment {
  text: string;
  start: number;
  duration: number;
}

function extractVideoId(url: string): string | null {
  const match =
    url.match(/[?&]v=([^&]+)/) ||
    url.match(/youtu\.be\/([^?&]+)/) ||
    url.match(/\/shorts\/([^?&]+)/) ||
    url.match(/\/live\/([^?&]+)/) ||
    url.match(/\/embed\/([^?&]+)/);
  return match ? match[1] || null : null;
}

function runPython(args: string[]): any {
  // 子进程需显式代理：后端由 launchd 启动时常无 HTTP_PROXY，直连 YouTube 会超时。
  // 默认走本机 Surge 代理（可用 YT_PROXY 覆盖）；若进程已有代理则沿用。
  const proxy =
    process.env.YT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    'http://127.0.0.1:61971';
  const env = { ...process.env };
  if (!env.HTTP_PROXY && !env.http_proxy) env.HTTP_PROXY = proxy;
  if (!env.HTTPS_PROXY && !env.https_proxy) env.HTTPS_PROXY = proxy;
  const out = execFileSync(PYTHON, [SCRIPT, ...args], {
    timeout: 180_000,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return JSON.parse(out);
}

function fmtSrtTime(sec: number): string {
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function toSrt(segments: Segment[]): string {
  return segments
    .map((s, i) => {
      const start = fmtSrtTime(s.start);
      const end = fmtSrtTime(s.start + (s.duration || 2));
      const text = (s.text || '').replace(/\r?\n/g, '\n');
      return `${i + 1}\n${start} --> ${end}\n${text}\n`;
    })
    .join('\n');
}

function toTxt(segments: Segment[]): string {
  return segments.map((s) => s.text || '').join('\n');
}

function toMd(title: string, url: string, lang: string, segments: Segment[]): string {
  const head = [
    `# ${title}`,
    '',
    `- 来源：${url}`,
    `- 原语言：${lang}`,
    `- 段数：${segments.length}`,
    `- 提取时间：${new Date().toISOString()}`,
    '',
    '---',
    '',
  ].join('\n');
  return head + segments.map((s) => s.text || '').join('\n\n');
}

export function createYoutubeSubtitleRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ===== 检查视频字幕可用性 =====
  router.post('/subtitle/check', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      const [article] = await sql`
        SELECT a.url, a.extra FROM articles a WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      const extra = article.extra || {};
      if (extra.subtitle_files?.srt) {
        return c.json({
          hasSubs: true,
          subLangs: extra.subtitle_files.lang ? [extra.subtitle_files.lang] : [],
          cached: true,
          needsTranslation: !extra.subtitle_files.lang?.startsWith('zh'),
        });
      }

      const videoId = extractVideoId(article.url || '');
      if (!videoId) return c.json({ error: '文章无有效视频链接' }, 400);

      try {
        const info = runPython(['check', '--video-id', videoId]);
        if (info.error) {
          return c.json({ hasSubs: false, subLangs: [], cached: false, checkError: info.error });
        }
        const codes = (info.available || []).map((a: any) => a.code);
        return c.json({
          hasSubs: (info.available || []).length > 0,
          subLangs: codes,
          cached: false,
          hasNativeZh: info.has_native_zh,
          needsTranslation: !info.has_native_zh,
          translatable: info.translatable,
        });
      } catch (e: any) {
        return c.json({ hasSubs: false, subLangs: [], cached: false, checkError: e.message });
      }
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ===== 提取并翻译字幕 =====
  router.post('/subtitle', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      const force = !!body.force;
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);
      if (!article.source_type?.startsWith('youtube')) {
        return c.json({ error: '仅支持 YouTube 文章' }, 400);
      }

      const videoId = extractVideoId(article.url || '');
      if (!videoId) return c.json({ error: '文章无有效视频链接' }, 400);

      const extra = article.extra || {};
      // 命中缓存（除非强制刷新）
      if (!force && extra.subtitle_files?.srt) {
        return c.json({
          ok: true,
          subtitle: extra.subtitle || '',
          cached: true,
          files: extra.subtitle_files,
          lang: extra.subtitle_files.lang,
          translated: extra.subtitle_files.translated,
          translatedVia: extra.subtitle_files.translatedVia,
          segmentCount: extra.subtitle_files.segmentCount,
        });
      }

      // 1. 提取字幕（--translate：非中文时翻成中文，由 Python 子进程处理，复用代理）
      let info: any;
      try {
        info = runPython(['extract', '--video-id', videoId, '--lang', 'auto', '--translate']);
      } catch (e: any) {
        const detail = e.stderr
          ? e.stderr.toString().slice(0, 400)
          : (e.message || '').slice(0, 400);
        return c.json({ error: `字幕提取失败（Python 执行错误）: ${detail}` }, 500);
      }
      if (info.error) {
        return c.json({ error: `字幕提取失败: ${info.error}` }, 404);
      }
      const srcLang: string = info.lang;
      const rawSegments: Segment[] = info.segments || [];
      if (rawSegments.length === 0) {
        return c.json({ error: '该视频没有任何字幕（含自动生成）' }, 404);
      }

      // 2. 翻译已在 Python 子进程完成（translated / translatedVia 由脚本返回）
      const needTranslate = !ZH_CODES.has(srcLang);
      const translated = !!info.translated;
      const translatedVia: string = info.translatedVia || 'none';
      const segments: Segment[] = rawSegments;

      // 3. 生成文件
      const outDir = join(DATA_DIR, String(articleId));
      mkdirSync(outDir, { recursive: true });
      const base = `youtube_${articleId}`;
      const srt = toSrt(segments);
      const txt = toTxt(segments);
      const md = toMd(article.title || '', article.url || '', srcLang, segments);
      writeFileSync(join(outDir, `${base}.srt`), srt, 'utf-8');
      writeFileSync(join(outDir, `${base}.txt`), txt, 'utf-8');
      writeFileSync(join(outDir, `${base}.md`), md, 'utf-8');

      const subtitleText = txt;
      const filesMeta = {
        srt: `/api/youtube/subtitle/file?article_id=${articleId}&fmt=srt`,
        txt: `/api/youtube/subtitle/file?article_id=${articleId}&fmt=txt`,
        md: `/api/youtube/subtitle/file?article_id=${articleId}&fmt=md`,
        lang: srcLang,
        translated,
        translatedVia,
        segmentCount: segments.length,
        generatedAt: new Date().toISOString(),
      };

      // 4. 写库缓存
      await sql`
        UPDATE articles
        SET extra = jsonb_set(
          COALESCE(extra, '{}'::jsonb),
          '{subtitle}', ${sql.json(subtitleText)}
        )
        WHERE id = ${articleId}
      `;
      await sql`
        UPDATE articles
        SET extra = jsonb_set(
          COALESCE(extra, '{}'::jsonb),
          '{subtitle_files}', ${sql.json(filesMeta)}
        )
        WHERE id = ${articleId}
      `;

      // 5. 更新 OB 文件
      try {
        const [updated] = await sql`
          SELECT a.*, s.name AS source_name, s.type AS source_type
          FROM articles a LEFT JOIN sources s ON a.source_id = s.id
          WHERE a.id = ${articleId}
        `;
        if (updated) {
          await saveArticleFile(articleId, updated.content || '', {
            id: articleId,
            title: updated.title,
            source_type: updated.source_type || 'unknown',
            source_name: updated.source_name || '',
            url: updated.url,
            published_at: updated.published_at,
            category: updated.category,
            tags: updated.tags || [],
            author: updated.author,
            is_read: updated.is_read,
            is_starred: updated.is_starred,
            content_hash: updated.content_hash,
            extra: updated.extra,
          });
        }
      } catch (e: any) {
        console.error(`[YouTube字幕] OB 更新失败 [id=${articleId}]:`, e.message);
      }

      return c.json({
        ok: true,
        subtitle: subtitleText,
        cached: false,
        files: filesMeta,
        lang: srcLang,
        translated,
        translatedVia,
        segmentCount: segments.length,
      });
    } catch (e: any) {
      console.error('[YouTube字幕] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // ===== 下载已生成的字幕文件 =====
  router.get('/subtitle/file', async (c) => {
    const articleId = Number(c.req.query('article_id'));
    const fmt = (c.req.query('fmt') || 'srt').toLowerCase();
    if (isNaN(articleId) || articleId <= 0) return c.json({ error: '无效 article_id' }, 400);
    if (!['srt', 'txt', 'md'].includes(fmt)) return c.json({ error: '不支持的格式' }, 400);

    const file = join(DATA_DIR, String(articleId), `youtube_${articleId}.${fmt}`);
    if (!existsSync(file)) return c.json({ error: '字幕文件不存在，请先提取' }, 404);

    const buf = readFileSync(file);
    const mime = fmt === 'srt' ? 'application/x-subrip' : fmt === 'md' ? 'text/markdown' : 'text/plain';
    const [art] = await sql`SELECT title FROM articles WHERE id = ${articleId}`;
    const fname = `${(art?.title || `youtube_${articleId}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.${fmt}`;
    return new Response(buf, {
      headers: {
        'Content-Type': `${mime}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Content-Length': String(statSync(file).size),
      },
    });
  });

  return router;
}
