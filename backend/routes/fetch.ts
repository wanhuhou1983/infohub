// @ts-nocheck
/**
 * 采集路由（新闻联播 + RSS）
 * 
 * 修复：
 * - 错误处理：使用 PostgreSQL 错误码 23505 识别唯一键冲突
 * - RSS N+1 查询：批量预查 source name
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString, processImages } from '../file-storage.js';
import { parseXWLBListHtml, parseGovopendataXWLB, cleanHtmlToText } from '../services/parser.js';
import { classifyByTitle, classifyByFeed, extractTags, extractXWLBTags } from '../services/classifier.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIDER_DIR = process.env.SPIDER_DIR || path.resolve(__dirname, '../../../wechat-article-spider');
const PYTHON_CMD = path.join(SPIDER_DIR, '.venv/bin/python3');
const MINERU_SCRIPT = process.env.MINERU_SCRIPT || path.join(
  process.env.HOME || '/root', '.workbuddy/skills/mineru-extract/scripts/mineru_extract.py'
);
const PENTI_SCRIPT_DIR = path.join(
  process.env.HOME || '/root', '.workbuddy/skills/penti-tugua/scripts'
);

// ============ Ollama 本地翻译（DeepSeek R1） ============
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://172.18.0.1:11435';
const OLLAMA_TRANSLATE_MODEL = process.env.OLLAMA_TRANSLATE_MODEL || 'gemma4:26b';

async function ollamaTranslate(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  try {
    const resp = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        model: OLLAMA_TRANSLATE_MODEL,
        messages: [
          { role: 'system', content: 'You are a professional translator. Translate the following text from English to Chinese. Output ONLY the translation, no explanations, no notes, no original text. Preserve formatting like paragraphs and line breaks.' },
          { role: 'user', content: text },
        ],
        stream: false,
        options: { temperature: 0.3 },
      }),
    });

    if (!resp.ok) {
      console.error(`[翻译] Ollama 翻译错误: HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as any;
    let result = data.message?.content || '';
    // Remove <think/> tags from DeepSeek R1 reasoning output
    result = result.replace(/<think[\s\S]*?<\/think>/g, '').trim();
    if (!result) return null;
    return result;
  } catch (e: any) {
    console.error(`[翻译] Ollama 翻译请求失败: ${e.message}`);
    return null;
  }
}

// ============ llama.cpp 本地翻译（DeepSeek Coder，最快） ============
const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || 'http://172.31.240.1:8889';
const LLAMA_MODEL = process.env.LLAMA_MODEL || 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf';

async function llamaCppTranslate(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  try {
    const resp = await fetch(`${LLAMA_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        model: LLAMA_MODEL,
        messages: [
          { role: 'system', content: 'Translate English to Chinese. Reply ONLY with the translation, no other text.' },
          { role: 'user', content: text },
        ],
        max_tokens: 4096,
        temperature: 0.1,
      }),
    });

    if (!resp.ok) {
      console.error(`[翻译] llama.cpp 翻译错误: HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as any;
    const result = data.choices?.[0]?.message?.content?.trim() || '';
    if (!result) return null;
    return result.replace(/<think[\s\S]*?<\/think>/g, '').trim();
  } catch (e: any) {
    console.error(`[翻译] llama.cpp 翻译请求失败: ${e.message}`);
    return null;
  }
}


// ============ Whisper Windows API（播客自动转录） ============
const WHISPER_WINDOWS_API_URL = process.env.WHISPER_WINDOWS_API_URL || 'http://172.31.240.1:8768';
const WHISPER_TRANSCRIBE_PREVIEW_SEC = Number(process.env.WHISPER_TRANSCRIBE_PREVIEW_SEC || 600); // 首10分钟预览

async function whisperWindowsTranscribe(audioUrl: string, durationSec: number = 600): Promise<string | null> {
  try {
    const resp = await fetch(`${WHISPER_WINDOWS_API_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: audioUrl, duration: durationSec, language: 'en' }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!resp.ok) {
      console.error(`[whisper] API error: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json() as any;
    return data.text || null;
  } catch (e: any) {
    console.error(`[whisper] 转录请求失败: ${e.message}`);
    return null;
  }
}


// ============ RSS 直接解析（不再依赖 Miniflux） ============
import RssParser from 'rss-parser';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const rssParser = new RssParser({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml',
  },
});

// ============ 百度翻译 API ============

const BAIDU_CONFIG_PATH = join(
  process.env.HOME || '/root', '.workbuddy/keys/baidu_translate.json'
);

interface BaiduTranslateConfig {
  appid: string;
  secretKey: string;
}

let _baiduConfig: BaiduTranslateConfig | null = null;

function getBaiduConfig(): BaiduTranslateConfig | null {
  if (_baiduConfig) return _baiduConfig;
  try {
    if (existsSync(BAIDU_CONFIG_PATH)) {
      _baiduConfig = JSON.parse(readFileSync(BAIDU_CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return _baiduConfig;
}

/**
 * 百度翻译 API：将文本从源语言翻译为目标语言
 * 文档：https://fanyi-api.baidu.com/doc/21
 */
