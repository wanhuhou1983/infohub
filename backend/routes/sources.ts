/**
 * 信息源路由
 * 
 * 支持：
 * - 获取信息源列表/树
 * - 更新信息源配置（PATCH config）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';

export function createSourcesRoutes(sql: Sql): Hono {
  const router = new Hono();

  // 获取所有信息源
  router.get('/', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;
    return c.json(sources);
  });

  // 获取信息源树（父源+子源分组）
  // 注意：微信公众号的子源如果 enabled=false 则不显示
  router.get('/tree', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;
    
    const parents = sources.filter(s => !s.parent_id);
    const children = sources.filter(s => s.parent_id);
    
    const tree = parents.map(p => {
      // 微信公众号（id=24）的子源：只显示 enabled=true 的
      let filteredChildren = children.filter(ch => ch.parent_id === p.id);
      if (p.id === 24) {
        filteredChildren = filteredChildren.filter(ch => ch.enabled === true);
      }
      return {
        ...p,
        children: filteredChildren,
      };
    });
    
    return c.json(tree);
  });

  // 更新信息源配置（合并式更新，不覆盖未传字段）
  router.patch('/:id/config', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

    // 读取当前 config，合并新值
    const [row] = await sql`SELECT config FROM sources WHERE id = ${id}`;
    if (!row) return c.json({ error: 'Source not found' }, 404);

    const currentConfig = row.config || {};
    const newConfig = { ...currentConfig, ...body };

    const [updated] = await sql`
      UPDATE sources SET config = ${sql.json(newConfig)}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, type, config
    `;

    return c.json(updated);
  });

  return router;
}
