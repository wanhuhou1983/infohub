// @ts-nocheck
/**
 * 微信公众号同步路由
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString, processImages } from '../../file-storage.js';
import { classifyByFeed, extractTags } from '../../services/classifier.js';
import { isEnglish, translateToChinese } from '../../services/translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIDER_DIR = process.env.SPIDER_DIR || path.resolve(__dirname, '../../../wechat-article-spider');
const PYTHON_CMD = path.join(SPIDER_DIR, '.venv/bin/python3');

export function createWechatRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 微信公众号同步 ============
  router.post('/wechat', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({} as any));
      const sourceId = body?.sourceId || 0;
      const authToken = body?.authorization || body?.auth || '';
      if (!sourceId) return c.json({ ok: false, error: '缺少 sourceId' }, 400);

      console.log(`[wechat] 开始同步 source_id=${sourceId}`);
      const [source] = await sql`SELECT id, name, config FROM sources WHERE id = ${sourceId} AND LOWER(type) = 'wechat'`;
      if (!source) return c.json({ ok: false, error: `未找到源: ${sourceId}` }, 404);

      const cfg = typeof source.config === 'string' ? JSON.parse(source.config) : (source.config || {});
      const wechatUrl = cfg.url || cfg.wechat_url || '';
      if (!wechatUrl) return c.json({ ok: false, error: '公众号未配置 URL' }, 400);

      const { spawn } = await import('child_process');
      const spiderDir = SPIDER_DIR;
      const python = PYTHON_CMD;
      const outputJson = '/tmp/wechat_' + sourceId + '_' + Date.now() + '.json';

      console.log(`[wechat] 运行爬虫: ${python} spider_cli.py ${wechatUrl}`);
      let stdout = '', stderr = '';
      try {
        const proc = spawn(python, [path.join(spiderDir, 'spider_cli.py'), wechatUrl, '--output', outputJson, '--count', String(cfg.max_items || 20)], { timeout: 180000 });
        for await (const chunk of proc.stdout) stdout += chunk;
        for await (const chunk of proc.stderr) stderr += chunk;
        await new Promise((res, rej) => { proc.on('close', res); proc.on('error', rej); });
      } catch (e: any) {
        if (!existsSync(outputJson)) return c.json({ ok: false, error: `爬虫失败: ${stderr.slice(0,200)}` }, 500);
      }

      let articles: any[] = [];
      try { articles = JSON.parse(readFileSync(outputJson, 'utf-8')); } catch { /* ignore */ }
      try { unlinkSync(outputJson); } catch { /* ignore */ }

      if (!Array.isArray(articles) || articles.length === 0) return c.json({ ok: false, error: '未获取到文章' }, 404);

      let inserted = 0;
      for (const art of articles) {
        const title = art.title?.trim() || '(无标题)';
        const url = art.url || '';
        const pubDate = art.publishTime || art.publishDate || new Date().toISOString();
        let content = art.content || art.html || art.description || '';
        const contentHash = hashString(url || title + pubDate);

        // 清理微信垃圾空图片链接
        content = content.replace(/!\[[^\]]*\]\(\)/g, '');

        try { content = await processImages(content, 'wechat'); } catch { /* ignore */ }

        if (isEnglish(content)) {
          try {
            const tc = await translateToChinese(content);
            if (tc !== content) content = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${content}`;
          } catch { /* ignore */ }
        }

        const rows = await sql`INSERT INTO articles (source_id,title,content,summary,url,published_at,category,tags,content_hash,fetched_at,author) VALUES (${sourceId},${title},${content},${(content||"").slice(0,150)},${url},${pubDate},${classifyByFeed(source.name)},${extractTags(title, source.name)},${contentHash},NOW(),'') ON CONFLICT (content_hash) DO NOTHING RETURNING id`;
        if (rows.length > 0) { inserted++; }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${sourceId}`;
      return c.json({ ok: true, fetched: articles.length, inserted });
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
  });

  return router;
}
