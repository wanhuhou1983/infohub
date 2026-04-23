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
const SPIDER_DIR = path.resolve(__dirname, '../../../wechat-article-spider');
const PYTHON_CMD = path.join(SPIDER_DIR, '.venv/bin/python3');

// ============ 辅助函数：调用 wechat-article-spider 抓取正文 ============
async function crawlWechatArticle(articleUrl: string): Promise<{ title: string; content: string; author: string; publishDate: string } | null> {
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

  // ============ RSS 同步（Miniflux） ============

  router.post('/rss', async (c) => {
    const { feed_id, limit = 100 } = await c.req.json().catch(() => ({}));
    // 🔒 修复：limit 参数上限校验，防止超大查询
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const startMs = Date.now();

    try {
      const [rssSource] = await sql`SELECT id, config FROM sources WHERE type = 'rss' LIMIT 1`;
      if (!rssSource) return c.json({ error: 'RSS 信息源未配置' }, 400);

      const config = rssSource.config || {};
      const minifluxUrl = config.miniflux_url || process.env.MINIFLUX_URL || 'http://localhost:8084';
      const minifluxUser = config.miniflux_user || process.env.MINIFLUX_USER;
      const minifluxPass = config.miniflux_pass || process.env.MINIFLUX_PASS;

      if (!minifluxUser || !minifluxPass) {
        return c.json({ error: 'Miniflux 凭证未配置，请设置 MINIFLUX_USER 和 MINIFLUX_PASS 环境变量' }, 400);
      }

      const auth = Buffer.from(`${minifluxUser}:${minifluxPass}`).toString('base64');
      let entriesUrl = `${minifluxUrl}/v1/entries?limit=${safeLimit}&order=published_at&direction=desc`;
      // 🔒 修复：feed_id 参数校验，防止 NaN 注入
      if (feed_id) {
        const fid = Number(feed_id);
        if (isNaN(fid) || fid <= 0) return c.json({ error: 'Invalid feed_id: must be a positive number' }, 400);
        entriesUrl += `&feed_id=${fid}`;
      }

      const response = await fetch(entriesUrl, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      if (!response.ok) throw new Error(`Miniflux API 返回 ${response.status}`);

      const data = await response.json() as any;
      const entries = data.entries || [];

      // 获取 feeds 列表
      const feedsResp = await fetch(`${minifluxUrl}/v1/feeds`, {
        headers: { 'Authorization': `Basic ${auth}` },
      });
      const feeds = feedsResp.ok ? await feedsResp.json() as any[] : [];
      const feedMap = new Map<number, { title: string; feed_url: string }>();
      for (const f of feeds) {
        feedMap.set(f.id, { title: f.title, feed_url: f.feed_url });
      }

      // 为每个 Miniflux feed 创建子信息源
      const feedSourceMap = new Map<number, number>();
      const seenFeedIds = new Set<number>();
      for (const entry of entries) {
        const mfFeedId = entry.feed?.id;
        if (!mfFeedId || seenFeedIds.has(mfFeedId)) continue;
        seenFeedIds.add(mfFeedId);

        const feedInfo = feedMap.get(mfFeedId);
        const feedName = feedInfo?.title || entry.feed?.title || `RSS Feed #${mfFeedId}`;
        const feedUrl = feedInfo?.feed_url || '';

        const isWechat = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
        const isMagazine = feedUrl.includes('caixin') && !feedUrl.includes('caixinwang');  // 杂志类 RSS（排除财新网）
        let feedType = 'rss';
        let parentId = rssSource.id;

        if (isWechat) {
          feedType = 'wechat';
          parentId = (await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`)[0]?.id;
        } else if (isMagazine) {
          feedType = 'magazine';
          parentId = (await sql`SELECT id FROM sources WHERE type = 'magazine' AND parent_id IS NULL LIMIT 1`)[0]?.id;
        }

        const [existing] = await sql`
          SELECT id FROM sources WHERE type = ${feedType} AND config->>'miniflux_feed_id' = ${String(mfFeedId)}
        `;
        if (existing) {
          feedSourceMap.set(mfFeedId, existing.id);
        } else {
          const [created] = await sql`
            INSERT INTO sources (name, type, icon, config, enabled, parent_id)
            VALUES (${feedName}, ${feedType}, ${feedType === 'wechat' ? '💬' : (feedType === 'magazine' ? '🗞️' : '📡')}, ${JSON.stringify({ miniflux_feed_id: String(mfFeedId), feed_url: feedUrl })}, true, ${parentId})
            RETURNING id
          `;
          feedSourceMap.set(mfFeedId, created!.id);
        }
      }

      // 🐛 修复 N+1：批量预查所有需要的 source name
      const sourceIds = [...feedSourceMap.values()];
      const sourceRows = sourceIds.length > 0
        ? await sql`SELECT id, name FROM sources WHERE id = ANY(${sourceIds}::int[])`
        : [];
      const sourceNameMap = new Map<number, string>();
      for (const row of sourceRows) {
        sourceNameMap.set(row.id, row.name);
      }

      // 写入文章
      let inserted = 0;
      for (const entry of entries) {
        try {
          const mfFeedId = entry.feed?.id;
          const sourceId = mfFeedId ? feedSourceMap.get(mfFeedId) : rssSource.id;
          if (!sourceId) continue;

          const title = entry.title || '无标题';
          const url = entry.url || '';
          const content = cleanHtmlToText(entry.content || entry.description || '');
          const publishedAt = entry.published_at || new Date().toISOString();
          const author = entry.author || '';

          const feedTitle = entry.feed?.title || '';
          const category = classifyByFeed(feedTitle);
          const tags = extractTags(title + ' ' + content.slice(0, 200), feedTitle);

          const feedUrl = entry.feed?.feed_url || '';
          const isWechat2 = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
          const isMagazine2 = feedUrl.includes('caixin') && !feedUrl.includes('caixinwang');
          const feedType2 = isWechat2 ? 'wechat' : (isMagazine2 ? 'magazine' : 'rss');
          
          // 使用预查的 Map 取 source name，不再循环内查询
          const feedName = sourceNameMap.get(sourceId) || feedTitle;

          const contentHash = hashString(url || (title + 'rss'));
          const insertedRows = await sql`
            INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
            VALUES (${sourceId}, ${title}, ${content}, ${content.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
          `;
          // 🐛 修复：只有真正插入才计数
          if (insertedRows.length > 0) {
            inserted++;
            const newId = insertedRows[0]!.id;
            const { processedContent } = await saveArticleFile(newId, content, {
              id: newId, title, source_type: feedType2,
              source_name: feedName, url, published_at: publishedAt,
              category, tags, author, is_read: false, is_starred: false,
            });
            if (processedContent !== content) {
              await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
            }
          }
        } catch (e: any) {
          // 使用 PostgreSQL 错误码识别唯一键冲突
          if (e.code !== '23505') console.error('RSS insert error:', e.message);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${rssSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${rssSource.id}, 'RSS同步', 'success', ${inserted}, ${`从Miniflux同步 ${entries.length} 条，入库 ${inserted} 条`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: entries.length, inserted });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [rssSource] = await sql`SELECT id FROM sources WHERE type = 'rss' LIMIT 1`;
      if (rssSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${rssSource.id}, 'RSS同步', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 微信公众号同步（WeFlow API → wechat-article-spider → 入库） ============

  router.post('/wechat', async (c) => {
    const startMs = Date.now();

    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      // 从配置中读取公众号名称过滤列表
      const wechatAccounts: string[] = config.wechat_accounts || [];
      
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN || '3ec6f66be8234004882d7eab6ff1d2c3';
      const wechatLimit = Math.min(Math.max(Number(config.wechat_limit) || 5, 1), 50);
      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // Step 1: 获取 WeFlow 会话列表，筛选 gh_ 开头的公众号
      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allSessions = (sessionsData.sessions || []).filter((s: any) => s.username?.startsWith('gh_'));

      // Step 2: 根据配置的公众号名称过滤（displayName 匹配）
      const targetSessions = wechatAccounts.length > 0
        ? allSessions.filter((s: any) => wechatAccounts.includes(s.displayName))
        : allSessions;

      if (targetSessions.length === 0) {
        return c.json({ ok: true, fetched: 0, inserted: 0, message: '没有匹配的公众号' });
      }

      // Step 3: 逐个公众号获取最新消息 → 提取文章 URL → spider 抓取正文 → 入库
      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const session of targetSessions) {
        const ghId = session.username;   // e.g. gh_64fcc3570158
        const displayName = session.displayName;  // e.g. 老陈侃财

        try {
          // 获取该公众号的最新消息
          const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${ghId}&limit=${wechatLimit}`, { headers });
          if (!msgsResp.ok) {
            errors.push(`${displayName}: messages API ${msgsResp.status}`);
            continue;
          }
          const msgsData = await msgsResp.json() as any;
          const messages = msgsData.messages || [];

          for (const msg of messages) {
            try {
              // 从 rawContent XML 中提取公众号文章 URL
              const rawContent = msg.rawContent || '';
              const urlMatches = [...rawContent.matchAll(/<url><!\[CDATA\[(.*?)\]\]><\/url>/g)];
              // 取第一个包含 mp.weixin.qq.com 的 URL
              const articleUrl = urlMatches
                .map(m => m[1])
                .find(u => u && u.includes('mp.weixin.qq.com'));
              if (!articleUrl) continue;

              // 从 rawContent 提取标题
              const titleMatch = rawContent.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
              const rawTitle = titleMatch?.[1] || '';

              const contentHash = hashString(articleUrl);

              // 检查是否已存在（content_hash 唯一键）
              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              // 查找或创建公众号子源
              let [sourceRow] = await sql`
                SELECT id FROM sources WHERE type = 'wechat' AND parent_id = ${wechatSource.id} AND name = ${displayName}
              `;
              if (!sourceRow) {
                const [newSource] = await sql`
                  INSERT INTO sources (name, type, parent_id, config, created_at)
                  VALUES (${displayName}, 'wechat', ${wechatSource.id}, ${JSON.stringify({ gh_id: ghId })}, NOW())
                  RETURNING id
                `;
                sourceRow = newSource;
              }

              // Step 4: 用 wechat-article-spider 抓取正文
              console.log(`🕷️ 抓取: [${displayName}] ${rawTitle || articleUrl}`);
              const article = await crawlWechatArticle(articleUrl);

              // 优先用 WeFlow rawContent 里的标题，spider 的标题可能解析失败
              const title = rawTitle || (article?.title && article.title !== '无标题' ? article.title : '') || displayName;
              const publishedAt = msg.createTime ? new Date(msg.createTime * 1000).toISOString() : new Date().toISOString();
              const author = displayName;

              // 处理图片并上传到图床
              let content = article?.content || `${title}\n\n来源：${displayName}\n链接：${articleUrl}`;
              try {
                content = await processImages(content);
              } catch (e: any) {
                console.error(`图片处理失败: ${e.message}`);
              }

              // 🔒 修复：调用分类器和标签提取器，而非硬编码
              const category = classifyByFeed(displayName);
              const tags = extractTags(title + ' ' + content.slice(0, 200), displayName);

              // Step 5: 写入数据库
              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${sourceRow.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${articleUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
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
        VALUES (${wechatSource.id}, '公众号同步', 'success', ${inserted}, ${`WeFlow 同步 ${targetSessions.length} 个公众号，获取 ${totalFetched} 条，入库 ${inserted} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`}, ${durationMs})
      `;

      return c.json({ ok: true, fetched: totalFetched, inserted, accounts: targetSessions.length, errors: errors.length ? errors : undefined });
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

  return router;
}
