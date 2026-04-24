/**
 * 文章路由
 * 
 * 安全修复：
 * - 消除 sql.unsafe()，改用参数化查询
 * - 动态 WHERE 条件构建，避免 if/else 组合爆炸
 * - source_id 参数校验防 NaN
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile } from '../file-storage.js';
import { parseXWLBContentHtml, parseWechatContentHtml, parseRMRBContentHtml } from '../services/parser.js';

export function createArticlesRoutes(sql: Sql): Hono {
  const router = new Hono();

  // 获取文章列表（动态条件构建，参数化安全查询）
  router.get('/', async (c) => {
    const {
      source_id, category, is_read, is_starred,
      search, tab, limit = '50', offset = '0'
    } = c.req.query();

    const numLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const numOffset = Math.max(Number(offset) || 0, 0);

    // 第一步：确定 source_id 过滤条件
    let sourceIds: number[] = [];
    if (source_id) {
      const sid = Number(source_id);
      if (isNaN(sid) || sid <= 0) return c.json({ error: 'Invalid source_id' }, 400);
      const childSources = await sql`SELECT id FROM sources WHERE parent_id = ${sid}`;
      sourceIds = [sid, ...childSources.map(c => c.id)];
    }

    // 第二步：动态构建 WHERE 条件
    // postgres.js 支持嵌套 sql`` 模板标签，自动展平为参数化查询
    const conditions: ReturnType<typeof sql>[] = [];

    // source_id 过滤
    if (sourceIds.length > 0) {
      conditions.push(sql`a.source_id = ANY(${sourceIds}::int[])`);
    }

    // 搜索
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(sql`(a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})`);
    }

    // tab 快捷方式（转换为具体条件）
    if (tab === 'unread') {
      conditions.push(sql`a.is_read = FALSE`);
    } else if (tab === 'starred') {
      conditions.push(sql`a.is_starred = TRUE`);
    } else if (tab === 'today') {
      conditions.push(sql`a.published_at >= CURRENT_DATE`);
    }

    // 独立过滤条件（可与 tab 叠加）
    if (category) {
      conditions.push(sql`a.category = ${category}`);
    }
    if (is_read !== undefined) {
      conditions.push(sql`a.is_read = ${is_read === 'true'}`);
    }
    if (is_starred !== undefined) {
      conditions.push(sql`a.is_starred = ${is_starred === 'true'}`);
    }

    // 合并条件：用 AND 连接所有片段
    // 🔒 修复：缓存 buildWhere 结果，避免多次调用生成不同参数编号
    const whereClause = conditions.length > 0
      ? conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)
      : sql`1=1`;

    const articles = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a LEFT JOIN sources s ON a.source_id = s.id
      WHERE ${whereClause}
      ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
    `;

    const countResult = await sql`
      SELECT COUNT(*)::int AS total FROM articles a
      WHERE ${whereClause}
    `;

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
    console.log(`[文章 ${id}] source_type=${art.source_type}, url=${art.url?.slice(-30)}, content_len=${art.content?.length}`);
    if (art.url && art.content && art.content.length < 100) {
      console.log(`[文章 ${id}] 尝试抓取正文, source_type=${art.source_type}, url包含people=${art.url.includes('paper.people.com.cn')}`);
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
      } else if (art.source_type === 'rmrb' && art.url && art.url.includes('paper.people.com.cn')) {
        console.log(`[文章 ${id}] 开始抓取人民日报正文`);
        try {
          const fullContent = await fetchAndParseRMRBContent(art.url);
          console.log(`[文章 ${id}] 抓取完成, length=${fullContent?.length}`);
          if (fullContent) {
            const { processedContent } = await saveArticleFile(id, fullContent, {
              id, title: art.title, source_type: 'rmrb',
              source_name: art.source_name || '人民日报', url: art.url,
              published_at: art.published_at, category: art.category,
              tags: art.tags || [], author: art.author,
              is_read: art.is_read, is_starred: art.is_starred,
            });
            await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${id}`;
            art.content = processedContent;
          }
        } catch (e: any) {
          console.error(`抓取人民日报正文失败 [${art.url}]:`, e.message);
        }
      }
    }

    return c.json(art);
  });

  // 标记已读/未读
  router.patch('/:id/read', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const { is_read } = await c.req.json();
    await sql`UPDATE articles SET is_read = ${!!is_read} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 标记星标
  router.patch('/:id/star', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const { is_starred } = await c.req.json();
    await sql`UPDATE articles SET is_starred = ${!!is_starred} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 批量标记已读
  router.post('/mark-all-read', async (c) => {
    const { source_id } = await c.req.json().catch(() => ({}));
    if (source_id) {
      const sid = Number(source_id);
      if (isNaN(sid) || sid <= 0) return c.json({ error: 'Invalid source_id' }, 400);
      await sql`UPDATE articles SET is_read = TRUE WHERE source_id = ${sid} AND is_read = FALSE`;
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

async function fetchAndParseRMRBContent(url: string): Promise<string | null> {
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
    return parseRMRBContentHtml(html);
  } catch (e: any) {
    console.error('fetchAndParseRMRBContent error:', e.message);
    return null;
  }
}
