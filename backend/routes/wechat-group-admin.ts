/**
 * 微信群聊管理路由（WeFlow 群聊管理后台）
 *
 * 功能：
 * - GET    /api/wechat-group-admin/groups           → 获取 WeFlow 群聊列表 + DB 启用状态
 * - PATCH  /api/wechat-group-admin/groups/:id/toggle → 切换单个群聊启用/禁用
 * - PATCH  /api/wechat-group-admin/groups/toggle-all → 批量切换所有群聊启用/禁用
 * - POST   /api/wechat-group-admin/fetch            → 采集已启用群聊消息入库（按天聚合+昵称替换）
 * - POST   /api/wechat-group-admin/analyze          → 调用 DeepSeek 分析群聊消息
 * - GET    /api/wechat-group-admin/prompt            → 获取当前提示词
 * - PATCH  /api/wechat-group-admin/prompt            → 更新提示词
 * - GET    /api/wechat-group-admin/daily             → 获取按天聚合的群聊记录
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

  // ============ 辅助：从 WeFlow 获取昵称映射 ============
  async function buildNicknameMap(weflowUrl: string, weflowToken: string): Promise<Record<string, string>> {
    const headers = { 'Authorization': `Bearer ${weflowToken}` };
    const map: Record<string, string> = {};

    // 一次性拉取所有联系人
    try {
      const resp = await fetch(`${weflowUrl}/api/v1/contacts?limit=1000`, { headers, signal: AbortSignal.timeout(30000) });
      if (resp.ok) {
        const data = await resp.json() as any;
        const contacts: any[] = data.contacts || [];
        for (const c of contacts) {
          if (c.type === 'friend') {
            const displayName = c.remark || c.nickname || c.displayName || '';
            if (c.username && displayName) {
              map[c.username] = displayName;
            }
          }
        }
        console.log(`昵称映射: 加载 ${contacts.length} 个联系人，${Object.keys(map).length} 个好友`);
      }
    } catch (e: any) {
      console.error(`获取昵称映射失败: ${e.message}`);
    }

    return map;
  }

  // ============ 辅助：保存/加载昵称映射到 DB ============
  async function saveNicknameMap(map: Record<string, string>) {
    const groupSource = await getGroupSource();
    if (!groupSource) return;
    await sql`
      UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'), '{nickname_map}', ${sql.json(map)}), updated_at = NOW()
      WHERE id = ${groupSource.id}
    `;
  }

  async function loadNicknameMap(): Promise<Record<string, string>> {
    const groupSource = await getGroupSource();
    if (!groupSource?.config?.nickname_map) return {};
    return groupSource.config.nickname_map as Record<string, string>;
  }

  // ============ 辅助：用昵称替换 wxid ============
  function resolveNickname(wxid: string, nicknameMap: Record<string, string>): string {
    return nicknameMap[wxid] || wxid;
  }

  // ============ 获取所有群聊列表（WeFlow + DB 状态合并） ============
  router.get('/groups', async (c) => {
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const { weflowUrl, weflowToken } = await getWeflowConfig();
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };

      const sessionsResp = await fetch(`${weflowUrl}/api/v1/sessions?limit=500`, { headers });
      if (!sessionsResp.ok) throw new Error(`WeFlow sessions API 返回 ${sessionsResp.status}`);
      const sessionsData = await sessionsResp.json() as any;
      const allGroups: any[] = (sessionsData.sessions || [])
        .filter((s: any) => s.username?.endsWith('@chatroom'));

      const dbSources = await sql`
        SELECT id, name, enabled, config->>'chatroom_id' AS chatroom_id
        FROM sources
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id}
      `;
      const dbByChatroomId = new Map<string, any>();
      for (const s of dbSources) {
        if (s.chatroom_id) dbByChatroomId.set(s.chatroom_id, s);
      }

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

      const updatedSources = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'chatroom_id' AS chatroom_id
        FROM sources s
        WHERE s.type = 'wechat_group' AND s.parent_id = ${groupSource.id}
      `;
      const updatedByChatroomId = new Map<string, any>();
      for (const s of updatedSources) {
        if (s.chatroom_id) updatedByChatroomId.set(s.chatroom_id, s);
      }

      let groups = allGroups.map((s: any) => {
        const db = updatedByChatroomId.get(s.username);
        return {
          chatroom_id: s.username,
          displayName: s.displayName,
          enabled: !!db?.enabled,
          db_id: db?.id || null,
        };
      });

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

  // ============ 采集已启用群聊消息入库（按天聚合 + 昵称替换） ============
  router.post('/fetch', async (c) => {
    const startMs = Date.now();
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const { weflowUrl, weflowToken } = await getWeflowConfig();
      if (!weflowToken) return c.json({ error: 'WeFlow Token 未配置' }, 400);

      const headers = { 'Authorization': `Bearer ${weflowToken}` };
      const messageLimit = 200; // 每个群聊拉取最近200条消息

      // 1. 构建昵称映射
      const nicknameMap = await buildNicknameMap(weflowUrl, weflowToken);
      await saveNicknameMap(nicknameMap);

      // 2. 获取已启用的群聊子源
      const enabledGroups = await sql`
        SELECT id, name, config->>'chatroom_id' AS chatroom_id
        FROM sources
        WHERE type = 'wechat_group' AND parent_id = ${groupSource.id} AND enabled = true
      `;

      if (enabledGroups.length === 0) {
        return c.json({ ok: true, fetched: 0, inserted: 0, message: '没有已启用的群聊' });
      }

      // 3. 拉取消息，按群聊+日期分组
      // { "群聊名::2026-04-25": { date, groupName, sourceId, messages: [...] } }
      const dayBuckets: Record<string, { date: string; groupName: string; sourceId: number; chatroomId: string; messages: any[] }> = {};
      let totalFetched = 0;
      const errors: string[] = [];

      for (const group of enabledGroups) {
        const chatroomId = group.chatroom_id;
        if (!chatroomId) continue;

        try {
          const msgsResp = await fetch(`${weflowUrl}/api/v1/messages?talker=${encodeURIComponent(chatroomId)}&limit=${messageLimit}`, { headers, signal: AbortSignal.timeout(30000) });
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

            const senderWxid = msg.senderUsername || '';
            const senderName = msg.isSend === 1 ? '我' : resolveNickname(senderWxid, nicknameMap);
            const createTime = msg.createTime ? new Date(msg.createTime * 1000) : new Date();

            // 按天分桶
            const dateStr = createTime.toISOString().slice(0, 10); // YYYY-MM-DD
            const bucketKey = `${group.name}::${dateStr}`;

            if (!dayBuckets[bucketKey]) {
              dayBuckets[bucketKey] = {
                date: dateStr,
                groupName: group.name,
                sourceId: group.id,
                chatroomId,
                messages: [],
              };
            }

            dayBuckets[bucketKey].messages.push({
              sender: senderName,
              senderWxid,
              content,
              time: createTime,
              serverId: String(msg.serverId || ''),
              localId: String(msg.localId || ''),
              isSend: msg.isSend === 1,
            });

            totalFetched++;
          }
        } catch (e: any) {
          errors.push(`${group.name}: ${e.message}`);
        }
      }

      // 4. 按天聚合入库
      let inserted = 0;

      for (const [bucketKey, bucket] of Object.entries(dayBuckets)) {
        // 构建聚合内容：消息明细列表
        const detailLines = bucket.messages.map(m => {
          const timeStr = m.time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          return `${timeStr} ${m.sender}: ${m.content}`;
        });
        const content = detailLines.join('\n');

        // 标题格式：日期 - 群聊名
        const title = `${bucket.date} - ${bucket.groupName}`;

        // content_hash：用 群聊ID+日期 做唯一键（同一天只保留一份）
        const contentHash = createHash('md5').update(`group_daily:${bucket.chatroomId}:${bucket.date}`).digest('hex');

        // extra 存消息明细 JSON（方便前端展开）
        const messagesExtra = bucket.messages.map(m => ({
          sender: m.sender,
          senderWxid: m.senderWxid,
          content: m.content,
          time: m.time.toISOString(),
          isSend: m.isSend,
        }));

        try {
          const result = await sql`
            INSERT INTO articles (source_id, title, content, published_at, fetched_at, category, tags, content_hash, extra)
            VALUES (
              ${bucket.sourceId},
              ${title},
              ${content},
              ${new Date(bucket.date + 'T23:59:59')},
              NOW(),
              '综合',
              ARRAY['群聊', ${bucket.groupName}],
              ${contentHash},
              ${sql.json({
                type: 'group_daily',
                chatroom_id: bucket.chatroomId,
                group_name: bucket.groupName,
                date: bucket.date,
                message_count: bucket.messages.length,
                messages: messagesExtra,
              })}
            )
            ON CONFLICT (content_hash) DO UPDATE SET
              content = ${content},
              extra = ${sql.json({
                type: 'group_daily',
                chatroom_id: bucket.chatroomId,
                group_name: bucket.groupName,
                date: bucket.date,
                message_count: bucket.messages.length,
                messages: messagesExtra,
              })},
              fetched_at = NOW()
          `;
          inserted++;
        } catch (e: any) {
          console.error(`群聊日聚合入库失败: ${e.message}`);
        }
      }

      // 更新最后采集时间
      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${groupSource.id}`;

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${groupSource.id}, '群聊消息采集', 'success', ${inserted},
          ${`采集 ${enabledGroups.length} 个群聊，获取 ${totalFetched} 条消息，聚合 ${inserted} 天`},
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

  // ============ AI 分析群聊消息（按天分析，结果存 extra.ai_analysis） ============
  router.post('/analyze', async (c) => {
    const startMs = Date.now();
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const body = await c.req.json().catch(() => ({}));
      const hours = body.hours || 24;

      const prompt = groupSource.config?.prompt || '请分析以下微信群聊记录，提取关键话题、重要观点和有价值的信息，生成简明扼要的中文摘要。';

      const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
      if (!deepseekApiKey) return c.json({ error: 'DEEPSEEK_API_KEY 环境变量未配置' }, 400);

      // 获取最近 N 小时的群聊日聚合记录
      const since = new Date(Date.now() - hours * 3600 * 1000);
      const dailyArticles = await sql`
        SELECT a.id, a.title, a.content, a.extra, a.published_at
        FROM articles a JOIN sources s ON a.source_id = s.id
        WHERE s.type = 'wechat_group' AND s.enabled = true
          AND a.extra->>'type' = 'group_daily'
          AND a.published_at >= ${since}
        ORDER BY a.published_at ASC
        LIMIT 30
      `;

      if (dailyArticles.length === 0) {
        return c.json({ ok: true, analysis: '没有找到群聊记录', messageCount: 0 });
      }

      let totalAnalyzed = 0;

      // 逐天分析
      for (const article of dailyArticles) {
        const messages: any[] = article.extra?.messages || [];
        if (messages.length === 0) continue;

        // 拼接消息文本
        const chatText = messages.map(m => {
          const time = new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          return `${time} ${m.sender}: ${m.content}`;
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
            max_tokens: 1500,
          }),
        });

        if (!deepseekResp.ok) {
          const errText = await deepseekResp.text();
          console.error(`DeepSeek API 错误: ${deepseekResp.status} ${errText.slice(0, 200)}`);
          continue;
        }

        const deepseekData = await deepseekResp.json() as any;
        const analysis = deepseekData.choices?.[0]?.message?.content || '分析结果为空';

        // 将分析结果存到 article 的 extra.ai_analysis 字段
        await sql`
          UPDATE articles SET
            extra = jsonb_set(COALESCE(extra, '{}'), '{ai_analysis}', ${sql.json(analysis)}),
            summary = ${analysis.slice(0, 200)}
          WHERE id = ${article.id}
        `;

        totalAnalyzed += messages.length;
      }

      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (${groupSource.id}, '群聊AI分析', 'success', ${dailyArticles.length},
          ${`分析 ${dailyArticles.length} 天记录，共 ${totalAnalyzed} 条消息，耗时 ${durationMs}ms`},
          ${durationMs})
      `;

      return c.json({
        ok: true,
        daysAnalyzed: dailyArticles.length,
        messageCount: totalAnalyzed,
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

  // ============ 获取按天聚合的群聊记录（前端展示用） ============
  router.get('/daily', async (c) => {
    try {
      const groupSource = await getGroupSource();
      if (!groupSource) return c.json({ error: '微信群聊信息源未配置' }, 400);

      const sourceId = c.req.query('source_id'); // 可选：只看某个群聊
      const days = Math.min(Number(c.req.query('days') || 7), 30);
      const since = new Date(Date.now() - days * 86400 * 1000);

      let query;
      if (sourceId) {
        query = sql`
          SELECT a.id, a.title, a.content, a.summary, a.published_at, a.extra,
                 s.name as group_name, s.id as source_id
          FROM articles a JOIN sources s ON a.source_id = s.id
          WHERE a.source_id = ${Number(sourceId)}
            AND a.extra->>'type' = 'group_daily'
            AND a.published_at >= ${since}
          ORDER BY a.published_at DESC
          LIMIT 100
        `;
      } else {
        // 获取所有已启用群聊的日聚合
        query = sql`
          SELECT a.id, a.title, a.content, a.summary, a.published_at, a.extra,
                 s.name as group_name, s.id as source_id
          FROM articles a JOIN sources s ON a.source_id = s.id
          WHERE s.type = 'wechat_group' AND s.enabled = true
            AND a.extra->>'type' = 'group_daily'
            AND a.published_at >= ${since}
          ORDER BY a.published_at DESC
          LIMIT 100
        `;
      }

      const articles = await query;

      const result = articles.map((a: any) => ({
        id: a.id,
        title: a.title,
        summary: a.summary || '',
        aiAnalysis: a.extra?.ai_analysis || '',
        groupName: a.group_name,
        sourceId: a.source_id,
        date: a.extra?.date || '',
        messageCount: a.extra?.message_count || 0,
        messages: (a.extra?.messages || []).map((m: any) => ({
          sender: m.sender,
          content: m.content,
          time: m.time,
          isSend: m.isSend,
        })),
        publishedAt: a.published_at,
      }));

      return c.json({ days: result, total: result.length });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
