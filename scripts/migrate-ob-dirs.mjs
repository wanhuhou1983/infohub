/**
 * OB 目录迁移脚本
 *
 * 将旧目录结构中的文件迁移到按源名/UP主名细分的目录：
 * - 哔哩哩哔/ 根目录（watch-later/favorites/updates）→ 对应子目录
 * - 哔哩哩哔/更新/（flat）→ 哔哩哩哔/更新/{UP主名}/
 * - RSS订阅/（flat）→ RSS订阅/{源名}/
 *
 * 同时更新 index.json 中的文件路径。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OB_DIR = '/Users/wuhuahui/Documents/infohub';
const DATA_DIR = '/Users/wuhuahui/WorkBuddy/20260422122342/infohub/data';
const INDEX_PATH = join(DATA_DIR, 'index.json');

// ============ 工具函数 ============

function sanitizeDirName(name) {
  if (!name) return '未分类';
  return String(name).replace(/[\/\\:*?"<>|\n\r]/g, '').trim() || '未分类';
}

function parseFrontmatter(content) {
  const result = {};
  if (!content.startsWith('---')) return result;
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return result;

  const fmText = content.slice(3, endIdx).trim();
  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    if (!val) continue;

    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        val = JSON.parse(val.replace(/'/g, '"'));
      } catch {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      }
    } else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^\d+$/.test(val)) val = Number(val);
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);

    result[key] = val;
  }
  return result;
}

/**
 * 根据 source_type 和 frontmatter 确定目标子目录
 * 与 ob-writer.ts 中的 getObSubdir() 逻辑一致
 */
function getTargetSubdir(fm) {
  const st = fm.source_type || '';
  switch (st) {
    case 'bilibili-updates': {
      const name = sanitizeDirName(fm.source);
      return join('哔哩哩哔', '更新', name);
    }
    case 'bilibili-watch-later': {
      const name = fm.author ? sanitizeDirName(fm.author) : '未分类';
      return join('哔哩哩哔', '稍后再看', name);
    }
    case 'bilibili-favorites': {
      const name = fm.author ? sanitizeDirName(fm.author) : '未分类';
      return join('哔哩哩哔', '收藏', name);
    }
    case 'rss': {
      const name = sanitizeDirName(fm.source);
      return join('RSS订阅', name);
    }
    case 'twitter-updates': {
      const name = sanitizeDirName(fm.source);
      return join('twitter-updates', name);
    }
    default:
      return null; // 不处理
  }
}

/**
 * 判断文件是否已经在正确位置
 */
function isAlreadyCorrect(fullPath, targetSubdir) {
  const expectedDir = join(OB_DIR, targetSubdir);
  return fullPath.startsWith(expectedDir + '/');
}

// ============ 主流程 ============

// 加载 index.json
let index = {};
try {
  index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  console.log(`📖 已加载 index.json，共 ${Object.keys(index).length} 条索引`);
} catch {
  console.log('⚠️  未找到 index.json，将创建新的');
}

const stats = { success: 0, skipped: 0, alreadyCorrect: 0, error: 0 };
const errors = [];

/**
 * 处理一个目录中的所有 .md 文件
 */
function processDirectory(dirPath, label) {
  if (!existsSync(dirPath)) {
    console.log(`  [${label}] ❌ 目录不存在: ${dirPath}`);
    return;
  }

  const items = readdirSync(dirPath);

  for (const item of items) {
    const fullPath = join(dirPath, item);
    
    // 跳过子目录
    if (!item.endsWith('.md')) continue;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      const fm = parseFrontmatter(content);

      if (!fm.source_type) {
        console.log(`  ⏭️  [${label}] 跳过（无 source_type）: ${item}`);
        stats.skipped++;
        continue;
      }

      const targetSubdir = getTargetSubdir(fm);
      if (!targetSubdir) {
        console.log(`  ⏭️  [${label}] 跳过（source_type=${fm.source_type}）: ${item}`);
        stats.skipped++;
        continue;
      }

      // 检查是否已在正确位置
      if (isAlreadyCorrect(fullPath, targetSubdir)) {
        stats.alreadyCorrect++;
        continue;
      }

      const targetDir = join(OB_DIR, targetSubdir);
      const targetPath = join(targetDir, item);

      // 创建目标目录并移动文件
      mkdirSync(targetDir, { recursive: true });
      renameSync(fullPath, targetPath);

      // 更新索引
      if (fm.id != null) {
        index[String(fm.id)] = targetPath;
      }

      stats.success++;
      console.log(`  ✅ [${label}] ${item} → ${targetSubdir}/`);
    } catch (e) {
      stats.error++;
      errors.push(`[${label}] ${item}: ${e.message}`);
      console.error(`  ❌ [${label}] ${item}: ${e.message}`);
    }
  }
}

// ============ 执行迁移 ============

// 1. 哔哩哩哔/ 根目录（混合）
console.log('\n📦【1/3】哔哩哩哔/ 根目录 → 子目录...');
processDirectory(join(OB_DIR, '哔哩哩哔'), '哔哩哩哔根');

// 2. 哔哩哩哔/更新/（flat → 按 UP 主细分）
console.log('\n📦【2/3】哔哩哩哔/更新/ → 按 UP 主细分...');
processDirectory(join(OB_DIR, '哔哩哩哔', '更新'), '哔哩哩哔/更新');

// 3. RSS订阅/（flat → 按源名细分）
console.log('\n📦【3/4】RSS订阅/ → 按源名细分...');
processDirectory(join(OB_DIR, 'RSS订阅'), 'RSS订阅');

// 4. twitter-updates/（flat → 按账号名细分）
console.log('\n📦【4/4】twitter-updates/ → 按账号名细分...');
processDirectory(join(OB_DIR, 'twitter-updates'), 'twitter-updates');

// 5. 持久化 index.json
console.log('\n📝 更新 index.json...');
const tempIndex = `${INDEX_PATH}.tmp`;
writeFileSync(tempIndex, JSON.stringify(index, null, 2), 'utf-8');
renameSync(tempIndex, INDEX_PATH);
console.log(`📖 index.json 已更新，共 ${Object.keys(index).length} 条`);

// ============ 报告 ============

console.log('\n' + '='.repeat(50));
console.log('迁移完成');
console.log('='.repeat(50));
console.log(`✅  已迁移: ${stats.success}`);
console.log(`📌 已在正确位置: ${stats.alreadyCorrect}`);
console.log(`⏭️  跳过: ${stats.skipped}`);
console.log(`❌  错误: ${stats.error}`);
if (errors.length > 0) {
  console.log('\n错误详情:');
  errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
}
