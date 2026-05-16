#!/usr/bin/env node
/**
 * OB 孤儿文件清理脚本
 *
 * 扫描 OB 仓库目录，删除 PG 中不存在的孤儿 .md 文件。
 * 1. 从 PG 导出所有 content_hash
 * 2. 扫描 OB .md 文件，读取 frontmatter 的 content_hash
 * 3. 如果 content_hash 不在 PG 集合中 → 删除（孤儿文件）
 * 4. 同时删除文件名含 " 2." 的重复文件
 *
 * 用法：node clean-orphan-ob-files.mjs
 */

import { readFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const OB_DIR = '/Users/wuhuahui/Documents/infohub';

const TYPE_TO_DIRNAME = { 'xwlb': '新闻联播', 'rmrb': '人民日报', 'magazine': '喷嚏图卦', 'tencent': '腾讯新闻' };
const DIRNAME_TO_TYPE = { '新闻联播': 'xwlb', '人民日报': 'rmrb', '喷嚏图卦': 'magazine', '腾讯新闻': 'tencent' };
const DIR_MAP = {
  'xwlb': '报刊杂志/新闻联播',
  'rmrb': '报刊杂志/人民日报',
  'magazine': '报刊杂志/喷嚏图卦',
  'tencent': '报刊杂志/腾讯新闻',
};

const CLEAN_DIRS = [
  ...Object.values(DIR_MAP),
  '哔哩哩哔',
];

// ─── PG 查询助手 ─────────────────────────────────────────
async function queryPG(sql) {
  const { execSync } = await import('child_process');
  const cmd = `docker exec -i infohub-db psql -U infohub -t -A -c "${sql.replace(/"/g, '\\"')}"`;
  const out = execSync(cmd, { encoding: 'utf-8' }).trim();
  return out.split('\n').filter(Boolean);
}

async function getPgHashes() {
  const rows = await queryPG("SELECT content_hash FROM articles");
  return new Set(rows);
}

async function getPgCounts() {
  const rows = await queryPG(
    "SELECT s.type, COUNT(a.id) FROM articles a JOIN sources s ON s.id = a.source_id WHERE s.type IN ('xwlb','rmrb','magazine','tencent') OR s.type LIKE 'bilibili%' GROUP BY s.type ORDER BY s.type"
  );
  return rows.map(line => line.split('|'));
}

// ─── OB 扫描 ─────────────────────────────────────────────
function scanObFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanObFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractContentHash(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fm = match[1];
    const hashMatch = fm.match(/content_hash:\s*"?([a-f0-9]+)"?/);
    return hashMatch ? hashMatch[1] : null;
  } catch {
    return null;
  }
}

function printReport(prefix) {
  for (const [type, count] of pgCountsCache) {
    const dirName = TYPE_TO_DIRNAME[type];
    if (!dirName) continue;
    const obDir = join(OB_DIR, DIR_MAP[type]);
    const obCount = existsSync(obDir) ? readdirSync(obDir).filter(f => f.endsWith('.md')).length : 0;
    const ok = String(obCount) === count;
    console.log(`  ${prefix}${dirName}: PG=${count}, OB=${obCount} ${ok ? '✅' : '❌'}`);
  }
}

let pgCountsCache = [];

// ─── 主逻辑 ─────────────────────────────────────────────
async function main() {
  console.log('[1/4] 获取 PG content_hash 列表...');
  const pgHashes = await getPgHashes();
  console.log(`  → PG 共有 ${pgHashes.size} 篇文章`);

  pgCountsCache = await getPgCounts();

  console.log('[2/4] 扫描 OB 目录中的 .md 文件...');
  const allObFiles = [];
  for (const subDir of CLEAN_DIRS) {
    const fullDir = join(OB_DIR, subDir);
    if (existsSync(fullDir)) {
      const files = scanObFiles(fullDir);
      allObFiles.push(...files.map(f => ({ path: f, dir: subDir })));
      console.log(`  → ${subDir}: ${files.length} 个文件`);
    } else {
      console.log(`  → ${subDir}: 目录不存在`);
    }
  }
  console.log(`  → 总计 ${allObFiles.length} 个 .md 文件`);

  console.log('[3/4] 逐文件匹配 content_hash...');
  let orphanCount = 0;
  let dupCount = 0;
  const orphans = [];
  const dups = [];

  for (const { path } of allObFiles) {
    const filename = path.split('/').pop();

    // 检查是否是 " 2." 重复文件
    if (/ 2\.md$/.test(filename)) {
      dupCount++;
      dups.push(path);
      continue;
    }

    // 提取 content_hash 并匹配
    const hash = extractContentHash(path);
    if (!hash) {
      // 可能是旧格式或无 frontmatter，视为孤儿
      orphanCount++;
      orphans.push(path);
      continue;
    }

    if (!pgHashes.has(hash)) {
      orphanCount++;
      orphans.push(path);
    }
  }

  console.log(`  → 重复文件 ( 2.md): ${dupCount} 个`);
  console.log(`  → 孤儿文件 (无 PG 匹配): ${orphanCount} 个`);

  const allToDelete = [...dups, ...orphans];

  if (allToDelete.length === 0) {
    console.log('\n✅ 没有需要清理的文件，内容如下：');
    printReport('');
    return;
  }

  console.log('\n[4/4] 删除文件...');
  console.log(`共 ${allToDelete.length} 个文件：`);
  for (const f of allToDelete) {
    console.log(`  🔴 ${f}`);
  }

  let deleted = 0;
  for (const f of allToDelete) {
    try {
      unlinkSync(f);
      deleted++;
    } catch (e) {
      console.error(`  ❌ 删除失败: ${f} - ${e.message}`);
    }
  }
  console.log(`\n✅ 已删除 ${deleted}/${allToDelete.length} 个文件`);

  // 清理后状态
  console.log('\n清理后各目录状态：');
  printReport('');
}

main().catch(console.error);
