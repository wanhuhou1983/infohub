// @ts-nocheck
/**
 * 翻译服务模块
 * 
 * 从 routes/fetch.ts 拆分出来的所有翻译相关功能
 * 支持：Ollama、llama.cpp、百度、Google、Azure 翻译 API
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
export async function translateText(text: string, from: string = 'en', to: string = 'zh'): Promise<string | null> {
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
export function isEnglish(text: string): boolean {
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
export async function translateToChinese(text: string): Promise<string> {
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
export async function translateTitle(title: string): Promise<string> {
  if (!isEnglish(title)) return title;
  const result = await translateText(title, 'en', 'zh');
  return result || title;
}

/**
 * 轻量并发池：限制同时执行的 Promise 数量
 * 不引入 p-limit 依赖，内联实现
 */
export function createConcurrencyPool(maxConcurrency: number) {
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
