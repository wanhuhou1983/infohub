// @ts-nocheck
/**
 * 喷嚏图卦采集路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString } from '../../file-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PENTI_SCRIPT_DIR = path.join(
  process.env.HOME || '/root', '.workbuddy/skills/penti-tugua/scripts'
);

export function createPentiRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 喷嚏图卦采集 ============
  router.post('/penti', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0,10).replace(/-/g, ''); const pubDate = date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);
      const sourceId = 12;

      const listUrl = `https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei`;
      const resp = await fetch(listUrl, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const buf = await resp.arrayBuffer();
      const html = new TextDecoder('gbk').decode(buf);

      // 提取文章链接
      const linkPattern = /<a\s+href=[^>]*more\.asp\?name=xilei&id=\d+[^>]*>([^<]+)<\/a>/gi;
      const links: Array<{ title: string; href: string }> = [];
      let match;
      while ((match = linkPattern.exec(html)) !== null) {
        const hrefMatch = match[0].match(/href=([^\s>]+)/);
        if (hrefMatch) links.push({ title: match[1].trim(), href: hrefMatch[1] });
      }
      const targetUrl = links.find(l => l.title.includes(date)) || links.find(l => l.title.includes(date.slice(4,8)));

      if (!targetUrl) return c.json({ ok: false, error: `未找到 ${date} 的喷嚏图卦` }, 404);

      const base = 'https://www.dapenti.com/blog/';
      const artResp = await fetch(base + targetUrl.href, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const artBuf = await artResp.arrayBuffer();
      const artHtml = new TextDecoder('gbk').decode(artBuf);

      // 提取正文
      const tdOpen = artHtml.match(/<td[^>]*class="oblog_t_2"[^>]*>/i);
      if (!tdOpen) return c.json({ ok: false, error: '未找到正文' }, 500);
      const rawHtml = artHtml.substring(tdOpen.index! + tdOpen[0].length, artHtml.lastIndexOf('</td>'));
      const tempJson = '/tmp/penti_' + date + '.json';
      const tempMd = '/tmp/penti_' + date + '.md';
      writeFileSync(tempJson, JSON.stringify({ title: targetUrl.title, html: rawHtml }), 'utf-8');

      // Convert HTML to MD
      const pentiScript = path.join(PENTI_SCRIPT_DIR, 'html_to_md.py');
      const convProc = spawn('python3', [pentiScript, tempJson, tempMd], { timeout: 30000 });
      for await (const chunk of convProc.stderr) { /* */ }
      await new Promise((res, rej) => { convProc.on('close', res); convProc.on('error', rej); });

      let mdContent = '';
      try { mdContent = readFileSync(tempMd, 'utf-8'); } catch { /* */ }
      try { unlinkSync(tempJson); } catch { /* */ }
      try { unlinkSync(tempMd); } catch { /* */ }

      if (!mdContent) return c.json({ ok: false, error: '转换失败' }, 500);

      const title = targetUrl.title;
      const contentHash = hashString('penti:' + date);
      const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${mdContent},${mdContent.slice(0,150)},${base + targetUrl.href},${pubDate},'社会',${['喷嚏图卦',date.slice(0,6)]},${contentHash},NOW(),'喷嚏图卦','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;

      let inserted = false;
      if (rows.length > 0) {
        inserted = true;
        await saveArticleFile(rows[0].id, mdContent, { id:rows[0].id, title, source_type:'magazine', source_name:'喷嚏图卦', url:base + targetUrl.href, published_at:pubDate, category:'社会', tags:['喷嚏图卦',date.slice(0,6)], author:'喷嚏图卦', is_read:false, is_starred:false });
      }
      return c.json({ ok: true, date, inserted });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
