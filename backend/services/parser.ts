/**
 * HTML 瑙ｆ瀽妯″潡
 * 浣跨敤 cheerio 鍋氱粨鏋勫寲瑙ｆ瀽锛屾浛浠ｈ剢寮辩殑姝ｅ垯鍖归厤
 */

import * as cheerio from 'cheerio';

// ============ CCTV 鏂伴椈鑱旀挱 ============

/**
 * 瑙ｆ瀽 CCTV 鏂伴椈鑱旀挱鍒楄〃椤碉紝鎻愬彇鏂囩珷閾炬帴鍜屾爣棰?
 */
export function parseXWLBListHtml(html: string, dateStr: string): Array<{
  title: string;
  url: string;
  publishedAt: string;
}> {
  const $ = cheerio.load(html);
  const articles: Array<{ title: string; url: string; publishedAt: string }> = [];
  const seen = new Set<string>();

  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);
  const publishedAt = `${year}-${month}-${day}T19:30:00`;

  // 鏌ユ壘鎵€鏈夋寚鍚?VIDE 椤甸潰鐨勯摼鎺?
  $('a[href*="VIDE"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = ($(el).attr('alt') || $(el).attr('title') || $(el).text() || '').trim();
    
    if (!href || !title) return;
    if (!href.match(/https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE\w+\.shtml/)) return;
    
    // 娓呯悊鏍囬
    const cleanTitle = title.replace(/^\[瑙嗛\]\s*/, '');
    if (!cleanTitle || cleanTitle.startsWith('銆婃柊闂昏仈鎾€?)) return;
    if (cleanTitle.includes('瀹屾暣鐗?) && cleanTitle.includes('鏂伴椈鑱旀挱')) return;

    // 鍘婚噸
    if (seen.has(href)) return;
    seen.add(href);

    articles.push({ title: cleanTitle, url: href, publishedAt });
  });

  return articles;
}

/**
 * 瑙ｆ瀽 CCTV 鍗曟潯鏂伴椈椤甸潰姝ｆ枃
 */
export function parseXWLBContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 浼樺厛鍖归厤 id="content_area"
  let contentEl = $('#content_area');
  if (contentEl.length === 0) {
    // 澶囩敤锛歝lass="content_area"
    contentEl = $('.content_area');
  }
  if (contentEl.length === 0) return null;

  return cleanHtmlToText($.html(contentEl) || contentEl.html() || '');
}

// ============ 浜烘皯鏃ユ姤 ============

/**
 * 瑙ｆ瀽浜烘皯鏃ユ姤椤甸潰姝ｆ枃
 */
export function parseRMRBContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 浜烘皯鏃ユ姤 PC 鐗堟枃绔犲唴瀹瑰尯鍩?- 姝ｇ‘鐨勯€夋嫨鍣?
  let contentEl = $('#articleContent');
  if (contentEl.length === 0) {
    contentEl = $('#articleText');
  }
  if (contentEl.length === 0) {
    contentEl = $('.article_text');
  }
  if (contentEl.length === 0) {
    contentEl = $('.text_con');
  }
  if (contentEl.length === 0) {
    // 鍏滃簳锛氭煡鎵炬鏂囧尯鍩?
    contentEl = $('article').first();
  }
  if (contentEl.length === 0) return null;

  // 鑾峰彇鍏冪礌鍐呯殑 HTML 骞舵墜鍔ㄦ竻鐞?
  const contentHtml = contentEl.html() || '';
  console.log('[RMRB] contentHtml 闀垮害:', contentHtml.length);
  if (!contentHtml.trim()) return null;

  // 澶勭悊鍥剧墖
  const $$ = cheerio.load(contentHtml);
  $$('img').each((_, el) => {
    const img = $$(el);
    const src = img.attr('src') || img.attr('data-src') || '';
    if (src && !src.startsWith('data:')) {
      img.replaceWith(`\n\n__IMG__${src}__IMG__\n\n`);
    } else {
      img.remove();
    }
  });

  // 鑾峰彇绾枃鏈?
  let text = $$.root().text();

  // HTML 瀹炰綋娓呯悊
  text = text
    .replace(/鈥?g, '\u201C').replace(/鈥?g, '\u201D')
    .replace(/鈥?g, '\u2018').replace(/鈥?g, '\u2019')
    .replace(/鈥?g, '\u2014').replace(/鈥?g, '\u2013')
    .replace(/鈥?g, '\u2026')
    .replace(/聽/g, ' ')
    .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"');

  // 娓呯悊澶氫綑绌鸿
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text || null;
}

