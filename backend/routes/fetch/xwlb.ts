// @ts-nocheck
/**
 * 新闻联播采集路由
 *
 * 两阶段采集：
 *   Phase 1: 抓取当日列表页 → parseXWLBListHtml 提取每条新闻的 VIDE 链接
 *   Phase 2: 逐篇 fetch VIDE 页面 → parseXWLBContentHtml 提取 #content_area 正文
 *   Phase 3: 拼接所有正文 → 入库
 *
 * ⏰ 新闻联播每日 19:00 播出，文字稿约 21:00 后可获取
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../../file-storage.js';
import { parseXWLBListHtml, parseXWLBContentHtml } from '../../services/parser.js';

const XWLB_LIST_URL = 'https://tv.cctv.com/lm/xwlb/day'; // 列表页模板：/day/20260610.shtml
const SOURCE_ID = 2893;

/** 并发抓取单条新闻正文（限流） */
async function fetchPerArticle(url: string): Promise<{ title: string; body: string } | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const body = parseXWLBContentHtml(html);
    if (!body || body.length < 10) return null;

    // 标题从页面提取（via cheerio in parseXWLBContentHtml 返回纯文本，标题需单独提取）
    // parseXWLBContentHtml 只返回正文，标题已在列表页解析时获取
    return { title: '', body };
  } catch {
    return null;
  }
}

export function createXwlbRoutes(sql: Sql): Hono {
  const router = new Hono();

  router.post('/xwlb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}) as any);
      // 默认取昨天（新闻联播 19:00 播出）
      const now = new Date();
      const yesterday = new Date(now.getTime() - 86400000);
      const dateStr =
        body?.date ||
        `${yesterday.getFullYear()}${String(yesterday.getMonth() + 1).padStart(2, '0')}${String(yesterday.getDate()).padStart(2, '0')}`;
      const pubDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

      console.log(`[xwlb] 获取 ${dateStr} 新闻联播...`);

      // ====== Phase 1: 抓取列表页，解析每条新闻链接 ======
      const listUrl = `${XWLB_LIST_URL}/${dateStr}.shtml`;
      console.log(`[xwlb]  列表页: ${listUrl}`);

      const listResp = await fetch(listUrl, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });

      if (!listResp.ok) {
        return c.json({ ok: false, error: `列表页请求失败 HTTP ${listResp.status}`, date: dateStr }, 500);
      }

      const listHtml = await listResp.text();
      const articles = parseXWLBListHtml(listHtml, dateStr);
      console.log(`[xwlb]  解析到 ${articles.length} 条新闻`);

      if (articles.length === 0) {
        return c.json({ ok: true, inserted: 0, date: dateStr, note: '当日尚无节目或无可用链接' });
      }

      // ====== Phase 2: 逐篇抓全文（限并发 5） ======
      const fullTexts: string[] = [];
      for (let i = 0; i < articles.length; i++) {
        const art = articles[i];
        console.log(`[xwlb]    [${i + 1}/${articles.length}] ${art.title.slice(0, 40)}`);
        const result = await fetchPerArticle(art.url);
        if (result && result.body) {
          fullTexts.push(`### ${art.title}\n\n${result.body}`);
        } else {
          // 降级：只放标题
          fullTexts.push(`### ${art.title}\n\n（全文获取失败）`);
        }
        // 限速，避免被 ban
        if (i < articles.length - 1) await new Promise(r => setTimeout(r, 500));
      }

      // ====== Phase 3: 拼接入库 ======
      const title = `${dateStr}-新闻联播`;
      const content = `# 《新闻联播》${pubDate}\n\n${fullTexts.join('\n\n---\n\n')}`;
      const contentHash = hashString('xwlb:' + dateStr);

      const rows = await sql`
        INSERT INTO articles (
          source_id, title, content, summary, url,
          published_at, category, tags, content_hash,
          fetched_at, author, extra
        ) VALUES (
          ${SOURCE_ID}, ${title}, ${content}, ${content.slice(0, 150)},
          ${listUrl},
          ${pubDate}, '时政', ${['新闻联播', dateStr.slice(0, 6)]},
          ${contentHash}, NOW(), '央视', '{}'
        )
        ON CONFLICT (content_hash) DO UPDATE SET
          content = EXCLUDED.content,
          summary  = EXCLUDED.summary
        RETURNING id
      `;

      if (rows.length > 0) {
        const artId = rows[0].id;
        await saveArticleFile(artId, content, {
          id: artId, title, source_type: 'magazine',
          source_name: '新闻联播', url: listUrl,
          published_at: pubDate, category: '时政',
          tags: ['新闻联播', dateStr.slice(0, 6)],
          author: '央视', is_read: false, is_starred: false,
        });
        console.log(`[xwlb]  ✅ 入库 article_id=${artId}, ${articles.length} 条新闻, ${content.length} 字符`);
        return c.json({ ok: true, inserted: 1, date: dateStr, segments: articles.length, chars: content.length });
      }

      return c.json({ ok: true, inserted: 0, date: dateStr, note: '已存在' });
    } catch (e: any) {
      console.error(`[xwlb] 错误: ${e.message}`);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
