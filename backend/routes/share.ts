/**
 * 轻量分享阅读页：GET /a/:id
 *
 * 服务端渲染的纯文章页面，零前端框架、零外部资源，手机打开即读。
 * 复制链接指向此页；完整 Web 应用仍可用 /?a=<id> 直达。
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 与前端 smartParagraphize 保持一致：采集正文多为无换行长文本
function smartParagraphize(text: string): string {
  if (!text) return text;
  if (text.includes('\n\n')) return text;
  text = text.replace(/(?<!^)(?<![\n\r])###\s+/g, '\n### ');
  if (text.includes('\n')) {
    return text.split('\n').map(line => {
      if (/^#{1,6}\s+/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) return line;
      if (line.includes('###')) line = line.replace(/###\s*/g, '｜');
      if (line.length > 50 && !/[。！？；]\s*$/.test(line)) {
        return line.replace(/([。！？；])(?=[^，。！？；\n])/g, '$1\n\n');
      }
      return line;
    }).join('\n');
  }
  return text.replace(/([。！？；])(?=[^，。！？；\n])/g, '$1\n\n');
}

function inline(text: string): string {
  let s = esc(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, rawUrl: string) => {
    let url = rawUrl.replace(/&amp;/g, '&');
    if (/mmbiz\.qpic\.cn|mmbiz\.qlogo\.cn|wx\.qlogo\.cn/.test(url)) {
      url = '/api/image-proxy?url=' + encodeURIComponent(url);
    }
    return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, rawUrl: string) => {
    const url = rawUrl.replace(/&amp;/g, '&');
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderBody(content: string): string {
  const text = smartParagraphize(String(content ?? '').replace(/__IMG__(.+?)__IMG__/g, '![image]($1)'));
  if (!text.trim()) return '<p class="empty">这篇文章没有正文内容。</p>';
  return text.split(/\n{2,}/).map(block => {
    const parts = block.split('\n').map(line => {
      const t = line.trim();
      if (!t) return '';
      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = Math.min(h[1].length, 4);
        return `<h${level}>${inline(h[2])}</h${level}>`;
      }
      if (/^[-*+]\s+/.test(t)) return `<li>${inline(t.replace(/^[-*+]\s+/, ''))}</li>`;
      if (/^\d+\.\s+/.test(t)) return `<li>${inline(t.replace(/^\d+\.\s+/, ''))}</li>`;
      return `<p>${inline(t)}</p>`;
    }).filter(Boolean);
    const listRun = parts.length > 0 && parts.every(p => p.startsWith('<li>'));
    return listRun ? `<ul>${parts.join('')}</ul>` : parts.join('');
  }).join('');
}

function pageHtml(a: any): string {
  const title = String(a.title ?? '未命名文章');
  const rawPublished = String(a.published_raw ?? '');
  // 纯日期源（人民日报/新闻联播/喷嚏）不补 00:00
  const time = /^\d{4}-\d{2}-\d{2}$/.test(rawPublished)
    ? rawPublished
    : (a.published_bj || a.fetched_bj || '');
  const source = a.source_name ? `${a.source_icon ? esc(a.source_icon) + ' ' : ''}${esc(a.source_name)}` : 'InfoHub';
  const category = a.category ? ` · ${esc(a.category)}` : '';
  const original = a.url
    ? `<a class="btn primary" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">阅读原文</a>`
    : '';
  const body = renderBody(a.content ?? '');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>${esc(title)} · InfoHub</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin:0; background:#f6f6f7; color:#1c1c1e; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif; -webkit-text-size-adjust:100%; }
.wrap { max-width:680px; margin:0 auto; padding:22px 18px calc(48px + env(safe-area-inset-bottom)); }
.meta { font-size:13px; color:#8a8a8e; line-height:1.6; }
h1 { font-size:22px; line-height:1.45; font-weight:650; margin:10px 0 20px; word-break:break-word; }
.article { font-size:17px; line-height:1.85; overflow-wrap:anywhere; }
.article p { margin:0 0 1.05em; }
.article h1,.article h2,.article h3,.article h4 { font-size:18px; line-height:1.5; margin:1.4em 0 .7em; }
.article ul { padding-left:1.4em; margin:0 0 1em; }
.article li { margin:.3em 0; }
.article img { display:block; max-width:100%; height:auto; margin:14px auto; border-radius:6px; }
.article a { color:#2f6fd0; text-decoration:none; }
.article .empty { color:#999; text-align:center; padding:36px 0; }
.actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:34px; padding-top:20px; border-top:1px solid #e3e3e6; }
.btn { display:inline-flex; align-items:center; justify-content:center; font-size:14px; padding:9px 15px; border-radius:8px; border:1px solid #dcdce0; background:#fff; color:#333; text-decoration:none; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.btn.primary { background:#2f6fd0; border-color:#2f6fd0; color:#fff; }
.foot { margin-top:18px; font-size:12px; color:#aaa; }
@media (prefers-color-scheme:dark) {
  body { background:#141519; color:#e8e8ea; }
  .meta,.foot { color:#8b8d95; }
  .btn { background:#202228; border-color:#34363e; color:#d8d9de; }
  .btn.primary { background:#3b78d8; border-color:#3b78d8; color:#fff; }
  .actions { border-top-color:#2b2d34; }
  .article a { color:#75a8f0; }
}
</style>
</head>
<body>
<div class="wrap">
  <div class="meta">${source}${category}${time ? ' · ' + esc(time) : ''}</div>
  <h1>${esc(title)}</h1>
  <div class="article">${body}</div>
  <div class="actions">
    ${original}
    <a class="btn" href="/?a=${a.id}">在 InfoHub 中打开</a>
    <button class="btn" id="copyBtn" type="button">复制链接</button>
  </div>
  <div class="foot">InfoHub · 分享阅读</div>
</div>
<script>
document.getElementById('copyBtn').addEventListener('click', async function () {
  const btn = this;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(location.href);
    } else {
      const ta = document.createElement('textarea');
      ta.value = location.href; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove();
      if (!ok) throw new Error('copy failed');
    }
    btn.textContent = '已复制';
    setTimeout(function () { btn.textContent = '复制链接'; }, 1800);
  } catch (e) {
    window.prompt('复制链接', location.href);
  }
});
</script>
</body>
</html>`;
}

export function createShareRoutes(sql: Sql): Hono {
  const router = new Hono();

  router.get('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.text('Invalid article id', 400);

    const rows = await sql`
      SELECT a.id, a.title, a.content, a.url, a.category,
             a.published_at::text AS published_raw,
             to_char(a.published_at, 'YYYY-MM-DD HH24:MI') AS published_bj,
             to_char(a.fetched_at, 'YYYY-MM-DD HH24:MI') AS fetched_bj,
             s.name AS source_name, s.icon AS source_icon, s.type AS source_type
      FROM articles a LEFT JOIN sources s ON a.source_id = s.id
      WHERE a.id = ${id}
    `;
    if (rows.length === 0) return c.text('文章不存在（可能尚未同步到云端）', 404);

    c.header('Cache-Control', 'public, max-age=300');
    return c.html(pageHtml(rows[0]));
  });

  return router;
}
