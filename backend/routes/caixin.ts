/**
 * 财新周刊 Clippings 导入路由
 *
 * POST /api/caixin/import-issue
 *   → 读取 Clippings 目录中的索引 + 单篇文件
 *   → 清洗正文、处理图片、入库 PG、存 OB、删原文
 *
 * 工作流：
 *   1. 扫描 Clippings 目录，找到 财新XXXX.md 索引文件
 *   2. 解析索引，提取当期所有文章标题
 *   3. 逐篇：匹配文件 → 清洗内容 → 图片处理 → 入库 → 存 OB → 删原文
 *   4. 删除索引文件
 */

import { Hono, type Context } from 'hono';
import type { Sql } from 'postgres';
import { readdir, readFile, unlink } from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fail } from '../shared/response.js';
import { processImages } from '../storage/image-processor.js';
import { getObDir, hashString } from '../file-storage.js';

const CLIPPINGS_DIR = '/Users/wuhuahui/Documents/infohub/Clippings';

// ============ 辅助函数 ============

/** 从索引文件内容中提取文章标题列表 */
function parseIndexTitles(content: string): string[] {
  const lines = content.split('\n');
  const sectionHeaders = new Set([
    '封面报道Cover Story', '财新观察Opinion',
    '经济Economy', '金融Finance',
    '商业Business', '时事Current Affairs',
  ]);
  const titles: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (sectionHeaders.has(trimmed)) continue;
    // 跳过副标题/摘要有前导缩进（缩进 ≥ 4 空格或 tab）
    if (line.startsWith('    ') || line.startsWith('\t')) continue;
    // 跳过出版日期行
    if (trimmed.includes('出版日期')) continue;
    // 跳过 "本文来源于" 行
    if (trimmed.startsWith('本文来源于')) continue;

    titles.push(trimmed);
  }

  return titles;
}

/** 根据索引标题查找匹配的文件 */
function findMatchingFile(
  files: Array<{ name: string; path: string }>,
  indexTitle: string,
  indexFileName: string
): { name: string; path: string } | null {
  const candidates = files.filter(f => f.name !== indexFileName);
  if (candidates.length === 0) return null;

  const indexKey = indexTitle.trim();

  // 方法1：文件名的短标题（"｜"之后的部分）精确匹配
  for (const f of candidates) {
    const shortTitle = f.name.replace(/\.md$/, '').split(/[｜|]/).pop()?.trim() || '';
    if (shortTitle === indexKey) return f;
  }

  // 方法2：文件名（去掉.md）包含索引标题
  for (const f of candidates) {
    const nameWithoutExt = f.name.replace(/\.md$/, '');
    if (nameWithoutExt.includes(indexKey)) return f;
  }

  // 方法3：索引标题包含文件名短标题（针对带｜前缀的文件名）
  for (const f of candidates) {
    const shortTitle = f.name.replace(/\.md$/, '').split(/[｜|]/).pop()?.trim() || '';
    if (indexKey.includes(shortTitle)) return f;
  }

  return null;
}

/** 从文件名中提取清洗后的文章标题（删除 "｜" 之前的内容） */
function extractCleanTitle(fileName: string): string {
  const parts = fileName.replace(/\.md$/, '').split(/[｜|]/);
  const last = parts.pop()?.trim() || fileName.replace(/\.md$/, '');
  return last;
}

