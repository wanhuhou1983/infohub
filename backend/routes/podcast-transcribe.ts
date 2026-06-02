/**
 * 播客转录路由
 *
 * 功能：
 * - POST /api/podcast/transcribe → 下载播客音频 + 转录为文字
 *   1. 先检查是否已有缓存字幕（extra.subtitle）
 *   2. 调用 podcast_audio.py 获取音频 URL
 *   3. 下载音频，调用 bili-transcribe.sh 的 whisper 转录
 *   4. 结果存入 articles.extra.subtitle 字段
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { tmpdir } from 'os';

export function createPodcastTranscribeRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ===== 转录播客音频 =====
  router.post('/transcribe', async (c) => {
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

      // 验证是播客文章
      if (article.source_type !== 'podcast-channel') {
        return c.json({ error: '仅支持播客文章' }, 400);
      }

      // 2. 检查是否已有缓存
      const extra = article.extra || {};
      if (extra.subtitle) {
        return c.json({ ok: true, subtitle: extra.subtitle, cached: true });
      }

      const trackUrl = article.url;
      if (!trackUrl) return c.json({ error: '文章无播放链接' }, 400);

      const platform = extra.platform || 'XimalayaMusicClient';

      // 3. 获取音频 URL
      const scriptPath = fileURLToPath(new URL('../../scripts/podcast_audio.py', import.meta.url));
      const venvPath = fileURLToPath(new URL('../../.venv311/bin/python3', import.meta.url));
      const pythonBin = existsSync(venvPath) ? venvPath : (process.platform === 'win32' ? 'python' : 'python3');

      let audioUrl = '';
      if (platform === 'XimalayaMusicClient' || platform === 'ximalaya') {
        const audioResult = execSync(
          `"${pythonBin}" "${scriptPath}" --url "${trackUrl.replace(/"/g, '\\"')}"`,
          { timeout: 20000, encoding: 'utf-8' }
        );
        const audioData = JSON.parse(audioResult);
        if (!audioData.ok) return c.json({ error: audioData.error || '获取音频 URL 失败' }, 500);
        audioUrl = audioData.audio_url;
      } else {
        return c.json({ error: `暂不支持 ${platform} 的转录` }, 400);
      }

      if (!audioUrl) return c.json({ error: '无法获取音频 URL' }, 500);

      // 4. 创建临时输出目录
      const outDir = join(tmpdir(), `podcast-trans-${articleId}-${Date.now()}`);
      mkdirSync(outDir, { recursive: true });

      let transcriptText = '';

      try {
        // 5. 下载音频
        const audioFile = join(outDir, 'audio.mp3');
        console.log(`[播客转录] 下载音频: ${audioUrl}`);
        execSync(
          `curl -sL -o "${audioFile}" "${audioUrl.replace(/"/g, '\\"')}"`,
          { timeout: 5 * 60 * 1000, encoding: 'utf-8' }
        );

        if (!existsSync(audioFile)) {
          throw new Error('音频下载失败');
        }

        // 6. 调用 whisper 转录
        const biliTranscribeSh = join(
          process.env.HOME || '/root',
          '.workbuddy/skills/bilibili/scripts/bili-transcribe.sh'
        );

        if (existsSync(biliTranscribeSh)) {
          console.log(`[播客转录] 开始转录: ${audioFile}`);
          execSync(
            `"${biliTranscribeSh}" "${audioFile}" "${outDir}"`,
            { timeout: 30 * 60 * 1000, encoding: 'utf-8' }
          );

          // 查找生成的文字稿文件
          const files = readdirSync(outDir);
          const transcriptFile = files.find(f =>
            f.endsWith('_文字稿.md') || f.endsWith('.txt')
          );
          if (transcriptFile) {
            transcriptText = readFileSync(join(outDir, transcriptFile), 'utf-8');
          }
        }

        // 如果没有 bili-transcribe.sh，尝试用 Python whisper
        if (!transcriptText) {
          try {
            console.log(`[播客转录] 尝试用 whisper 直接转录`);
            const whisperResult = execSync(
              `"${pythonBin}" -c "
import whisper
model = whisper.load_model('base')
result = model.transcribe('${audioFile.replace(/'/g, "'\\''")}', language='zh')
print(result['text'])
"`,
              { timeout: 30 * 60 * 1000, encoding: 'utf-8' }
            );
            transcriptText = whisperResult.trim();
          } catch (whisperErr: any) {
            console.error('[播客转录] whisper 失败:', whisperErr.message);
            transcriptText = '';
          }
        }

        if (!transcriptText) {
          return c.json({ error: '转录失败，未能生成文字稿' }, 500);
        }

        // 7. 存入数据库缓存
        await sql`
          UPDATE articles
          SET extra = jsonb_set(COALESCE(extra, '{}'::jsonb), '{subtitle}', ${sql.json(transcriptText)})
          WHERE id = ${articleId}
        `;

        return c.json({ ok: true, subtitle: transcriptText, cached: false });
      } catch (e: any) {
        console.error('[播客转录] 错误:', e.message);
        return c.json({ error: `转录失败: ${e.message}` }, 500);
      } finally {
        try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch (e: any) {
      console.error('[播客转录] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
