// @ts-nocheck
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { translateToChinese, isEnglish, createConcurrencyPool } from './translate.js';
import { whisperWindowsTranscribe } from './transcribe.js';
import { saveArticleFile } from '../file-storage.js';

// ============ DeepSeek 重断句（播客转录/B站字幕后处理） ============
async function deepseekReparagraph(text: string, context: string): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个专业的文字整理助手。以下是一段语音识别/字幕转写的原始文本，可能没有段落划分、有重复、有断句错误。请：1. 按内容主题分成段落，每段加小标题 2. 修正明显的同音错字 3. 删除重复内容 4. 保持原意，不增删观点。输出只包含整理后的文本。' },
          { role: 'user', content: `来源：${context}\n\n原始文本：\n${text.slice(0, 30000)}` },
        ],
        max_tokens: 16384,
        temperature: 0,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return (data.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e: any) {
    console.error('[DeepSeek] 重断句失败:', e.message);
    return null;
  }
}



// ============ DeepSeek 批量标题翻译 ============
async function deepseekTranslateTitles(titles: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || titles.length === 0) return result;

  // Filter: only translate English titles (no Chinese chars, length >= 5)
  const englishTitles = titles.filter(t => t && t.length >= 5 && !/[\u4e00-\u9fff]/.test(t));
  if (englishTitles.length === 0) return result;

  try {
    const systemPrompt = '你是一位专业翻译。将用户提供的每行英文标题翻译成简洁准确的中文。请按顺序逐行输出中文翻译，不要加编号、引号或额外文字。专有名词保持原样。';
    const userContent = englishTitles.join('\n');
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 4000,
        temperature: 0,
      }),
    });
    if (!resp.ok) {
      console.error(`[DeepSeek] 标题翻译 API HTTP ${resp.status}`);
      return result;
    }
    const data = await resp.json() as any;
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const lines = text.split('\n').filter(l => l.trim());
    englishTitles.forEach((title, i) => {
      const translated = lines[i]?.trim();
      if (translated && translated !== title) {
        result.set(title, translated);
      }
    });
    console.log(`[DeepSeek] 标题翻译: ${result.size}/${englishTitles.length} 成功`);
  } catch (e: any) {
    console.error('[DeepSeek] 标题翻译失败:', e.message);
  }
  return result;
}

const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OB_DIR = process.env.OB_DIR || '/obsidian';

// ============ State ============
let _lastRunAt: string | null = null;
let _lastRunStatus: 'running' | 'success' | 'error' | null = null;
let _lastRunError: string | null = null;
let _isRunning = false;

