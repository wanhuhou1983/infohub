/**
 * AI 路由 - 文章解读 & 翻译 & 字幕解读 & 提示词管理
 *
 * API：
 *   POST /api/ai/analyze           → AI 解读文章
 *   POST /api/ai/translate         → AI 翻译文章（经济学人）
 *   POST /api/ai/analyze-subtitle  → AI 解读视频字幕
 *   GET  /api/ai/prompts           → 获取所有提示词
 *   PUT  /api/ai/prompts           → 更新特定提示词（需管理员）
 *   POST /api/ai/prompts/sync      → 从 OB 同步提示词到 PG（需管理员）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { analyzeArticle, translateArticle, callDeepSeek } from '../services/ai.js';
import { getPrompt, getAllPrompts, upsertPrompt, syncPromptsFromOB, getPromptsBaseDir } from '../services/prompts.js';
import { getObDir, saveArticleFile } from '../file-storage.js';

export function createAiRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ AI 处理完成后更新 OB 文件 ============

  async function updateObAfterAi(articleId: number): Promise<void> {
    try {
      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return;

      await saveArticleFile(articleId, article.content || '', {
        id: articleId,
        title: article.title,
        source_type: article.source_type || 'unknown',
        source_name: article.source_name || '',
        url: article.url,
        published_at: article.published_at,
        category: article.category,
        tags: article.tags || [],
        author: article.author,
        is_read: article.is_read,
        is_starred: article.is_starred,
        content_hash: article.content_hash,
        extra: article.extra,
      });
    } catch (e: any) {
      console.error(`[AI] OB 更新失败 [id=${articleId}]:`, e.message);
    }
  }

  // ============ AI 解读 ============

  router.post('/analyze', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      // 1. 获取文章
      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 2. 获取提示词
      const promptText = await getPrompt(sql, article.source_name || '', article.source_type || '', 'analyze');

      // 3. 调用 AI 分析
      // 判断正文是否足够：用 content（优先）或 summary 或 title
      const articleContent = (article.content && article.content.length > 100)
        ? article.content
        : (article.title || '');

      const analysis = await analyzeArticle(sql, articleId, promptText, articleContent);

      // 更新 OB 文件中的衍生区块
      await updateObAfterAi(articleId);

      return c.json({ ok: true, analysis });
    } catch (e: any) {
      console.error('[AI分析] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ AI 翻译 ============

  router.post('/translate', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      // 1. 获取文章
      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 2. 获取翻译提示词
      const promptText = await getPrompt(sql, article.source_name || '', article.source_type || '', 'translate');

      // 3. 翻译
      const articleContent = (article.content && article.content.length > 100)
        ? article.content
        : (article.title || '');

      const translation = await translateArticle(sql, articleId, promptText, articleContent);

      // 更新 OB 文件中的衍生区块
      await updateObAfterAi(articleId);

      return c.json({ ok: true, translation });
    } catch (e: any) {
      console.error('[AI翻译] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ AI 字幕解读 ============

  router.post('/analyze-subtitle', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      if (isNaN(articleId) || articleId <= 0) {
        return c.json({ error: '无效的 article_id' }, 400);
      }

      // 1. 获取文章
      const [article] = await sql`
        SELECT a.*, s.name AS source_name, s.type AS source_type
        FROM articles a LEFT JOIN sources s ON a.source_id = s.id
        WHERE a.id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 2. 检查是否有字幕
      const extra = article.extra || {};
      const subtitle = extra.subtitle;
      if (!subtitle || subtitle.trim().length < 10) {
        return c.json({ error: '该文章没有字幕，请先下载字幕' }, 400);
      }

      // 3. 检查是否已有缓存
      if (extra.subtitle_analysis) {
        return c.json({ ok: true, analysis: extra.subtitle_analysis, cached: true });
      }

      // 4. 获取提示词（优先用 B站 专用的，回退到默认）
      const promptText = await (async () => {
        try {
          const p = await getPrompt(sql, article.source_name || '', article.source_type || '', 'analyze');
          if (p) return p;
        } catch { /* fallback */ }
        return '你是一位视频内容分析师。请根据以下视频字幕内容，用中文总结本期视频的要点，包括：\n' +
          '1. 本期主题和核心观点（一句话概括）\n' +
          '2. 关键内容要点（分点列出，每点一两句话）\n' +
          '3. 重要结论或观点\n\n' +
          '请用简洁、有条理的语言输出，控制在 500 字以内。';
      })();

      // 5. 截取字幕前 8000 字符分析
      const subtitleContent = subtitle.trim().slice(0, 8000);

      // 6. 调用 AI
      const analysis = await callDeepSeek(promptText, subtitleContent, 3000);

      // 7. 存入数据库缓存
      await sql`
        UPDATE articles SET
          extra = jsonb_set(COALESCE(extra, '{}'), '{subtitle_analysis}', ${sql.json(analysis)})
        WHERE id = ${articleId}
      `;

      // 更新 OB 文件中的衍生区块
      await updateObAfterAi(articleId);

      return c.json({ ok: true, analysis, cached: false });
    } catch (e: any) {
      console.error('[AI字幕分析] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 章节级 AI 解读 ============

  router.post('/analyze-section', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const articleId = Number(body.article_id);
      const sectionIndex = Number(body.section_index);
      if (isNaN(articleId) || articleId <= 0 || isNaN(sectionIndex) || sectionIndex < 0) {
        return c.json({ error: '无效的参数' }, 400);
      }
      const sectionHeading = String(body.section_heading || '').trim();
      let sectionText = String(body.section_text || '').trim();

      if (!sectionHeading || !sectionText) {
        return c.json({ error: '章节标题或内容为空' }, 400);
      }

      // 1. 获取文章
      const [article] = await sql`
        SELECT id, extra FROM articles WHERE id = ${articleId}
      `;
      if (!article) return c.json({ error: '文章不存在' }, 404);

      // 2. 检查缓存
      const extra = article.extra || {};
      const sectionAnalysis: Array<{ heading: string; analysis: string }> = extra.section_analysis || [];
      if (sectionAnalysis[sectionIndex]?.analysis) {
        return c.json({ ok: true, analysis: sectionAnalysis[sectionIndex].analysis, cached: true });
      }

      // 3. 截取章节内容（控制 token 消耗）
      sectionText = sectionText.slice(0, 3000);

      // 4. 调用 AI
      const systemPrompt = '你是一位资深编辑。请分析以下文章片段的核心观点和关键信息，用 200 字以内概括。';
      const analysis = await callDeepSeek(systemPrompt, sectionText, 1000);

      // 5. 存入缓存
      sectionAnalysis[sectionIndex] = { heading: sectionHeading, analysis };
      await sql`
        UPDATE articles SET
          extra = jsonb_set(COALESCE(extra, '{}'), '{section_analysis}', ${sql.json(sectionAnalysis)})
        WHERE id = ${articleId}
      `;

      return c.json({ ok: true, analysis, cached: false });
    } catch (e: any) {
      console.error('[章节分析] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 提示词管理 ============

  // 获取所有提示词
  router.get('/prompts', async (c) => {
    try {
      const prompts = await getAllPrompts(sql);
      return c.json(prompts);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 更新特定提示词
  router.put('/prompts', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { source_name, source_type, prompt_type, prompt_text } = body;

      if (!source_name || !prompt_type) {
        return c.json({ error: '缺少 source_name 或 prompt_type' }, 400);
      }
      if (!['analyze', 'translate'].includes(prompt_type)) {
        return c.json({ error: 'prompt_type 必须为 analyze 或 translate' }, 400);
      }

      await upsertPrompt(sql, source_name, source_type || '', prompt_type, prompt_text || '');

      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 从 OB 同步提示词到 PG
  router.post('/prompts/sync', async (c) => {
    try {
      const obDir = getObDir();
      const result = await syncPromptsFromOB(sql, obDir);
      return c.json({ ok: true, ...result });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 批量标题翻译 ============

  router.post('/translate-titles', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const titles: string[] = body.titles || [];
      if (!Array.isArray(titles) || titles.length === 0) {
        return c.json({ translations: {} });
      }

      // 仅翻译非空的英文标题
      const englishTitles = titles.filter(t => t && t.length >= 5 && !/[\u4e00-\u9fff]/.test(t));
      if (englishTitles.length === 0) {
        const empty: Record<string, string> = {};
        titles.forEach(t => { empty[t] = t; });
        return c.json({ translations: empty });
      }

      // 用 DeepSeek 批量翻译（一次性请求，节省 token）
      const systemPrompt = '你是一位专业翻译。将用户提供的每行英文翻译成简洁准确的中文。请按顺序逐行输出中文翻译，每行对应一个，不要加编号、引号或额外文字。如果遇到专有名词保持原样。';
      const userContent = englishTitles.join('\n');

      const result = await callDeepSeek(systemPrompt, userContent, 4000);

      // 解析返回结果
      const lines = result.split('\n').filter((l: string) => l.trim());
      const translations: Record<string, string> = {};
      englishTitles.forEach((title, i) => {
        translations[title] = lines[i]?.trim() || title;
      });

      // 非英文标题直接返回原文
      titles.forEach(t => {
        if (!translations[t]) translations[t] = t;
      });

      return c.json({ translations });
    } catch (e: any) {
      console.error('[标题翻译] 错误:', e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
