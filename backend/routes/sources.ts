/**
 * 信息源路由
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
  router.get('/tree', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;
    
    const parents = sources.filter(s => !s.parent_id);
    const children = sources.filter(s => s.parent_id);
    
    const tree = parents.map(p => ({
      ...p,
      children: children.filter(ch => ch.parent_id === p.id),
    }));
    
    return c.json(tree);
  });

  return router;
}