// ============ 寰俊鍏紬鍙?============

/**
 * 瑙ｆ瀽寰俊鍏紬鍙烽〉闈㈡鏂?
 * 杩斿洖澶勭悊鍚庣殑鏂囨湰锛堝浘鐗囩敤 __IMG__url__IMG__ 鏍囪锛?
 */
export function parseWechatContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 浼樺厛鍖归厤 id="js_content"
  let contentEl = $('#js_content');
  if (contentEl.length === 0) {
    // 澶囩敤锛歝lass 鍚?rich_media_content
    contentEl = $('.rich_media_content').first();
  }
  if (contentEl.length === 0) return null;

  // 澶勭悊鍥剧墖锛氬井淇＄敤 data-src 鎳掑姞杞?
  contentEl.find('img').each((_, el) => {
    const img = $(el);
    // 浼樺厛鍙?data-src锛堝井淇℃噿鍔犺浇锛?
    let src = img.attr('data-src') || img.attr('src') || '';
    
    // 璺宠繃鍗犱綅鍥惧拰鍥炬爣
    if (!src || src.includes('data:image')) {
      img.remove();
      return;
    }

    // 鏇挎崲涓?__IMG__ 鏍囪
    img.replaceWith(`__IMG__${src}__IMG__`);
  });

  return cleanHtmlToText(contentEl.html() || '');
}

// ============ 閫氱敤 HTML 娓呯悊 ============

/**
 * 灏?HTML 鐗囨娓呯悊涓虹函鏂囨湰
 * 淇濈暀 __IMG__ 鏍囪锛屽叾浣欐爣绛捐浆涓烘枃鏈?
 */
export function cleanHtmlToText(html: string): string {
  if (!html) return '';

  const $ = cheerio.load(html);
  
  // <img> 鏍囩锛氬鏋滆繕娈嬬暀鏈澶勭悊鐨勶紝鎻愬彇 src 杞负 __IMG__ 鏍囪
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (src && !src.startsWith('data:')) {
      $(el).replaceWith(`\n\n__IMG__${src}__IMG__\n\n`);
    } else {
      $(el).remove();
    }
  });

  // <p> 杞崲琛?
  $('p').each((_, el) => {
    $(el).append('\n\n');
  });

  // <br> 杞崲琛?
  $('br').replaceWith('\n');

  // <strong>/<b> 鍘绘爣绛剧暀鏂囧瓧
  // cheerio 鐨?.text() 宸茶嚜鍔ㄥ鐞?

  // 鑾峰彇绾枃鏈?
  let text = $.root().text();

  // HTML 瀹炰綋锛坈heerio 宸插鐞嗗ぇ閮ㄥ垎锛岃繖閲岃ˉ鍏咃級
  text = text
    .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  // 娓呯悊澶氫綑绌鸿
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

// ============ cn.govopendata.com 鏂伴椈鑱旀挱鍏ㄦ枃 ============

/**
 * 瑙ｆ瀽 cn.govopendata.com 鏂伴椈鑱旀挱鍏ㄦ枃椤?
 * 杩斿洖姣忔潯鏂伴椈鐨勫畬鏁存爣棰樺拰姝ｆ枃
 * 缁撴瀯锛?article.content-section> 鈫?<h2.content-heading> + <div.content-body> 鈫?<p>
 * 澶辫触鏃惰繑鍥炵┖鏁扮粍
 */
export function parseGovopendataXWLB(html: string): Array<{ title: string; body: string }> {
  const $ = cheerio.load(html);
  const items: Array<{ title: string; body: string }> = [];

  $('article.content-section').each((_, el) => {
    const title = $(el).find('h2.content-heading').text().trim();
    const paragraphs: string[] = [];
    $(el).find('.content-body p').each((_, p) => {
      const text = $(p).text().trim();
      if (text) paragraphs.push(text);
    });
    if (title) {
      items.push({ title, body: paragraphs.join('\n\n') });
    }
  });

  return items;
}