/** 清洗正文 */
function cleanContent(rawContent: string, isCaixinObserve: boolean): string {
  let content = rawContent;

  if (isCaixinObserve) {
    // 财新观察特殊规则：从最后一段 "请务必在总结开头增加这段话" 之后开始
    const lastPleaseIdx = content.lastIndexOf('请务必在总结开头增加这段话');
    if (lastPleaseIdx !== -1) {
      const afterPlease = content.indexOf('\n', lastPleaseIdx);
      if (afterPlease !== -1) {
        content = content.slice(afterPlease + 1);
      } else {
        content = content.slice(lastPleaseIdx);
      }
    }
  } else {
    // 常规文章：从 "文｜" 行开始
    const wenMatch = content.match(/^.*文｜.*$/m);
    if (wenMatch) {
      content = content.slice(wenMatch.index!);
    } else {
      // 兼容加粗格式：**文｜
      const boldMatch = content.match(/\*\*文｜.*\*\*/);
      if (boldMatch) {
        content = content.slice(boldMatch.index!);
      }
    }
  }

  // 删除 "版面编辑：" 行及之后的内容
  const banIdx = content.indexOf('版面编辑：');
  if (banIdx !== -1) {
    // 找到此行开始的位置（往前找上一行末尾）
    const lineStart = content.lastIndexOf('\n', banIdx);
    content = lineStart !== -1 ? content.slice(0, lineStart) : content.slice(0, banIdx);
  }

  // 删除所有 "请务必在总结开头增加这段话" 段落
  content = content.replace(/请务必在总结开头增加这段话[^\n]*(\n|$)/g, '');

  // 删除HTML注释
  content = content.replace(/<![\s\S]*?>/g, '');

  // 合并多余空行
  content = content.replace(/\n{3,}/g, '\n\n');

  return content.trim();
}

/** 从正文中提取作者 */
function extractAuthor(content: string): string {
  const match = content.match(/文｜(.+?)(?:\n|$)/);
  if (!match) return '';
  return match[1]?.trim().replace(/\*\*+$/, '') || '';
}

/** 写入 OB 文件 */
function writeObFile(
  articleId: number,
  issue: string,
  title: string,
  author: string,
  contentHash: string,
  publishDate: string,
  body: string
): string {
  const obBase = getObDir();
  const subdir = join('报刊杂志', '财新周刊', `财新${issue}`);
  const dirPath = join(obBase, subdir);

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  const safeTitle = title.replace(/[\/\\:*?"<>|\n\r]/g, '_').trim() || 'untitled';
  const filePath = join(dirPath, `${safeTitle}.md`);

  const frontmatter = [
    '---',
    `id: ${articleId}`,
    `content_hash: "${contentHash}"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source: "财新周刊"`,
    `source_type: "magazine"`,
    `published_at: "${publishDate}T00:00:00"`,
    `tags: ["财新周刊", "第${issue}期"]`,
    `author: "${author.replace(/"/g, '\\"')}"`,
    '---',
    '',
    `# ${title}`,
    '',
    body.replace(/\/api\/images\/([^\s)\]\)]+)/g, '/附件/$1'),
    '',
  ].join('\n');

  writeFileSync(filePath, frontmatter, 'utf-8');
  return filePath;
}

// ============ 路由 ============

