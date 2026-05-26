// @ts-nocheck
/**
 * 新闻联播采集路由
 * 
 * v2: 从每篇文章页面抓取全文，而非仅标题列表
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../../file-storage.js';
import { parseXWLBListHtml } from '../../services/parser.js';

/**
 * 从文章页面提取正文（content_area div）
 */
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Extract content_area div
    const contentMatch = html.match(/id="content_area"[^>]*>([\s\S]*?)<\/div>/);
    if (!contentMatch) {
      // Fallback: try to find text in paragraphs
      const paragraphs = html.match(/<p[^>]*>([\s\S]*?)<\/p>/g);
      if (paragraphs) {
        return paragraphs
          .map(p => p.replace(/<[^>]+>/g, '').trim())
          .filter(t => t.length > 10)
          .join('\n');
      }
      return null;
    }

    return contentMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return null;
  }
}

/**
 * 获取新闻联播全文：遍历每天的文章链接，逐篇抓取正文
 */
async function fetchXWLBFull(date: string): Promise<{ title: string; content: string; articleCount: number }> {
  const pubDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const title = `${date}-新闻联播`;

  // Step 1: Get article list from day page
  let listData: Array<{ title: string; link?: string }> = [];
  try {
    const resp = await fetch(`https://tv.cctv.com/lm/xwlb/day/${date}.shtml`, {
      signal: AbortSignal.timeout(15000),
    });
    const listHtml = await resp.text();
    listData = parseXWLBListHtml(listHtml, date);
  } catch (e: any) {
    console.error(`[xwlb] 列表获取失败: ${e.message}`);
  }

  if (listData.length === 0) {
    return { title, content: '', articleCount: 0 };
  }

  // Step 2: Fetch each article's full text
  const articles: Array<{ title: string; content: string }> = [];
  for (const item of listData) {
    if (!item.url) {
      articles.push({ title: item.title, content: item.title });
      continue;
    }
    const text = await fetchArticleContent(item.url);
    if (text && text.length > 20) {
      articles.push({ title: item.title, content: text });
      console.log(`[xwlb]   ${item.title.slice(0, 30)}... (${text.length} chars)`);
    } else {
      articles.push({ title: item.title, content: item.title });
      console.log(`[xwlb]   ${item.title.slice(0, 30)}... (short)`);
    }
  }

  // Step 3: Assemble full content
  const lines: string[] = [`# ${title}`, ''];
  for (const art of articles) {
    lines.push(`## ${art.title}`);
    lines.push('');
    lines.push(art.content);
    lines.push('');
  }

  return { title, content: lines.join('\n'), articleCount: listData.length };
}

export function createXwlbRoutes(sql: Sql): Hono {
  const router = new Hono();

  router.post('/xwlb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const date = body?.date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const pubDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const sourceId = 1;
      console.log(`[xwlb] 获取 ${date} 新闻联播全文...`);

      const { title, content, articleCount } = await fetchXWLBFull(date);
      if (!content) return c.json({ ok: false, error: '获取失败' }, 500);

      const hash = hashString('xwlb:' + date);
      const inserted = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
        VALUES (${sourceId}, ${title}, ${content}, ${content.slice(0, 150)}, 'https://tv.cctv.com/lm/xwlb/', ${pubDate}, '时政', ${['新闻联播', date.slice(0, 6)]}, ${hash}, NOW(), '央视', '{}')
        ON CONFLICT (content_hash) DO UPDATE SET content = ${content}, summary = ${content.slice(0, 150)}
        RETURNING id
      `;

      if (inserted.length > 0) {
        const artId = inserted[0].id;
        const { processedContent } = await saveArticleFile(artId, content, {
          id: artId, title, source_type: 'magazine', source_name: '新闻联播',
          url: 'https://tv.cctv.com/lm/xwlb/', published_at: pubDate,
          category: '时政', tags: ['新闻联播', date.slice(0, 6)],
          author: '央视', is_read: false, is_starred: false,
        });
        if (processedContent !== content) {
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${artId}`;
        }
        return c.json({ ok: true, fetched: articleCount, inserted: 1, date, contentLen: content.length });
      }
      return c.json({ ok: true, fetched: articleCount, inserted: 0, date });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
