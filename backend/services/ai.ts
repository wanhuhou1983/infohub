/**
 * AI 服务模块 - DeepSeek API 封装
 * 
 * 提供：
 * - callDeepSeek()          → 通用 DeepSeek API 调用
 * - analyzeArticle()        → AI 文章解读，结果存入 extra.ai_analysis + summary
 * - translateArticle()      → AI 文章翻译，结果存入 extra.ai_translation
 */

import type { Sql } from 'postgres';

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

/**
 * 调用 DeepSeek Chat API
 */
export async function callDeepSeek(
  systemPrompt: string,
  userContent: string,
  maxTokens = 2000,
): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY 未配置');
  }

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek API 错误 (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as any;
  const result = data.choices?.[0]?.message?.content || '';
  return result.trim();
}

/**
 * 对文章进行 AI 解读
 * 结果存入 articles 表的 extra.ai_analysis 和 summary 字段
 * 
 * @returns AI 生成的解读文本
 */
export async function analyzeArticle(
  sql: Sql,
  articleId: number,
  promptText: string,
  articleContent: string,
): Promise<string> {
  // 截取文章正文前 4000 字符（控制 token 消耗）
  const content = (articleContent || '').slice(0, 4000);

  const analysis = await callDeepSeek(promptText, content);

  // 更新数据库：extra.ai_analysis + summary
  await sql`
    UPDATE articles SET
      extra = jsonb_set(COALESCE(extra, '{}'), '{ai_analysis}', ${sql.json(analysis)}),
      summary = ${analysis.slice(0, 500)}
    WHERE id = ${articleId}
  `;

  return analysis;
}

/**
 * 对文章进行 AI 翻译
 * 结果存入 articles 表的 extra.ai_translation
 * 
 * @returns AI 生成的翻译文本
 */
export async function translateArticle(
  sql: Sql,
  articleId: number,
  promptText: string,
  articleContent: string,
): Promise<string> {
  // 截取文章正文前 6000 字符（翻译需要稍微多一些上下文）
  const content = (articleContent || '').slice(0, 6000);

  const translation = await callDeepSeek(promptText, content, 3000);

  // 更新数据库：extra.ai_translation
  await sql`
    UPDATE articles SET
      extra = jsonb_set(COALESCE(extra, '{}'), '{ai_translation}', ${sql.json(translation)})
    WHERE id = ${articleId}
  `;

  return translation;
}
