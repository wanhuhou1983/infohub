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
import { isIPv6 } from 'net';
import { saveArticleFile } from '../file-storage.js';
import { parseXWLBContentHtml, parseWechatContentHtml, parseRMRBContentHtml } from '../services/parser.js';
import { fail } from '../shared/response.js';

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
      if (isNaN(sid) || sid <= 0) return fail(c, 'Invalid source_id', 400);
      // 递归 WITH 查询获取所有子孙源
      const allDescendants = await sql`
        WITH RECURSIVE tree AS (
          SELECT id FROM sources WHERE id = ${sid}
          UNION ALL
          SELECT s.id FROM sources s JOIN tree t ON s.parent_id = t.id
          WHERE s.enabled = true
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
    // postgres.js Fragment 可安全复用于多个查询，参数自动独立编号
    const whereClause = conditions.length > 0
      ? conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)
      : sql`1=1`;

    const articles = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a LEFT JOIN sources s ON a.source_id = s.id
      WHERE ${whereClause}
      ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
    `;

    // COUNT 查询保持与主查询一致的 JOIN + WHERE 结构
    const countResult = await sql`SELECT COUNT(*)::int AS total FROM articles a LEFT JOIN sources s ON a.source_id = s.id WHERE ${whereClause}`;

    return c.json({ articles, total: countResult[0]?.total ?? 0 });
  });

  // 获取单篇文章（纯读取，不触发写操作）
  // 🔒 Bug fix：原来 GET 内部执行远程抓取+写库，违背 REST 规范且有竞态风险
  router.get('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    const article = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a
      LEFT JOIN sources s ON a.source_id = s.id
      WHERE a.id = ${id}
    `;
    if (article.length === 0) return fail(c, 'Not found', 404);

    const art = article[0]!;
    // 标记是否需要抓取正文（前端可据此提示用户手动触发）
    // stub 文章（100~500字符且仅来源+链接）也标记为需要重新抓取
    const isStub = art.content && art.content.length >= 100 &&
      art.content.length < 500 &&
      art.content.includes('来源：') && art.content.includes('链接：');
    const needsFetch = art.url && (!art.content || art.content.length < 100 || isStub);
    return c.json({ ...art, needsFetch: !!needsFetch });
  });

  // 🔒 新增：独立正文抓取接口，POST 触发，带防重锁
  router.post('/:id/fetch-content', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    const article = await sql`
      SELECT a.*, s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a
      LEFT JOIN sources s ON a.source_id = s.id
      WHERE a.id = ${id}
    `;
    if (article.length === 0) return fail(c, 'Not found', 404);

    const art = article[0]!;

    // 已经有足够正文（>500字符）且不是 stub（不含来源：+链接：），无需重新抓取
    if (art.content && art.content.length >= 500) {
      return c.json({ ok: true, message: '正文已存在', content_length: art.content.length });
    }
    // 100~500 字符的 stub（仅来源+链接），允许重新抓取
    const isStub = art.content && art.content.length >= 100 &&
      art.content.includes('来源：') && art.content.includes('链接：');
    if (art.content && art.content.length >= 100 && !isStub) {
      // 有短正文但不是 stub，也视为够用
      return c.json({ ok: true, message: '正文已存在(短正文)', content_length: art.content.length });
    }

    // 防重锁：检查 extra.fetching 是否在 30 秒内（防并发重复抓取）
    const extra = (art.extra as Record<string, any>) || {};
    if (extra.fetching && Date.now() - extra.fetching < 30000) {
      return fail(c, '正在抓取中，请稍候', 409);
    }

    // 设置抓取锁
    await sql`UPDATE articles SET extra = jsonb_set(COALESCE(extra, '{}'), '{fetching}', ${JSON.stringify(Date.now())}::jsonb) WHERE id = ${id}`;

    try {
      let fullContent: string | null = null;
      let sourceType = art.source_type;

      console.log(`[文章 ${id}] 开始抓取正文, source_type=${art.source_type}, url=${art.url}`);

      if (art.source_type === 'xwlb') {
        fullContent = await fetchAndParseXWLBContent(art.url);
      } else if (art.source_type === 'wechat' || (art.source_type === 'rss' && art.url?.includes('mp.weixin.qq.com'))) {
        fullContent = await fetchAndParseWechatContent(art.url);
        sourceType = 'wechat';
      } else if (art.source_type === 'rmrb' && art.url?.includes('paper.people.com.cn')) {
        fullContent = await fetchAndParseRMRBContent(art.url);
      } else {
        return fail(c, '不支持自动抓取该类型文章', 400);
      }

      if (!fullContent) {
        return fail(c, '抓取失败，可能是 URL 失效或网络问题', 502);
      }

      const { processedContent } = await saveArticleFile(id, fullContent, {
        id, title: art.title, source_type: sourceType,
        source_name: art.source_name || '', url: art.url,
        published_at: art.published_at, category: art.category,
        tags: art.tags || [], author: art.author,
        is_read: art.is_read, is_starred: art.is_starred,
        extra: art.extra,
      });

      // 更新正文并清除抓取锁
      await sql`UPDATE articles SET content = ${processedContent}, extra = extra - 'fetching' WHERE id = ${id}`;

      return c.json({ ok: true, content_length: processedContent.length });
    } catch (e: any) {
      // 清除抓取锁（失败也要释放）
      await sql`UPDATE articles SET extra = extra - 'fetching' WHERE id = ${id}`;
      console.error(`抓取正文失败 [${id}]:`, e.message);
      return fail(c, `抓取失败: ${e.message}`, 500);
    }
  });

  // 标记已读/未读
  router.patch('/:id/read', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);
    const { is_read } = await c.req.json();
    await sql`UPDATE articles SET is_read = ${!!is_read} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 标记星标
  router.patch('/:id/star', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);
    const { is_starred } = await c.req.json();
    await sql`UPDATE articles SET is_starred = ${!!is_starred} WHERE id = ${id}`;
    return c.json({ ok: true });
  });

  // 批量标记已读
  router.post('/mark-all-read', async (c) => {
    const { source_id } = await c.req.json().catch(() => ({}));
    if (source_id) {
      const sid = Number(source_id);
      if (isNaN(sid) || sid <= 0) return fail(c, 'Invalid source_id', 400);
      await sql`UPDATE articles SET is_read = TRUE WHERE source_id = ${sid} AND is_read = FALSE`;
    } else {
      await sql`UPDATE articles SET is_read = TRUE WHERE is_read = FALSE`;
    }
    return c.json({ ok: true });
  });

  return router;
}

