/**
 * 笔记路由
 *
 * 一篇文章可以有多个笔记；列表按文章分组返回，点进去看笔记全文 + 原文链接。
 * 时间列统一存北京时间 wall clock（timestamp without time zone）。
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { fail } from '../shared/response.js';

export function createNotesRoutes(sql: Sql): Hono {
  const router = new Hono();

  // 获取笔记列表：按文章分组，组内按更新时间倒序，组间按最新笔记时间倒序
  router.get('/', async (c) => {
    const search = c.req.query('search')?.trim();

    const rows = await sql`
      SELECT n.id AS note_id, n.content, n.created_at, n.updated_at,
             a.id AS article_id, a.title AS article_title, a.url AS article_url,
             a.published_at, s.type AS source_type,
             s.name AS source_name, s.icon AS source_icon
      FROM notes n
      JOIN articles a ON n.article_id = a.id
      LEFT JOIN sources s ON a.source_id = s.id
      ${search ? sql`WHERE n.content ILIKE ${'%' + search + '%'} OR a.title ILIKE ${'%' + search + '%'}` : sql``}
      ORDER BY n.updated_at DESC, n.id DESC
    `;

    // 按文章分组
    const groupMap = new Map<number, any>();
    for (const r of rows) {
      let g = groupMap.get(r.article_id);
      if (!g) {
        g = {
          article_id: r.article_id,
          title: r.article_title,
          url: r.article_url,
          source_name: r.source_name,
          source_icon: r.source_icon,
          source_type: r.source_type,
          published_at: r.published_at,
          note_count: 0,
          latest_at: r.updated_at,
          notes: [],
        };
        groupMap.set(r.article_id, g);
      }
      g.notes.push({
        id: r.note_id,
        content: r.content,
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
      g.note_count++;
    }

    const groups = [...groupMap.values()].sort((a, b) => {
      const ta = a.latest_at ? new Date(a.latest_at).getTime() : 0;
      const tb = b.latest_at ? new Date(b.latest_at).getTime() : 0;
      return tb - ta;
    });

    return c.json({ groups, total: rows.length, articleCount: groups.length });
  });

  // 取某篇文章的所有笔记（用于详情页展示）
  router.get('/article/:id', async (c) => {
    const articleId = Number(c.req.param('id'));
    if (!Number.isInteger(articleId) || articleId <= 0) return fail(c, 'Invalid article id', 400);
    const notes = await sql`
      SELECT id, content, created_at, updated_at
      FROM notes WHERE article_id = ${articleId}
      ORDER BY updated_at DESC, id DESC
    `;
    return c.json({ notes });
  });

  // 新增笔记
  router.post('/', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return fail(c, 'Invalid JSON', 400); }
    const articleId = Number(body.article_id);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!Number.isInteger(articleId) || articleId <= 0) return fail(c, 'Invalid article_id', 400);
    if (!content) return fail(c, '笔记内容不能为空', 400);

    // 校验文章存在
    const exists = await sql`SELECT 1 FROM articles WHERE id = ${articleId} LIMIT 1`;
    if (exists.length === 0) return fail(c, '文章不存在', 404);

    const rows = await sql`
      INSERT INTO notes (article_id, content)
      VALUES (${articleId}, ${content})
      RETURNING id, article_id, content, created_at, updated_at
    `;
    return c.json({ ok: true, note: rows[0] });
  });

  // 编辑笔记
  router.patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(c, 'Invalid id', 400);
    let body: any;
    try { body = await c.req.json(); } catch { return fail(c, 'Invalid JSON', 400); }
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return fail(c, '笔记内容不能为空', 400);

    const rows = await sql`
      UPDATE notes SET content = ${content}, updated_at = (NOW() AT TIME ZONE 'Asia/Shanghai')
      WHERE id = ${id}
      RETURNING id, article_id, content, created_at, updated_at
    `;
    if (rows.length === 0) return fail(c, '笔记不存在', 404);
    return c.json({ ok: true, note: rows[0] });
  });

  // 删除笔记
  router.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return fail(c, 'Invalid id', 400);
    const rows = await sql`DELETE FROM notes WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) return fail(c, '笔记不存在', 404);
    return c.json({ ok: true });
  });

  return router;
}
