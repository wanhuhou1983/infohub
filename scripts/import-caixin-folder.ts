/**
 * 财新周刊本地文件夹导入脚本
 *
 * 将 Obsidian Clippings 目录中的已处理财新周刊文章（财新XXXX｜标题.md 格式）
 * 导入到 InfoHub 数据库。
 *
 * 用法：
 *   npx tsx scripts/import-caixin-folder.ts [--source-id 26] [--folder "path"]
 *
 * 示例：
 *   npx tsx scripts/import-caixin-folder.ts
 *   npx tsx scripts/import-caixin-folder.ts --folder "/Users/wuhuahui/Nutstore Files/GitHub/wanhuhou_vault/Clippings"
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

// ============ 配置 ============
const CAIXIN_SOURCE_ID = 26; // 财新周刊 source_id
const DEFAULT_FOLDER = '/Users/wuhuahui/Nutstore Files/GitHub/wanhuhou_vault/Clippings';

// ============ 参数解析 ============
const args = process.argv.slice(2);
const folderArg = args.indexOf('--folder');
const FOLDER = folderArg >= 0 ? args[folderArg + 1] : DEFAULT_FOLDER;

// ============ 数据库连接 ============
const sql = postgres({
  host: 'localhost',
  port: 5433,
  user: 'infohub',
  password: 'infohub123',
  database: 'infohub',
});

// ============ 工具函数 ============

/** 解析 Markdown 文件的 frontmatter */
function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const metaLines = match[1]!;
  const body = match[2];
  const meta: Record<string, any> = {};

  for (const line of metaLines.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // 处理数组格式：tags: ["tag1", "tag2"]
    if (value.startsWith('[')) {
      try {
        meta[key] = JSON.parse(value);
      } catch {
        meta[key] = [];
      }
    } else if (value === 'true') {
      meta[key] = true;
    } else if (value === 'false') {
      meta[key] = false;
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body };
}

/** 从文件名解析期刊号和标题 */
function parseFilename(filename: string): { issue: string | null; title: string } {
  // 格式：财新2616｜标题.md
  const m = filename.match(/^财新(\d{4})｜(.+)\.md$/);
  if (m) {
    return { issue: m[1]!, title: m[2]! };
  }
  return { issue: null, title: filename.replace(/\.md$/, '') };
}

/** 从内容中提取发布日期 */
function extractPublishedAt(content: string): string | null {
  const patterns = [
    /(\d{4})年\s*第\s*\d+\s*期/,
    /(\d{4})-(\d{2})-(\d{2})/,
    /published_at["\s:]+([^"\n]+)/,
  ];

  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) {
      // 如果匹配到日期格式
      if (m[1] && m[2] && m[3]) {
        return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
      }
      if (m[1] && Number(m[1]) > 2000) {
        return `${m[1]}-01-01T00:00:00`;
      }
    }
  }
  return null;
}

/** 分类财新文章 */
function classifyCaixin(title: string): string {
  const t = title;
  if (t.includes('封面报道') || t.includes('特别报道')) return '封面报道';
  if (t.includes('财新观察')) return '财新观察';
  if (t.includes('专栏')) return '专栏';
  if (t.includes('社论') || t.includes('编辑')) return '社论';
  if (/IPO|上市|股市|基金|银行|保险|债|利率|资本/.test(t)) return '金融';
  if (/AI|科技|互联网|芯片|半导体/.test(t)) return '科技';
  if (/中东|俄乌|美国|中国|外交|制裁|战争/.test(t)) return '时事';
  if (/经济|GDP|通胀|贸易|关税/.test(t)) return '经济';
  if (/环境|气候|能源|碳/.test(t)) return '环境与科技';
  return '综合';
}

// ============ 主流程 ============

async function main() {
  console.log('='.repeat(60));
  console.log('财新周刊 Clippings 导入 InfoHub');
  console.log(`文件夹: ${FOLDER}`);
  console.log(`Source ID: ${CAIXIN_SOURCE_ID}`);
  console.log('='.repeat(60));

  // 1. 扫描目录中的已处理文件
  const files = readdirSync(FOLDER)
    .filter(f => f.endsWith('.md'))
    .filter(f => /^财新\d{4}｜/.test(f))
    .filter(f => !/^财新\d{4}\.md$/.test(f)) // 排除目录笔记
    .map(f => join(FOLDER, f));

  if (files.length === 0) {
    console.log('\n未找到已处理的财新周刊文章（财新XXXX｜标题.md 格式）');
    process.exit(0);
  }

  console.log(`\n找到 ${files.length} 篇已处理文章:`);
  for (const f of files) {
    const name = basename(f);
    const { issue, title } = parseFilename(name);
    console.log(`  - [${issue}] ${title}`);
  }

  // 2. 导入每篇文章
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const filepath of files) {
    const filename = basename(filepath);
    const { issue, title } = parseFilename(filename);

    try {
      const rawContent = readFileSync(filepath, 'utf-8');
      const { body } = parseFrontmatter(rawContent);

      // 生成 content_hash（使用文件路径作为唯一标识）
      const contentHash = createHash('md5').update(filepath).digest('hex');

      // 检查是否已存在
      const [existing] = await sql`SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1`;
      if (existing) {
        console.log(`  ⏭️  跳过（已存在）: ${filename}`);
        skipped++;
        continue;
      }

      // 提取发布时间
      const publishedAt = extractPublishedAt(rawContent) || new Date().toISOString();

      // 分类
      const category = classifyCaixin(title);

      // 清理正文中的图片引用
      const cleanContent = body
        .replace(/!\[(.*?)\]\((.*?)\)/g, (_, alt, url) => `![${alt}](${url})`);

      // 提取作者
      let author: string | null = null;
      const authorMatch = rawContent.match(/\*\*\s*文｜([^*]+)\*\*/);
      if (authorMatch) author = authorMatch[1]!.trim();

      // 插入数据库
      const [inserted] = await sql`
        INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
        VALUES (
          ${CAIXIN_SOURCE_ID},
          ${title},
          ${cleanContent},
          ${cleanContent.slice(0, 200)},
          ${''},
          ${publishedAt},
          ${category},
          ${sql.array(['财新周刊', `财新${issue || ''}`])},
          ${contentHash},
          NOW(),
          ${author}
        )
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;

      if (inserted) {
        console.log(`  ✅ 导入: ${filename} (id=${inserted.id}, category=${category})`);
        imported++;
      } else {
        console.log(`  ⏭️  跳过（content_hash 冲突）: ${filename}`);
        skipped++;
      }
    } catch (e: any) {
      console.error(`  ❌ 错误 [${filename}]: ${e.message}`);
      errors++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`导入完成: ${imported} 篇导入, ${skipped} 篇跳过, ${errors} 个错误`);
  console.log('='.repeat(60));

  await sql.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
