import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { saveArticleFile, syncAllFiles } from './file-storage.js';

const sql = postgres(process.env.DATABASE_URL!);

const app = new Hono();

app.use('/api/*', cors());

// ============ Sources ============

// 获取所有信息源（树形结构）
app.get('/api/sources', async (c) => {
  const sources = await sql`SELECT * FROM sources ORDER BY id`;
  return c.json(sources);
});

// 获取信息源树（父源+子源分组）
app.get('/api/sources/tree', async (c) => {
  const sources = await sql`SELECT * FROM sources ORDER BY id`;
  
  // 分为父源和子源
  const parents = sources.filter(s => !s.parent_id);
  const children = sources.filter(s => s.parent_id);
  
  // 构建树
  const tree = parents.map(p => ({
    ...p,
    children: children.filter(c => c.parent_id === p.id),
  }));
  
  return c.json(tree);
});

// ============ Articles ============

// 获取文章列表
app.get('/api/articles', async (c) => {
  const {
    source_id, category, is_read, is_starred,
    search, tab, limit = '50', offset = '0'
  } = c.req.query();

  let whereParts: string[] = [];
  let params: any[] = [];
  let paramIdx = 1;

  if (source_id) {
    // 如果是父源，包含所有子源的文章
    const childSources = await sql`SELECT id FROM sources WHERE parent_id = ${Number(source_id)}`;
    const sourceIds = [Number(source_id), ...childSources.map(c => c.id)];
    whereParts.push(`source_id IN (${sourceIds.join(',')})`);
  }
  if (category) {
    whereParts.push(`category = $${paramIdx++}`);
    params.push(category);
  }
  if (is_read !== undefined) {
    whereParts.push(`is_read = $${paramIdx++}`);
    params.push(is_read === 'true');
  }
  if (is_starred !== undefined) {
    whereParts.push(`is_starred = $${paramIdx++}`);
    params.push(is_starred === 'true');
  }
  if (search) {
    whereParts.push(`(title ILIKE $${paramIdx} OR content ILIKE $${paramIdx})`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  // tab 快捷过滤
  if (tab === 'unread') {
    whereParts.push(`is_read = FALSE`);
  } else if (tab === 'starred') {
    whereParts.push(`is_starred = TRUE`);
  } else if (tab === 'today') {
    whereParts.push(`published_at >= CURRENT_DATE`);
  }

  const where = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';

  const articles = await sql`
    SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
    FROM articles a
    LEFT JOIN sources s ON a.source_id = s.id
    ${sql.unsafe(where ? where : '')}
    ORDER BY a.published_at DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `;

  const countResult = await sql`
    SELECT COUNT(*)::int AS total FROM articles a
    ${sql.unsafe(where ? where : '')}
  `;

  return c.json({ articles, total: countResult[0]?.total ?? 0 });
});

// 获取单篇文章（自动抓取正文）
app.get('/api/articles/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const article = await sql`
    SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
    FROM articles a
    LEFT JOIN sources s ON a.source_id = s.id
    WHERE a.id = ${id}
  `;
  if (article.length === 0) return c.json({ error: 'Not found' }, 404);

  const art = article[0];

  // 如果正文是占位符或太短，尝试从原始 URL 抓取正文
  if (art.url && art.content && art.content.length < 100) {
    // 根据来源类型选择抓取方式
    if (art.source_type === 'xwlb') {
      try {
        const fullContent = await fetchXWLBContent(art.url);
        if (fullContent) {
          // 先保存文件（会处理图片上传到图床），再更新 DB
          const { processedContent } = await saveArticleFile(id, fullContent, {
            id,
            title: art.title,
            source_type: art.source_type,
            source_name: art.source_name || '新闻联播',
            url: art.url,
            published_at: art.published_at,
            category: art.category,
            tags: art.tags || [],
            author: art.author,
            is_read: art.is_read,
            is_starred: art.is_starred,
          });
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${id}`;
          art.content = processedContent;
        }
      } catch (e: any) {
        console.error(`抓取新闻联播正文失败 [${art.url}]:`, e.message);
      }
    } else if (art.source_type === 'rss' && art.url.includes('mp.weixin.qq.com')) {
      try {
        const fullContent = await fetchWechatContent(art.url);
        if (fullContent) {
          // 先保存文件（会处理图片上传到图床），再更新 DB
          const { processedContent } = await saveArticleFile(id, fullContent, {
            id,
            title: art.title,
            source_type: 'wechat',
            source_name: art.source_name || '微信公众号',
            url: art.url,
            published_at: art.published_at,
            category: art.category,
            tags: art.tags || [],
            author: art.author,
            is_read: art.is_read,
            is_starred: art.is_starred,
          });
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${id}`;
          art.content = processedContent;
        }
      } catch (e: any) {
        console.error(`抓取公众号正文失败 [${art.url}]:`, e.message);
      }
    }
  }

  return c.json(art);
});

// 标记已读/未读
app.patch('/api/articles/:id/read', async (c) => {
  const id = Number(c.req.param('id'));
  const { is_read } = await c.req.json();
  await sql`UPDATE articles SET is_read = ${is_read} WHERE id = ${id}`;
  return c.json({ ok: true });
});

// 标记星标
app.patch('/api/articles/:id/star', async (c) => {
  const id = Number(c.req.param('id'));
  const { is_starred } = await c.req.json();
  await sql`UPDATE articles SET is_starred = ${is_starred} WHERE id = ${id}`;
  return c.json({ ok: true });
});

// 批量标记已读
app.post('/api/articles/mark-all-read', async (c) => {
  const { source_id } = await c.req.json().catch(() => ({}));
  if (source_id) {
    await sql`UPDATE articles SET is_read = TRUE WHERE source_id = ${Number(source_id)} AND is_read = FALSE`;
  } else {
    await sql`UPDATE articles SET is_read = TRUE WHERE is_read = FALSE`;
  }
  return c.json({ ok: true });
});

// ============ Fetch Logs ============

app.get('/api/fetch-logs', async (c) => {
  const { source_id, status, limit = '30' } = c.req.query();
  let whereParts: string[] = [];
  if (source_id) whereParts.push(`source_id = ${Number(source_id)}`);
  if (status) whereParts.push(`status = '${status}'`);
  const where = whereParts.length > 0 ? 'WHERE ' + whereParts.join(' AND ') : '';

  const logs = await sql`
    SELECT fl.*, s.name AS source_name, s.icon AS source_icon
    FROM fetch_logs fl
    LEFT JOIN sources s ON fl.source_id = s.id
    ${sql.unsafe(where ? where : '')}
    ORDER BY fl.started_at DESC
    LIMIT ${Number(limit)}
  `;
  return c.json(logs);
});

// ============ Stats ============

// 全量同步：将数据库所有文章导出为本地文件
app.post('/api/sync/files', async (c) => {
  const startMs = Date.now();
  try {
    const result = await syncAllFiles(
      async (queryStr: string) => {
        return sql.unsafe(queryStr);
      },
      async (id: number, content: string) => {
        await sql`UPDATE articles SET content = ${content} WHERE id = ${id}`;
      }
    );
    const durationMs = Date.now() - startMs;
    return c.json({ ok: true, ...result, duration_ms: durationMs });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get('/api/stats', async (c) => {
  const [totalResult] = await sql`SELECT COUNT(*)::int AS total FROM articles`;
  const [todayResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE published_at >= CURRENT_DATE`;
  const [unreadResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_read = FALSE`;
  const [starredResult] = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_starred = TRUE`;

  const sourceStats = await sql`
    SELECT s.id, s.name, s.icon, s.type, s.enabled, s.last_fetch, s.parent_id,
           COUNT(a.id)::int AS article_count,
           COUNT(CASE WHEN a.published_at >= CURRENT_DATE THEN 1 END)::int AS today_count,
           COUNT(CASE WHEN a.is_read = FALSE THEN 1 END)::int AS unread_count
    FROM sources s
    LEFT JOIN articles a ON a.source_id = s.id
    GROUP BY s.id, s.name, s.icon, s.type, s.enabled, s.last_fetch, s.parent_id
    ORDER BY s.id
  `;

  return c.json({
    totalArticles: totalResult.total,
    todayArticles: todayResult.total,
    unreadArticles: unreadResult.total,
    starredArticles: starredResult.total,
    sources: sourceStats,
  });
});

// ============ Fetch (采集) ============

app.post('/api/fetch/xwlb', async (c) => {
  const { date } = await c.req.json().catch(() => ({}));
  const targetDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const startMs = Date.now();

  try {
    // 获取新闻联播源
    const [xwlbSource] = await sql`SELECT id FROM sources WHERE type = 'xwlb' LIMIT 1`;
    if (!xwlbSource) return c.json({ error: '新闻联播信息源未配置' }, 400);

    // 从 CCTV 抓取
    const url = `https://tv.cctv.com/lm/xwlb/day/${targetDate}.shtml`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CCTV 页面返回 ${response.status}`);
    }
    const html = await response.text();

    // 解析文章列表
    const articles = parseXWLBHtml(html, targetDate);

    // 写入数据库 + 本地文件
    let inserted = 0;
    for (const art of articles) {
      try {
        const contentHash = hashString(art.title + 'xwlb');
        const insertedRows = await sql`
          INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at)
          VALUES (${xwlbSource.id}, ${art.title}, ${art.content}, ${art.summary}, ${art.url}, ${art.publishedAt}, ${art.category}, ${art.tags}, ${contentHash}, NOW())
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING id
        `;
        inserted++;
        // 同步写本地文件 + 上传图片到图床
        if (insertedRows.length > 0) {
          const { processedContent } = await saveArticleFile(insertedRows[0].id, art.content, {
            id: insertedRows[0].id,
            title: art.title,
            source_type: 'xwlb',
            source_name: '新闻联播',
            url: art.url,
            published_at: art.publishedAt,
            category: art.category,
            tags: art.tags,
            author: null,
            is_read: false,
            is_starred: false,
          });
          // 如果图片被替换了，更新 DB
          if (processedContent !== art.content) {
            await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${insertedRows[0].id}`;
          }
        }
      } catch (e: any) {
        if (!e.message?.includes('duplicate')) console.error('Insert error:', e.message);
      }
    }

    // 更新源最后采集时间
    await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${xwlbSource.id}`;

    // 写日志
    const durationMs = Date.now() - startMs;
    await sql`
      INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
      VALUES (${xwlbSource.id}, '每日采集', 'success', ${inserted}, ${`获取 ${targetDate} 文字稿成功，共 ${articles.length} 条新闻，入库 ${inserted} 条`}, ${durationMs})
    `;

    return c.json({ ok: true, fetched: articles.length, inserted, date: targetDate });

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

// ============ Fetch RSS (Miniflux) ============

app.post('/api/fetch/rss', async (c) => {
  const { feed_id, limit = 100 } = await c.req.json().catch(() => ({}));
  const startMs = Date.now();

  try {
    // 获取 RSS 信息源
    const [rssSource] = await sql`SELECT id, config FROM sources WHERE type = 'rss' LIMIT 1`;
    if (!rssSource) return c.json({ error: 'RSS 信息源未配置' }, 400);

    const config = rssSource.config || {};
    const minifluxUrl = config.miniflux_url || process.env.MINIFLUX_URL || 'http://localhost:8084';
    const minifluxUser = config.miniflux_user || process.env.MINIFLUX_USER || 'admin';
    const minifluxPass = config.miniflux_pass || process.env.MINIFLUX_PASS || 'miniflux123';

    // 从 Miniflux API 拉取条目
    const auth = Buffer.from(`${minifluxUser}:${minifluxPass}`).toString('base64');
    let entriesUrl = `${minifluxUrl}/v1/entries?limit=${Number(limit)}&order=published_at&direction=desc`;
    if (feed_id) entriesUrl += `&feed_id=${Number(feed_id)}`;

    const response = await fetch(entriesUrl, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new Error(`Miniflux API 返回 ${response.status}`);
    }

    const data = await response.json() as any;
    const entries = data.entries || [];

    // 同时获取 feeds 列表，建立 feed_id -> feed_name 映射
    const feedsResp = await fetch(`${minifluxUrl}/v1/feeds`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const feeds = feedsResp.ok ? await feedsResp.json() as any[] : [];
    const feedMap = new Map<number, { title: string; feed_url: string }>();
    for (const f of feeds) {
      feedMap.set(f.id, { title: f.title, feed_url: f.feed_url });
    }

    // 为每个 Miniflux feed 创建子信息源（如果不存在）
    const feedSourceMap = new Map<number, number>(); // miniflux_feed_id -> infohub_source_id
    const seenFeedIds = new Set<number>();
    for (const entry of entries) {
      const mfFeedId = entry.feed?.id;
      if (!mfFeedId || seenFeedIds.has(mfFeedId)) continue;
      seenFeedIds.add(mfFeedId);

      const feedInfo = feedMap.get(mfFeedId);
      const feedName = feedInfo?.title || entry.feed?.title || `RSS Feed #${mfFeedId}`;
      const feedUrl = feedInfo?.feed_url || '';

      // 判断是否为微信公众号 feed
      const isWechat = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
      const feedType = isWechat ? 'wechat' : 'rss';
      const parentId = isWechat
        ? (await sql`SELECT id FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`)[0]?.id
        : rssSource.id;

      // 检查是否已有此子源
      const [existing] = await sql`
        SELECT id FROM sources WHERE type = ${feedType} AND config->>'miniflux_feed_id' = ${String(mfFeedId)}
      `;
      if (existing) {
        feedSourceMap.set(mfFeedId, existing.id);
      } else {
        // 创建子信息源，parent_id 指向对应的父源
        const [created] = await sql`
          INSERT INTO sources (name, type, icon, config, enabled, parent_id)
          VALUES (${feedName}, ${feedType}, ${isWechat ? '💬' : '📡'}, ${JSON.stringify({ miniflux_feed_id: String(mfFeedId), feed_url: feedUrl })}, true, ${parentId})
          RETURNING id
        `;
        feedSourceMap.set(mfFeedId, created.id);
      }
    }

    // 写入文章 + 本地文件
    let inserted = 0;
    for (const entry of entries) {
      try {
        const mfFeedId = entry.feed?.id;
        const sourceId = mfFeedId ? feedSourceMap.get(mfFeedId) : rssSource.id;
        if (!sourceId) continue;

        const title = entry.title || '无标题';
        const url = entry.url || '';
        const content = cleanHtmlContent(entry.content || entry.description || '');
        const publishedAt = entry.published_at || new Date().toISOString();
        const author = entry.author || '';

        // 根据 feed 名称和标题分类
        const feedTitle = entry.feed?.title || '';
        let category = '综合';
        if (/科技|tech|AI| Hacker|Lil'|arXiv|量子位/i.test(feedTitle)) category = '科技';
        else if (/财经|金融|Bloomberg|market|wallstreet|财新/i.test(feedTitle)) category = '财经';
        else if (/BBC|CNN|新闻|News/i.test(feedTitle)) category = '国际';
        else if (/三联|生活|利维坦/i.test(feedTitle)) category = '人文';
        else if (/阑夕|饭统|喷嚏/i.test(feedTitle)) category = '综合';

        // 从内容提取标签
        const tags = extractTags(title + ' ' + content.slice(0, 200), feedTitle);

        // 判断来源类型
        const feedUrl = entry.feed?.feed_url || '';
        const isWechat = feedUrl.includes('weixin') || feedUrl.includes('wechat') || feedUrl.includes('kindle4rss');
        const feedType = isWechat ? 'wechat' : 'rss';
        const feedName = feedSourceMap.has(mfFeedId)
          ? (await sql`SELECT name FROM sources WHERE id = ${sourceId}`)[0]?.name || feedTitle
          : feedTitle;

        const contentHash = hashString(url || (title + 'rss'));
        const insertedRows = await sql`
          INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
          VALUES (${sourceId}, ${title}, ${content}, ${content.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author})
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING id
        `;
        inserted++;

        // 同步写本地文件 + 上传图片到图床
        if (insertedRows.length > 0) {
          const { processedContent } = await saveArticleFile(insertedRows[0].id, content, {
            id: insertedRows[0].id,
            title,
            source_type: feedType,
            source_name: feedName,
            url,
            published_at: publishedAt,
            category,
            tags,
            author,
            is_read: false,
            is_starred: false,
          });
          // 如果图片被替换了，更新 DB
          if (processedContent !== content) {
            await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${insertedRows[0].id}`;
          }
        }
      } catch (e: any) {
        if (!e.message?.includes('duplicate')) console.error('RSS insert error:', e.message);
      }
    }

    // 更新源最后采集时间
    await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${rssSource.id}`;

    // 写日志
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

// 从标题和内容中提取标签
function extractTags(text: string, feedTitle: string = ''): string[] {
  const tags: string[] = [];
  const tagRules: [RegExp, string][] = [
    [/AI|人工智能|GPT|LLM|大模型/i, 'AI'],
    [/芯片|semiconductor|chip/i, '芯片'],
    [/加密|crypto|bitcoin|区块链/i, '加密'],
    [/石油|oil|原油/i, '石油'],
    [/降息|加息|利率|interest rate/i, '利率'],
    [/GDP|经济|economy/i, '经济'],
    [/战争|冲突|war|conflict/i, '地缘'],
    [/气候|carbon|碳/i, '气候'],
    [/航天|space|火箭/i, '航天'],
  ];
  for (const [pattern, tag] of tagRules) {
    if (pattern.test(text) || pattern.test(feedTitle)) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags : ['综合'];
}

// ============ 辅助函数 ============

function parseXWLBHtml(html: string, dateStr: string): any[] {
  const articles: any[] = [];
  const seen = new Set<string>();

  // CCTV 页面结构: <a href="https://tv.cctv.com/...VIDE...shtml" alt="标题" title="标题">
  // 匹配方式1: 从 alt 或 title 属性提取标题
  const linkPattern = /<a\s+href="(https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE\w+\.shtml)"[^>]*(?:alt|title)="([^"]+)"[^>]*>/gi;
  let match;

  // 提取日期用于 publishedAt
  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);
  const publishedAt = `${year}-${month}-${day}T19:30:00`;

  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1];
    let title = match[2].trim();

    // 清理标题：去掉 [视频] 前缀和《新闻联播》节目头
    title = title.replace(/^\[视频\]\s*/, '');
    if (!title || title.startsWith('《新闻联播》')) continue;
    if (title.includes('完整版') && title.includes('新闻联播')) continue;

    // 去重
    if (seen.has(url)) continue;
    seen.add(url);

    // 简单分类
    let category = '国内';
    if (/国际|外交|访华|会谈|峰会|日本|美国|伊朗|韩国|欧盟|联合国/.test(title)) category = '国际';
    if (/经济|GDP|财政|央行|金融|降准|利率|投资|市场/.test(title)) category = '财经';
    if (/科技|创新|数字|AI|芯片|航天|航空/.test(title)) category = '科技';
    if (/农业|农村|农民|粮食|春播|扶贫/.test(title)) category = '民生';

    // 提取标签
    const tags: string[] = [];
    const tagMap: Record<string, string> = {
      '经济': '经济', '政策': '政策', '外交': '外交', '科技': '科技',
      '农业': '农业', '教育': '教育', '环境': '环保', '军事': '军事',
      '金融': '金融', '改革': '改革',
    };
    for (const [keyword, tag] of Object.entries(tagMap)) {
      if (title.includes(keyword)) tags.push(tag);
    }

    articles.push({
      title,
      content: `（完整内容请查看原文）`,
      summary: title,
      url,
      publishedAt,
      category,
      tags: tags.length > 0 ? tags : ['综合'],
    });
  }

  return articles;
}

// 从微信公众号页面抓取正文
async function fetchWechatContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!response.ok) return null;

    const html = await response.text();

    // 公众号正文在 <div id="js_content"> 或 <div class="rich_media_content"> 里
    let contentHtml = '';
    const jsContentMatch = html.match(/<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/i);
    if (jsContentMatch) {
      contentHtml = jsContentMatch[1];
    } else {
      const richMediaMatch = html.match(/<div[^>]*class="rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<\/div>)/i);
      if (richMediaMatch) {
        contentHtml = richMediaMatch[1];
      }
    }

    if (!contentHtml) return null;

    // 提取图片 URL（微信用 data-src 懒加载）
    contentHtml = contentHtml.replace(/<img[^>]*data-src=["']([^"']+)["'][^>]*\/?>/gi, (match, src) => {
      return `__IMG__${src}__IMG__`;
    });
    // 也处理普通 src
    contentHtml = contentHtml.replace(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, (match, src) => {
      // 跳过微信的占位图和图标
      if (src.includes('data:image') || src.includes('biz') || src.includes('qrcode')) return '';
      return `__IMG__${src}__IMG__`;
    });

    return cleanHtmlContent(contentHtml);
  } catch (e: any) {
    console.error('fetchWechatContent error:', e.message);
    return null;
  }
}

