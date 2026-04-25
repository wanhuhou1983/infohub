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
import { parseXWLBListHtml, cleanHtmlToText } from '../services/parser.js';
import { classifyByTitle, classifyByFeed, extractTags, extractXWLBTags } from '../services/classifier.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, statSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIDER_DIR = process.env.SPIDER_DIR || path.resolve(__dirname, '../../../wechat-article-spider');
const PYTHON_CMD = path.join(SPIDER_DIR, '.venv/bin/python3');
const MINERU_SCRIPT = process.env.MINERU_SCRIPT || path.join(
  process.env.HOME || '/root', '.workbuddy/skills/mineru-extract/scripts/mineru_extract.py'
);
const TENCENT_NEWS_CLI = process.env.TENCENT_NEWS_CLI || path.join(
  process.env.HOME || '/root', '.workbuddy/skills/tencent-news/tencent-news-cli'
);

// ============ RSS 直接解析（不再依赖 Miniflux） ============
import RssParser from 'rss-parser';
import { createHash } from 'node:crypto';
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
 * 翻译英文文本为中文（分段处理，百度 API 限制单次 6000 字符）
 * 返回翻译后的中文文本
 */
async function translateToChinese(text: string): Promise<string> {
  if (!text || text.length < 10) return text;

  // 百度翻译单次最大 6000 字符，分段翻译
  const MAX_CHUNK = 5000; // 留余量
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_CHUNK));
    remaining = remaining.slice(MAX_CHUNK);
  }

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    const result = await baiduTranslate(chunk, 'en', 'zh');
    if (result) {
      translatedChunks.push(result);
    } else {
      translatedChunks.push(chunk); // 翻译失败保留原文
    }
    // 避免请求过快（百度 QPS 限制）
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 200));
  }

  return translatedChunks.join('\n');
}

/**
 * 翻译标题
 */
async function translateTitle(title: string): Promise<string> {
  if (!isEnglish(title)) return title;
  const result = await baiduTranslate(title, 'en', 'zh');
  return result || title;
}

