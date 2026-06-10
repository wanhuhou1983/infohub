// @ts-nocheck
/**
 * 人民日报采集路由
 *
 * 数据源：人民日报数字版 (paper.people.com.cn)
 * 依赖：skills/rmrb-daily/rmrb_daily.py（需 requests + beautifulsoup4）
 * ⏰ 每日 10:00 后更新
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { saveArticleFile, hashString } from '../../file-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createRmrbRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 人民日报采集 ============
  router.post('/rmrb', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}) as any);

      // 接受 YYYY-MM-DD 或 YYYYMMDD 格式，统一为 YYYY-MM-DD
      let date =
        body?.date ||
        new Date().toISOString().slice(0, 10);
      if (/^\d{8}$/.test(date)) {
        date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      }
      const pubDate = date; // 已经是 YYYY-MM-DD
      const dateCompact = date.replace(/-/g, '');
      const full = body?.full !== false;
      const sourceId = 2892;

      const rmrbDir =
        process.env.RMRB_DIR ||
        path.resolve(__dirname, '../../skills/rmrb-daily');
      const python =
        process.platform === 'win32'
          ? 'python'
          : '/Users/linhu/.workbuddy/binaries/python/envs/default/bin/python3';
      const outputMd = `/tmp/rmrb_${dateCompact}.md`;

      console.log(`[rmrb] 采集 ${date}...`);

      // Step1: 运行 Python 脚本生成 Markdown
      const proc = spawn(
        python,
        [
          path.join(rmrbDir, 'rmrb_daily.py'),
          date,
          ...(full ? ['--full', '--output', outputMd] : ['--output', outputMd]),
        ],
        { timeout: 180000 },
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
        console.error(`[rmrb] 采集失败: ${stderr.slice(0, 300)}`);
        return c.json({ ok: false, error: `采集失败: ${stderr.slice(0, 200)}` }, 500);
      }

      // Step2: 读取生成的 Markdown
      const content = readFileSync(outputMd, 'utf-8').trim();
      try {
        unlinkSync(outputMd);
      } catch { /* ignore */ }

      if (!content) return c.json({ ok: false, error: '内容为空' }, 500);

      // Step3: 解析文章数（### 开头的行为每篇要闻标题）
      const lines = content.split('\n');
      const title = `${dateCompact}-人民日报要闻汇总`;
      const bodyContent = lines.slice(1).join('\n').trim();
      const articleCount = bodyContent.split('\n### ').filter(Boolean).length;
      const contentHash = hashString('rmrb:' + dateCompact);

      console.log(`[rmrb]  内容 ${bodyContent.length} 字符，${articleCount} 篇要闻`);

      // Step4: 入库
      const rows = await sql`
        INSERT INTO articles (
          source_id, title, content, summary, url,
          published_at, category, tags, content_hash,
          fetched_at, author, extra
        ) VALUES (
          ${sourceId}, ${title}, ${bodyContent}, ${bodyContent.slice(0, 150)},
          ${'https://paper.people.com.cn/rmrb/'},
          ${pubDate}, '时政', ${['人民日报', dateCompact.slice(0, 6)]},
          ${contentHash}, NOW(), '人民日报', '{}'
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
          source_name: '人民日报',
          url: 'https://paper.people.com.cn/rmrb/',
          published_at: pubDate,
          category: '时政',
          tags: ['人民日报', dateCompact.slice(0, 6)],
          author: '人民日报',
          is_read: false,
          is_starred: false,
        });
        console.log(`[rmrb]  ✅ 入库 article_id=${rows[0].id}`);
      } else {
        console.log(`[rmrb]  ⚠️ 已存在（跳过）`);
      }

      return c.json({ ok: true, fetched: articleCount, inserted, date });
    } catch (e: any) {
      console.error(`[rmrb] 错误: ${e.message}`);
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  return router;
}