// 从 CCTV 单条页面抓取正文
async function fetchXWLBContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) return null;

    const html = await response.text();

    // 提取 <div class="content_area" id="content_area"> 内的内容
    const contentMatch = html.match(/<div[^>]*class="content_area"[^>]*id="content_area"[^>]*>([\s\S]*?)<\/div>/i);
    if (!contentMatch) {
      // 备用：尝试匹配 class="content_area" 不管 id
      const altMatch = html.match(/<div[^>]*class="content_area"[^>]*>([\s\S]*?)<\/div>/i);
      if (!altMatch) return null;
      return cleanHtmlContent(altMatch[1]);
    }

    return cleanHtmlContent(contentMatch[1]);
  } catch (e: any) {
    console.error('fetchXWLBContent error:', e.message);
    return null;
  }
}

// 清理 HTML 内容，保留图片标签，其余转为纯文本
function cleanHtmlContent(html: string): string {
  if (!html) return '';

  let text = html
    // <img> 标签：提取 src，转为自闭合占位，后续不会被清除
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '\n\n__IMG__$1__IMG__\n\n')
    // <p> 标签转为换行
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    // <br> 转换行
    .replace(/<br\s*\/?>/gi, '\n')
    // <strong>/<b> 去标签留文字
    .replace(/<\/?(strong|b)>/gi, '')
    // HTML 实体
    .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // 去掉剩余 HTML 标签（__IMG__ 标记不受影响，因为不是 <tag>）
    .replace(/<[^>]+>/g, '')
    // 清理多余空行
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function hashString(str: string): string {
  // 使用 Bun 内置的 crypto 生成 MD5
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(str);
  return hasher.digest('hex');
}

// ============ 启动 ============

const port = Number(process.env.PORT || 3001);
console.log(`InfoHub API 启动: http://localhost:${port}`);

serve({ fetch: app.fetch, port });
