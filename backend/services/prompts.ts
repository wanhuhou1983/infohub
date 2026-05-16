/**
 * 提示词服务模块 - 提示词管理与同步
 * 
 * 提示词来源：
 * - OB 文件（`{OB_DIR}/AI提示词/`）用于展示和编辑
 * - PG ai_prompts 表是真实存储，通过 sync 从 OB 同步
 * 
 * 查询优先级：
 * - 先查 source_name 特定的提示词（如 "The Economist"）
 * - 未找到或为空 → 使用 "通用" 提示词
 */

import type { Sql } from 'postgres';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/** 提示词类型 */
export type PromptType = 'analyze' | 'translate';

/** 提示词记录 */
export interface PromptRecord {
  id: number;
  source_name: string;
  source_type: string;
  prompt_type: string;
  prompt_text: string | null;
  updated_at: string;
}

/**
 * 获取适用于某文章的提示词
 * 
 * 查找优先级：
 * 1. 按 source_name + prompt_type 查找特定的提示词
 * 2. 如果为空或不存在，回退到通用提示词（source_name='通用'）
 * 
 * @param sql       postgres.js 实例
 * @param sourceName 文章来源名称（如 "The Economist", "小道消息"）
 * @param sourceType 文章来源类型（如 "wechat", "magazine"）
 * @param promptType 提示词类型（"analyze" | "translate"）
 * @returns 提示词文本
 */
export async function getPrompt(
  sql: Sql,
  sourceName: string,
  sourceType: string,
  promptType: PromptType,
): Promise<string> {
  // 1. 尝试查特定 source_name 的提示词
  const [specificPrompt] = await sql<PromptRecord[]>`
    SELECT * FROM ai_prompts
    WHERE source_name = ${sourceName} AND prompt_type = ${promptType}
    LIMIT 1
  `;

  if (specificPrompt && specificPrompt.prompt_text && specificPrompt.prompt_text.trim()) {
    return specificPrompt.prompt_text;
  }

  // 2. 回退到通用提示词
  const [genericPrompt] = await sql<PromptRecord[]>`
    SELECT * FROM ai_prompts
    WHERE source_name = '通用' AND prompt_type = ${promptType}
    LIMIT 1
  `;

  return genericPrompt?.prompt_text || getDefaultPrompt(promptType);
}

/**
 * 获取所有提示词（供前端管理页面使用）
 */
export async function getAllPrompts(sql: Sql): Promise<PromptRecord[]> {
  return sql<PromptRecord[]>`
    SELECT * FROM ai_prompts ORDER BY prompt_type, source_name
  `;
}

/**
 * 更新特定提示词
 */
export async function upsertPrompt(
  sql: Sql,
  sourceName: string,
  sourceType: string,
  promptType: PromptType,
  promptText: string,
): Promise<void> {
  await sql`
    INSERT INTO ai_prompts (source_name, source_type, prompt_type, prompt_text, updated_at)
    VALUES (${sourceName}, ${sourceType}, ${promptType}, ${promptText}, NOW())
    ON CONFLICT (source_name, prompt_type)
    DO UPDATE SET prompt_text = ${promptText}, source_type = ${sourceType}, updated_at = NOW()
  `;
}

/**
 * 从 OB 目录同步提示词到 PG
 * 
 * 读取路径：{OB_DIR}/AI提示词/
 *   ├── 通用提示词.md         → prompt_type=analyze, source_name='通用'
 *   ├── 报刊杂志/
 *   │   └── {source_name}.md → prompt_type=analyze, source_name={source_name}
 *   └── 微信公众号/
 *       └── {source_name}.md → prompt_type=analyze, source_name={source_name}
 */
