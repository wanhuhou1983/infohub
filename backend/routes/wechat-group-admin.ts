/**
 * 微信群聊管理路由（WeFlow 群聊管理后台）
 *
 * 功能：
 * - GET    /api/wechat-group-admin/groups           → 获取 WeFlow 群聊列表 + DB 启用状态
 * - PATCH  /api/wechat-group-admin/groups/:id/toggle → 切换单个群聊启用/禁用
 * - PATCH  /api/wechat-group-admin/groups/toggle-all → 批量切换所有群聊启用/禁用
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';

export function createWechatGroupAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有群聊列表（WeFlow + DB 状态合并） ============
  router.get('/groups', async (c) => {
    try {
      const [groupSource] = await sql`SELECT id, config FROM sources WHERE type = 'wechat_group' AND parent_id IS NULL LIMIT 1`;
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      // 从微信公众号源获取 WeFlow 配置（群聊和公众号共用同一套 WeFlow）
      const [wechatSource] = await sql`SELECT config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
      const wechatConfig = wechatSource?.config || {};
      const weflowUrl = (wechatConfig.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
      const weflowToken = wechatConfig.weflow_token || process.env.WEFLOW_TOKEN;
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      // 获取 WeFlow 会话列表，筛选群聊（以 @chatroom 结尾）
      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allGroups: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.username?.endsWith('@chatroom'));

      // 获取 DB 中已有的群聊子源
      const dbSources = await sql`
        SELECT id, name, enabled, config->>'chatroom_id' AS chatroom_id
        FROM sources
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id}
      `;
      const dbByChatroomId = new Map<string, any>();
      for (const s of dbSources) {
        if (s.chatroom_id) dbByChatroomId.set(s.chatroom_id, s);
      }

      // 合并：确保 WeFlow 每个群聊都在 DB 中有记录
      let newlyCreated = 0;
      for (const session of allGroups) {
        const existing = dbByChatroomId.get(session.username);
        if (!existing) {
          await sql`
            INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
            VALUES (${session.displayName}, 'wechat_group', ${groupSource.id}, ${sql.json({ chatroom_id: session.username })}, false, NOW())
          `;
          newlyCreated++;
        }
      }

      // 重新读取（包含新创建的）
      const updatedSources = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'chatroom_id' AS chatroom_id
        FROM sources s
        WHERE s.type = 'wechat_group' AND s.parent_id = ${groupSource.id}
      `;
      const updatedByChatroomId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.chatroom_id) updatedByChatroomId.set(s.chatroom_id, s);
      }

      // 组装响应
      let groups = allGroups.map((s: any) => {
        const db = updatedByChatroomId.get(s.username);
        return {
          chatroom_id: s.username,
          displayName: s.displayName,
          enabled: !!db?.enabled,
          db_id: db?.id || null,
        };
      });

      // 按名称排序
      groups.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));

      return c.json({ groups, total: groups.length, newlyCreated });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 切换单个群聊启用 / 禁用 ============
  router.patch('/groups/:id/toggle', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled === true;

    const [updated] = await sql`
      UPDATE sources SET enabled = ${enabled}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, enabled
    `;
    if (!updated) return c.json({ error: 'Source not found' }, 404);

    return c.json(updated);
  });

  // ============ 批量切换所有群聊启用/禁用 ============
  router.patch('/groups/toggle-all', async (c) => {
    try {
      const [groupSource] = await sql`SELECT id FROM sources WHERE type = 'wechat_group' AND parent_id IS NULL LIMIT 1`;
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const body = await c.req.json().catch(() => ({}));
      const enabled = body.enabled === true;

      await sql`
        UPDATE sources SET enabled = ${enabled}, updated_at = NOW()
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id}
      `;

      const [count] = await sql`
        SELECT count(*)::int AS cnt FROM sources
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id} AND enabled = ${enabled}
      `;

      return c.json({ ok: true, enabled, count: count?.cnt || 0 });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
