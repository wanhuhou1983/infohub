/**
 * 经济学人批量翻译脚本 - 百度翻译版
 * 翻译 source_id=1536 的英文文章
 * 运行: cd infohub/backend && bun run transcribe-economist.ts
 */

import { readFileSync, existsSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';

// ============ 百度翻译 API ============
interface BaiduConfig {
  appid: string;
  secretKey: string;
}

function loadBaiduConfig(): BaiduConfig | null {
  const path = '/Users/wuhuahui/.workbuddy/keys/baidu_translate.json';
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BaiduConfig;
  } catch { return null; }
}

async function baiduTranslate(text: string, config: BaiduConfig): Promise<string | null> {
  const salt = randomBytes(6).toString('hex');
  const signStr = config.appid + text.slice(0, 5000) + salt + config.secretKey;
  const sign = createHash('md5').update(signStr).digest('hex');

  const params = new URLSearchParams({
    q: text.slice(0, 5000),
    from: 'en',
    to: 'zh',
    appid: config.appid,
    salt,
    sign,
  });

  try {
    const resp = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    if (data.error_code) {
      console.error(`  [百度错误] ${data.error_code}: ${data.error_msg}`);
      return null;
    }
    return data.trans_result?.map((t: any) => t.dst).join('');
  } catch {
    return null;
  }
}

async function translateWithRetry(text: string, config: BaiduConfig, maxRetries = 3): Promise<string | null> {
  for (let i = 0; i <= maxRetries; i++) {
    const r = await baiduTranslate(text, config);
    if (r) return r;
    if (i < maxRetries) {
      const wait = 500 * Math.pow(2, i);
      await new Promise(res => setTimeout(res, wait));
    }
  }
  return null;
}

/**
 * 分段翻译正文（百度每段限制 5000 字）
 */
async function translateContent(text: string, config: BaiduConfig): Promise<string> {
  if (!text || text.length < 20) return text;
  const maxChunk = 4000;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChunk));
    remaining = remaining.slice(maxChunk);
  }
  const results: string[] = [];
  for (const c of chunks) {
    const tr = await translateWithRetry(c, config);
    results.push(tr || c);
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 400));
  }
  return results.join('');
}

function isEnglish(text: string): boolean {
  if (!text) return false;
  const ascii = text.replace(/[^\x00-\x7F]/g, '');
  return ascii.length / text.length > 0.5;
}

// ============ 数据库 ============
import postgres from 'postgres';

async function main() {
  const sql = postgres({
    host: 'localhost', port: 5433,
    database: 'infohub', username: 'infohub', password: 'infohub123', max: 3,
  });

  const config = loadBaiduConfig();
  if (!config) {
    console.error('❌ 百度翻译未配置: ~/.workbuddy/keys/baidu_translate.json');
    process.exit(1);
  }
  console.log('✅ 百度翻译配置就绪');

  // 只取未翻译的（标题不含【中文翻译】标记的）
  const articles = await sql`
    SELECT id, title, content
    FROM articles
    WHERE source_id = 1536
      AND content NOT LIKE '%【中文翻译】%'
    ORDER BY id
  `;

  console.log(`\n📰 待翻译：${articles.length} 篇\n`);

  let translated = 0, skipped = 0, errors = 0;

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    if (!art) continue;
    process.stdout.write(`[${i + 1}/${articles.length}] ${art.title.slice(0, 45)}... `);

    const needTitle = isEnglish(art.title);
    const needContent = isEnglish(art.content);
    if (!needTitle && !needContent) { console.log('⏭️'); skipped++; continue; }

    try {
      let newTitle = art.title, newContent = art.content;

      if (needTitle) {
        const t = await translateWithRetry(art.title, config);
        if (t) newTitle = `${t} [${art.title}]`;
      }

      if (needContent) {
        const tc = await translateContent(art.content, config);
        if (tc !== art.content) {
          newContent = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${art.content}`;
        }
      }

      await sql`UPDATE articles SET title = ${newTitle}, content = ${newContent} WHERE id = ${art.id}`;
      console.log('✅');
      translated++;
    } catch (e: any) {
      console.error(`❌ ${e.message}`);
      errors++;
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n\n🎉 完成！翻译 ${translated} | 跳过 ${skipped} | 错误 ${errors}`);
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
