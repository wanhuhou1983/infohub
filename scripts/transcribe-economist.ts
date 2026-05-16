/**
 * 经济学人批量翻译脚本
 * 用 Azure Translator API 翻译 source_id=1536 的文章
 * 运行方式：cd infohub && node scripts/transcribe-economist.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ============ Azure Translator API ============
interface AzureConfig {
  key: string;
  region: string;
  endpoint: string;
}

function loadAzureConfig(): AzureConfig {
  const envFile = '/Users/wuhuahui/WorkBuddy/20260422122342/infohub/.env.json';
  try {
    const raw = JSON.parse(readFileSync(envFile, 'utf-8'));
    return {
      key: raw.AZURE_TRANSLATE_KEY || '',
      region: raw.AZURE_TRANSLATE_REGION || 'eastasia',
      endpoint: raw.AZURE_TRANSLATE_ENDPOINT || 'https://api.cognitive.microsofttranslator.com/',
    };
  } catch {
    return { key: '', region: 'eastasia', endpoint: 'https://api.cognitive.microsofttranslator.com/' };
  }
}

async function azureTranslate(text: string, from = 'en', to = 'zh', config: AzureConfig): Promise<string | null> {
  if (!config.key) return null;
  try {
    const url = `${config.endpoint}translate?api-version=3.0&from=${from}&to=${to}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': config.key,
        'Ocp-Apim-Subscription-Region': config.region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ text: text.slice(0, 10000) }]),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`  [Azure翻译错误] ${err}`);
      return null;
    }
    const data = await resp.json() as any;
    return data?.[0]?.translations?.[0]?.text ?? null;
  } catch (e: any) {
    console.error(`  [Azure请求失败] ${e.message}`);
    return null;
  }
}

async function translateChunks(text: string, config: AzureConfig, maxChunk = 8000): Promise<string> {
  if (!text || text.length < 20) return text;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxChunk));
    remaining = remaining.slice(maxChunk);
  }
  const results: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const tr = await azureTranslate(chunks[i], 'en', 'zh', config);
    if (tr) {
      results.push(tr);
    } else {
      results.push(chunks[i]);
    }
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 200));
  }
  return results.join('');
}

function isEnglish(text: string): boolean {
  if (!text) return false;
  const ascii = text.replace(/[^\x00-\x7F]/g, '');
  return ascii.length / text.length > 0.5;
}

// ============ 数据库操作 ============
import postgres from 'postgres';

async function main() {
  const sql = postgres({
    host: 'localhost',
    port: 5433,
    database: 'infohub',
    username: 'infohub',
    password: 'infohub123',
    max: 3,
  });

  const azureConfig = loadAzureConfig();
  if (!azureConfig.key) {
    console.error('❌ Azure 未配置，请先在 .env.json 中配置 AZURE_TRANSLATE_KEY');
    process.exit(1);
  }
  console.log(`✅ Azure 配置就绪 (region: ${azureConfig.region})`);

  // 查出所有待翻译的文章
  const articles = await sql`
    SELECT id, title, content
    FROM articles
    WHERE source_id = 1536
    ORDER BY id
  `;

  console.log(`\n📰 待翻译文章：${articles.length} 篇\n`);

  let translated = 0;
  let skipped = 0;
  let errors = 0;

  for (const art of articles) {
    process.stdout.write(`[${articles.indexOf(art) + 1}/${articles.length}] ${art.title.slice(0, 50)}... `);

    const needTranslateTitle = isEnglish(art.title);
    const needTranslateContent = isEnglish(art.content);

    if (!needTranslateTitle && !needTranslateContent) {
      console.log('⏭️  无需翻译');
      skipped++;
      continue;
    }

    try {
      let newTitle = art.title;
      let newContent = art.content;

      if (needTranslateTitle) {
        const t = await translateChunks(art.title, azureConfig, 5000);
        if (t !== art.title) {
          newTitle = `${t} [${art.title}]`;
        }
      }

      if (needTranslateContent) {
        const tc = await translateChunks(art.content, azureConfig, 8000);
        if (tc !== art.content) {
          newContent = `【中文翻译】\n${tc}\n\n---\n【English Original】\n${art.content}`;
        }
      }

      await sql`
        UPDATE articles
        SET title = ${newTitle}, content = ${newContent}, translated_at = NOW()
        WHERE id = ${art.id}
      `;

      console.log('✅');
      translated++;
    } catch (e: any) {
      console.error(`❌ ${e.message}`);
      errors++;
    }

    // 每篇间隔 300ms 避免触发限流
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n\n🎉 完成！`);
  console.log(`   翻译：${translated} 篇`);
  console.log(`   跳过：${skipped} 篇`);
  console.log(`   错误：${errors} 篇`);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
