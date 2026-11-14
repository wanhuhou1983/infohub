// @ts-nocheck
/**
 * 今天看啥 (jintiankansha.me) 采集路由
 * 替代旧的 WEFLOW 公众号采集方案
 */
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { fetchAllJtkSources } from '../../services/jintiankansha.js';

export function createJintiankanshaRoutes(sql: Sql): Hono {
  const router = new Hono();

  router.post('/jintiankansha', async (c) => {
    try {
      // 脱钩后本地只采 JTK 音视频专栏（B站投稿/小宇宙）；
      // 文本类专栏由云端采集器直接调用 fetchAllJtkSources 并传白名单，不走此路由。
      const allowedSources = process.env.LOCAL_TEXT_FETCH === 'false'
        ? ['B站投稿视频', '小宇宙']
        : undefined;
      const result = await fetchAllJtkSources(sql, allowedSources);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
