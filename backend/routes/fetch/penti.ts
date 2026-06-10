// @ts-nocheck
/**
 * 喷嚏图卦采集路由
 *
 * 依赖：skills/penti-tugua/scripts/penti_daily.py
 *  （需 requests + beautifulsoup4）
 * ⏰ 喷嚏图卦每日 18:00 后更新
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString } from '../../file-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createPentiRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 喷嚏图卦采集 ============
  router.post('/penti', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}) as any);

      // 日期：优先用参数，否则 18:00 前用昨天，18:00 后用今天
      let date: string;
      if (body?.date) {
        date = body.date.replace(/-/g, '');
      } else {
        const now = new Date();
        const h = now.getHours();
        const d = new Date(now);
        if (h < 18) d.setDate(d.getDate() - 1);
        date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      }
      const pubDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      const sourceId = 2891;

      const scriptDir = path.resolve(__dirname, '../../skills/penti-tugua/scripts');
      const python =
        process.platform === 'win32'
          ? 'python'
          : '/Users/linhu/.workbuddy/binaries/python/envs/default/bin/python3';
      const outputMd = `/tmp/penti_${date}.md`;

      console.log(`[penti] 采集 ${date}...`);

      // Step1: 运行 Python 脚本生成 Markdown
      const proc = spawn(
        python,
        [path.join(scriptDir, 'penti_daily.py'), date, '--output', outputMd],
        { timeout: 120000 },
      );

      let stderr = '';
      for await (const chunk of proc.stderr) {
        stderr += chunk.toString();
      }
      await new Promise<void>((res, rej) => {
        proc.on('close', () => res());
        proc.on('error', rej);
      });

      if (!existsSync(outputMd)) {
        console.error(`[penti] 采集失败: ${stderr.slice(0, 300)}`);
        return c.json({ ok: false, error: `采集失败: ${stderr.slice(0, 200)}` }, 500);
      }

      // Step2: 读取生成的 Markdown
      const content = readFileSync(outputMd, 'utf-8').trim();
      try { unlinkSync(outputMd); } catch { /* ignore */ }

      if (!content) return c.json({ ok: false, error: '内容为空' }, 500);

      // Step3: 解析标题和条目数
      const lines = content.split('\n');
      const titleLine = lines[0]?.replace(/^#\s*/, '') || `${date}-喷嚏图卦`;
      const title = titleLine.replace(/【】/g, '');
      const bodyContent = lines.slice(1).join('\n').trim();
      const entryCount = (bodyContent.match(/^【\d+】/gm) || []).length;
      const contentHash = hashString('penti:' + date);

      console.log(`[penti]  内容 ${bodyContent.length} 字符，${entryCount} 条`);

      // Step4: 入库
      const rows = await sql`
        INSERT INTO articles (
          source_id, title, content, summary, url,
          published_at, category, tags, content_hash,
          fetched_at, author, extra
        ) VALUES (
          ${sourceId}, ${title}, ${bodyContent}, ${bodyContent.slice(0, 150)},
          ${'https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei'},
          ${pubDate}, '社会', ${['喷嚏图卦', date.slice(0, 6)]},
          ${contentHash}, NOW(), '喷嚏图卦', '{}'
        )
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      let inserted = 0;
      if (rows.length > 0) {
        inserted = 1;
        await saveArticleFile(rows[0].id, bodyContent, {
          id: rows[0].id,
          title,
          source_type: 'magazine',
          source_name: '喷嚏图卦',
          url: 'https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei',
          published_at: pubDate,
          category: '社会',
          tags: ['喷嚏图卦', date.slice(0, 6)],
          author: '喷嚏图卦',
          is_read: false,
          is_starred: false,
        });
        console.log(`[penti]  ✅ 入库 article_id=${rows[0].id}`);
      } else {
        console.log(`[penti]  ⚠️ 已存在（跳过）`);
      }

      return c.json({ ok: true, fetched: entryCount, inserted, date });
    } catch (e: any) {
      console.error(`[penti] 错误: ${e.message}`);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