/**
 * 对单个 RSS feed URL 执行采集：解析 XML → 全文抓取 → 图片上传图床 → 英文翻译 → 本地存储 → 入库
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
  const isWechat = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
  const isMagazine = feedUrl.includes('caixin') && !feedUrl.includes('caixinwang');
  const feedType = isWechat ? 'wechat' : (isMagazine ? 'magazine' : 'rss');

  let inserted = 0;
  let translated = 0;
  for (const item of items) {
    try {
      const title = item.title || '无标题';
      const url = item.link || item.guid || '';
      if (!url) continue;

      const rssContent = cleanHtmlToText(item.content || item.contentSnippet || item.summary || '');
      const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
      const author = item.creator || item.author || '';

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

      // ========== 图片处理：上传到图床 ==========
      try {
        fullContent = await processImages(fullContent);
      } catch (e: any) {
        console.error(`[RSS] 图片处理失败: ${e.message}`);
      }

      // ========== 英文翻译 ==========
      let finalTitle = title;
      let finalContent = fullContent;
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
              translated++;
            }
          }
        } catch (e: any) {
          console.error(`[RSS] 翻译失败: ${title.slice(0, 30)}... - ${e.message}`);
        }
      }

      const category = classifyByFeed(sourceName);
      const tags = extractTags(finalTitle + ' ' + finalContent.slice(0, 200), sourceName);

      const insertedRows = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
        VALUES (${sourceId}, ${finalTitle}, ${finalContent}, ${finalContent.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      if (insertedRows.length > 0) {
        inserted++;
        const newId = insertedRows[0]!.id;
        const { processedContent } = await saveArticleFile(newId, finalContent, {
          id: newId, title: finalTitle, source_type: feedType,
          source_name: sourceName, url, published_at: publishedAt,
          category, tags, author, is_read: false, is_starred: false,
        });
        if (processedContent !== finalContent) {
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
        }
      }
    } catch (e: any) {
      if (e.code !== '23505') console.error('RSS insert error:', e.message);
    }
  }

  // 更新子源的 last_fetch
  await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;

  return { fetched: items.length, inserted, translated };
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

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        console.error(`MinerU error: ${stderr}`);
        resolve(null);
        return;
      }
      // 清理 MinerU 输出的图片格式，转换为 __IMG__ 标记
      const content = stdout
        .replace(/!\[.*?\]\((https?:\/\/[^)]+)\)/g, '__IMG__$1__IMG__')
        .replace(/<img.*?src=["'](https?:\/\/[^"']+)["'].*?>/g, '__IMG__$1__IMG__');
      resolve(content);
    });
  });
}

// ============ 辅助函数：调用 wechat-article-spider 抓取正文 ============
export async function crawlWechatArticle(articleUrl: string): Promise<{ title: string; content: string; author: string; publishDate: string } | null> {
  return new Promise((resolve) => {
    const outputDir = path.join(SPIDER_DIR, 'docs');
    const args = ['main.py', articleUrl, outputDir];
    
    const proc = spawn(PYTHON_CMD, args, {
      cwd: path.join(SPIDER_DIR, 'scripts'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`Wechat spider error: ${stderr}`);
        resolve(null);
        return;
      }
      
      // 解析输出的 markdown 文件
      // 查找最新的 .md 文件
      try {
        const files = readdirSync(outputDir).filter(f => f.endsWith('.md'));
        if (files.length === 0) {
          resolve(null);
          return;
        }
        
        // 按修改时间排序，取最新的
        files.sort((a: string, b: string) => {
          const statA = statSync(path.join(outputDir, a));
          const statB = statSync(path.join(outputDir, b));
          return statB.mtime.getTime() - statA.mtime.getTime();
        });
        
        const latestFile = files[0];
        const content = readFileSync(path.join(outputDir, latestFile), 'utf-8');
        
        // 去掉 frontmatter
        let body = content;
        if (content.startsWith('---')) {
          const endIdx = content.indexOf('---', 3);
          if (endIdx > 0) {
            body = content.slice(endIdx + 3).trim();
          }
        }
        
        // 提取标题（第一行 # 开头）
        let title = '';
        let restContent = body;
        const titleMatch = body.match(/^#\s+(.+)$/m);
        if (titleMatch) {
          title = titleMatch[1];
          restContent = body.replace(/^#\s+.+$/m, '').trim();
        }
        
        resolve({
          title: title || '无标题',
          content: restContent,
          author: '',
          publishDate: '',
        });
      } catch (e: any) {
        console.error(`Parse markdown error: ${e.message}`);
        resolve(null);
      }
    });
  });
}

export function createFetchRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 新闻联播采集 ============

  router.post('/xwlb', async (c) => {
    const { date } = await c.req.json().catch(() => ({}));
    const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const startMs = Date.now();

    try {
      const [xwlbSource] = await sql`SELECT id FROM sources WHERE type = 'xwlb' LIMIT 1`;
      if (!xwlbSource) return c.json({ error: '新闻联播信息源未配置' }, 400);

      const url = `https://tv.cctv.com/lm/xwlb/day/${targetDate}.shtml`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`CCTV 页面返回 ${response.status}`);
      const html = await response.text();

      // 用 cheerio 解析
      const parsedArticles = parseXWLBListHtml(html, targetDate);

      let inserted = 0;
      for (const art of parsedArticles) {
        const category = classifyByTitle(art.title);
        const tags = extractXWLBTags(art.title);

        try {
          const contentHash = hashString(art.title + 'xwlb');
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
            VALUES (${xwlbSource.id}, ${art.title}, '（完整内容请查看原文）', ${art.title}, ${art.url}, ${art.publishedAt}, ${category}, ${tags}, ${contentHash}, NOW())
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          // 🐛 修复：只有真正插入才计数
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            const { processedContent } = await saveArticleFile(newId, '（完整内容请查看原文）', {
              id: newId, title: art.title, source_type: 'xwlb',
              source_name: '新闻联播', url: art.url, published_at: art.publishedAt,
              category, tags, author: null, is_read: false, is_starred: false,
            });
            if (processedContent !== '（完整内容请查看原文）') {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
            }
          }
        } catch (e: any) {
          // 使用 PostgreSQL 错误码识别唯一键冲突，而非字符串匹配
          if (e.code !== '23505') console.error('XWLB insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${xwlbSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${xwlbSource.id}, '每日采集', 'success', ${inserted}, ${`获取 ${targetDate} 文字稿成功，共 ${parsedArticles.length} 条新闻，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: parsedArticles.length, inserted, date: targetDate });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [xwlbSource] = await sql`SELECT id FROM sources WHERE type = 'xwlb' LIMIT 1`;
      if (xwlbSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${xwlbSource.id}, '每日采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ RSS 采集（直接解析 RSS feed，不依赖 Miniflux） ============

  router.post('/rss', async (c) => {
    const { feed_url, limit } = await c.req.json().catch(() => ({}));
    const startMs = Date.now();

    try {
      const [rssSource] = await sql`SELECT id FROM sources WHERE type = 'rss' AND parent_id IS NULL LIMIT 1`;
      if (!rssSource) return c.json({ error: 'RSS 信息源未配置' }, 400);

      // 获取所有已启用的 RSS 子源（有 feed_url 的）
      const childSources = await sql`
        SELECT id, name, config->>'feed_url' AS feed_url
        FROM sources
        WHERE parent_id = ${rssSource.id} AND enabled = true AND config->>'feed_url' IS NOT NULL
        ORDER BY id
      `;

      if (childSources.length === 0) {
        return c.json({ error: '没有已启用的 RSS 子源，请在设置中配置 RSS feed URL' }, 400);
      }

      // 如果指定了 feed_url，只采集该源
      const targets = feed_url
        ? childSources.filter((s: any) => s.feed_url === feed_url)
        : childSources;

      if (feed_url && targets.length === 0) {
        return c.json({ error: `未找到 feed_url=${feed_url} 的子源` }, 404);
      }

      let totalFetched = 0;
      let totalInserted = 0;
      let totalTranslated = 0;
      const errors: string[] = [];

      for (const source of targets) {
        try {
          const result = await fetchRssFeed(sql, source.feed_url, source.id, source.name, rssSource.id);
          totalFetched += result.fetched;
          totalInserted += result.inserted;
          totalTranslated += result.translated;
        } catch (e: any) {
          errors.push(`${source.name}: ${e.message}`);
          console.error(`[RSS] 采集失败: ${source.name}`, e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${rssSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${rssSource.id}, 'RSS采集', 'success', ${totalInserted}, ${`采集 ${targets.length} 个 RSS 源，获取 ${totalFetched} 条，入库 ${totalInserted} 条，翻译 ${totalTranslated} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`}, ${durationMs})
      `;

      return c.json({ ok: true, sources: targets.length, fetched: totalFetched, inserted: totalInserted, translated: totalTranslated, errors: errors.length ? errors : undefined });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [rssSource] = await sql`SELECT id FROM sources WHERE type = 'rss' AND parent_id IS NULL LIMIT 1`;
      if (rssSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${rssSource.id}, 'RSS采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 微信公众号同步（从已启用的 WeFlow 子源采集 → wechat-article-spider → 入库） ============

  router.post('/wechat', async (c) => {
    const startMs = Date.now();

    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置，请在设置页面或环境变量中填写' }, 400);
      const wechatLimit = Math.min(Math.max(Number(config.wechat_limit) || 5, 1), 50);
      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // Step 1: 从数据库读取已启用的 WeFlow 公众号子源（enabled = true 且有 gh_id）
      const childSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources
        WHERE type = 'wechat' AND parent_id = ${wechatSource.id} AND enabled = true AND config->>'gh_id' IS NOT NULL
        ORDER BY name
      `;

      if (childSources.length === 0) {
        return c.json({ ok: true, fetched: 0, inserted: 0, message: '未启用任何公众号，请在公众号管理中开启' });
      }

      // Step 2: 逐个已启用的公众号获取最新消息 → 提取文章 URL → spider 抓取正文 → 入库
      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const source of childSources) {
        const ghId = source.gh_id;
        const displayName = source.name;

        try {
          const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${ghId}&limit=${wechatLimit}`, { headers });
          if (!msgsResp.ok) {
            errors.push(`${displayName}: messages API ${msgsResp.status}`);
            continue;
          }
          const msgsData = await msgsResp.json() as any;
          const messages = msgsData.messages || [];

          for (const msg of messages) {
            try {
              const rawContent = msg.rawContent || '';
              const urlMatches = [...rawContent.matchAll(/<url><!\[CDATA\[(.*?)\]\]><\/url>/g)];
              const articleUrl = urlMatches
                .map(m => m[1])
                .find(u => u && u.includes('mp.weixin.qq.com'));
              if (!articleUrl) continue;

              const titleMatch = rawContent.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
              const rawTitle = titleMatch?.[1] || '';

              const contentHash = hashString(articleUrl);

              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              console.log(`🕷️ 抓取: [${displayName}] ${rawTitle || articleUrl}`);
              const article = await crawlWechatArticle(articleUrl);

              const title = rawTitle || (article?.title && article.title !== '无标题' ? article.title : '') || displayName;
              const publishedAt = msg.createTime ? new Date(msg.createTime * 1000).toISOString() : new Date().toISOString();
              const author = displayName;

              let content = article?.content || `${title}\n\n来源：${displayName}\n链接：${articleUrl}`;
              try {
                content = await processImages(content);
              } catch (e: any) {
                console.error(`图片处理失败: ${e.message}`);
              }

              const category = classifyByFeed(displayName);
              const tags = extractTags(title + ' ' + content.slice(0, 200), displayName);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${source.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${articleUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, content, {
                  id: newId, title, source_type: 'wechat',
                  source_name: displayName, url: articleUrl, published_at: publishedAt,
                  category, tags, author, is_read: false, is_starred: false,
                });
              }
              totalFetched++;
            } catch (e: any) {
              if (e.code !== '23505') {
                errors.push(`${displayName}: ${e.message}`);
                console.error('Wechat article error:', e.message);
              }
            }
          }
        } catch (e: any) {
          errors.push(`${displayName}: ${e.message}`);
          console.error(`WeFlow session ${displayName} error:`, e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${wechatSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${wechatSource.id}, '公众号同步', 'success', ${inserted}, ${`采集 ${childSources.length} 个已启用的公众号，获取 ${totalFetched} 条，入库 ${inserted} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: totalFetched, inserted, accounts: childSources.length, errors: errors.length ? errors : undefined });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [wechatSource] = await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (wechatSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${wechatSource.id}, '公众号同步', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 人民日报采集 ============

  router.post('/rmrb', async (c) => {
    const { date, full } = await c.req.json().catch(() => ({}));
    const startMs = Date.now();

    try {
      const [rmrbSource] = await sql`SELECT id FROM sources WHERE type = 'rmrb' LIMIT 1`;
      if (!rmrbSource) return c.json({ error: '人民日报信息源未配置' }, 400);

      const targetDate = date || new Date().toISOString().slice(0, 10);
      const rmrbDir = process.env.RMRB_DIR || path.resolve(__dirname, '../../skills/rmrb-daily');
      const outputFile = path.join(rmrbDir, `rmrb_${targetDate}.md`);

      // 构建命令参数
      const args = ['rmrb_daily.py', targetDate];
      if (full) args.push('--full');

      console.log(`📰 执行人民日报采集: ${args.join(' ')}`);

      // 调用 Python 脚本
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        const proc = spawn('python3', args, { cwd: rmrbDir });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => resolve({ stdout, stderr, code: code || 0 }));
      });

      if (result.code !== 0) {
        throw new Error(`采集失败: ${result.stderr || '未知错误'}`);
      }

      // 读取生成的 Markdown 文件
      let mdContent = '';
      try {
        mdContent = readFileSync(outputFile, 'utf-8');
      } catch (e: any) {
        throw new Error(`无法读取输出文件: ${e.message}`);
      }

      // 解析 Markdown 提取文章
      // 格式: ## 第01版：要闻\n\n### 1. 标题\n- [查看原文](url)
      const articlePattern = /###\s+\d+\.\s+(.+?)\n- \[查看原文\]\((.+?)\)/g;
      const articles: { title: string; url: string }[] = [];
      let match;
      while ((match = articlePattern.exec(mdContent)) !== null) {
        articles.push({ title: match[1].trim(), url: match[2].trim() });
      }

      console.log(`📰 解析到 ${articles.length} 篇文章`);

      let inserted = 0;
      let totalFetched = 0;
      for (const art of articles) {
        console.log(`  → 处理: ${art.title.slice(0, 20)}... URL: ${art.url.slice(-30)}`);
        try {
          const contentHash = hashString(art.url);
          const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
          if (existing) {
            totalFetched++;
            continue;
          }

          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
            VALUES (${rmrbSource.id}, ${art.title}, ${`来源：人民日报\n链接：${art.url}`}, ${art.title.slice(0, 150)}, ${art.url}, ${targetDate}, '国内', ARRAY['人民日报要闻'], ${contentHash}, NOW())
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;

          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            await saveArticleFile(newId, `来源：人民日报\n链接：${art.url}`, {
              id: newId, title: art.title, source_type: 'rmrb',
              source_name: '人民日报', url: art.url, published_at: targetDate,
              category: '国内', tags: '人民日报要闻', author: '人民日报', is_read: false, is_starred: false,
            });
          }
        } catch (e: any) {
          if (e.code !== '23505') console.error('RMRB insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${rmrbSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${rmrbSource.id}, '每日采集', 'success', ${inserted}, ${`人民日报 ${targetDate}，获取 ${articles.length} 条，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: articles.length, inserted, date: targetDate });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [rmrbSource] = await sql`SELECT id FROM sources WHERE type = 'rmrb' LIMIT 1`;
      if (rmrbSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${rmrbSource.id}, '每日采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 腾讯新闻采集 ============

  router.post('/tencent', async (c) => {
    const { limit = 10 } = await c.req.json().catch(() => ({}));
    const startMs = Date.now();

    try {
      const [tencentSource] = await sql`SELECT id FROM sources WHERE type = 'tencent' LIMIT 1`;
      if (!tencentSource) return c.json({ error: '腾讯新闻信息源未配置' }, 400);

      const cliPath = TENCENT_NEWS_CLI;
      const apiKey = process.env.TENCENT_NEWS_APIKEY;

      if (!apiKey) return c.json({ error: 'TENCENT_NEWS_APIKEY 未配置' }, 400);

      // 调用 CLI 获取热点新闻
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        const proc = spawn('bash', ['-c', `export TENCENT_NEWS_APIKEY='${apiKey}' && ${cliPath} hot --limit ${limit}`]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => resolve({ stdout, stderr, code: code || 0 }));
      });

      if (result.code !== 0) {
        throw new Error(`CLI 执行失败: ${result.stderr}`);
      }

      // 解析输出
      const articles: Array<{title: string; summary: string; source: string; publishedAt: string; url: string}> = [];
      const lines = result.stdout.split('\n');
      let current: any = {};

      for (const line of lines) {
        const titleMatch = line.match(/^\s*(\d+)\.\s*标题：(.+)$/);
        const summaryMatch = line.match(/^\s*摘要[:：]\s*(.+)$/);
        const sourceMatch = line.match(/^\s*来源[:：]\s*(.+)$/);
        const timeMatch = line.match(/^\s*发布时间[:：]\s*(.+)$/);
        const urlMatch = line.match(/^\s*链接[:：]\s*(.+)$/);

        if (titleMatch) {
          if (current.title) articles.push(current);
          current = { title: titleMatch[2], summary: '', source: '', publishedAt: '', url: '' };
        } else if (summaryMatch) {
          current.summary = summaryMatch[1];
        } else if (sourceMatch) {
          current.source = sourceMatch[1];
        } else if (timeMatch) {
          current.publishedAt = timeMatch[1];
        } else if (urlMatch) {
          current.url = urlMatch[1];
        }
      }
      if (current.title) articles.push(current);

      // 过滤无效文章
      const validArticles = articles.filter(a => a.title && a.url && !a.title.includes('共 ') && !a.publishedAt.includes('1970'));

      let inserted = 0;
      for (const art of validArticles) {
        try {
          // 先尝试抓取正文
          let fullContent = '（完整内容请查看原文）';
          try {
            const fetchedContent = await crawlArticleContent(art.url);
            if (fetchedContent && fetchedContent.length > 100) {
              fullContent = fetchedContent;
              console.log(`[Tencent] 抓到正文: ${art.title.slice(0, 20)}... (${fetchedContent.length} chars)`);
            }
          } catch (e: any) {
            console.error(`[Tencent] 抓取正文失败: ${art.url}`, e.message);
          }

          const contentHash = hashString(art.url);
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
            VALUES (${tencentSource.id}, ${art.title}, ${fullContent}, ${art.summary}, ${art.url}, ${art.publishedAt || null}, '热点', ${['腾讯新闻']}, ${contentHash}, NOW())
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            await saveArticleFile(newId, fullContent, {
              id: newId, title: art.title, source_type: 'tencent',
              source_name: '腾讯新闻', url: art.url, published_at: art.publishedAt,
              category: '热点', tags: '腾讯新闻', author: art.source, is_read: false, is_starred: false,
            });
          }
        } catch (e: any) {
          if (e.code !== '23505') console.error('Tencent insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${tencentSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${tencentSource.id}, '热点采集', 'success', ${inserted}, ${`获取 ${validArticles.length} 条热点新闻，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: validArticles.length, inserted });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [tencentSource] = await sql`SELECT id FROM sources WHERE type = 'tencent' LIMIT 1`;
      if (tencentSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${tencentSource.id}, '热点采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ AI 资讯采集 ============

  router.post('/ai', async (c) => {
    const { articles = [] } = await c.req.json().catch(() => ({ articles: [] }));
    const startMs = Date.now();

    try {
      const [aiSource] = await sql`SELECT id FROM sources WHERE type = 'ai' LIMIT 1`;
      if (!aiSource) return c.json({ error: 'AI 资讯信息源未配置' }, 400);

      let inserted = 0;
      for (const art of articles) {
        try {
          // 先尝试抓取正文
          let fullContent = '（完整内容请查看原文）';
          try {
            const fetchedContent = await crawlArticleContent(art.url);
            if (fetchedContent && fetchedContent.length > 100) {
              fullContent = fetchedContent;
              console.log(`[AI] 抓到正文: ${art.title.slice(0, 20)}... (${fetchedContent.length} chars)`);
            }
          } catch (e: any) {
            console.error(`[AI] 抓取正文失败: ${art.url}`, e.message);
          }

          const contentHash = hashString(art.url);
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
            VALUES (${aiSource.id}, ${art.title}, ${fullContent}, ${art.summary}, ${art.url}, ${art.published_at || null}, 'AI', ${['AI资讯']}, ${contentHash}, NOW())
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            await saveArticleFile(newId, fullContent, {
              id: newId, title: art.title, source_type: 'ai',
              source_name: 'AI 资讯', url: art.url, published_at: art.published_at,
              category: 'AI', tags: 'AI资讯', author: art.author, is_read: false, is_starred: false,
            });
          }
        } catch (e: any) {
          if (e.code !== '23505') console.error('AI insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${aiSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${aiSource.id}, 'AI资讯采集', 'success', ${inserted}, ${`获取 ${articles.length} 条 AI 资讯，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: articles.length, inserted });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [aiSource] = await sql`SELECT id FROM sources WHERE type = 'ai' LIMIT 1`;
      if (aiSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${aiSource.id}, 'AI资讯采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
