// @ts-nocheck
import { whisperWindowsTranscribe, WHISPER_TRANSCRIBE_PREVIEW_SEC } from '../../services/transcribe.js';
/**
 * RSS 采集路由
 * 
 * 包含 RSS feed 解析、全文抓取、翻译、图片处理
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import RssParser from 'rss-parser';
import { saveArticleFile, hashString, processImages } from '../../file-storage.js';
import { cleanHtmlToText } from '../../services/parser.js';
import { classifyByFeed, extractTags } from '../../services/classifier.js';
import { isEnglish, translateTitle, translateToChinese, createConcurrencyPool } from '../../services/translate.js';
import { crawlArticleContent } from '../../services/crawler.js';



/**
 * 对单个 RSS feed URL 执行采集：解析 XML → 全文抓取 → 图片本地存储 → 英文翻译 → 本地存储 → 入库
 * 返回 { fetched, inserted, translated }
 */
async function fetchRssFeed(
  sql: any,
  feedUrl: string,
  sourceId: number,
  sourceName: string,
  rssSourceId: number
): Promise<{ fetched: number; inserted: number; translated: number }> {
  console.log(`[RSS] 解析: ${sourceName} ← ${feedUrl}`);

  const rssParser = new RssParser({
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml',
    },
  });

  let feed: any;
  try {
    feed = await rssParser.parseURL(feedUrl);
  } catch (e: any) {
    try {
      const resp = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      feed = await rssParser.parseString(xml);
    } catch (e2: any) {
      console.error(`[RSS] 解析失败: ${feedUrl} - ${e2.message}`);
      return { fetched: 0, inserted: 0, translated: 0 };
    }
  }

  const items = feed?.items || [];
  // 播客类 feed（含音频附件）：只取最新 20 条，避免首次采集回填几百期旧节目
  const isPodcastFeed = items.some((it: any) => it.enclosure?.url);
  const selectedItems = isPodcastFeed ? items.slice(0, 20) : items;
  if (selectedItems.length === 0) return { fetched: 0, inserted: 0, translated: 0 };

  const feedType = 'rss';

  const limit = createConcurrencyPool(3);
  let inserted = 0;
  let translated = 0;

  const results = await Promise.all(selectedItems.map((item: any) => limit(async () => {
    try {
      const title = item.title || '无标题';
      const url = item.link || item.guid || '';
      if (!url) return { inserted: false, translated: false };

      const rssContent = cleanHtmlToText(item.content || item.contentSnippet || item.summary || '');
      const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
      const author = item.creator || item.author || '';

      const enclosureUrl = item.enclosure?.url || '';
      const enclosureType = item.enclosure?.type || '';
      const enclosureLength = item.enclosure?.length || '';

      const contentHash = hashString(url);

      // 早期去重：已入库的条目直接跳过，避免重复爬正文/翻译（英文源尤其耗时）
      const [existingRow] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
      if (existingRow) return { inserted: false, translated: false };

      let fullContent = rssContent;
      // 播客条目（含音频附件）不爬网页：show notes 已在 description 中，网页多为 JS 渲染页
      if (url && !enclosureUrl) {
        try {
          const fetchedContent = await crawlArticleContent(url);
          if (fetchedContent && fetchedContent.length > rssContent.length) {
            fullContent = fetchedContent;
            console.log(`[RSS] 抓到全文: ${title.slice(0, 30)}... (${rssContent.length} → ${fetchedContent.length} chars)`);
          }
        } catch { /* ignore */ }
      }

      try {
        fullContent = await processImages(fullContent, 'rss');
      } catch (e: any) {
        console.error(`[RSS] 图片处理失败: ${e.message}`);
      }

      let finalTitle = title;
      let finalContent = fullContent;
      let didTranslate = false;
      const needTranslate = isEnglish(fullContent) || isEnglish(title);
      if (needTranslate) {
        try {
          if (isEnglish(title)) {
            const tTitle = await translateTitle(title);
            if (tTitle !== title) {
              finalTitle = `${tTitle} [${title}]`;
            }
          }
          if (isEnglish(fullContent)) {
            const tContent = await translateToChinese(fullContent);
            if (tContent !== fullContent) {
              finalContent = `【中文翻译】\n${tContent}\n\n---\n【English Original】\n${fullContent}`;
              didTranslate = true;
            }
          }
        } catch (e: any) {
          console.error(`[RSS] 翻译失败: ${title.slice(0, 30)}... - ${e.message}`);
        }
      }

      const category = classifyByFeed(sourceName);
      const tags = extractTags(finalTitle + ' ' + finalContent.slice(0, 200), sourceName);

      const extraData: Record<string, any> = {};
      if (enclosureUrl) {
        extraData.audio_url = enclosureUrl;
        if (enclosureType) extraData.audio_type = enclosureType;
        if (enclosureLength) extraData.audio_length = enclosureLength;
      }

      const insertedRows = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
        VALUES (${sourceId}, ${finalTitle}, ${finalContent}, ${finalContent.slice(0, 150)}, ${url}, ${publishedAt}, ${category}, ${tags}, ${contentHash}, NOW(), ${author}, ${sql.json(extraData)})
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      let didInsert = false;
      if (insertedRows.length > 0) {
        const newId = insertedRows[0]!.id;
        
        if (enclosureUrl && enclosureUrl.match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)) {
          whisperWindowsTranscribe(enclosureUrl, WHISPER_TRANSCRIBE_PREVIEW_SEC).then(transcript => {
            if (transcript) {
              const transcriptContent = '> 🎙️ 音频转录（前' + (WHISPER_TRANSCRIBE_PREVIEW_SEC / 60) + '分钟预览）\n> \n> ' + transcript.slice(0, 5000).split('\n').join('\n> ') + '\n\n---\n\n';
              const newContent = transcriptContent + finalContent;
              sql`UPDATE articles SET content = ${newContent} WHERE id = ${newId}`.catch((e: any) => console.error('[whisper] update failed:', e.message));
              saveArticleFile(newId, newContent, {
                id: newId, title: finalTitle, source_type: feedType,
                source_name: sourceName, url, published_at: publishedAt,
                category, tags, author, is_read: false, is_starred: false,
              }).catch(() => {});
            }
          }).catch((e: any) => console.error('[whisper] background transcript error:', e.message));
        }
        const { processedContent } = await saveArticleFile(newId, finalContent, {
          id: newId, title: finalTitle, source_type: feedType,
          source_name: sourceName, url, published_at: publishedAt,
          category, tags, author, is_read: false, is_starred: false,
        });
        if (processedContent !== finalContent) {
          await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
        }
        didInsert = true;
      }

      return { inserted: didInsert, translated: didTranslate };
    } catch (e: any) {
      if (e.code !== '23505') console.error('RSS insert error:', e.message);
      return { inserted: false, translated: false };
    }
  })));

  for (const r of results) {
    if (r.inserted) inserted++;
    if (r.translated) translated++;
  }

  await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;

  return { fetched: items.length, inserted, translated };
}

