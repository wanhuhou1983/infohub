/**
 * 信息源路由
 *
 * 注意：这是唯一生效的 sources 路由定义。
 * index.ts 中的内联版本已废弃，统一由此模块管理。
 *
 * 支持：
 * - 获取信息源列表/树
 * - 创建/更新/删除信息源
 * - 更新信息源配置（PATCH config）
 * - 从本地文件夹导入杂志文章（import-folder）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { readdir, readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'node:crypto';
import { fail } from '../shared/response.js';

// ============ 路由定义 ============

interface AuthCheck {
  valid: boolean;
  error?: string;
}

export function createSourcesRoutes(sql: Sql, requireAdminAuth: (c: any) => AuthCheck): Hono {
  const router = new Hono();

  // 获取所有信息源
  router.get('/', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;
    return c.json(sources);
  });

  // 获取信息源树（支持多层嵌套）
  router.get('/tree', async (c) => {
    const sources = await sql`SELECT * FROM sources ORDER BY id`;

    // 一次性查所有 source 的文章数
    const articleCounts = await sql`
      SELECT source_id, COUNT(*) as count
      FROM articles
      GROUP BY source_id
    `;
    const countMap = new Map<number, number>();
    articleCounts.forEach((r: any) => countMap.set(r.source_id, Number(r.count)));

    // 构建节点映射
    const nodeMap = new Map();
    sources.forEach(s => nodeMap.set(s.id, {
      ...s,
      article_count: countMap.get(s.id) || 0,
      children: []
    }));

    const roots: any[] = [];

    // 构建树结构
    sources.forEach(s => {
      const node = nodeMap.get(s.id);
      if (s.parent_id === null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(s.parent_id);
        if (parent) {
          // 只显示 enabled=true 的子源（公众号/群聊/B站/YouTube等）
          if (node.enabled === false) {
            return; // 跳过
          }
          parent.children.push(node);
        }
      }
    });

    // 计算每个节点的 total_articles（自身 + 所有子孙）
    function calcTotal(node: any): number {
      let total = node.article_count || 0;
      for (const child of node.children) {
        total += calcTotal(child);
      }
      node.total_articles = total;
      return total;
    }
    roots.forEach(calcTotal);

    return c.json(roots);
  });

  // 获取指定源的文章标题列表（树形视图用）
  router.get('/tree/:id/articles', async (c) => {
    const sourceId = Number(c.req.param('id'));
    const limit = Number(c.req.query('limit') || 100);
    const articles = await sql`
      SELECT id, title, url, published_at, fetched_at
      FROM articles
      WHERE source_id = ${sourceId}
      ORDER BY COALESCE(published_at, fetched_at) DESC
      LIMIT ${limit}
    `;
    return c.json(articles);
  });

  // 创建新信息源
  router.post('/', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    const { name, type, icon, enabled, parent_id, config } = await c.req.json();
    if (!name || !type) return fail(c, 'name and type are required', 400);

    const [created] = await sql`
      INSERT INTO sources (name, type, icon, enabled, parent_id, config)
      VALUES (${name}, ${type}, ${icon || null}, ${enabled !== false}, ${parent_id || null}, ${sql.json(config || {})})
      RETURNING *
    `;
    return c.json(created, 201);
  });

  // 更新信息源（PATCH 部分更新）
  router.patch('/:id', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return fail(c, 'Invalid body', 400);

    // 读取当前记录
    const [row] = await sql`SELECT * FROM sources WHERE id = ${id}`;
    if (!row) return fail(c, 'Source not found', 404);

    // 合并更新字段
    const newName = body.name !== undefined ? body.name : row.name;
    const newEnabled = body.enabled !== undefined ? body.enabled : row.enabled;
    const newIcon = body.icon !== undefined ? body.icon : row.icon;
    const newConfig = body.config !== undefined ? { ...row.config, ...body.config } : row.config;

    const [updated] = await sql`
      UPDATE sources
      SET name = ${newName}, enabled = ${newEnabled}, icon = ${newIcon},
          config = ${sql.json(newConfig)}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return c.json(updated);
  });

  // 删除信息源（及其下所有文章）
  router.delete('/:id', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    // 先删除关联文章
    await sql`DELETE FROM articles WHERE source_id = ${id}`;
    // 再删除源
    const [deleted] = await sql`DELETE FROM sources WHERE id = ${id} RETURNING id`;
    if (!deleted) return fail(c, 'Source not found', 404);
    return c.json({ ok: true });
  });

  // 更新信息源配置（合并式更新，不覆盖未传字段）
  router.patch('/:id/config', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return fail(c, 'Invalid body', 400);

    // 读取当前 config，合并新值
    const [row] = await sql`SELECT config FROM sources WHERE id = ${id}`;
    if (!row) return fail(c, 'Source not found', 404);

    const currentConfig = row.config || {};
    const newConfig = { ...currentConfig, ...body };

    const [updated] = await sql`
      UPDATE sources SET config = ${sql.json(newConfig)}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, type, config
    `;

    return c.json(updated);
  });

  // POST /api/sources/:id/import-folder - 从本地文件夹导入杂志文章
  router.post('/:id/import-folder', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

    const [source] = await sql`SELECT * FROM sources WHERE id = ${id}`;
    if (!source) return fail(c, 'Source not found', 404);

    const folderPath = source.config?.folderPath;
    if (!folderPath) return fail(c, '未设置文件夹路径，请先在配置中设置 folderPath', 400);

    let files: string[] = [];
    try {
      const entries = await readdir(folderPath, { withFileTypes: true });
      files = entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => join(folderPath, e.name));
    } catch (e: any) {
      return fail(c, '无法读取文件夹: ' + e.message, 500);
    }

    // 匹配 财新XXXX｜ 格式（兼容全角 ｜ 和半角 |）
    const articleRegex = /^财新(\d+)[｜|](.+)\.md$/;
    const processed: string[] = [];
    const skipped: string[] = [];

    for (const filePath of files) {
      const fileName = basename(filePath);
      const match = fileName.match(articleRegex);
      if (!match) continue;

      const issue = match[1];
      const title = match[2];

      const content = await readFile(filePath, 'utf-8');
      // 🔒 使用内容（而非路径）计算 hash，避免重名文件冲突
      const contentHash = createHash('md5').update(content).digest('hex');

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM articles WHERE source_id = ${id} AND content_hash = ${contentHash} LIMIT 1
      `;
      if (existing) {
        skipped.push(fileName);
        continue;
      }

      // 提取作者
      const authorMatch = content.match(/\*\*文｜(.+?)\*\*/);
      const author = authorMatch ? (authorMatch[1]?.trim() || '') : '';

      // 清理内容
      const cleanContent = content
        .replace(/\*\*请务必[\s\S]*?$/, '')
        .replace(/<![\s\S]*?>/g, '')
        .trim();

      // 简单分类
      const category = '财经';
      const tags: string[] = ['财新周刊', `第${issue}期`];

      try {
        await sql`
          INSERT INTO articles (source_id, title, author, content, content_hash, category, tags, extra)
          VALUES (
            ${id},
            ${'【' + issue + '】' + title},
            ${author},
            ${cleanContent},
            ${contentHash},
            ${category},
            ${tags},
            ${sql.json({ issue, sourceFile: filePath })}
          )
        `;
        processed.push(fileName);
      } catch (e: any) {
        console.error(`导入失败: ${fileName}`, e.message);
        // 单条失败不影响其他文件继续导入
      }
    }

    return c.json({
      ok: true,
      imported: processed.length,
      skipped: skipped.length,
      importedFiles: processed,
      skippedFiles: skipped,
    });
  });

  return router;
}