// ============ Helper: call internal API ============
async function fetchApi(path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (adminToken) {
    headers['Authorization'] = `Bearer ${adminToken}`;
  }
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    return await resp.json();
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ============ Types ============
interface FetchResult {
  source: string;
  success: boolean;
  inserted: number;
  fetched?: number;
  error?: string;
}

interface SourceTitles {
  wechat: Map<string, string[]>;
  bilibili: Array<{ title: string; author: string }>;
  podcast: Array<{ title: string; channel: string }>;
  youtube: Array<{ title: string; channel: string }>;
  twitter: number;
  rss: number;
}

interface PostProcessStats {
  translated: number;
  transcribed: number;
  subtitles: number;
}

// ============ Phase 1: Parallel Fetch ============
async function phase1ParallelFetch(sql: Sql): Promise<FetchResult[]> {
  const settings = await loadCollectionSettings(sql);
  const s = settings.sources;

  const now = new Date();
  const todayCompact = now.toISOString().slice(0, 10).replace(/-/g, '');
  const todayDash = now.toISOString().slice(0, 10);
  const yesterdayCompact = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const yesterdayDash = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const fetches: Promise<FetchResult>[] = [
    // 报刊杂志: try today, then fallback to yesterday if 0 inserted
    ...(s.rmrb?.enabled !== false ? [(async () => {
      let r = await fetchApi('/fetch/rmrb', { date: todayDash });
      if (!r.inserted) r = await fetchApi('/fetch/rmrb', { date: yesterdayDash });
      return { source: '人民日报', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error };
    })()] : []),
    ...(s.xwlb?.enabled !== false ? [(async () => {
      let r = await fetchApi('/fetch/xwlb', { date: todayCompact });
      if (!r.inserted) r = await fetchApi('/fetch/xwlb', { date: yesterdayCompact });
      return { source: '新闻联播', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error };
    })()] : []),
    ...(s.penti?.enabled !== false ? [(async () => {
      let r = await fetchApi('/fetch/penti', { date: todayCompact });
      if (!r.inserted) r = await fetchApi('/fetch/penti', { date: yesterdayCompact });
      return { source: '喷嚏图卦', success: !!r.ok, inserted: r.inserted || 0, error: r.error };
    })()] : []),
    ...(s.wechat?.enabled !== false ? [fetchApi('/wechat-admin/refresh')
      .then(r => ({ source: '公众号', success: !!r.ok, inserted: r.inserted || 0, error: r.error }))] : []),
    ...(s.bilibili?.enabled !== false ? [fetchApi('/bilibili-admin/refresh')
      .then(r => ({ source: 'B站', success: !!r.ok, inserted: r.inserted || 0, fetched: r.fetched || 0, error: r.error }))] : []),
    ...(s.twitter?.enabled !== false ? [fetchApi('/twitter-admin/refresh')
      .then(r => ({ source: 'X/推特', success: !!r.ok, inserted: r.inserted || 0, error: r.error }))] : []),
    ...(s.youtube?.enabled !== false ? [fetchApi('/youtube-admin/refresh')
      .then(r => ({ source: 'YouTube', success: !!r.ok, inserted: r.inserted || 0, error: r.error }))] : []),
    ...(s.podcast?.enabled !== false ? [fetchApi('/podcast-admin/sync')
      .then(r => ({ source: '播客', success: !!r.ok, inserted: r.inserted || 0, error: r.error }))] : []),
  ];

  // RSS: query enabled sources, then fetch each
  let rssAgg: FetchResult = { source: 'RSS', success: true, inserted: 0 };
  try {
    const rssSources = await sql`
      SELECT id, name, config->>'feed_url' AS feed_url
      FROM sources
      WHERE enabled = true AND LOWER(type) IN ('rss', 'podcast-channel')
    `;
    const rssFetches = rssSources
      .filter(s => s.feed_url)
      .map(s =>
        fetchApi('/fetch/rss', { feedUrl: s.feed_url, sourceName: s.name })
          .then(r => ({ inserted: r.inserted || 0, ok: !!r.ok, error: r.error }))
      );
    const rssResults = await Promise.all(rssFetches);
    rssAgg = {
      source: 'RSS',
      success: rssResults.every(r => r.ok),
      inserted: rssResults.reduce((sum, r) => sum + r.inserted, 0),
      error: rssResults.filter(r => r.error).map((r: any) => r.error).join('; ') || undefined,
    };
  } catch (e: any) {
    rssAgg = { source: 'RSS', success: false, inserted: 0, error: e.message };
  }

  const results: FetchResult[] = [];
  const settled = await Promise.allSettled(fetches);
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      results.push({ source: '(unknown)', success: false, inserted: 0, error: s.reason?.message || String(s.reason) });
    }
  }
  results.push(rssAgg);
  return results;
}

