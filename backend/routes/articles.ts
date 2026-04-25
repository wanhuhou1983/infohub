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

    // 第一步：确定 source_id 过滤条件（递归查所有子孙源）
    let sourceIds: number[] = [];
    if (source_id) {
      const sid = Number(source_id);
      if (isNaN(sid) || sid <= 0) return c.json({ error: 'Invalid source_id' }, 400);
      // 递归 WITH 查询获取所有子孙源
      const allDescendants = await sql`
        WITH RECURSIVE tree AS (
          SELECT id FROM sources WHERE id = ${sid}
          UNION ALL
          SELECT s.id FROM sources s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id FROM tree
      `;
      sourceIds = allDescendants.map(c => c.id);
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
    if (c.req.query('is_watch_later') !== undefined) {
      conditions.push(sql`a.is_watch_later = ${c.req.query('is_watch_later') === 'true'}`);
    }

    // 合并条件：用 AND 连接所有片段
    // 🔒 Bug fix：使用工厂函数，每次调用生成独立的 sql 片段，避免 postgres.js 参数编号冲突
    const buildWhere = () => conditions.length > 0
      ? conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)
      : sql`1=1`;

    const articles = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a LEFT JOIN sources s ON a.source_id = s.id
      WHERE ${buildWhere()}
      ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
    `;

    // 🔒 Bug fix：COUNT 查询保持与主查询一致的 JOIN 结构
    // 防止未来 WHERE 条件引用 sources 表字段时因缺少 JOIN 报错
    const countResult = conditions.length > 0
      ? await sql`SELECT COUNT(*)::int AS total FROM articles a LEFT JOIN sources s ON a.source_id = s.id WHERE ${buildWhere()}`
      : await sql`SELECT COUNT(*)::int AS total FROM articles`;

    return c.json({ articles, total: countResult[0]?.total ?? 0 });
  });

  // 获取单篇文章（纯读取，不触发写操作）
  // 🔒 Bug fix：原来 GET 内部执行远程抓取+写库，违背 REST 规范且有竞态风险
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
    // 标记是否需要抓取正文（前端可据此提示用户手动触发）
    const needsFetch = art.url && (!art.content || art.content.length < 100);
    return c.json({ ...art, needsFetch: !!needsFetch });
  });

  // 🔒 新增：独立正文抓取接口，POST 触发，带防重锁
  router.post('/:id/fetch-content', async (c) => {
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

    // 已经有足够正文，无需抓取
    if (art.content && art.content.length >= 100) {
      return c.json({ ok: true, message: '正文已存在', content_length: art.content.length });
    }

    // 防重锁：检查 extra.fetching 是否在 30 秒内（防并发重复抓取）
    const extra = (art.extra as Record<string, any>) || {};
    if (extra.fetching && Date.now() - extra.fetching < 30000) {
      return c.json({ error: '正在抓取中，请稍候' }, 409);
    }

    // 设置抓取锁
    await sql`UPDATE articles SET extra = jsonb_set(COALESCE(extra, '{}'), '{fetching}', '${Date.now()}'::jsonb) WHERE id = ${id}`;

    try {
      let fullContent: string | null = null;
      let sourceType = art.source_type;

      console.log(`[文章 ${id}] 开始抓取正文, source_type=${art.source_type}, url=${art.url}`);

      if (art.source_type === 'xwlb') {
        fullContent = await fetchAndParseXWLBContent(art.url);
      } else if (art.source_type === 'rss' && art.url?.includes('mp.weixin.qq.com')) {
        fullContent = await fetchAndParseWechatContent(art.url);
        sourceType = 'wechat';
      } else if (art.source_type === 'rmrb' && art.url?.includes('paper.people.com.cn')) {
        fullContent = await fetchAndParseRMRBContent(art.url);
      } else {
        return c.json({ error: '不支持自动抓取该类型文章', source_type: art.source_type }, 400);
      }

      if (!fullContent) {
        return c.json({ error: '抓取失败，可能是 URL 失效或网络问题' }, 502);
      }

      const { processedContent } = await saveArticleFile(id, fullContent, {
        id, title: art.title, source_type: sourceType,
        source_name: art.source_name || '', url: art.url,
        published_at: art.published_at, category: art.category,
        tags: art.tags || [], author: art.author,
        is_read: art.is_read, is_starred: art.is_starred,
      });

      // 更新正文并清除抓取锁
      await sql`UPDATE articles SET content = ${processedContent}, extra = extra - 'fetching' WHERE id = ${id}`;

      return c.json({ ok: true, content_length: processedContent.length });
    } catch (e: any) {
      // 清除抓取锁（失败也要释放）
      await sql`UPDATE articles SET extra = extra - 'fetching' WHERE id = ${id}`;
      console.error(`抓取正文失败 [${id}]:`, e.message);
      return c.json({ error: `抓取失败: ${e.message}` }, 500);
    }
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