// ============ 辅助：从 URL 抓取并解析正文 ============

/** 检查 URL 是否指向内网地址（SSRF 防护） */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    // 检查已知内网域名/IP
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname === '::1' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return true;
    }
    // 检查内网 IP 段：10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x, 127.x.x.x, 0.x.x.x
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [a, b] = [parseInt(ipv4Match[1]!), parseInt(ipv4Match[2]!)];
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 127) return true;
      if (a === 0) return true; // 0.0.0.0/8
    }
    // 检查 IPv6 内网地址
    if (isIPv6(hostname)) {
      // 规范化：去掉方括号（URL 中 IPv6 可能被 [::1] 包裹）
      const clean = hostname.replace(/^\[|\]$/g, '');
      if (isIPv6(clean)) {
        // 取第一个 hextet 判断前缀
        const first = clean.split(':')[0]?.toLowerCase() || '';
        // fc00::/7（唯一本地地址）：fc00 ~ fdff
        if (first.startsWith('fc') || first.startsWith('fd')) return true;
        // fe80::/10（链路本地地址）：fe80 ~ febf
        if (first.startsWith('fe8') || first.startsWith('fe9') || first.startsWith('fea') || first.startsWith('feb')) return true;
      }
    }
    return false;
  } catch {
    return true; // URL 解析失败视为不安全
  }
}

async function fetchAndParseXWLBContent(url: string): Promise<string | null> {
  try {
    if (isPrivateUrl(url)) {
      console.error('[SSRF 拦截] xwlb URL 指向内网:', url);
      return null;
    }
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
    if (isPrivateUrl(url)) {
      console.error('[SSRF 拦截] wechat URL 指向内网:', url);
      return null;
    }
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
  if (isPrivateUrl(url)) {
    console.error('fetchAndParseRMRBContent: 拒绝访问内网地址', url);
    return null;
  }
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
