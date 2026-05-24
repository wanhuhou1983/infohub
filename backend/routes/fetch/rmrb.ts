// @ts-nocheck
/**
 * 人民日报采集路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString } from '../../file-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createRmrbRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 人民日报采集 ============
  router.post('/rmrb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0,10); const pubDate = (body?.date || new Date().toISOString().slice(0,10)).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1-$2-$3').replace(/(\d{4})(\d{2})(\d{2})/g, '$1-$2-$3');
      const full = body?.full !== false;
      const sourceId = 1264;

      const rmrbDir = process.env.RMRB_DIR || path.resolve(__dirname, '../../skills/rmrb-daily');
      const python = 'python3';
      const outputMd = `/tmp/rmrb_${date.replace(/-/g,'')}.md`;

      const proc = spawn(python, [path.join(rmrbDir, 'rmrb_daily.py'), date, ...(full ? ['--full', '--output', outputMd] : ['--output', outputMd])], { timeout: 120000 });
      let stderr = '';
      for await (const chunk of proc.stderr) stderr += chunk;
      await new Promise((res, rej) => { proc.on('close', res); proc.on('error', rej); });

      if (!existsSync(outputMd)) return c.json({ ok: false, error: `采集失败: ${stderr.slice(0,200)}` }, 500);
      const content = readFileSync(outputMd, 'utf-8');
      try { unlinkSync(outputMd); } catch { /* ignore */ }

      const lines = content.trim().split('\n');
      const title = lines[0]?.replace(/^#\s*/, '') || `人民日报 ${date}`;
      const bodyContent = lines.slice(1).join('\n').trim();
      const contentHash = hashString('rmrb:' + date.replace(/-/g,''));

      const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${bodyContent},${bodyContent.slice(0,150)},${'https://paper.people.com.cn/rmrb/'},${pubDate},'时政',${['人民日报',date.slice(0,7)]},${contentHash},NOW(),'人民日报','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
      let inserted = 0;
      if (rows.length > 0) {
        inserted = 1;
        await saveArticleFile(rows[0].id, bodyContent, { id:rows[0].id, title, source_type:'rmrb', source_name:'人民日报', url:'https://paper.people.com.cn/rmrb/', published_at:pubDate, category:'时政', tags:['人民日报',date.slice(0,7)], author:'人民日报', is_read:false, is_starred:false });
      }
      const cnt = bodyContent.split('###').filter(l => l.trim()).length;
      return c.json({ ok: true, fetched: cnt, inserted, date });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  return router;
}
