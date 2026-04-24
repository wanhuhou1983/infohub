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

  // 获取信息源树（支持多层嵌套）
  // 注意：微信公众号的子源如果 enabled=false 则不显示
  router.get('/tree', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;
    
    // 构建节点映射
    const nodeMap = new Map();
    sources.forEach(s => nodeMap.set(s.id, { ...s, children: [] }));
    
    const roots: any[] = [];
    
    // 构建树结构
    sources.forEach(s => {
      const node = nodeMap.get(s.id);
      if (s.parent_id === null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(s.parent_id);
        if (parent) {
          // 微信公众号：只显示 enabled=true 的子源
          if (parent.type === 'wechat' && node.enabled === false) {
            return; // 跳过
          }
          parent.children.push(node);
        }
      }
    });
    
    return c.json(roots);
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