async function baiduTranslate(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  const config = getBaiduConfig();
  if (!config?.appid || !config?.secretKey) {
    console.error('[翻译] 百度翻译 API 未配置，跳过');
    return null;
  }

  const salt = String(Math.floor(Math.random() * 100000));
  const sign = createHash('md5')
    .update(config.appid + text + salt + config.secretKey)
    .digest('hex');

  const params = new URLSearchParams({
    q: text,
    from,
    to,
    appid: config.appid,
    salt,
    sign,
  });

  try {
    const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;

    if (data.error_code) {
      console.error(`[翻译] 百度翻译错误: ${data.error_code} - ${data.error_msg}`);
      return null;
    }

    if (data.trans_result && Array.isArray(data.trans_result)) {
      return data.trans_result.map((r: any) => r.dst).join('\n');
    }
    return null;
  } catch (e: any) {
    console.error(`[翻译] 百度翻译请求失败: ${e.message}`);
    return null;
  }
}

// ============ Google Cloud Translation API ============

/**
 * Google Cloud Translation API
 * 需要环境变量：GOOGLE_TRANSLATE_KEY（API Key）
 */
async function googleTranslate(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  const apiKey = process.env.GOOGLE_TRANSLATE_KEY;
  if (!apiKey) {
    console.error('[翻译] Google Translate API Key 未配置，跳过');
    return null;
  }

  try {
    const resp = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: from,
          target: to,
          format: 'text',
        }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[翻译] Google Translate 错误: ${err}`);
      return null;
    }

    const data = await resp.json() as any;
    if (data.data?.translations?.[0]?.translatedText) {
      return data.data.translations[0].translatedText;
    }
    return null;
  } catch (e: any) {
    console.error(`[翻译] Google Translate 请求失败: ${e.message}`);
    return null;
  }
}

// ============ Azure Translator API ============

/**
 * Azure Translator API (Microsoft)
 * 需要环境变量：
 * - AZURE_TRANSLATE_KEY
 * - AZURE_TRANSLATE_REGION (默认 eastasia)
 * - AZURE_TRANSLATE_ENDPOINT (默认 https://api.cognitive.microsofttranslator.com/)
 */
async function azureTranslate(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  const apiKey = process.env.AZURE_TRANSLATE_KEY;
  const region = process.env.AZURE_TRANSLATE_REGION || 'eastasia';
  const endpoint = process.env.AZURE_TRANSLATE_ENDPOINT || 'https://api.cognitive.microsofttranslator.com/';

  if (!apiKey) {
    console.error('[翻译] Azure Translator API Key 未配置，跳过');
    return null;
  }

  try {
    const url = `${endpoint}translate?api-version=3.0&from=${from}&to=${to}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ Text: text }]),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[翻译] Azure Translator 错误: ${err}`);
      return null;
    }

    const data = await resp.json() as any;
    if (data[0]?.translations?.[0]?.text) {
      return data[0].translations[0].text;
    }
    return null;
  } catch (e: any) {
    console.error(`[翻译] Azure Translator 请求失败: ${e.message}`);
    return null;
  }
}

/**
 * 统一翻译入口：按优先级尝试可用翻译API
 * 优先级：llama.cpp（本地 DeepSeek Coder，最快） > Ollama（本地 Gemma4） > 百度 > Azure > Google
 */
async function translateText(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
  // 0. 最优使用 llama.cpp 本地翻译（DeepSeek Coder，最快，无需外部 API）
  const llamaResult = await llamaCppTranslate(text, from, to);
  if (llamaResult) return llamaResult;

  // 1. Ollama 本地翻译（Gemma4）
  const ollamaResult = await ollamaTranslate(text, from, to);
  if (ollamaResult) return ollamaResult;

  // 1. 百度翻译
  if (getBaiduConfig()) {
    const result = await baiduTranslate(text, from, to);
    if (result) return result;
  }

  // 2. Azure Translator
  if (process.env.AZURE_TRANSLATE_KEY) {
    const result = await azureTranslate(text, from, to);
    if (result) return result;
  }

  // 3. Google Translate
  if (process.env.GOOGLE_TRANSLATE_KEY) {
    const result = await googleTranslate(text, from, to);
    if (result) return result;
  }

  console.error('[翻译] 没有任何翻译API可用，跳过翻译');
  return null;
}

/**
 * 检测文本是否主要为英文
 * 简单启发式：统计 ASCII 字母占比，>50% 视为英文，且中文字符 <10%
 */
function isEnglish(text: string): boolean {
  if (!text || text.length < 20) return false;
  const asciiLetters = (text.match(/[a-zA-Z]/g) || []).length;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  if (cjkChars / text.length > 0.1) return false;
  return asciiLetters / text.length > 0.5;
}

/**
 * 翻译英文文本为中文（分段处理，按API限制调整每段长度）
 * 返回翻译后的中文文本
 * 优先级：百度 > Azure > Google
 */
async function translateToChinese(text: string): Promise<string> {
  if (!text || text.length < 10) return text;

  // 检查是否有任何翻译API可用
  const hasOllama = !!process.env.LLAMA_BASE_URL || !!process.env.OLLAMA_BASE_URL;
  const hasBaidu = getBaiduConfig() !== null;
  const hasAzure = !!process.env.AZURE_TRANSLATE_KEY;
  const hasGoogle = !!process.env.GOOGLE_TRANSLATE_KEY;

  if (!hasOllama && !hasBaidu && !hasAzure && !hasGoogle) {
    console.log('[翻译] 没有任何翻译API配置，跳过翻译');
    return text;
  }

  // 根据不同API设置分段大小
  let maxChunk = 5000; // 默认
  if (hasBaidu) maxChunk = 5000;
  else if (hasAzure) maxChunk = 10000; // Azure 限制更宽松
  else if (hasGoogle) maxChunk = 5000;

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChunk));
    remaining = remaining.slice(maxChunk);
  }

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const result = await translateText(chunk, 'en', 'zh');
    if (result) {
      translatedChunks.push(result);
    } else {
      translatedChunks.push(chunk); // 翻译失败保留原文
    }
    // 避免请求过快
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }

  return translatedChunks.join('\n');
}

/**
 * 翻译标题（使用统一翻译API）
 */
async function translateTitle(title: string): Promise<string> {
  if (!isEnglish(title)) return title;
  const result = await translateText(title, 'en', 'zh');
  return result || title;
}

/**
 * 轻量并发池：限制同时执行的 Promise 数量
 * 不引入 p-limit 依赖，内联实现
 */
function createConcurrencyPool(maxConcurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  function next() {
    if (queue.length > 0 && running < maxConcurrency) {
      running++;
      const resolve = queue.shift()!;
      resolve();
    }
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    // 如果已达上限，排队等待
    if (running >= maxConcurrency) {
      await new Promise<void>(resolve => queue.push(resolve));
    } else {
      running++;
    }
    try {
      return await fn();
    } finally {
      running--;
      next();
    }
  };
}

/**
 * 对单个 RSS feed URL 执行采集：解析 XML → 全文抓取 → 图片本地存储 → 英文翻译 → 本地存储 → 入库
 * 返回 { fetched, inserted, translated }
 */
async function fetchRssFeed(
  sql: any,
  feedUrl: string,
  sourceId: number,
  sourceName: string,
  rssSourceId: number
): Promise<{ fetched: number; inserted: number; translated: number }> {
  console.log(`[RSS] 解析: ${sourceName} ← ${feedUrl}`);

  let feed: any;
  try {
    feed = await rssParser.parseURL(feedUrl);
  } catch (e: any) {
    // 有些 RSS URL 可能被墙或超时，尝试用 fetch 手动获取再解析
    try {
      const resp = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      feed = await rssParser.parseString(xml);
    } catch (e2: any) {
      console.error(`[RSS] 解析失败: ${feedUrl} - ${e2.message}`);
      return { fetched: 0, inserted: 0, translated: 0 };
    }
  }

  const items = feed?.items || [];
  if (items.length === 0) return { fetched: 0, inserted: 0, translated: 0 };

  // 判断 feed_type（用于文件存储）
  // ⚠️ 注意：RSS 来源统一使用 'rss' 类型，不依赖 URL 字符串判断
  // 因为很多 RSS feed 地址包含 'wechat'/'kindle4rss' 等关键词，
  // 但实际内容不是公众号采集，不应误导到微信公众号目录
  const feedType = 'rss';

  // 🛡️ 隐患 5 修复：并发池限制，最多 3 个同时抓取，避免大量 MinerU 子进程
  const limit = createConcurrencyPool(3);
  let inserted = 0;
  let translated = 0;

  const results = await Promise.all(items.map((item: any) => limit(async () => {
    try {
      const title = item.title || '无标题';
      const url = item.link || item.guid || '';
      if (!url) return { inserted: false, translated: false };

      const rssContent = cleanHtmlToText(item.content || item.contentSnippet || item.summary || '');
      const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
      const author = item.creator || item.author || '';

      // ========== 提取播客音频URL (enclosure) ==========
      const enclosureUrl = item.enclosure?.url || '';
      const enclosureType = item.enclosure?.type || '';
      const enclosureLength = item.enclosure?.length || '';

      const contentHash = hashString(url);

      // ========== 全文抓取：所有文章都尝试抓取原文全文 ==========
      let fullContent = rssContent;
      if (url) {
        try {
          const fetchedContent = await crawlArticleContent(url);
          if (fetchedContent && fetchedContent.length > rssContent.length) {
            fullContent = fetchedContent;
            console.log(`[RSS] 抓到全文: ${title.slice(0, 30)}... (${rssContent.length} → ${fetchedContent.length} chars)`);
          }
        } catch { /* ignore */ }
      }

      // ========== 图片处理：下载到本地存储 ==========
      try {
        fullContent = await processImages(fullContent, 'rss');
      } catch (e: any) {
        console.error(`[RSS] 图片处理失败: ${e.message}`);
      }

      // ========== 英文翻译 ==========
      let finalTitle = title;
      let finalContent = fullContent;
      let didTranslate = false;
      const needTranslate = isEnglish(fullContent) || isEnglish(title);
      if (needTranslate) {
        try {
          // 翻译标题
          if (isEnglish(title)) {
            const tTitle = await translateTitle(title);
            if (tTitle !== title) {
              finalTitle = `${tTitle} [${title}]`;
            }
          }
          // 翻译正文
          if (isEnglish(fullContent)) {
            const tContent = await translateToChinese(fullContent);
            if (tContent !== fullContent) {
              finalContent = `【中文翻译】\n${tContent}\n\n---\n【English Original】\n${fullContent}`;
              didTranslate = true;
            }
          }
        } catch (e: any) {
          console.error(`[RSS] 翻译失败: ${title.slice(0, 30)}... - ${e.message}`);
        }
      }

      const category = classifyByFeed(sourceName);
      const tags = extractTags(finalTitle + ' ' + finalContent.slice(0, 200), sourceName);

      // 构建 extra 对象（包含音频URL等）
      const extraData: Record<string, any> = {};
      if (enclosureUrl) {
        extraData.audio_url = enclosureUrl;
        if (enclosureType) extraData.audio_type = enclosureType;
        if (enclosureLength) extraData.audio_length = enclosureLength;
      }

      const insertedRows = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
        VALUES (${sourceId}, ${finalTitle}, ${finalContent}, ${finalContent.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, ${sql.json(extraData)})
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      let didInsert = false;
      if (insertedRows.length > 0) {
        const newId = insertedRows[0]!.id;
        
        // 若有播客音频，后台转录首10分钟
        if (enclosureUrl && enclosureUrl.match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)) {
          whisperWindowsTranscribe(enclosureUrl, WHISPER_TRANSCRIBE_PREVIEW_SEC).then(transcript => {
            if (transcript) {
              const transcriptContent = '> 🎙️ 音频转录（前' + (WHISPER_TRANSCRIBE_PREVIEW_SEC / 60) + '分钟预览）\n> \n> ' + transcript.slice(0, 5000).split('\n').join('\n> ') + '\n\n---\n\n';
              const newContent = transcriptContent + finalContent;
              sql`UPDATE articles SET content = ${newContent} WHERE id = ${newId}`.catch((e: any) => console.error('[whisper] update failed:', e.message));
              saveArticleFile(newId, newContent, {
                id: newId, title: finalTitle, source_type: feedType,
                source_name: sourceName, url, published_at: publishedAt,
                category, tags, author, is_read: false, is_starred: false,
              }).catch(() => {});
            }
          }).catch((e: any) => console.error('[whisper] background transcript error:', e.message));
        }
const { processedContent } = await saveArticleFile(newId, finalContent, {
          id: newId, title: finalTitle, source_type: feedType,
          source_name: sourceName, url, published_at: publishedAt,
          category, tags, author, is_read: false, is_starred: false,
        });
        if (processedContent !== finalContent) {
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
        }
        didInsert = true;
      }

return { inserted: didInsert, translated: didTranslate };
    } catch (e: any) {
      if (e.code !== '23505') console.error('RSS insert error:', e.message);
      return { inserted: false, translated: false };
    }
  })));

  // 汇总结果
  for (const r of results) {
    if (r.inserted) inserted++;
    if (r.translated) translated++;
  }

  // 更新子源的 last_fetch
  await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;

  return { fetched: items.length, inserted, translated };
}

// ============ 辅助函数：去除正文末尾的评论区 ============
function stripCommentSection(content: string): string {
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



export function createFetchRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 新闻联播采集（每日一篇） ============
  router.post('/xwlb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const sourceId = 26;
      console.log(`[xwlb] 获取 ${date} 新闻联播...`);

      // 1. 尝试获取 govopendata 全文
      let fullData: any = null;
      try { fullData = await parseGovopendataXWLB(date, ""); } catch (e) { /* fallback */ }
      let listHtml = '';
      let listData: Array<{ title: string; link?: string }> = [];
      try {
        const resp = await fetch(`https://tv.cctv.com/lm/xwlb/day/${date}.shtml`, { signal: AbortSignal.timeout(15000) });
        listHtml = await resp.text();
        listData = parseXWLBListHtml(listHtml);
      } catch (e: any) { console.error(`[xwlb] 列表获取失败: ${e.message}`); }

      const title = fullData?.title || `新闻联播 ${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
      let content = fullData?.content || (listData.map((i, idx) => `${idx+1}. ${i.title}`).join('\n'));
      if (!content) return c.json({ ok: false, error: '获取失败' }, 500);

      const hash = hashString('xwlb:' + date);
      const inserted = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},'https://tv.cctv.com/lm/xwlb/',${date},'时政',${['新闻联播',date.slice(0,6)]},${hash},NOW(),'央视','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
      if (inserted.length > 0) {
        await saveArticleFile(inserted[0].id, content, { id:inserted[0].id, title, source_type:'rss', source_name:'新闻联播', url:'https://tv.cctv.com/lm/xwlb/', published_at:date, category:'时政', tags:['新闻联播',date.slice(0,6)], author:'央视', is_read:false, is_starred:false });
        return c.json({ ok:true, fetched:listData.length, inserted:1, date });
      }
      return c.json({ ok:true, fetched:listData.length, inserted:0, date });
    } catch (e: any) { return c.json({ ok:false, error: e.message }, 500); }
  });

  // ============ RSS 采集 ============
  router.post('/rss', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const feedUrl = body?.feedUrl || body?.url || '';
      const sourceName = body?.sourceName || '';
      const feedType = body?.feedType || 'rss';
      let authToken = body?.authorization || body?.auth || '';
      if (!authToken) { const h = c.req.header('authorization'); if (h) authToken = h.replace('Bearer ', ''); }

      if (!feedUrl) return c.json({ ok: false, error: '缺少 feedUrl' }, 400);
      if (!sourceName) return c.json({ ok: false, error: '缺少 sourceName' }, 400);

      const [sourceRow] = await sql`SELECT id, config FROM sources WHERE enabled = true AND name = ${sourceName} AND LOWER(type) IN ('rss','podcast-channel') LIMIT 1`;
      if (!sourceRow) return c.json({ ok: false, error: `未找到已启用的源: ${sourceName}` }, 404);
      const sourceId = sourceRow.id;
      const config = typeof sourceRow.config === 'string' ? JSON.parse(sourceRow.config) : (sourceRow.config || {});
      const maxItems = config.max_items || 100;

      let feed: any;
      const rssParser = new RssParser({ timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml' } });
      try { feed = await rssParser.parseURL(feedUrl); }
      catch {
        try {
          const resp = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
          const xml = await resp.text();
          feed = await rssParser.parseString(xml);
        } catch (e: any) { return c.json({ ok: false, error: `RSS 解析失败: ${e.message}` }, 500); }
      }

      const items = (feed?.items || []).slice(0, maxItems);
      let fetched = 0, inserted = 0, translated = 0;

      for (const item of items) {
        const url = item.link || item.guid || '';
        const title = item.title?.trim() || '(无标题)';
        const rssContent = item.content || item.contentSnippet || item.description || '';
        const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
        const author = item.creator || item.author || '';
        const enclosureUrl = item.enclosure?.url || '';
        const enclosureType = item.enclosure?.type || '';
        const enclosureLength = item.enclosure?.length || '';
        const contentHash = hashString(url);

        // 全文抓取
        let fullContent = rssContent;
        if (url) {
          try {
            const fc = await crawlArticleContent(url);
            if (fc && fc.length > rssContent.length) fullContent = fc;
          } catch { /* ignore */ }
        }

        // 图片处理
        try { fullContent = await processImages(fullContent, 'rss'); } catch { /* ignore */ }

        // 翻译
        let finalTitle = title, finalContent = fullContent, didTranslate = false;
        const needTranslate = isEnglish(fullContent) || isEnglish(title);
        if (needTranslate) {
          try {
            if (isEnglish(title)) { const tt = await translateTitle(title); if (tt !== title) finalTitle = `${tt} [${title}]`; }
            if (isEnglish(fullContent)) {
              const tc = await translateToChinese(fullContent);
              if (tc !== fullContent) { finalContent = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${fullContent}`; didTranslate = true; }
            }
          } catch { /* ignore */ }
        }

        const category = classifyByFeed(sourceName);
        const tags = extractTags(finalTitle + ' ' + finalContent.slice(0,200), sourceName);
        const extraData: Record<string, any> = {};
        if (enclosureUrl) { extraData.audio_url = enclosureUrl; extraData.audio_type = enclosureType; extraData.audio_length = enclosureLength; }

        fetched++;
        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${finalTitle},${finalContent},${finalContent.slice(0,150)},${url},${publishedAt},${category},${tags},${contentHash},NOW(),${author},${sql.json(extraData)}) ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) {
          const newId = rows[0].id;
          const { processedContent } = await saveArticleFile(newId, finalContent, { id:newId, title:finalTitle, source_type:feedType, source_name:sourceName, url, published_at:publishedAt, category, tags, author, is_read:false, is_starred:false });
          if (processedContent !== finalContent) await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
          inserted++;

          // 播客音频转录首10分钟
          if (enclosureUrl && enclosureUrl.match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)) {
            whisperWindowsTranscribe(enclosureUrl, WHISPER_TRANSCRIBE_PREVIEW_SEC).then(transcript => {
              if (transcript) {
                const tc = '> @ # 音频转录（前' + (WHISPER_TRANSCRIBE_PREVIEW_SEC/60) + '分钟预览）\n> \n> ' + transcript.slice(0,5000).split('\n').join('\n> ') + '\n\n---\n\n';
                const nc = tc + finalContent;
                sql`UPDATE articles SET content = ${nc} WHERE id = ${newId}`.catch((e: any) => console.error('[whisper] update failed:', e.message));
                saveArticleFile(newId, nc, { id:newId, title:finalTitle, source_type:feedType, source_name:sourceName, url, published_at:publishedAt, category, tags, author, is_read:false, is_starred:false }).catch(()=>{});
              }
            }).catch(e => console.error('[whisper] error:', e.message));
          }
        }
        if (didTranslate) translated++;
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched, inserted, translated, sourceName });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  // ============ 微信公众号同步 ============
  router.post('/wechat', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const sourceId = body?.sourceId || 0;
      const authToken = body?.authorization || body?.auth || '';
      if (!sourceId) return c.json({ ok: false, error: '缺少 sourceId' }, 400);

      console.log(`[wechat] 开始同步 source_id=${sourceId}`);
      const [source] = await sql`SELECT id, name, config FROM sources WHERE id = ${sourceId} AND LOWER(type) = 'wechat'`;
      if (!source) return c.json({ ok: false, error: `未找到源: ${sourceId}` }, 404);

      const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : (source.config || {});
      const wechatUrl = cfg.url || cfg.wechat_url || '';
      if (!wechatUrl) return c.json({ ok: false, error: '公众号未配置 URL' }, 400);

      const { spawn } = await import('child_process');
      const spiderDir = SPIDER_DIR;
      const python = PYTHON_CMD;
      const outputJson = '/tmp/wechat_' + sourceId + '_' + Date.now() + '.json';

      console.log(`[wechat] 运行爬虫: ${python} spider_cli.py ${wechatUrl}`);
      let stdout = '', stderr = '';
      try {
        const proc = spawn(python, [path.join(spiderDir, 'spider_cli.py'), wechatUrl, '--output', outputJson, '--count', String(cfg.max_items || 20)], { timeout: 180000 });
        for await (const chunk of proc.stdout) stdout += chunk;
        for await (const chunk of proc.stderr) stderr += chunk;
        await new Promise((res, rej) => { proc.on('close', res); proc.on('error', rej); });
      } catch (e: any) {
        if (!existsSync(outputJson)) return c.json({ ok: false, error: `爬虫失败: ${stderr.slice(0,200)}` }, 500);
      }

      let articles: any[] = [];
      try { articles = JSON.parse(readFileSync(outputJson, 'utf-8')); } catch { /* ignore */ }
      try { unlinkSync(outputJson); } catch { /* ignore */ }

      if (!Array.isArray(articles) || articles.length === 0) return c.json({ ok: false, error: '未获取到文章' }, 404);

      let inserted = 0;
      for (const art of articles) {
        const title = art.title?.trim() || '(无标题)';
        const url = art.url || '';
        const pubDate = art.publishTime || art.publishDate || new Date().toISOString();
        let content = art.content || art.html || art.description || '';
        const contentHash = hashString(url || title + pubDate);

        // 清理微信垃圾空图片链接
        content = content.replace(/!\[[^\]]*\]\(\)/g, '');

        try { content = await processImages(content, 'wechat'); } catch { /* ignore */ }

        if (isEnglish(content)) {
          try {
            const tc = await translateToChinese(content);
            if (tc !== content) content = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${content}`;
          } catch { /* ignore */ }
        }

        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},${url},${pubDate},${classifyByFeed(source.name)},${extractTags(title, source.name)},${contentHash},NOW(),'') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) { inserted++; }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched: articles.length, inserted });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  // ============ 人民日报采集 ============
  router.post('/rmrb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0,10);
      const full = body?.full !== false;
      const sourceId = 1957;

      const rmrbDir = process.env.RMRB_DIR || path.resolve(__dirname, '../../skills/rmrb-daily');
      const python = 'python3';
      const outputMd = `/tmp/rmrb_${date.replace(/-/g,'')}.md`;

      const proc = spawn(python, [path.join(rmrbDir, 'rmrb_daily.py'), date, ...(full ? ['--full', '--output', outputMd] : ['--output', outputMd])], { timeout: 120000 });
      let stderr = '';
      for await (const chunk of proc.stderr) stderr += chunk;
      await new Promise((res, rej) => { proc.on('close', res); proc.on('error', rej); });

      if (!existsSync(outputMd)) return c.json({ ok: false, error: `采集失败: ${stderr.slice(0,200)}` }, 500);
      const content = readFileSync(outputMd, 'utf-8');
      try { unlinkSync(outputMd); } catch { /* ignore */ }

      const lines = content.trim().split('\n');
      const title = lines[0]?.replace(/^#\s*/, '') || `人民日报 ${date}`;
      const bodyContent = lines.slice(1).join('\n').trim();
      const contentHash = hashString('rmrb:' + date.replace(/-/g,''));

      const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${bodyContent},${bodyContent.slice(0,150)},${'https://paper.people.com.cn/rmrb/'},${date.replace(/-/g,'')},'时政',${['人民日报',date.slice(0,7)]},${contentHash},NOW(),'人民日报','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
      let inserted = 0;
      if (rows.length > 0) {
        inserted = 1;
        await saveArticleFile(rows[0].id, bodyContent, { id:rows[0].id, title, source_type:'rss', source_name:'人民日报', url:'https://paper.people.com.cn/rmrb/', published_at:date.replace(/-/g,''), category:'时政', tags:['人民日报',date.slice(0,7)], author:'人民日报', is_read:false, is_starred:false });
      }
      const cnt = bodyContent.split('###').filter(l => l.trim()).length;
      return c.json({ ok: true, fetched: cnt, inserted, date });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  // ============ AI 资讯采集 ============
  router.post('/ai', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const sourceId = body?.sourceId || 0;
      const authToken = body?.authorization || body?.auth || '';
      if (!sourceId) return c.json({ ok: false, error: '缺少 sourceId' }, 400);

      const [source] = await sql`SELECT id, name, config FROM sources WHERE id = ${sourceId} AND LOWER(type) = 'ai'`;
      if (!source) return c.json({ ok: false, error: `未找到源: ${sourceId}` }, 404);

      const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : (source.config || {});
      const apiUrl = cfg.api_url || cfg.url || '';
      if (!apiUrl) return c.json({ ok: false, error: 'AI 源未配置 API URL' }, 400);

      const resp = await fetch(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0', ...(cfg.api_key ? { 'Authorization': `Bearer ${cfg.api_key}` } : {}) }, signal: AbortSignal.timeout(60000) });
      const data: any[] = await resp.json();
      if (!Array.isArray(data)) return c.json({ ok: false, error: 'API 返回格式无效' }, 500);

      let inserted = 0;
      for (const item of (data || []).slice(0, cfg.max_items || 50)) {
        const title = item.title?.trim() || '(无标题)';
        const url = item.url || item.link || '';
        const publishedAt = item.published_at || item.pubDate || item.isoDate || new Date().toISOString();
        let content = item.content || item.description || item.summary || '';
        const contentHash = hashString(url || title + publishedAt);
        try { content = await processImages(content, 'ai'); } catch { /* ignore */ }

        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},${url},${publishedAt},${classifyByFeed(source.name)},${extractTags(title, source.name)},${contentHash},NOW(),'') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) { inserted++; }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched: data.length, inserted });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  // ============ 喷嚏图卦采集 ============
  router.post('/penti', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0,10).replace(/-/g, '');
      const sourceId = 12;

      const listUrl = `https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei`;
      const resp = await fetch(listUrl, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await resp.text();

      // 提取文章链接
      const linkPattern = /<a\s+href="[^"]*blog\.asp\?name=xilei&subjectid=70[^"]*"[^>]*>([^<]+)<\/a>/gi;
      const links: Array<{ title: string; href: string }> = [];
      let match;
      while ((match = linkPattern.exec(html)) !== null) {
        const hrefMatch = match[0].match(/href="([^"]+)"/);
        if (hrefMatch) links.push({ title: match[1].trim(), href: hrefMatch[1] });
      }
      const targetUrl = links.find(l => l.title.includes(date)) || links.find(l => l.title.includes(date.slice(4,8)));

      if (!targetUrl) return c.json({ ok: false, error: `未找到 ${date} 的喷嚏图卦` }, 404);

      const base = 'https://www.dapenti.com/blog/';
      const artResp = await fetch(base + targetUrl.href, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const artHtml = await artResp.text();

      // 提取正文
      const tdMatch = artHtml.match(/<td[^>]*class="oblog_t_2"[^>]*>([\s\S]*?)<\/td>/i);
      if (!tdMatch) return c.json({ ok: false, error: '未找到正文' }, 500);

      const rawHtml = tdMatch[1];
      const tempJson = '/tmp/penti_' + date + '.json';
      const tempMd = '/tmp/penti_' + date + '.md';
      writeFileSync(tempJson, JSON.stringify({ title: targetUrl.title, html: rawHtml }), 'utf-8');

      // Convert HTML to MD
      const pentiScript = path.join(PENTI_SCRIPT_DIR, 'html_to_md.py');
      const convProc = spawn('python3', [pentiScript, tempJson, tempMd], { timeout: 30000 });
      for await (const chunk of convProc.stderr) { /* */ }
      await new Promise((res, rej) => { convProc.on('close', res); convProc.on('error', rej); });

      let mdContent = '';
      try { mdContent = readFileSync(tempMd, 'utf-8'); } catch { /* */ }
      try { unlinkSync(tempJson); } catch { /* */ }
      try { unlinkSync(tempMd); } catch { /* */ }

      if (!mdContent) return c.json({ ok: false, error: '转换失败' }, 500);

      const title = targetUrl.title;
      const contentHash = hashString('penti:' + date);
      const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${mdContent},${mdContent.slice(0,150)},${base + targetUrl.href},${date},'社会',${['喷嚏图卦',date.slice(0,6)]},${contentHash},NOW(),'喷嚏图卦','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;

      let inserted = false;
      if (rows.length > 0) {
        inserted = true;
        await saveArticleFile(rows[0].id, mdContent, { id:rows[0].id, title, source_type:'rss', source_name:'喷嚏图卦', url:base + targetUrl.href, published_at:date, category:'社会', tags:['喷嚏图卦',date.slice(0,6)], author:'喷嚏图卦', is_read:false, is_starred:false });
      }
      return c.json({ ok: true, date, inserted });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

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
