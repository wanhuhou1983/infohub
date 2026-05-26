// @ts-nocheck
/**
 * 播客转录路由
 * 
 * 包含 Whisper Windows API 转录功能
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { timingSafeEqual } from 'node:crypto';
import { saveArticleFile } from '../file-storage.js';

export const WHISPER_TRANSCRIBE_PREVIEW_SEC = Number(process.env.WHISPER_TRANSCRIBE_PREVIEW_SEC || 600);
const WHISPER_WINDOWS_API_URL = process.env.WHISPER_WINDOWS_API_URL || 'http://172.31.240.1:8768';

export async function whisperWindowsTranscribe(audioUrl: string, durationSec: number = 600): Promise<string | null> {
  // Try Windows whisper-server.exe first, then Docker whisper server as fallback
  const windowsUrl = process.env.WHISPER_WINDOWS_API_URL || 'http://172.31.240.1:8768';
  const dockerUrl = process.env.WHISPER_DOCKER_URL || 'http://whisper-server:8768';

  async function tryServer(serverUrl: string, label: string): Promise<string | null> {
    try {
      console.log(`[whisper] ${label}: downloading ${audioUrl.slice(0, 80)}...`);
      const audioResp = await fetch(audioUrl, { signal: AbortSignal.timeout(300_000) });
      if (!audioResp.ok) {
        console.error(`[whisper] ${label}: download failed HTTP ${audioResp.status}`);
        return null;
      }

      // Use FormData for multipart upload (Bun supports this natively)
      const formData = new FormData();
      const audioBlob = await audioResp.blob();
      formData.append('file', audioBlob, 'audio.wav');
      formData.append('temperature', '0.0');
      formData.append('response_format', 'json');

      console.log(`[whisper] ${label}: sending ${audioBlob.size} bytes...`);
      const resp = await fetch(`${serverUrl}/inference`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(600_000),
      });
      if (!resp.ok) {
        console.error(`[whisper] ${label}: API error HTTP ${resp.status}`);
        return null;
      }
      const data = await resp.json() as any;
      const text = data.text || '';
      console.log(`[whisper] ${label}: got ${text.length} chars`);
      return text || null;
    } catch (e: any) {
      console.error(`[whisper] ${label}: ${e.message}`);
      return null;
    }
  }

  // Try Windows (GPU) first, then Docker (CPU)
  let result = await tryServer(windowsUrl, 'Windows');
  if (result) return result;
  result = await tryServer(dockerUrl, 'Docker');
  return result;
}

export function createTranscribeRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 播客转录 ============

  router.post('/transcribe/podcast', async (ctx) => {
    try {
      const { url, duration = 0, language = 'en' } = await ctx.req.json() as any;
      if (!url) return ctx.json({ ok: false, error: '缺少 url 参数' }, 400);
      const transcript = await whisperWindowsTranscribe(url, duration);
      if (!transcript) return ctx.json({ ok: false, error: '转录失败' }, 500);
      return ctx.json({ ok: true, audio_url: url, text: transcript });
    } catch (e: any) { return ctx.json({ ok: false, error: e.message }, 500); }
  });

  router.post('/transcribe/:id', async (c) => {
    try {
      const { id } = c.req.param();
      const auth = c.req.header('authorization');
      const expected = Buffer.from(`Bearer ${process.env.ADMIN_TOKEN ?? ''}`);
      const actual = Buffer.from(auth ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const [article] = await sql`SELECT id, title, url, extra FROM articles WHERE id = ${Number(id)}`;
      if (!article) return c.json({ error: 'Article not found' }, 404);
      const extra = typeof article.extra === 'string' ? JSON.parse(article.extra) : (article.extra || {});
      const audioUrl = extra.audio_url;
      if (!audioUrl) return c.json({ error: 'No audio URL' }, 400);

      const transcript = await whisperWindowsTranscribe(audioUrl, 0);
      if (!transcript) return c.json({ error: 'Transcription failed' }, 500);

      const transcriptContent = '> @ # 音频全文转录\n> \n> ' + transcript.slice(0,50000).split('\n').join('\n> ') + '\n\n---\n\n';
      const [existing] = await sql`SELECT content FROM articles WHERE id = ${Number(id)}`;
      const cleanContent = (existing?.content || '').replace(/^> .*?\n---\n\n/s, '');
      const newContent = transcriptContent + cleanContent;

      await sql`UPDATE articles SET content = ${newContent} WHERE id = ${Number(id)}`;
      saveArticleFile(Number(id), newContent, { id:Number(id), title:article.title, source_type:'rss', source_name:'', url:article.url, published_at:(new Date().toISOString()), category:'', tags:'', author:'', is_read:false, is_starred:false }).catch(()=>{});

      return c.json({ ok: true, text: transcript });
    } catch (e: any) { console.error('[transcribe] error:', e.message); return c.json({ error: e.message }, 500); }
  });

  // ============ 通用播客转录（POST url） ============

  return router;
}
