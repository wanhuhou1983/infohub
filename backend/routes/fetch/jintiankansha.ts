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
      const result = await fetchAllJtkSources(sql);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