export async function syncPromptsFromOB(
  sql: Sql,
  obDir: string,
): Promise<{ synced: number; errors: string[] }> {
  const promptBase = join(obDir, 'AI提示词');
  const errors: string[] = [];
  let synced = 0;

  // 确保目录存在
  if (!existsSync(promptBase)) {
    await mkdir(promptBase, { recursive: true });
    return { synced, errors };
  }

  // 1. 读取通用提示词
  const genericPath = join(promptBase, '通用提示词.md');
  if (existsSync(genericPath)) {
    try {
      const text = await readFile(genericPath, 'utf-8');
      const promptText = extractPromptFromMd(text);
      if (promptText) {
        await upsertPrompt(sql, '通用', '', 'analyze', promptText);
        synced++;
      }
      // 也读取翻译提示词（通用提示词包含翻译部分或单独内容）
      // 如果通用提示词文件中有 "## 翻译" 章节，则也更新翻译提示词
      const translateText = extractTranslationPrompt(text);
      if (translateText) {
        await upsertPrompt(sql, '通用', '', 'translate', translateText);
        synced++;
      }
    } catch (e: any) {
      errors.push(`通用提示词: ${e.message}`);
    }
  }

  // 2. 读取报刊杂志提示词
  const magazineDir = join(promptBase, '报刊杂志');
  if (existsSync(magazineDir)) {
    try {
      const files = await readdir(magazineDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const sourceName = file.replace(/\.md$/, '');
        const filePath = join(magazineDir, file);
        try {
          const text = await readFile(filePath, 'utf-8');
          const promptText = extractPromptFromMd(text);
          if (promptText) {
            await upsertPrompt(sql, sourceName, 'magazine', 'analyze', promptText);
            synced++;
          }
        } catch (e: any) {
          errors.push(`报刊杂志/${file}: ${e.message}`);
        }
      }
    } catch (e: any) {
      errors.push(`报刊杂志目录读取失败: ${e.message}`);
    }
  }

  // 3. 读取微信公众号提示词
  const wechatDir = join(promptBase, '微信公众号');
  if (existsSync(wechatDir)) {
    try {
      const files = await readdir(wechatDir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const sourceName = file.replace(/\.md$/, '');
        const filePath = join(wechatDir, file);
        try {
          const text = await readFile(filePath, 'utf-8');
          const promptText = extractPromptFromMd(text);
          if (promptText) {
            await upsertPrompt(sql, sourceName, 'wechat', 'analyze', promptText);
            synced++;
          }
        } catch (e: any) {
          errors.push(`微信公众号/${file}: ${e.message}`);
        }
      }
    } catch (e: any) {
      errors.push(`微信公众号目录读取失败: ${e.message}`);
    }
  }

  return { synced, errors };
}

// ============ 辅助函数 ============

/**
 * 从 Markdown 文件中提取提示词正文（去掉 frontmatter）
 */
function extractPromptFromMd(content: string): string {
  let text = content.trim();
  // 去掉 frontmatter（--- 开头的内容）
  if (text.startsWith('---')) {
    const endIdx = text.indexOf('---', 3);
    if (endIdx !== -1) {
      text = text.slice(endIdx + 3).trim();
    }
  }
  // 去掉 # 开头的标题行
  text = text.replace(/^#\s+.*$/m, '').trim();
  return text || '';
}

/**
 * 从通用提示词文件中提取翻译专用提示词
 * 查找 "## 翻译" 章节后的内容
 */
function extractTranslationPrompt(content: string): string | null {
  const translateSection = content.match(/##\s*翻译\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (translateSection && translateSection[1]?.trim()) {
    return translateSection[1].trim();
  }
  return null;
}

/**
 * 默认提示词（当数据库中也没有时使用）
 */
function getDefaultPrompt(type: PromptType): string {
  if (type === 'analyze') {
    return '请分析以下文章，生成简洁的中文摘要（200字以内），包括核心观点、关键信息和潜在影响。';
  }
  return '请将以下英文内容翻译成中文，保持原文的格式和语气。如果本身是中文，直接返回原文。';
}

/**
 * 获取 OB 提示词基准目录（{OB_DIR}/AI提示词/）
 */
export function getPromptsBaseDir(obDir: string): string {
  return join(obDir, 'AI提示词');
}
