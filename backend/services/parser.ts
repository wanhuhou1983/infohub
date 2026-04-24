/**
 * HTML 解析模块
 * 使用 cheerio 做结构化解析，替代脆弱的正则匹配
 */

import * as cheerio from 'cheerio';

// ============ CCTV 新闻联播 ============

/**
 * 解析 CCTV 新闻联播列表页，提取文章链接和标题
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

  // 查找所有指向 VIDE 页面的链接
  $('a[href*="VIDE"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = ($(el).attr('alt') || $(el).attr('title') || $(el).text() || '').trim();
    
    if (!href || !title) return;
    if (!href.match(/https?:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE\w+\.shtml/)) return;
    
    // 清理标题
    const cleanTitle = title.replace(/^\[视频\]\s*/, '');
    if (!cleanTitle || cleanTitle.startsWith('《新闻联播》')) return;
    if (cleanTitle.includes('完整版') && cleanTitle.includes('新闻联播')) return;

    // 去重
    if (seen.has(href)) return;
    seen.add(href);

    articles.push({ title: cleanTitle, url: href, publishedAt });
  });

  return articles;
}

/**
 * 解析 CCTV 单条新闻页面正文
 */
export function parseXWLBContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 优先匹配 id="content_area"
  let contentEl = $('#content_area');
  if (contentEl.length === 0) {
    // 备用：class="content_area"
    contentEl = $('.content_area');
  }
  if (contentEl.length === 0) return null;

  return cleanHtmlToText($.html(contentEl) || contentEl.html() || '');
}

// ============ 人民日报 ============

/**
 * 解析人民日报页面正文
 */
export function parseRMRBContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 人民日报 PC 版文章内容区域 - 正确的选择器
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
    // 兜底：查找正文区域
    contentEl = $('article').first();
  }
  if (contentEl.length === 0) return null;

  // 获取元素内的 HTML 并手动清理
  const contentHtml = contentEl.html() || '';
  console.log('[RMRB] contentHtml 长度:', contentHtml.length);
  if (!contentHtml.trim()) return null;

  // 处理图片
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

  // 获取纯文本
  let text = $$.root().text();

  // HTML 实体清理
  text = text
    .replace(/“/g, '\u201C').replace(/”/g, '\u201D')
    .replace(/‘/g, '\u2018').replace(/’/g, '\u2019')
    .replace(/—/g, '\u2014').replace(/–/g, '\u2013')
    .replace(/…/g, '\u2026')
    .replace(/ /g, ' ')
    .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"');

  // 清理多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text || null;
}

// ============ 微信公众号 ============

/**
 * 解析微信公众号页面正文
 * 返回处理后的文本（图片用 __IMG__url__IMG__ 标记）
 */
export function parseWechatContentHtml(html: string): string | null {
  const $ = cheerio.load(html);

  // 优先匹配 id="js_content"
  let contentEl = $('#js_content');
  if (contentEl.length === 0) {
    // 备用：class 含 rich_media_content
    contentEl = $('.rich_media_content').first();
  }
  if (contentEl.length === 0) return null;

  // 处理图片：微信用 data-src 懒加载
  contentEl.find('img').each((_, el) => {
    const img = $(el);
    // 优先取 data-src（微信懒加载）
    let src = img.attr('data-src') || img.attr('src') || '';
    
    // 跳过占位图和图标
    if (!src || src.includes('data:image') || src.includes('biz') || src.includes('qrcode')) {
      img.remove();
      return;
    }

    // 替换为 __IMG__ 标记
    img.replaceWith(`__IMG__${src}__IMG__`);
  });

  return cleanHtmlToText(contentEl.html() || '');
}

// ============ 通用 HTML 清理 ============

/**
 * 将 HTML 片段清理为纯文本
 * 保留 __IMG__ 标记，其余标签转为文本
 */
export function cleanHtmlToText(html: string): string {
  if (!html) return '';

  const $ = cheerio.load(html);
  
  // <img> 标签：如果还残留未被处理的，提取 src 转为 __IMG__ 标记
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (src && !src.startsWith('data:')) {
      $(el).replaceWith(`\n\n__IMG__${src}__IMG__\n\n`);
    } else {
      $(el).remove();
    }
  });

  // <p> 转换行
  $('p').each((_, el) => {
    $(el).append('\n\n');
  });

  // <br> 转换行
  $('br').replaceWith('\n');

  // <strong>/<b> 去标签留文字
  // cheerio 的 .text() 已自动处理

  // 获取纯文本
  let text = $.root().text();

  // HTML 实体（cheerio 已处理大部分，这里补充）
  text = text
    .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

  // 清理多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