export function createCaixinRoutes(
  sql: Sql,
  requireAdminAuth: (c: Context) => { valid: boolean; error?: string }
): Hono {
  const router = new Hono();

  // POST /api/caixin/import-issue — 从 Clippings 导入财新周刊新一期
  router.post('/import-issue', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);

    // 1. 读取 Clippings 目录
    let entries: { name: string; path: string }[];
    try {
      const dirEntries = await readdir(CLIPPINGS_DIR, { withFileTypes: true });
      entries = dirEntries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => ({ name: e.name, path: join(CLIPPINGS_DIR, e.name) }));
    } catch (e: any) {
      return fail(c, `无法读取 Clippings 目录: ${e.message}`, 500);
    }

    if (entries.length === 0) {
      return fail(c, 'Clippings 目录为空', 400);
    }

    // 2. 查找索引文件 (财新XXXX.md)
    const indexFile = entries.find(f => /^财新(\d+)\.md$/.test(f.name));
    if (!indexFile) {
      return fail(c, '未找到财新周刊索引文件（需命名为 财新XXXX.md）', 404);
    }

    const issueMatch = indexFile.name.match(/^财新(\d+)\.md$/);
    const issue = issueMatch?.[1] || '';
    if (!issue) return fail(c, '无法从索引文件名中提取期号', 400);

    // 读取出版日期
    const indexContent = await readFile(indexFile.path, 'utf-8');
    const dateMatch = indexContent.match(/出版日期：(\d{4}-\d{2}-\d{2})/);
    const publishDate = dateMatch?.[1] || '';

    // 3. 解析索引标题
    const indexTitles = parseIndexTitles(indexContent);
    if (indexTitles.length === 0) {
      return fail(c, '索引文件未能解析出任何文章标题', 400);
    }

    // 4. 逐篇处理
    const processed: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    for (const indexTitle of indexTitles) {
      // 匹配文件
      const matchedFile = findMatchingFile(entries, indexTitle, indexFile.name);
      if (!matchedFile) {
        errors.push(`未找到匹配文件: ${indexTitle}`);
        continue;
      }

      // 读取原始内容
      const rawContent = await readFile(matchedFile.path, 'utf-8');
      if (!rawContent.trim()) {
        errors.push(`空文件: ${matchedFile.name}`);
        continue;
      }

      // 判断是否财新观察
      const isCaixinObserve = matchedFile.name.startsWith('财新观察');

      // 清洗正文
      const cleanedContent = cleanContent(rawContent, isCaixinObserve);
      if (!cleanedContent) {
        errors.push(`清洗后内容为空: ${matchedFile.name}`);
        continue;
      }

      // 清洗标题
      const cleanTitle = extractCleanTitle(matchedFile.name);

      // 提取作者
      const author = extractAuthor(cleanedContent);

      // 内容哈希（使用清洗后的内容）
      const contentHash = hashString(cleanedContent);

      // 检查重复
      const [existing] = await sql`
        SELECT id FROM articles WHERE source_id = 26 AND content_hash = ${contentHash} LIMIT 1
      `;
      if (existing) {
        skipped.push(matchedFile.name);
        continue;
      }

      // 处理图片（下载 → COS → 替换 URL）
      const processedContent = await processImages(cleanedContent, 'magazine');

      // 插入 PG
      const publishDateObj = publishDate ? new Date(publishDate) : null;
      const [inserted] = await sql`
        INSERT INTO articles (
          source_id, title, author, content, content_hash,
          published_at, category, tags, extra
        ) VALUES (
          26,
          ${cleanTitle},
          ${author},
          ${processedContent},
          ${contentHash},
          ${publishDateObj},
          '',
          ${sql.array(['财新周刊', `第${issue}期`])},
          ${sql.json({ issue })}
        )
        RETURNING id
      `;

      // 写入 OB 文件
      try {
        writeObFile(
          inserted!.id, issue, cleanTitle, author, contentHash,
          publishDate || new Date().toISOString().slice(0, 10),
          processedContent
        );
      } catch (e: any) {
        console.error(`OB 文件写入失败 (${matchedFile.name}):`, e.message);
        // OB 写入失败不影响 PG 入库
      }

      // 删除 Clippings 原文
      try {
        await unlink(matchedFile.path);
        console.log(`[caixin] 已删除原文: ${matchedFile.name}`);
      } catch (e: any) {
        console.error(`删除源文件失败 (${matchedFile.name}):`, e.message);
      }

      processed.push(matchedFile.name);
    }

    // 5. 删除索引文件
    try {
      await unlink(indexFile.path);
      console.log(`[caixin] 已删除索引: ${indexFile.name}`);
    } catch (e: any) {
      console.error(`删除索引文件失败:`, e.message);
    }

    return c.json({
      ok: true,
      issue,
      publishDate,
      imported: processed.length,
      skipped: skipped.length,
      errors: errors.length,
      importedFiles: processed,
      skippedFiles: skipped,
      errorFiles: errors,
    });
  });

  return router;
}
