/**
 * B站 UP主管理路由
 *
 * 功能：
 * - GET /api/bilibili-admin/uppers  → 获取UP主列表 + 启用状态（支持搜索）
 * - PATCH /api/bilibili-admin/uppers/:id/toggle → 切换单个UP主启用/禁用
 * - POST /api/bilibili-admin/refresh → 采集已启用UP主的新视频
 */

import { Hono } from 'hono';
import type { Sql } from 'sql.js';

export function createBilibiliAdminUppersRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取UP主列表（支持搜索） ============
  router.get('/uppers', async (c) => {
    try {
      const search = c.req.query('search') || '';
      const parentId = 1273; // B站"更新"节点的ID

      let sources;
      if (search) {
        sources = await sql`
          SELECT s.id, s.name, s.enabled, s.config->>'mid' AS mid,
                 (SELECT MAX(published_at) FROM articles WHERE source_id = s.id) AS latest_article_at
          FROM sources s
          WHERE s.type = 'bilibili-updates' AND s.parent_id = ${parentId}
            AND s.name ILIKE ${'%' + search + '%'}
          ORDER BY s.name
        `;
      } else {
        sources = await sql`
          SELECT s.id, s.name, s.enabled, s.config->>'mid' AS mid,
                 (SELECT MAX(published_at) FROM articles WHERE source_id = s.id) AS latest_article_at
          FROM sources s
          WHERE s.type = 'bilibili-updates' AND s.parent_id = ${parentId}
          ORDER BY s.name
        `;
      }

      const total = sources.length;
      const enabledCount = sources.filter(s => s.enabled).length;

      return c.json({
        total,
        enabledCount,
        uppers: sources.map(s => ({
          id: s.id,
          name: s.name,
          mid: s.mid,
          enabled: s.enabled,
          latest_article_at: s.latest_article_at,
        })),
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 添加UP主 ============
  router.post('/uppers', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { name, mid } = body;

      if (!name || !mid) {
        return c.json({ ok: false, error: '缺少 name 或 mid 参数' }, 400);
      }

      const parentId = 1273; // B站"更新"节点

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources WHERE type = 'bilibili-updates' AND parent_id = ${parentId} AND config->>'mid' = ${mid}
      `;

      if (existing) {
        return c.json({ ok: false, error: '该 UP 主已存在' });
      }

      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at, updated_at)
        VALUES (${name}, 'bilibili-updates', ${parentId}, ${JSON.stringify({ mid })}, true, NOW(), NOW())
        RETURNING id
      `;

      return c.json({ ok: true, id: inserted?.id });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ============ 删除UP主 ============
  router.delete('/uppers/:id', async (c) => {
    try {
      const id = Number(c.req.param('id'));
      if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

      // 先删除关联的文章
      await sql`DELETE FROM articles WHERE source_id = ${id}`;
      // 再删除 UP 主
      await sql`DELETE FROM sources WHERE id = ${id}`;

      return c.json({ ok: true, id });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  // ============ 切换UP主启用/禁用 ============
  router.patch('/uppers/:id/toggle', async (c) => {
    try {
      const id = Number(c.req.param('id'));
      if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

      const body = await c.req.json().catch(() => ({}));
      const enabled = body.enabled === true;

      await sql`
        UPDATE sources SET enabled = ${enabled}, updated_at = NOW() WHERE id = ${id}
      `;

      return c.json({ ok: true, id, enabled });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 采集已启用UP主的新视频 ============
  router.post('/refresh', async (c) => {
    try {
      const parentId = 1273; // B站"更新"节点

      // 获取所有已启用的UP主
      const enabledUppers = await sql`
        SELECT s.id, s.name, s.config->>'mid' AS mid
        FROM sources s
        WHERE s.type = 'bilibili-updates' AND s.parent_id = ${parentId} AND s.enabled = true
      `;

      if (enabledUppers.length === 0) {
        return c.json({ ok: false, error: '没有已启用的UP主' });
      }

      const body = await c.req.json().catch(() => ({}));
      const SESSDATA = body.sessdata || process.env.BILIBILI_SESSDATA || '';

      let totalInserted = 0;
      let totalFetched = 0;

      // 遍历每个UP主获取最新视频
      for (const upper of enabledUppers) {
        if (!upper.mid) continue;

        // 调用B站API获取UP主视频
        const resp = await fetch(
          `https://api.bilibili.com/x/space/arc/search?mid=${upper.mid}&pn=1&ps=10&jsonp=jsonp`,
          { headers: { 'Cookie': `SESSDATA=${SESSDATA}` } }
        );

        if (!resp.ok) continue;

        const data = await resp.json() as any;
        const list = data?.data?.list?.vlist || [];

        if (list.length === 0) continue;

        // 插入文章
        for (const video of list) {
          const bvid = video.bvid;
          const title = video.title;
          const desc = video.description || '';
          const pubdate = new Date(video.created * 1000).toISOString();
          const author = upper.name;
          const sourceId = upper.id;

          // 检查是否已存在
          const [existing] = await sql`
            SELECT id FROM articles WHERE source_id = ${sourceId} AND external_id = ${bvid}
          `;

          if (!existing) {
            const url = `https://www.bilibili.com/video/${bvid}`;
            const [inserted] = await sql`
              INSERT INTO articles (source_id, title, url, external_id, author, description, published_at, created_at)
              VALUES (${sourceId}, ${title}, ${url}, ${bvid}, ${author}, ${desc}, ${pubdate}, NOW())
              RETURNING id
            `;
            if (inserted) {
              totalInserted++;
            }
          }
          totalFetched++;
        }
      }

      return c.json({
        ok: true,
        fetched: totalFetched,
        inserted: totalInserted,
        uppersCount: enabledUppers.length,
      });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}