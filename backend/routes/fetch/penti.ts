// @ts-nocheck
/**
 * 喷嚏图卦采集路由
 * 
 * ⏰ 喷嚏图卦每日18:00后更新
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString } from '../../file-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PENTI_SCRIPT_DIR = path.resolve(__dirname, '../../skills/penti-tugua/scripts');

export function createPentiRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 喷嚏图卦采集 ============
  router.post('/penti', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0,10).replace(/-/g, ''); const pubDate = date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8);
      const sourceId = 2891;

      // 2026-11 上游改版：旧列表页 blog.asp?subjectid=70&name=xilei 已 ASP 500
      // (/blog/conn.asp「Page 命令无序」)。新版首页 index-responsive-new.asp 包含
      // 最近两周的图卦列表，链接为 more-new-v5.asp?name=xilei&id=xxx。
      const listUrl = 'https://www.dapenti.com/blog/index-responsive-new.asp';
      const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
      const resp = await fetch(listUrl, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': UA } });
      if (!resp.ok) return c.json({ ok: false, error: `列表页 HTTP ${resp.status}` }, 502);
      const buf = await resp.arrayBuffer();
      const html = new TextDecoder('gbk').decode(buf);

      // 新版 <a ... href=more-new-v5.asp?... title='【喷嚏图卦20261121】...' ...>
      // 标题可能被 <span> 包裹并截断，优先取 title 属性；旧版 more.asp 兼容。
      const linkPattern = /<a\b[^>]*\bhref=(?:"|')?([^"'\s>]*more(?:-new-v5)?\.asp\?name=xilei&id=\d+)(?:"|')?[^>]*>([\s\S]*?)<\/a>/gi;
      const links: Array<{ title: string; href: string }> = [];
      let match;
      while ((match = linkPattern.exec(html)) !== null) {
        const tag = match[0];
        const href = match[1].replace(/&amp;/g, '&');
        const titleAttr = tag.match(/\btitle=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const text = match[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
        const title = (titleAttr?.[1] ?? titleAttr?.[2] ?? titleAttr?.[3] ?? text).trim();
        if (title && !links.some(l => l.href === href)) links.push({ title, href });
      }
      // 新版首页同时列出「图卦音频版」，必须排除，否则会抓成音频而非图卦正文。
      const isTugua = (t: string) => t.includes('图卦') && !t.includes('音频');
      const targetUrl =
        links.find(l => l.title.includes(`喷嚏图卦${date}`)) ||
        links.find(l => l.title.includes(date) && isTugua(l.title)) ||
        links.find(l => l.title.includes(date)) ||
        links.find(l => l.title.includes(date.slice(4,8)) && isTugua(l.title));

      if (!targetUrl) return c.json({ ok: false, error: `未找到 ${date} 的喷嚏图卦（列表页解析到 ${links.length} 条链接）` }, 404);

      // 新版详情页 more-new-v5.asp 换了正文容器（无 oblog_t_2），
      // 旧路径 more.asp 仍 200 且容器兼容现有 html_to_md.py，统一归一化回旧路径。
      const base = 'https://www.dapenti.com/blog/';
      const detailHref = targetUrl.href.replace(/^more-new-v5\.asp/, 'more.asp');
      const artResp = await fetch(base + detailHref, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': UA } });
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

      const title = targetUrl.title.replace(/[【】]/g, '');
      const contentHash = hashString('penti:' + date);
      const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${title},${mdContent},${mdContent.slice(0,150)},${base + detailHref},${pubDate},'社会',${['喷嚏图卦',date.slice(0,6)]},${contentHash},NOW(),'喷嚏图卦','{}') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;

      let inserted = false;
      if (rows.length > 0) {
        inserted = true;
        await saveArticleFile(rows[0].id, mdContent, { id:rows[0].id, title, source_type:'magazine', source_name:'喷嚏图卦', url:base + detailHref, published_at:pubDate, category:'社会', tags:['喷嚏图卦',date.slice(0,6)], author:'喷嚏图卦', is_read:false, is_starred:false });
      }
      return c.json({ ok: true, date, inserted });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
