/**
 * 公众号管理路由（WeFlow 账号管理后台）
 * 
 * 功能：
 * - GET /api/wechat-admin/accounts  → 获取 WeFlow 公众号列表 + DB 启用状态
 * - POST /api/wechat-admin/refresh  → 同步公众号列表 + 采集已启用的文章
 * - POST /api/wechat-admin/ob-resync → 补写缺失的 OB 文件
 * - PATCH /api/wechat-admin/accounts/:id/toggle → 切换单个公众号启用/禁用
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import * as fs from 'fs';
import * as path from 'path';
import { crawlWechatArticle } from '../services/crawler.js';
import { saveArticleFile, hashString, processImages } from '../file-storage.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

// Cache file path (mounted from host WeFlow cache)
const WEFLOW_CACHE_PATH = '/weflow-cache/session-messages.json';

/**
 * 从 WeFlow 缓存文件读取所有 gh_id → messages 映射
 * 缓存文件是 WeFlow 的 session-messages.json，key 是 gh_xxx
 */
function loadWeflowCache(): Record<string, { messages: any[] }> {
  try {
    if (!fs.existsSync(WEFLOW_CACHE_PATH)) return {};
    const raw = fs.readFileSync(WEFLOW_CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e: any) {
    console.warn(`[WeChat] Failed to read cache: ${e.message}`);
    return {};
  }
}

/**
 * 从消息列表中提取文章 URL + title + createTime
 * 只处理 localType=21474836529 且含 mp.weixin.qq.com URL 的消息
 */
function extractArticleUrls(messages: any[]): Array<{ url: string; title: string; createTime: number }> {
  const articles: Array<{ url: string; title: string; createTime: number }> = [];
  for (const msg of messages) {
    const raw = msg.rawContent || '';
    // Must be an article-type message (not welcome text, etc.)
    if (msg.localType !== 21474836529 && msg.localType !== undefined) continue;
    
    const urlMatches = [...raw.matchAll(/<url><!\[CDATA\[(.*?)\]\]><\/url>/g)];
    const articleUrl = urlMatches.map(m => m[1]).find((u: string) => u && u.includes('mp.weixin.qq.com'));
    if (!articleUrl) continue;

    const titleMatch = raw.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const title = titleMatch?.[1] || '';
    articles.push({ url: articleUrl, title, createTime: msg.createTime || 0 });
  }
  // Deduplicate by URL
  const seen = new Set<string>();
  return articles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

export function createWechatAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有公众号列表（WeFlow + DB 状态合并） ============

  router.get('/accounts', async (c) => {
    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allSessions: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.sessionType === 'channel' && s.username?.length > 0);

      const dbSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources
        WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const dbByGhId = new Map<string, any>();
      for (const s of dbSources) {
        if (s.gh_id) dbByGhId.set(s.gh_id, s);
      }

      let newlyCreated = 0;
      for (const session of allSessions) {
        const existing = dbByGhId.get(session.username);
        if (!existing) {
          await sql`
            INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
            VALUES (${session.displayName}, 'wechat', ${wechatSource.id}, ${sql.json({ gh_id: session.username })}, false, NOW())
          `;
          newlyCreated++;
        }
      }

      const updatedSources = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'gh_id' AS gh_id,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_article_at
        FROM sources s
        WHERE s.type = 'wechat' AND s.parent_id = ${wechatSource.id}
      `;
      const updatedByGhId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.gh_id) updatedByGhId.set(s.gh_id, s);
      }

      let accounts = allSessions.map((s: any) => {
        const db = updatedByGhId.get(s.username);
        return {
          gh_id: s.username,
          displayName: s.displayName,
          enabled: !!db?.enabled,
          db_id: db?.id || null,
          latest_article_at: db?.latest_article_at || null,
        };
      });

      accounts.sort((a, b) => {
        if (!a.latest_article_at) return 1;
        if (!b.latest_article_at) return -1;
        return new Date(b.latest_article_at).getTime() - new Date(a.latest_article_at).getTime();
      });

      return c.json({ accounts, total: accounts.length, newlyCreated });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 切换单个公众号启用 / 禁用 ============

  router.patch('/accounts/:id/toggle', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled === true;

    const [updated] = await sql`
      UPDATE sources SET enabled = ${enabled}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, enabled
    `;
    if (!updated) return c.json({ error: 'Source not found' }, 404);

    return c.json(updated);
  });

  // ============ 刷新公众号列表 + 采集已启用的文章 ============

  /**
   * 改进点：
   * 1. 始终合并 HTTP API + Cache 数据（按 URL 去重），不再仅 API=0 时 fallback
   * 2. 采集完成后自动补写缺失的 OB 文件（对已入库但无 OB 文件的文章）
   */
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [wechatSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (!wechatSource) return c.json({ error: '微信公众号信息源未配置' }, 400);

      const config = wechatSource.config || {};
      const weflowUrl = (config.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = config.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);
      const wechatLimit = Math.min(Math.max(Number(config.wechat_limit) || 5, 1), 50);
      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // Step 1: 获取 WeFlow 会话列表
      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allSessions: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.sessionType === 'channel' && s.username?.length > 0);

      // Step 2: 获取 DB 现有子源（只认 gh_id）
      const existingSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const existingByGhId = new Map<string, any>();
      for (const s of existingSources) {
        if (s.gh_id) existingByGhId.set(s.gh_id, s);
      }

      // Step 3: 新增不存在的公众号（默认禁用），只按 gh_id 匹配
      let newlyAdded = 0;
      for (const session of allSessions) {
        const existing = existingByGhId.get(session.username);
        if (!existing) {
          await sql`
            INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
            VALUES (${session.displayName}, 'wechat', ${wechatSource.id}, ${sql.json({ gh_id: session.username })}, false, NOW())
          `;
          newlyAdded++;
        }
      }

      // Step 4: 重新读取（获取完整状态）
      const updatedSources = await sql`
        SELECT id, name, enabled, config->>'gh_id' AS gh_id
        FROM sources WHERE type = 'wechat' AND parent_id = ${wechatSource.id}
      `;
      const sourceByGhId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.gh_id) sourceByGhId.set(s.gh_id, s);
      }

      // Step 5: 筛选已启用的公众号
      const enabledAccounts = allSessions.filter((s: any) => {
        const db = sourceByGhId.get(s.username);
        return !!db?.enabled;
      });

      // ======== Step 6: 采集文章（API + Cache 合并） ========
      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      // Pre-load cache once for all accounts (avoid repeated file reads)
      const weflowCache = loadWeflowCache();
      console.log(`[WeChat] Loaded cache: ${Object.keys(weflowCache).filter(k => k.startsWith('gh_')).length} gh_ids`);

      for (const session of enabledAccounts) {
        const ghId = session.username;
        const displayName = session.displayName;
        const dbSource = sourceByGhId.get(session.username)!;

        try {
          // --- Always try BOTH API and Cache, then merge by URL ---

          // 6a: Try HTTP API
          let apiMessages: any[] = [];
          try {
            const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${ghId}&limit=${wechatLimit}&cursor=0`, { headers });
            if (msgsResp.ok) {
              const msgsData = await msgsResp.json() as any;
              apiMessages = msgsData.messages || [];
            }
          } catch (e: any) {
            console.warn(`[WeChat] HTTP API failed for ${ghId}: ${e.message}`);
          }

          // 6b: Always read from cache too
          let cacheMessages: any[] = [];
          const cached = weflowCache[ghId];
          if (cached?.messages && Array.isArray(cached.messages)) {
            cacheMessages = cached.messages;
          }

          // 6c: Extract article URLs from both sources and merge (deduplicate by URL)
          const apiArticles = extractArticleUrls(apiMessages);
          const cacheArticles = extractArticleUrls(cacheMessages);
          
          const allArticles = new Map<string, { url: string; title: string; createTime: number }>();
          for (const a of cacheArticles) allArticles.set(a.url, a);
          for (const a of apiArticles) {
            if (!allArticles.has(a.url)) allArticles.set(a.url, a);
          }

          if (cacheArticles.length > 0) {
            console.log(`[WeChat] ${displayName} (${ghId}): API=${apiArticles.length}, Cache=${cacheArticles.length}, Merged=${allArticles.size}`);
          }

          // 6d: Process merged articles
          for (const article of allArticles.values()) {
            try {
              const { url: articleUrl, title: rawTitle, createTime } = article;
              const contentHash = hashString(articleUrl);

              // Skip if already in DB
              const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
              if (existing) {
                totalFetched++;
                continue;
              }

              console.log(`🕷️ 抓取: [${displayName}] ${rawTitle.slice(0, 40) || articleUrl}`);
              const crawledArticle = await crawlWechatArticle(articleUrl);

              const title = rawTitle || (crawledArticle?.title && crawledArticle.title !== '无标题' ? crawledArticle.title : '') || displayName;
              const publishedAt = createTime ? new Date(createTime * 1000).toISOString() : new Date().toISOString();
              const author = displayName;

              let content = crawledArticle?.content || `${title}\n\n来源：${displayName}\n链接：${articleUrl}`;
              try { content = await processImages(content, 'wechat'); } catch (e: any) { /* ignore */ }

              const category = classifyByFeed(displayName);
              const tags = extractTags(title + ' ' + content.slice(0, 200), displayName);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (${dbSource.id}, ${title}, ${content}, ${title.slice(0, 150)}, ${articleUrl}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
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
              }
            }
          }
        } catch (e: any) {
          errors.push(`${displayName}: ${e.message}`);
        }
      }

      // ======== Step 7: OB 补写（对已入库但缺少 OB 文件的文章） ========
      let obResynced = 0;
      try {
        const OB_DIR = process.env.OB_DIR || (fs.existsSync('/obsidian') ? '/obsidian' : '');
        if (OB_DIR) {
          // Find wechat articles in DB that don't have corresponding OB files
          const unsynced = await sql`
            SELECT a.id, a.title, a.url, a.published_at, a.content, a.category, a.tags, a.author,
                   s.name as source_name
            FROM articles a
            JOIN sources s ON a.source_id = s.id
            WHERE s.type = 'wechat' AND a.published_at >= NOW() - INTERVAL '30 days'
            ORDER BY a.published_at DESC
          `;

          for (const art of unsynced) {
            // Check if OB file exists using the same logic as saveArticleFile
            const subDir = '微信公众号';
            const dateStr = new Date(art.published_at).toISOString().slice(0, 10).replace(/-/g, '');
            const safeTitle = (art.title || 'untitled').slice(0, 60).replace(/[\/\\:*?"<>|]/g, '_').trim();
            const fileName = `${dateStr}-${safeTitle}.md`;
            const dirPath = path.join(OB_DIR, subDir, art.source_name || '未分类');
            const filePath = path.join(dirPath, fileName);

            if (!fs.existsSync(filePath)) {
              // Write the OB file
              fs.mkdirSync(dirPath, { recursive: true });
              const frontmatter = [
                '---',
                `id: ${art.id}`,
                `title: "${(art.title || '').replace(/"/g, '\\"')}"`,
                `source: 微信公众号`,
                `author: "${(art.author || '').replace(/"/g, '\\"')}"`,
                `url: ${art.url || ''}`,
                `published: ${art.published_at}`,
                `category: ${art.category || ''}`,
                `tags: ${art.tags || ''}`,
                `date: ${new Date(art.published_at).toISOString().slice(0, 10)}`,
                '---',
                '',
                art.content || '',
              ].join('\n');
              fs.writeFileSync(filePath, frontmatter, 'utf-8');
              obResynced++;
            }
          }
          if (obResynced > 0) {
            console.log(`[WeChat] OB resync: wrote ${obResynced} missing files`);
          }
        }
      } catch (e: any) {
        console.warn(`[WeChat] OB resync failed: ${e.message}`);
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${wechatSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${wechatSource.id}, '公众号管理刷新', 'success', ${inserted},
          ${`同步 ${allSessions.length} 个公众号（新增 ${newlyAdded} 个），已启用 ${enabledAccounts.length} 个，获取 ${totalFetched} 条，入库 ${inserted} 条，OB补写 ${obResynced} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        newlyAdded,
        enabledCount: enabledAccounts.length,
        totalAccounts: allSessions.length,
        fetched: totalFetched,
        inserted,
        obResynced,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [wechatSource] = await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      if (wechatSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${wechatSource.id}, '公众号管理刷新', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