// ============ Phase 2: Post-Processing (Translation, Transcription, Subtitles) ============
async function phase2PostProcess(sql: Sql): Promise<PostProcessStats> {
  const stats: PostProcessStats = { translated: 0, transcribed: 0, subtitles: 0 };
  const today = new Date().toISOString().slice(0, 10);

  // --- 2a: English Translation ---
  console.log('[scheduler] Phase 2a: English translation...');
  try {
    const engArticles = await sql`
      SELECT a.id, a.title, a.content, s.name, s.type
      FROM articles a JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND (s.type IN ('twitter', 'twitter-updates', 'youtube-updates', 'youtube-watch-later', 'youtube-favorites')
             OR (s.type = 'rss' AND a.content ~ '[a-zA-Z]{20,}'))
        AND (a.title ~ '[a-zA-Z]{10,}' OR a.content ~ '[a-zA-Z]{50,}')
        AND a.content NOT LIKE '%【中文翻译】%'
      ORDER BY a.id
      LIMIT 30
    `;

    if (engArticles.length > 0) {
      // GPU-bound: limit to 2 concurrent
      const translationLimit = createConcurrencyPool(2);
      const translationResults = await Promise.allSettled(
        engArticles.map((article: any) => translationLimit(async () => {
          const content = article.content || '';
          if (!isEnglish(content)) return;
          const translated = await translateToChinese(content);
          if (!translated || translated === content) return;

          const newContent = `【中文翻译】\n${translated}\n\n---\n【English Original】\n${content}`;

          await sql`UPDATE articles SET content = ${newContent} WHERE id = ${article.id}`;

          // Update OB file
          try {
            const [updated] = await sql`
              SELECT a.*, s.name AS source_name, s.type AS source_type
              FROM articles a LEFT JOIN sources s ON a.source_id = s.id
              WHERE a.id = ${article.id}
            `;
            if (updated) {
              await saveArticleFile(article.id, newContent, {
                id: article.id,
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
            console.error(`[scheduler] OB update failed for translation id=${article.id}:`, e.message);
          }

          stats.translated++;
        }))
      );
      const failed = translationResults.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        console.error(`[scheduler] Phase 2a: ${failed} translations failed`);
      }
    }

    // --- 2a-title: 翻译英文标题为中文 ---
    console.log('[scheduler] Phase 2a-title: translating titles...');
    try {
      const engTitleArticles = await sql`
        SELECT a.id, a.title
        FROM articles a JOIN sources s ON a.source_id = s.id
        WHERE a.fetched_at::date = ${today}
          AND (s.type IN ('twitter', 'twitter-updates', 'youtube-updates', 'youtube-watch-later', 'youtube-favorites')
               OR (s.type = 'rss' AND a.content ~ '[a-zA-Z]{20,}'))
          AND a.title ~ '[a-zA-Z]{10,}'
          AND a.title NOT LIKE '%[%'
          AND a.title NOT LIKE '%】%'
        ORDER BY a.id
        LIMIT 100
      `;
      if (engTitleArticles.length > 0) {
        const titles = engTitleArticles.map((r: any) => r.title);
        const titleMap = await deepseekTranslateTitles(titles);
        let titleCount = 0;
        for (const article of engTitleArticles) {
          const translated = titleMap.get(article.title);
          if (translated) {
            const newTitle = `${translated} [${article.title}]`;
            await sql`UPDATE articles SET title = ${newTitle} WHERE id = ${article.id}`;
            // Update OB file with new title
            try {
              const [updated] = await sql`
                SELECT a.*, s.name AS source_name, s.type AS source_type
                FROM articles a LEFT JOIN sources s ON a.source_id = s.id
                WHERE a.id = ${article.id}
              `;
              if (updated) {
                await saveArticleFile(article.id, updated.content, {
                  id: article.id, title: newTitle,
                  source_type: updated.source_type || 'unknown',
                  source_name: updated.source_name || '',
                  url: updated.url, published_at: updated.published_at,
                  category: updated.category, tags: updated.tags || [],
                  author: updated.author, is_read: updated.is_read,
                  is_starred: updated.is_starred, content_hash: updated.content_hash,
                  extra: updated.extra,
                });
              }
            } catch (e: any) {}
            titleCount++;
          }
        }
        console.log(`[scheduler] Phase 2a-title: ${titleCount} titles translated`);
      }
    } catch (e: any) {
      console.error('[scheduler] Phase 2a-title error:', e.message);
    }

    console.log(`[scheduler] Phase 2a complete: ${stats.translated} articles translated`);
  } catch (e: any) {
    console.error('[scheduler] Phase 2a error:', e.message);
  }

  // --- 2b: Podcast Transcription ---
  console.log('[scheduler] Phase 2b: Podcast transcription...');
  try {
    const podcastArticles = await sql`
      SELECT a.id, a.title, a.extra->>'audio_url' AS audio_url, s.name
      FROM articles a JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND s.type IN ('podcast-channel', 'rss')
        AND a.extra->>'audio_url' IS NOT NULL
        AND a.extra->>'audio_url' != ''
        AND a.content NOT LIKE '%音频转录%'
      ORDER BY a.id
      LIMIT 10
    `;

    // GPU-bound (Whisper): STRICTLY SERIAL
    for (const article of podcastArticles) {
      try {
        const audioUrl = article.audio_url;
        if (!audioUrl) continue;

        console.log(`[scheduler] Transcribing podcast: ${article.title} (${audioUrl})`);
        const transcript = await whisperWindowsTranscribe(audioUrl, 0);
        if (!transcript) {
          console.log(`[scheduler] Transcription returned null for id=${article.id}`);
          continue;
        }

        const originalContent = await sql`SELECT content FROM articles WHERE id = ${article.id}`;
        const content = originalContent[0]?.content || '';

        const newContent = `> 🎙️ 音频转录\n> \n> ${transcript}\n\n---\n\n${content}`;

        await sql`UPDATE articles SET content = ${newContent} WHERE id = ${article.id}`;

        // Update OB file
        try {
          const [updated] = await sql`
            SELECT a.*, s.name AS source_name, s.type AS source_type
            FROM articles a LEFT JOIN sources s ON a.source_id = s.id
            WHERE a.id = ${article.id}
          `;
          if (updated) {
            await saveArticleFile(article.id, newContent, {
              id: article.id,
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
          console.error(`[scheduler] OB update failed for transcription id=${article.id}:`, e.message);
        }

        stats.transcribed++;
      } catch (e: any) {
        console.error(`[scheduler] Transcription failed for id=${article.id}:`, e.message);
      }
    }
    console.log(`[scheduler] Phase 2b complete: ${stats.transcribed} podcasts transcribed`);
  } catch (e: any) {
    console.error('[scheduler] Phase 2b error:', e.message);
  }


  // --- 2b-2: B站字幕下载 + Whisper 转录 + DeepSeek 重断句 ---
  console.log('[scheduler] Phase 2b-2: Bilibili subtitle/audio processing...');
  try {
    const biliArticles = await sql`
      SELECT a.id, a.title, a.url, a.extra, s.name AS source_name, s.type AS source_type
      FROM articles a JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND s.type LIKE 'bilibili%'
        AND (a.content IS NULL OR a.content = '' OR a.content NOT LIKE '%字幕%')
        AND a.content NOT LIKE '%音频转录%'
        AND a.content NOT LIKE '%【整理后】%'
      ORDER BY a.id
      LIMIT 10
    `;

    if (biliArticles.length > 0) {
      const sessdata = await sql`
        SELECT config->>'sessdata' AS sessdata FROM sources
        WHERE type = 'bilibili' LIMIT 1
      `;
      const sd = sessdata[0]?.sessdata || '';

      for (const article of biliArticles) {
        try {
          const bvid = article.url?.match(/BV[a-zA-Z0-9]+/)?.[0];
          if (!bvid) continue;

          console.log(`[scheduler] Processing B站: ${article.title} (${bvid})`);

          // Step 1: Try to get subtitle via bili-service
          let subtitle = '';
          try {
            const subResp = await fetch('http://bili-service:8979/', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'subtitle', bvid, sessdata: sd }),
              signal: AbortSignal.timeout(30000),
            });
            if (subResp.ok) {
              const subData = await subResp.json() as any;
              if (subData.text) subtitle = subData.text;
            }
          } catch (e: any) {
            console.log(`[scheduler] B站字幕获取失败: ${e.message}`);
          }

          let processedContent = '';
          let transcript = '';

          if (subtitle) {
            transcript = subtitle;
            console.log(`[scheduler] Got subtitle for ${bvid}, calling DeepSeek...`);
          } else {
            // Step 2: No subtitle - try Whisper audio transcription
            try {
              const audioResp = await fetch('http://bili-service:8979/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'audio', bvid, sessdata: sd }),
                signal: AbortSignal.timeout(30000),
              });
              if (audioResp.ok) {
                const audioData = await audioResp.json() as any;
                if (audioData.audio_url) {
                  console.log(`[scheduler] Transcribing B站 audio for ${bvid}...`);
                  const whisperResult = await whisperWindowsTranscribe(audioData.audio_url, 0);
                  if (whisperResult) {
                    transcript = whisperResult;
                    console.log(`[scheduler] Whisper done for ${bvid}: ${transcript.length} chars`);
                  }
                }
              }
            } catch (e: any) {
              console.log(`[scheduler] B站音频转录失败: ${e.message}`);
            }
          }

          if (transcript) {
            // DeepSeek re-paragraph
            const reparagraphed = await deepseekReparagraph(transcript, article.title);
            if (reparagraphed && reparagraphed !== transcript) {
              processedContent = `【整理后】\n\n${reparagraphed}\n\n---\n\n【原始转录】\n${transcript}`;
            } else {
              processedContent = `【原始转录】\n\n${transcript}`;
            }
          } else if (subtitle) {
            processedContent = `【字幕】\n\n${subtitle}`;
          } else {
            console.log(`[scheduler] No transcript or subtitle for ${bvid}`);
            continue;
          }

          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${article.id}`;

          try {
            const [updated] = await sql`
              SELECT a.*, s.name AS source_name, s.type AS source_type
              FROM articles a LEFT JOIN sources s ON a.source_id = s.id
              WHERE a.id = ${article.id}
            `;
            if (updated) {
              await saveArticleFile(article.id, processedContent, {
                id: article.id, title: updated.title,
                source_type: updated.source_type || 'unknown',
                source_name: updated.source_name || '',
                url: updated.url, published_at: updated.published_at,
                category: updated.category, tags: updated.tags || [],
                author: updated.author,
                is_read: updated.is_read, is_starred: updated.is_starred,
                content_hash: updated.content_hash, extra: updated.extra,
              });
            }
          } catch (e: any) {
            console.error(`[scheduler] OB update failed for B站 id=${article.id}:`, e.message);
          }

          stats.transcribed++;
        } catch (e: any) {
          console.error(`[scheduler] B站 processing failed for id=${article.id}:`, e.message);
        }
      }
    }
    console.log(`[scheduler] Phase 2b-2 complete`);
  } catch (e: any) {
    console.error('[scheduler] Phase 2b-2 error:', e.message);
  }
  // --- 2c: Subtitle Download (Bilibili & YouTube) ---
  console.log('[scheduler] Phase 2c: Subtitle download...');
  try {
    const subtitleArticles = await sql`
      SELECT a.id, a.title, a.url, s.type
      FROM articles a JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND s.type IN ('bilibili', 'bilibili-watch-later', 'bilibili-updates', 'bilibili-favorites',
                        'youtube-updates', 'youtube-watch-later', 'youtube-favorites')
      ORDER BY a.id
    `;

    if (subtitleArticles.length > 0) {
      // Network I/O: parallel with max 3 concurrent
      const subtitleLimit = createConcurrencyPool(3);
      const subtitleResults = await Promise.allSettled(
        subtitleArticles.map((article: any) => subtitleLimit(async () => {
          const isBilibili = article.type.startsWith('bilibili');
          const apiPath = isBilibili ? '/bilibili-subtitle/subtitle' : '/youtube-subtitle/subtitle';
          const resp = await fetchApi(apiPath, { article_id: article.id });

          if (!resp.ok || !resp.subtitle) return;

          // Append subtitle text to article content
          const [row] = await sql`SELECT content, extra FROM articles WHERE id = ${article.id}`;
          const existingContent = row?.content || '';
          const subtitle = resp.subtitle;

          // Only append if not already present
          if (existingContent.includes(subtitle.slice(0, 100))) return;

          const newContent = `${existingContent}\n\n---\n\n${subtitle}`;

          await sql`UPDATE articles SET content = ${newContent} WHERE id = ${article.id}`;

          // Update OB file
          try {
            const [updated] = await sql`
              SELECT a.*, s.name AS source_name, s.type AS source_type
              FROM articles a LEFT JOIN sources s ON a.source_id = s.id
              WHERE a.id = ${article.id}
            `;
            if (updated) {
              await saveArticleFile(article.id, newContent, {
                id: article.id,
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
            console.error(`[scheduler] OB update failed for subtitle id=${article.id}:`, e.message);
          }

          stats.subtitles++;
        }))
      );
      const failed = subtitleResults.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        console.error(`[scheduler] Phase 2c: ${failed} subtitle downloads failed`);
      }
    }
    console.log(`[scheduler] Phase 2c complete: ${stats.subtitles} subtitles downloaded`);
  } catch (e: any) {
    console.error('[scheduler] Phase 2c error:', e.message);
  }

  console.log(`[scheduler] Phase 2 post-processing complete: translated=${stats.translated}, transcribed=${stats.transcribed}, subtitles=${stats.subtitles}`);
  return stats;
}

// ============ Phase 3: Query Today's Titles ============
async function queryTodayTitles(sql: Sql): Promise<SourceTitles> {
  const today = new Date().toISOString().slice(0, 10);

  const wechat = new Map<string, string[]>();
  const bilibili: Array<{ title: string; author: string }> = [];
  const podcast: Array<{ title: string; channel: string }> = [];
  const youtube: Array<{ title: string; channel: string }> = [];
  let twitter = 0;
  let rss = 0;

  try {
    // Wechat articles today
    const wcRows = await sql`
      SELECT a.title, s.name AS source_name
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND s.type = 'wechat'
      ORDER BY s.name, a.published_at
    `;
    for (const r of wcRows) {
      const list = wechat.get(r.source_name) || [];
      list.push(r.title);
      wechat.set(r.source_name, list);
    }

    // Bilibili articles today
    const biliRows = await sql`
      SELECT a.title, a.author
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND LOWER(s.type) LIKE 'bilibili%'
    `;
    for (const r of biliRows) {
      bilibili.push({ title: r.title, author: r.author || '' });
    }

    // Podcast articles today
    const podRows = await sql`
      SELECT a.title, s.name AS channel
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND s.type = 'podcast-channel'
    `;
    for (const r of podRows) {
      podcast.push({ title: r.title, channel: r.channel });
    }

    // YouTube articles today
    const ytRows = await sql`
      SELECT a.title, a.author AS channel
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND LOWER(s.type) LIKE 'youtube%'
    `;
    for (const r of ytRows) {
      youtube.push({ title: r.title, channel: r.channel || '' });
    }

    // Twitter count today
    const twRows = await sql`
      SELECT COUNT(*)::int AS cnt FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND LOWER(s.type) LIKE 'twitter%'
    `;
    twitter = twRows[0]?.cnt || 0;

    // RSS count today
    const rssRows = await sql`
      SELECT COUNT(*)::int AS cnt FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
        AND LOWER(s.type) IN ('rss', 'podcast-channel')
    `;
    rss = rssRows[0]?.cnt || 0;

  } catch (e: any) {
    console.error('[scheduler] queryTodayTitles error:', e.message);
  }

  return { wechat, bilibili, podcast, youtube, twitter, rss };
}

// ============ Phase 4: Anomaly Detection ============
async function detectAnomalies(sql: Sql): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const lines: string[] = [];

  try {
    const todayCounts = await sql`
      SELECT s.name, COUNT(*)::int AS cnt
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${today}
      GROUP BY s.name
    `;
    const yesterdayCounts = await sql`
      SELECT s.name, COUNT(*)::int AS cnt
      FROM articles a
      JOIN sources s ON a.source_id = s.id
      WHERE a.fetched_at::date = ${yesterday}
      GROUP BY s.name
    `;

    const yMap = new Map<string, number>();
    for (const r of yesterdayCounts) yMap.set(r.name, r.cnt);

    for (const t of todayCounts) {
      const yCnt = yMap.get(t.name) || 0;
      if (yCnt > 0 && t.cnt < yCnt * 0.5) {
        lines.push(`- ${t.name}: 今日${t.cnt}篇（昨日${yCnt}篇）— ⚠️ 可能源失效`);
      }
    }

    // Also check sources that had articles yesterday but zero today
    const todayNames = new Set(todayCounts.map(r => r.name));
    for (const [name, cnt] of yMap) {
      if (cnt >= 2 && !todayNames.has(name)) {
        lines.push(`- ${name}: 今日0篇（昨日${cnt}篇）— ⚠️ 可能源失效`);
      }
    }
  } catch (e: any) {
    console.error('[scheduler] detectAnomalies error:', e.message);
  }

  return lines;
}

// ============ Phase 5: Build Markdown Report ============
function buildReport(
  fetchResults: FetchResult[],
  titles: SourceTitles,
  anomalies: string[],
  todayTotal: number,
  yesterdayTotal: number,
  postProcessStats: PostProcessStats,
): string {
  const todayDash = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# 📋 更新日志 ${todayDash}`);
  lines.push('');

  // 报刊杂志
  lines.push('## 报刊杂志');
  lines.push('| 信息源 | 新增 | 状态 |');
  lines.push('|--------|------|------|');
  for (const r of fetchResults) {
    if (['人民日报', '新闻联播', '喷嚏图卦'].includes(r.source)) {
      lines.push(`| ${r.source} | ${r.inserted} | ${r.success ? '✅' : '❌'} |`);
    }
  }
  lines.push('');

  // 公众号
  const wechatEntries = [...titles.wechat.entries()];
  const wechatTotal = wechatEntries.reduce((s, [, ts]) => s + ts.length, 0);
  lines.push(`## 公众号（${wechatTotal}篇）`);
  if (wechatEntries.length === 0) {
    const wcResult = fetchResults.find(r => r.source === '公众号');
    lines.push(wcResult?.success ? '无新增' : `❌ ${wcResult?.error || '采集失败'}`);
  } else {
    for (const [name, ts] of wechatEntries) {
      lines.push(`- ${name}: ${ts.map(t => `《${t}》`).join(' ')}`);
    }
  }
  lines.push('');

  // B站
  lines.push(`## B站（${titles.bilibili.length}篇）`);
  if (titles.bilibili.length === 0) {
    const biliResult = fetchResults.find(r => r.source === 'B站');
    lines.push(biliResult?.success ? '无新增' : `❌ ${biliResult?.error || '采集失败'}`);
  } else {
    for (const b of titles.bilibili) {
      lines.push(`- 【${b.title}】— ${b.author}`);
    }
  }
  lines.push('');

  // 播客
  lines.push(`## 播客（${titles.podcast.length}集）`);
  if (titles.podcast.length === 0) {
    const podResult = fetchResults.find(r => r.source === '播客');
    lines.push(podResult?.success ? '无新增' : `❌ ${podResult?.error || '采集失败'}`);
  } else {
    for (const p of titles.podcast) {
      lines.push(`- 【${p.title}】— ${p.channel}`);
    }
  }
  lines.push('');

  // Twitter
  const twResult = fetchResults.find(r => r.source === 'X/推特');
  lines.push(`## X/推特（${titles.twitter}条）`);
  if (titles.twitter > 0) {
    lines.push(`新增 ${titles.twitter} 条 ✅`);
  } else {
    lines.push(twResult?.success ? '无新增' : `❌ ${twResult?.error || '采集失败'}`);
  }
  lines.push('');

  // YouTube
  lines.push(`## YouTube（${titles.youtube.length}篇）`);
  if (titles.youtube.length === 0) {
    const ytResult = fetchResults.find(r => r.source === 'YouTube');
    lines.push(ytResult?.success ? '无新增' : `❌ ${ytResult?.error || '采集失败'}`);
  } else {
    for (const y of titles.youtube) {
      lines.push(`- 【${y.title}】— ${y.channel}`);
    }
  }
  lines.push('');

  // RSS
  const rssResult = fetchResults.find(r => r.source === 'RSS');
  lines.push(`## RSS（${titles.rss}篇）`);
  if (titles.rss > 0) {
    lines.push(`新增 ${titles.rss} 篇 ✅`);
  } else {
    lines.push(rssResult?.success ? '无新增' : `❌ ${rssResult?.error || '采集失败'}`);
  }
  lines.push('');

  // 后处理统计
  lines.push('## 🔄 后处理');
  lines.push(`- 英文翻译: ${postProcessStats.translated} 篇`);
  lines.push(`- 音频转录: ${postProcessStats.transcribed} 篇`);
  lines.push(`- 字幕下载: ${postProcessStats.subtitles} 篇`);
  lines.push('');

  // 异常检测
  lines.push('## ⚠️ 异常检测');
  if (anomalies.length === 0) {
    lines.push('- 无异常');
  } else {
    lines.push(...anomalies);
  }
  lines.push('');

  // 趋势
  lines.push('## 📊 趋势');
  const diff = todayTotal - yesterdayTotal;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  lines.push(`- 昨日总数: ${yesterdayTotal} → 今日: ${todayTotal}（${diffStr}）`);

  return lines.join('\n');
}

// ============ Collection Settings ============

interface CollectionSettings {
  dailyTime: string;
  sources: Record<string, { name: string; enabled: boolean }>;
}

const DEFAULT_SETTINGS: CollectionSettings = {
  dailyTime: '22:00',
  sources: {
    wechat: { name: '微信公众号', enabled: true },
    rss: { name: 'RSS 订阅', enabled: true },
    bilibili: { name: '哔哩哔哩', enabled: true },
    youtube: { name: 'YouTube', enabled: true },
    newspaper: { name: '报刊杂志', enabled: true },
    podcast: { name: '播客', enabled: true },
    twitter: { name: 'Twitter/X', enabled: true },
    xwlb: { name: '新闻联播', enabled: true },
    penti: { name: '喷嚏图卦', enabled: true },
    rmrb: { name: '人民日报', enabled: true },
    wechat_group: { name: '微信群聊', enabled: false },
  },
};

async function loadCollectionSettings(sql: Sql): Promise<CollectionSettings> {
  try {
    const [row] = await sql`SELECT config FROM sources WHERE type = 'system' AND name = 'collection_settings' LIMIT 1`;
    if (row?.config) {
      return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...row.config };
    }
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

async function saveCollectionSettingsToDb(sql: Sql, settings: CollectionSettings): Promise<void> {
  const existing = await sql`SELECT id FROM sources WHERE type = 'system' AND name = 'collection_settings' LIMIT 1`;
  if (existing.length > 0) {
    await sql`UPDATE sources SET config = ${sql.json(settings)} WHERE id = ${existing[0].id}`;
  } else {
    await sql`INSERT INTO sources (name, type, config, enabled) VALUES ('collection_settings', 'system', ${sql.json(settings)}, true)`;
  }
}

/** Check if a source module is enabled */
async function isSourceEnabled(sql: Sql, key: string): Promise<boolean> {
  const settings = await loadCollectionSettings(sql);
  return settings.sources[key]?.enabled !== false;
}

// ============ Main Entry Point ============
export async function runDailyFetch(sql: Sql): Promise<string> {
  // Auto-reset stuck flag after 10 minutes
  const timeout = setTimeout(() => {
    console.error('[scheduler] 10 minute timeout reached, force-resetting');
    _isRunning = false;
  }, 600_000);
  if (_isRunning) {
    throw new Error('Another fetch is already running');
  }
  _isRunning = true;
  _lastRunAt = new Date().toISOString();
  _lastRunStatus = 'running';
  _lastRunError = null;

  try {
    console.log('[scheduler] === Daily fetch started ===');

    // Phase 1: Parallel fetch
    console.log('[scheduler] Phase 1: Parallel fetch...');
    const fetchResults = await phase1ParallelFetch(sql);

    // Write fetch logs
    try {
      const now = new Date();
      for (const fr of fetchResults) {
        const detail = fr.error ? fr.error.slice(0, 500) : (fr.success ? 'ok' : 'fail');
        await sql`INSERT INTO fetch_logs (action, status, articles_count, detail, started_at, duration_ms)
          VALUES ('daily_fetch', ${fr.success ? 'success' : 'error'}, ${fr.fetched || fr.inserted || 0}, ${detail}, ${now.toISOString()}, 0)`;
      }
    } catch (e: any) {
      console.error('[scheduler] Failed to write fetch_logs:', e.message);
    }

    // Phase 2: Post-processing (translation, transcription, subtitles)
    console.log('[scheduler] Phase 2: Post-processing...');
    const postProcessStats = await phase2PostProcess(sql);

    // Phase 3: Query today's titles
    console.log('[scheduler] Phase 3: Query titles...');
    const titles = await queryTodayTitles(sql);

    // Phase 4: Anomaly detection
    console.log('[scheduler] Phase 4: Anomaly detection...');
    const anomalies = await detectAnomalies(sql);

    // Get today/yesterday totals
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    let todayTotal = 0;
    let yesterdayTotal = 0;
    try {
      const t = await sql`SELECT COUNT(*)::int AS cnt FROM articles WHERE fetched_at::date = ${today}`;
      todayTotal = t[0].cnt;
      const y = await sql`SELECT COUNT(*)::int AS cnt FROM articles WHERE fetched_at::date = ${yesterday}`;
      yesterdayTotal = y[0].cnt;
    } catch { /* ignore */ }

    // Phase 5: Build report
    console.log('[scheduler] Phase 5: Build report...');
    const markdown = buildReport(fetchResults, titles, anomalies, todayTotal, yesterdayTotal, postProcessStats);

    // Write to OB
    try {
      const logDir = join(OB_DIR, '更新日志');
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${today}.md`);
      writeFileSync(logPath, markdown, 'utf-8');
      console.log(`[scheduler] Written daily log to ${logPath}`);
    } catch (e: any) {
      console.error(`[scheduler] Failed to write OB log: ${e.message}`);
    }

    _lastRunStatus = 'success';
    console.log('[scheduler] === Daily fetch completed ===');
    return markdown;
  } catch (e: any) {
    _lastRunStatus = 'error';
    _lastRunError = e.message;
    console.error('[scheduler] Daily fetch error:', e.message);
    throw e;
  } finally {
    clearTimeout(timeout);
    _isRunning = false;
  }
}

// ==// ============ Routes ============
export function createSchedulerRoutes(sql: Sql): Hono {
  const router = new Hono();

  // GET /settings -- load collection settings
  router.get('/settings', async (c) => {
    try {
      const settings = await loadCollectionSettings(sql);
      return c.json(settings);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /settings -- save collection settings
  router.post('/settings', async (c) => {
    try {
      const body = await c.req.json();
      await saveCollectionSettingsToDb(sql, body);
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /run -- trigger daily fetch (admin auth required)
  router.post('/run', async (c) => {
    // Basic admin auth check
    const adminToken = process.env.ADMIN_TOKEN || '';
    if (adminToken) {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: '缺少 Authorization 头' }, 401);
      }
      const token = authHeader.slice(7);
      if (token !== adminToken) {
        return c.json({ error: '管理员 Token 无效' }, 403);
      }
    }

    if (_isRunning) {
      return c.json({ error: 'Another fetch is already running', startedAt: _lastRunAt }, 409);
    }

    try {
      const markdown = await runDailyFetch(sql);
      return c.json({ ok: true, log: markdown });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // GET /status — last run info
  router.get('/status', async (c) => {
    return c.json({
      isRunning: _isRunning,
      lastRunAt: _lastRunAt,
      lastRunStatus: _lastRunStatus,
      lastRunError: _lastRunError,
    });
  });

  // POST /reset — force reset stuck scheduler (admin only)
  router.post('/reset', async (c) => {
    const adminToken = process.env.ADMIN_TOKEN || '';
    if (adminToken) {
      const authHeader = c.req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: '缺少 Authorization 头' }, 401);
      }
      const token = authHeader.slice(7);
      if (token !== adminToken) {
        return c.json({ error: '管理员 Token 无效' }, 403);
      }
    }
    _isRunning = false;
    _lastRunStatus = 'reset';
    return c.json({ ok: true, message: 'Scheduler state reset' });
  });

  return router;
}