export function createRssRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ RSS 采集 ============
  router.post('/rss', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const feedUrl = body?.feedUrl || body?.url || '';
      const sourceName = body?.sourceName || '';
      const feedType = body?.feedType || 'rss';
      let authToken = body?.authorization || body?.auth || '';
      if (!authToken) { const h = c.req.header('authorization'); if (h) authToken = h.replace('Bearer ', ''); }

      if (!feedUrl) return c.json({ ok: false, error: '缺少 feedUrl' }, 400);
      if (!sourceName) return c.json({ ok: false, error: '缺少 sourceName' }, 400);

      const [sourceRow] = await sql`SELECT id, config FROM sources WHERE enabled = true AND name = ${sourceName} AND LOWER(type) IN ('rss','rss_news','rss-feed','podcast-channel') LIMIT 1`;
      if (!sourceRow) return c.json({ ok: false, error: `未找到已启用的源: ${sourceName}` }, 404);
      const sourceId = sourceRow.id;
      const config = typeof sourceRow.config === 'string' ? JSON.parse(sourceRow.config) : (sourceRow.config || {});
      const maxItems = config.max_items || 100;

      let feed: any;
      const rssParser = new RssParser({ timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml' } });
      try { feed = await rssParser.parseURL(feedUrl); }
      catch {
        try {
          const resp = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
          const xml = await resp.text();
          feed = await rssParser.parseString(xml);
        } catch (e: any) { return c.json({ ok: false, error: `RSS 解析失败: ${e.message}` }, 500); }
      }

      const items = (feed?.items || []).slice(0, maxItems);
      // 播客类 feed（含音频附件）：只取最新 20 条，避免首次采集回填几百期旧节目
      const isPodcastFeed = items.some((it: any) => it.enclosure?.url);
      const selectedItems = isPodcastFeed ? items.slice(0, 20) : items;

      // 批量预去重：已入库条目直接跳过，避免逐条爬正文/翻译浪费大量时间（串行处理下尤其致命）
      const hashList = selectedItems.map((it: any) => hashString(it.link || it.guid || ''));
      const existingHashes = new Set<string>();
      if (hashList.length > 0) {
        const existRows = await sql`SELECT content_hash FROM articles WHERE content_hash IN ${sql(hashList)}`;
        for (const r of existRows) existingHashes.add(r.content_hash);
      }

      let fetched = 0, inserted = 0, translated = 0;

      for (const item of selectedItems) {
        const url = item.link || item.guid || '';
        const title = item.title?.trim() || '(无标题)';
        const rssContent = item.content || item.contentSnippet || item.description || '';
        const publishedAt = item.isoDate || item.pubDate || new Date().toISOString();
        const author = item.creator || item.author || '';
        const enclosureUrl = item.enclosure?.url || '';
        const enclosureType = item.enclosure?.type || '';
        const enclosureLength = item.enclosure?.length || '';
        const contentHash = hashString(url);

        // 全文抓取（已入库条目跳过；播客条目不爬网页——show notes 已在 description 中）
        if (existingHashes.has(contentHash)) { fetched++; continue; }
        let fullContent = rssContent;
        if (url && !enclosureUrl) {
          try {
            const fc = await crawlArticleContent(url);
            if (fc && fc.length > rssContent.length) fullContent = fc;
          } catch { /* ignore */ }
        }

        // 图片处理
        try { fullContent = await processImages(fullContent, 'rss'); } catch { /* ignore */ }

        // 翻译
        let finalTitle = title, finalContent = fullContent, didTranslate = false;
        const needTranslate = isEnglish(fullContent) || isEnglish(title);
        if (needTranslate) {
          try {
            if (isEnglish(title)) { const tt = await translateTitle(title); if (tt !== title) finalTitle = `${tt} [${title}]`; }
            if (isEnglish(fullContent)) {
              const tc = await translateToChinese(fullContent);
              if (tc !== fullContent) { finalContent = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${fullContent}`; didTranslate = true; }
            }
          } catch { /* ignore */ }
        }

        const category = classifyByFeed(sourceName);
        const tags = extractTags(finalTitle + ' ' + finalContent.slice(0,200), sourceName);
        const extraData: Record<string, any> = {};
        if (enclosureUrl) { extraData.audio_url = enclosureUrl; extraData.audio_type = enclosureType; extraData.audio_length = enclosureLength; }

        fetched++;
        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author,extra) VALUES (${sourceId},${finalTitle},${finalContent},${finalContent.slice(0,150)},${url},${publishedAt},${category},${tags},${contentHash},NOW(),${author},${sql.json(extraData)}) ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) {
          const newId = rows[0].id;
          const { processedContent } = await saveArticleFile(newId, finalContent, { id:newId, title:finalTitle, source_type:feedType, source_name:sourceName, url, published_at:publishedAt, category, tags, author, is_read:false, is_starred:false });
          if (processedContent !== finalContent) await sql`UPDATE articles SET content = ${processedContent} WHERE id = ${newId}`;
          inserted++;

          // 播客音频转录首10分钟
          if (enclosureUrl && enclosureUrl.match(/\.(mp3|m4a|ogg|wav|aac|flac)$/i)) {
            whisperWindowsTranscribe(enclosureUrl, WHISPER_TRANSCRIBE_PREVIEW_SEC).then(transcript => {
              if (transcript) {
                const tc = '> @ # 音频转录（前' + (WHISPER_TRANSCRIBE_PREVIEW_SEC/60) + '分钟预览）\n> \n> ' + transcript.slice(0,5000).split('\n').join('\n> ') + '\n\n---\n\n';
                const nc = tc + finalContent;
                sql`UPDATE articles SET content = ${nc} WHERE id = ${newId}`.catch((e: any) => console.error('[whisper] update failed:', e.message));
                saveArticleFile(newId, nc, { id:newId, title:finalTitle, source_type:feedType, source_name:sourceName, url, published_at:publishedAt, category, tags, author, is_read:false, is_starred:false }).catch(()=>{});
              }
            }).catch(e => console.error('[whisper] error:', e.message));
          }
        }
        if (didTranslate) translated++;
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched, inserted, translated, sourceName });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  return router;
}
