// @ts-nocheck
/**
 * 新闻联播采集路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../../file-storage.js';
import { parseXWLBListHtml, parseGovopendataXWLB } from '../../services/parser.js';

export function createXwlbRoutes(sql: Sql): Hono {
  const router = new Hono();

  router.post('/xwlb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''); const pubDate = date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);
      const sourceId = 1;
      console.log(`[xwlb] 获取 ${date} 新闻联播...`);

      // 1. 尝试获取 govopendata 全文
      let fullData: any = null;
      try { fullData = await parseGovopendataXWLB(date, ""); } catch (e) { /* fallback */ }
      let listHtml = '';
      let listData: Array<{ title: string; link?: string }> = [];
      try {
        const resp = await fetch(`https://tv.cctv.com/lm/xwlb/day/${date}.shtml`, { signal: AbortSignal.timeout(15000) });
        listHtml = await resp.text();
        listData = parseXWLBListHtml(listHtml, date);
      } catch (e: any) { console.error(`[xwlb] 列表获取失败: ${e.message}`); }

      const title = fullData?.title || `新闻联播 ${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
      let content = fullData?.content || (listData.map((i, idx) => `${idx+1}. ${i.title}`).join('\n'));
      if (!content) return c.json({ ok: false, error: '获取失败' }, 500);

      const hash = hashString('xwlb:' + date);
      const inserted = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},'https://tv.cctv.com/lm/xwlb/',${pubDate},'时政',${['新闻联播',date.slice(0,6)]},${hash},NOW(),'央视','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
      if (inserted.length > 0) {
        await saveArticleFile(inserted[0].id, content, { id:inserted[0].id, title, source_type:'xwlb', source_name:'新闻联播', url:'https://tv.cctv.com/lm/xwlb/', published_at:pubDate, category:'时政', tags:['新闻联播',date.slice(0,6)], author:'央视', is_read:false, is_starred:false });
        return c.json({ ok:true, fetched:listData.length, inserted:1, date });
      }
      return c.json({ ok:true, fetched:listData.length, inserted:0, date });
    } catch (e: any) { return c.json({ ok:false, error: e.message }, 500); }
  });

  return router;
}
