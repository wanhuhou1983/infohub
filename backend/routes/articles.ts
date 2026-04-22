/**
 * 文章路由
 * 
 * 安全修复：消除 sql.unsafe()，改用参数化查询
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile } from '../file-storage.js';
import { parseXWLBContentHtml, parseWechatContentHtml } from '../services/parser.js';

export function createArticlesRoutes(sql: Sql): Hono {
  const router = new Hono();

  // 获取文章列表（参数化查询，无 SQL 注入风险）
  router.get('/', async (c) => {
    const {
      source_id, category, is_read, is_starred,
      search, tab, limit = '50', offset = '0'
    } = c.req.query();

    // 使用 postgres.js 的动态条件构建
    // 通过分段查询实现安全的动态 WHERE
    
    // 第一步：确定 source_id 过滤条件
    let sourceIds: number[] = [];
    if (source_id) {
      const sid = Number(source_id);
      const childSources = await sql`SELECT id FROM sources WHERE parent_id = ${sid}`;
      sourceIds = [sid, ...childSources.map(c => c.id)];
    }

    // 第二步：使用参数化查询构建条件
    // postgres.js 不支持动态拼接参数，所以用条件分支实现
    
    const numLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const numOffset = Math.max(Number(offset) || 0, 0);

    // 构建安全的查询：将所有用户输入参数化
    let articles: any[];
    let countResult: any[];

    if (search) {
      const searchPattern = `%${search}%`;
      if (sourceIds.length > 0) {
        // 有 source_id + search
        if (category !== undefined && is_read !== undefined && is_starred !== undefined) {
          articles = await sql`
            SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
            FROM articles a LEFT JOIN sources s ON a.source_id = s.id
            WHERE a.source_id IN (${sql(sourceIds.map(String))})
              AND a.category = ${category}
              AND a.is_read = ${is_read === 'true'}
              AND a.is_starred = ${is_starred === 'true'}
              AND (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
            ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
          `;
          countResult = await sql`
            SELECT COUNT(*)::int AS total FROM articles a
            WHERE a.source_id IN (${sql(sourceIds.map(String))})
              AND a.category = ${category}
              AND a.is_read = ${is_read === 'true'}
              AND a.is_starred = ${is_starred === 'true'}
              AND (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
          `;
        } else {
          articles = await sql`
            SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
            FROM articles a LEFT JOIN sources s ON a.source_id = s.id
            WHERE a.source_id IN (${sql(sourceIds.map(String))})
              AND (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
            ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
          `;
          countResult = await sql`
            SELECT COUNT(*)::int AS total FROM articles a
            WHERE a.source_id IN (${sql(sourceIds.map(String))})
              AND (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
          `;
        }
      } else {
        // 只 search
        articles = await sql`
          SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
          FROM articles a LEFT JOIN sources s ON a.source_id = s.id
          WHERE (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
          ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
        `;
        countResult = await sql`
          SELECT COUNT(*)::int AS total FROM articles a
          WHERE (a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})
        `;
      }
    } else if (sourceIds.length > 0) {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.source_id IN (${sql(sourceIds.map(String))})
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`
        SELECT COUNT(*)::int AS total FROM articles a
        WHERE a.source_id IN (${sql(sourceIds.map(String))})
      `;
    } else if (tab === 'unread') {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.is_read = FALSE
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_read = FALSE`;
    } else if (tab === 'starred') {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.is_starred = TRUE
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE is_starred = TRUE`;
    } else if (tab === 'today') {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.published_at >= CURRENT_DATE
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE published_at >= CURRENT_DATE`;
    } else if (category) {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.category = ${category}
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`SELECT COUNT(*)::int AS total FROM articles WHERE category = ${category}`;
    } else {
      articles = await sql`
        SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
      `;
      countResult = await sql`SELECT COUNT(*)::int AS total FROM articles`;
    }

    return c.json({ articles, total: countResult[0]?.total ?? 0 });
  });

  // 获取单篇文章（自动抓取正文）
  router.get('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const article = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a
      LEFT JOIN sources s ON a.source_id = s.id
      WHERE a.id = ${id}
    `;
    if (article.length === 0) return c.json({ error: 'Not found' }, 404);

    const art = article[0]!;

    // 如果正文是占位符或太短，尝试从原始 URL 抓取正文
    if (art.url && art.content && art.content.length < 100) {
      if (art.source_type === 'xwlb') {
        try {
          const fullContent = await fetchAndParseXWLBContent(art.url);
          if (fullContent) {
            const { processedContent } = await saveArticleFile(id, fullContent, {
              id, title: art.title, source_type: art.source_type,
              source_name: art.source_name || '新闻联播', url: art.url,
              published_at: art.published_at, category: art.category,
              tags: art.tags || [], author: art.author,
              is_read: art.is_read, is_starred: art.is_starred,
            });
            await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${id}`;
            art.content = processedContent;
          }
        } catch (e: any) {
          console.error(`抓取新闻联播正文失败 [${art.url}]:`, e.message);
        }
      } else if (art.source_type === 'rss' && art.url.includes('mp.weixin.qq.com')) {
        try {
          const fullContent = await fetchAndParseWechatContent(art.url);
          if (fullContent) {
            const { processedContent } = await saveArticleFile(id, fullContent, {
              id, title: art.title, source_type: 'wechat',
              source_name: art.source_name || '微信公众号', url: art.url,
              published_at: art.published_at, category: art.category,
              tags: art.tags || [], author: art.author,
              is_read: art.is_read, is_starred: art.is_starred,
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
  router.patch('/:id/read', async (c) => {
    const id = Number(c.req.param('id'));
    const { is_read } = await c.req.json();
    await sql`UPDATE articles SET is_read = ${!!is_read} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 标记星标
  router.patch('/:id/star', async (c) => {
    const id = Number(c.req.param('id'));
    const { is_starred } = await c.req.json();
    await sql`UPDATE articles SET is_starred = ${!!is_starred} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 批量标记已读
  router.post('/mark-all-read', async (c) => {
    const { source_id } = await c.req.json().catch(() => ({}));
    if (source_id) {
      await sql`UPDATE articles SET is_read = TRUE WHERE source_id = ${Number(source_id)} AND is_read = FALSE`;
    } else {
      await sql`UPDATE articles SET is_read = TRUE WHERE is_read = FALSE`;
    }
    return c.json({ ok: true });
  });

  return router;
}

// ============ 辅助：从 URL 抓取并解析正文 ============

async function fetchAndParseXWLBContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    return parseXWLBContentHtml(html);
  } catch (e: any) {
    console.error('fetchAndParseXWLBContent error:', e.message);
    return null;
  }
}

async function fetchAndParseWechatContent(url: string): Promise<string | null> {
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
    return parseWechatContentHtml(html);
  } catch (e: any) {
    console.error('fetchAndParseWechatContent error:', e.message);
    return null;
  }
}
