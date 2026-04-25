/**
 * 微信群聊管理路由（WeFlow 群聊管理后台）
 *
 * 功能：
 * - GET    /api/wechat-group-admin/groups           → 获取 WeFlow 群聊列表 + DB 启用状态
 * - PATCH  /api/wechat-group-admin/groups/:id/toggle → 切换单个群聊启用/禁用
 * - PATCH  /api/wechat-group-admin/groups/toggle-all → 批量切换所有群聊启用/禁用
 * - POST   /api/wechat-group-admin/fetch            → 采集已启用群聊消息入库
 * - POST   /api/wechat-group-admin/analyze          → 调用 DeepSeek 分析群聊消息
 * - GET    /api/wechat-group-admin/prompt            → 获取当前提示词
 * - PATCH  /api/wechat-group-admin/prompt            → 更新提示词
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { createHash } from 'crypto';

export function createWechatGroupAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 辅助：获取 WeFlow 配置 ============
  async function getWeflowConfig() {
    const [wechatSource] = await sql`SELECT config FROM sources WHERE type = 'wechat' AND parent_id IS NULL LIMIT 1`;
    const wechatConfig = wechatSource?.config || {};
    const weflowUrl = (wechatConfig.weflow_url || process.env.WEFLOW_URL || 'http://127.0.0.1:5031').replace(/\/+$/, '');
    const weflowToken = wechatConfig.weflow_token || process.env.WEFLOW_TOKEN;
    return { weflowUrl, weflowToken };
  }

  // ============ 辅助：获取群聊根源 ============
  async function getGroupSource() {
    const [row] = await sql`SELECT id, config FROM sources WHERE type = 'wechat_group' AND parent_id IS NULL LIMIT 1`;
    return row;
  }

  // ============ 获取所有群聊列表（WeFlow + DB 状态合并） ============
  router.get('/groups', async (c) => {
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const { weflowUrl, weflowToken } = await getWeflowConfig();
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
      const groupSource = await getGroupSource();
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

  // ============ 采集已启用群聊消息入库 ============
  router.post('/fetch', async (c) => {
    const startMs = Date.now();
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const { weflowUrl, weflowToken } = await getWeflowConfig();
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };
      const messageLimit = 50; // 每个群聊拉取最近50条消息

      // 获取已启用的群聊子源
      const enabledGroups = await sql`
        SELECT id, name, config->>'chatroom_id' AS chatroom_id
        FROM sources
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id} AND enabled = true
      `;

      if (enabledGroups.length === 0) {
        return c.json({ ok: true, fetched: 0, inserted: 0, message: '没有已启用的群聊' });
      }

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const group of enabledGroups) {
        const chatroomId = group.chatroom_id;
        if (!chatroomId) continue;

        try {
          const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${encodeURIComponent(chatroomId)}&limit=${messageLimit}`, { headers });
          if (!msgsResp.ok) {
            errors.push(`${group.name}: messages API ${msgsResp.status}`);
            continue;
          }

          const msgsData = await msgsResp.json() as any;
          const messages: any[] = msgsData.messages || msgsData.data || [];

          for (const msg of messages) {
            // 只处理文本消息 (localType = 1)
            if (msg.localType !== 1) continue;

            const content = msg.parsedContent || msg.content || '';
            if (!content || content.trim().length === 0) continue;

            const sender = msg.senderUsername || '';
            const createTime = msg.createTime ? new Date(msg.createTime * 1000) : new Date();
            const contentHash = createHash('md5').update(`${chatroomId}:${msg.serverId || msg.localId}`).digest('hex');

            try {
              await sql`
                INSERT INTO articles (source_id, title, content, author, published_at, fetched_at, category, tags, content_hash, extra)
                VALUES (
                  ${group.id},
                  ${content.slice(0, 100)},
                  ${content},
                  ${sender},
                  ${createTime},
                  NOW(),
                  '综合',
                  ARRAY['群聊', ${group.name}],
                  ${contentHash},
                  ${sql.json({ 
                    chatroom_id: chatroomId, 
                    group_name: group.name,
                    server_id: String(msg.serverId || ''),
                    local_id: String(msg.localId || ''),
                    is_send: msg.isSend === 1,
                    type: 'wechat_group_message'
                  })}
                )
                ON CONFLICT (content_hash) DO NOTHING
              `;
              // 检查是否真的插入了（postgres.js 不直接返回 affected rows，用 ON CONFLICT DO NOTHING 不会报错）
              inserted++;
            } catch (e: any) {
              // content_hash 唯一冲突忽略
              if (!e.message?.includes('duplicate') && !e.message?.includes('unique')) {
                console.error(`群聊消息入库失败: ${e.message}`);
              }
            }

            totalFetched++;
          }
        } catch (e: any) {
          errors.push(`${group.name}: ${e.message}`);
        }
      }

      // 更新最后采集时间
      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${groupSource.id}`;

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${groupSource.id}, '群聊消息采集', 'success', ${inserted},
          ${`采集 ${enabledGroups.length} 个群聊，获取 ${totalFetched} 条消息，入库 ${inserted} 条`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        groups: enabledGroups.length,
        fetched: totalFetched,
        inserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const groupSource = await getGroupSource();
      if (groupSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${groupSource.id}, '群聊消息采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 获取/更新提示词 ============
  router.get('/prompt', async (c) => {
    const groupSource = await getGroupSource();
    if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);
    const prompt = groupSource.config?.prompt || '请分析以下微信群聊记录，提取关键话题、重要观点和有价值的信息，生成简明扼要的中文摘要。';
    return c.json({ prompt });
  });

  router.patch('/prompt', async (c) => {
    const groupSource = await getGroupSource();
    if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

    const body = await c.req.json();
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return c.json({ error: '提示词不能为空' }, 400);
    }

    await sql`
      UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'), '{prompt}', ${sql.json(prompt)}), updated_at = NOW()
      WHERE id = ${groupSource.id}
    `;

    return c.json({ ok: true, prompt });
  });

  // ============ AI 分析群聊消息 ============
  router.post('/analyze', async (c) => {
    const startMs = Date.now();
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const body = await c.req.json().catch(() => ({}));
      const sourceId = body.source_id; // 可选：只分析某个群聊
      const hours = body.hours || 24; // 分析最近N小时的消息

      const prompt = groupSource.config?.prompt || '请分析以下微信群聊记录，提取关键话题、重要观点和有价值的信息，生成简明扼要的中文摘要。';

      // DeepSeek API 配置
      const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
      if (!deepseekApiKey) return c.json({ error: 'DEEPSEEK_API_KEY 环境变量未配置' }, 400);

      // 获取群聊消息
      const since = new Date(Date.now() - hours * 3600 * 1000);
      let messagesQuery;
      if (sourceId) {
        messagesQuery = sql`
          SELECT a.id, a.title, a.content, a.author, a.published_at, s.name as group_name
          FROM articles a JOIN sources s ON a.source_id = s.id
          WHERE a.source_id = ${sourceId} AND a.published_at >= ${since}
          ORDER BY a.published_at ASC
          LIMIT 500
        `;
      } else {
        // 分析所有已启用群聊的消息
        messagesQuery = sql`
          SELECT a.id, a.title, a.content, a.author, a.published_at, s.name as group_name
          FROM articles a JOIN sources s ON a.source_id = s.id
          WHERE s.type = 'wechat_group' AND s.enabled = true AND a.published_at >= ${since}
          ORDER BY a.published_at ASC
          LIMIT 500
        `;
      }

      const messages = await messagesQuery;
      if (messages.length === 0) {
        return c.json({ ok: true, analysis: '没有找到群聊消息', messageCount: 0 });
      }

      // 拼接消息文本
      const chatText = messages.map((m: any) => {
        const time = m.published_at ? new Date(m.published_at).toLocaleString('zh-CN') : '';
        return `[${m.group_name}] ${time} ${m.author || '未知'}: ${m.content || m.title}`;
      }).join('\n');

      // 调用 DeepSeek API
      const deepseekResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekApiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: chatText },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        }),
      });

      if (!deepseekResp.ok) {
        const errText = await deepseekResp.text();
        throw new Error(`DeepSeek API 返回 ${deepseekResp.status}: ${errText.slice(0, 200)}`);
      }

      const deepseekData = await deepseekResp.json() as any;
      const analysis = deepseekData.choices?.[0]?.message?.content || '分析结果为空';

      // 将分析结果作为一篇文章入库
      const analysisHash = createHash('md5').update(`analysis:${hours}:${sourceId || 'all'}:${Date.now()}`).digest('hex');
      const analysisTitle = `群聊AI分析 - 最近${hours}小时`;

      // 找到或创建一个"AI分析"子源
      let [analysisSource] = await sql`
        SELECT id FROM sources WHERE type = 'wechat_group' AND parent_id = ${groupSource.id} AND config->>'is_analysis' = 'true' LIMIT 1
      `;
      if (!analysisSource) {
        [analysisSource] = await sql`
          INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
          VALUES ('AI分析', 'wechat_group', ${groupSource.id}, ${sql.json({ is_analysis: 'true' })}, true, NOW())
          RETURNING id
        `;
      }

      await sql`
        INSERT INTO articles (source_id, title, content, summary, published_at, fetched_at, category, tags, content_hash, extra)
        VALUES (
          ${analysisSource.id},
          ${analysisTitle},
          ${analysis},
          ${analysis.slice(0, 200)},
          NOW(),
          NOW(),
          '综合',
          ARRAY['AI分析', '群聊摘要'],
          ${analysisHash},
          ${sql.json({ 
            type: 'group_analysis',
            hours,
            message_count: messages.length,
            source_id: sourceId || null,
          })}
        )
        ON CONFLICT (content_hash) DO NOTHING
      `;

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${groupSource.id}, '群聊AI分析', 'success', 1,
          ${`分析 ${messages.length} 条群聊消息，耗时 ${durationMs}ms`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        analysis,
        messageCount: messages.length,
        hours,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const groupSource = await getGroupSource();
      if (groupSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${groupSource.id}, '群聊AI分析', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
