/**
 * 每日简报（云端 COLLECTOR_MODE 下启用）
 *
 * 定位：对当天云端采集的国内文本资讯（人民日报 / 新闻联播 / 喷嚏图卦 /
 * JTK 公众号·微博·雪球动态）用 LLM 做一次汇总，产出一份 Markdown 简报，
 * 作为一篇 article 写入云端 PG（source=每日简报, type=briefing），
 * 前端文章列表自动可见；同时归档原文 JSON 到 COS。
 *
 * 设计要点：
 * - 调度：每天北京时间 21:50（21:10 那轮已采到新闻联播，留 40 分钟缓冲）。
 *   失败自动重试（最多 2 次，间隔 40 分钟）。
 * - 幂等：content_hash = hash('briefing:'+日期)，ON CONFLICT DO NOTHING，
 *   重跑不会产生重复简报。
 * - fetched_at 两地时区混用（本地同步=北京时间、云端写入=UTC），
 *   「当天」查询用双窗口覆盖两种约定，宁可略多不可遗漏。
 * - 不依赖容器 TZ，全部用北京时间偏移计算。
 * - RSS / 播客 / 视频类不参与简报：量大或需本地化处理（翻译/转录），
 *   且 RSS 由本地采集同步而来，时点不齐。
 */
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { hashString } from '../file-storage.js';
import { archiveArticles } from '../storage/cos-archive.js';

// 参与简报的来源类型（均为国内文本，云端权威数据）
const BRIEF_SOURCE_TYPES = ['rmrb', 'xwlb', 'dapenti', 'wechat', 'weibo', 'xueqiu'] as const;
const SOURCE_LABELS: Record<string, string> = {
  rmrb: '人民日报',
  xwlb: '新闻联播',
  dapenti: '喷嚏图卦',
  wechat: '公众号',
  weibo: '微博',
  xueqiu: '雪球动态',
};
// 每组参与汇总的文章上限与单篇正文截断（控制 token 预算）
const MAX_ARTICLES_PER_GROUP = 40;
const CONTENT_SLICE = 1000;

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';

/** 北京时间 YYYY-MM-DD 与 HH:mm，不依赖容器 TZ */
function bjNow(offsetMin = 0) {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetMin * 60_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** 距下一个北京时间 HH:mm 的毫秒数 */
function msUntilNextRun(hour: number, minute: number): number {
  const nowBj = Date.now() + 8 * 3600_000;
  const d = new Date(nowBj);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0, 0);
  let delta = target - nowBj;
  if (delta <= 0) delta += 86_400_000;
  return delta;
}

async function chat(system: string, user: string, maxTokens: number): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error('[briefing] DEEPSEEK_API_KEY 未配置');
    return null;
  }
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        model: process.env.BRIEF_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      console.error(`[briefing] LLM HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as any;
    return (data.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e: any) {
    console.error(`[briefing] LLM 调用失败: ${e.message}`);
    return null;
  }
}

interface DayArticle {
  title: string;
  summary: string | null;
  content: string | null;
  url: string | null;
  author: string | null;
  source_type: string;
  source_name: string | null;
}

/** 取「今天（北京时间）」的文章，双窗口兼容两种时间戳约定 */
async function loadTodayArticles(sql: Sql, dateBj: string): Promise<DayArticle[]> {
  // 北京时间 naive 起点；以及与其对应的 UTC naive 起点（本地同步行存北京时间、
  // 云端自采行存 UTC，两条窗口并起来才不漏）。
  const bjStart = dateBj + ' 00:00:00';
  const utcStart = new Date(new Date(dateBj + 'T00:00:00+08:00').getTime() - 8 * 3600_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const rows = await sql`
    SELECT a.title, a.summary, a.content, a.url, a.author, s.type AS source_type, s.name AS source_name
    FROM articles a LEFT JOIN sources s ON s.id = a.source_id
    WHERE a.fetched_at >= ${bjStart}
       OR (a.fetched_at >= ${utcStart} AND a.fetched_at < ${bjStart})
    ORDER BY a.id DESC
  `;
  // 过滤：只留参与简报的类型 + 去掉无标题噪音
  return (rows as any[])
    .filter(r => (BRIEF_SOURCE_TYPES as readonly string[]).includes(String(r.source_type || '').toLowerCase()))
    .filter(r => r.title && String(r.title).trim());
}

/** 按来源分组逐组小结 */
async function summarizeGroups(groups: Map<string, DayArticle[]>): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const [type, arts] of groups) {
    const label = SOURCE_LABELS[type] || type;
    const picked = arts.slice(0, MAX_ARTICLES_PER_GROUP);
    const body = picked.map((a, i) => {
      const excerpt = String(a.content || a.summary || '').replace(/\s+/g, ' ').slice(0, CONTENT_SLICE);
      return `【${i + 1}】${a.title}\n来源：${a.source_name || label}${a.author ? ' / ' + a.author : ''}\n正文摘录：${excerpt || '（无正文）'}`;
    }).join('\n\n');
    const out = await chat(
      `你是资讯编辑。下面是「${label}」今天的文章列表（标题 + 正文摘录）。` +
      `请输出该来源的今日要点小结：用 Markdown 无序列表，每条 1-2 句，按重要性排序；` +
      `保留具体的人名、数字、政策名称等关键事实；不要评论、不要总结性套话；最多 ${Math.min(picked.length, 15)} 条。`,
      body.slice(0, 60_000),
      4096,
    );
    if (out) results.set(type, out);
  }
  return results;
}

/** 合并各组小结为一份完整简报 */
async function composeBriefing(dateBj: string, groupSummaries: Map<string, string>): Promise<string | null> {
  const parts = [...groupSummaries.entries()].map(([type, text]) => `## ${SOURCE_LABELS[type] || type}\n\n${text}`);
  const merged = await chat(
    '你是资讯简报主编。请把各来源的要点小结合并成一份「每日简报」Markdown，结构：\n' +
    '# 每日简报 {YYYY-MM-DD}（日期用我给的）\n' +
    '## 今日要点\n（跨来源提炼 5-8 条，最重要的放前面，一句话一条）\n' +
    '## 分来源详情\n（保留各来源小节，可精简合并重复内容）\n' +
    '## 值得深读\n（挑 3-5 条最值得细看的话题，说明为什么）\n' +
    '要求：事实准确，保留关键数字与人名；语言精炼；不要虚构未提供的信息。',
    `日期：${dateBj}\n\n${parts.join('\n\n')}`.slice(0, 60_000),
    8192,
  );
  return merged;
}

/**
 * 生成当日简报并入库。sql 缺省时自建连接（供 docker exec 手动触发用）。
 */
export async function runDailyBriefing(sql?: Sql, dateBjOverride?: string): Promise<{
  ok: boolean; date: string; groups: number; articles: number; inserted: boolean; error?: string;
}> {
  const ownSql = sql || postgres(process.env.DATABASE_URL!);
  const dateBj = dateBjOverride || bjNow().date;
  let result = { ok: false, date: dateBj, groups: 0, articles: 0, inserted: false, error: undefined as string | undefined };
  try {
    const articles = await loadTodayArticles(ownSql, dateBj);
    result.articles = articles.length;
    if (articles.length === 0) {
      result.error = '今日无参与简报的文章';
      return result;
    }

    const groups = new Map<string, DayArticle[]>();
    for (const a of articles) {
      const t = String(a.source_type || '').toLowerCase();
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t)!.push(a);
    }
    result.groups = groups.size;

    const groupSummaries = await summarizeGroups(groups);
    if (groupSummaries.size === 0) {
      result.error = '所有来源的 LLM 小结均失败';
      return result;
    }

    let md = await composeBriefing(dateBj, groupSummaries);
    if (!md) {
      // 合并失败时降级：直接拼分组小结
      console.warn('[briefing] 合并调用失败，降级为分组小结拼接');
      md = `# 每日简报 ${dateBj}\n\n` +
        [...groupSummaries.entries()].map(([t, s]) => `## ${SOURCE_LABELS[t] || t}\n\n${s}`).join('\n\n');
    }

    // 确保简报 source 存在
    let sourceId: number | undefined;
    const srcRows = await ownSql`SELECT id FROM sources WHERE name = ${'每日简报'} LIMIT 1`;
    if (srcRows.length > 0) {
      sourceId = Number((srcRows[0] as any).id);
    } else {
      const ins = await ownSql`
        INSERT INTO sources (name, type, enabled, config)
        VALUES (${'每日简报'}, ${'briefing'}, true, ${'{}'}::jsonb)
        RETURNING id`;
      sourceId = Number((ins[0] as any).id);
    }

    const title = `每日简报 ${dateBj}`;
    const contentHash = hashString('briefing:' + dateBj);
    const insertedRows = await ownSql`
      INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author, extra)
      VALUES (${sourceId}, ${title}, ${md}, ${md.slice(0, 300)}, ${''}, ${dateBj}, ${'简报'},
              ${['每日简报', dateBj]}, ${contentHash}, NOW(), ${'DeepSeek'}, ${'{}'}::jsonb)
      ON CONFLICT (content_hash) DO NOTHING
      RETURNING id`;
    result.inserted = insertedRows.length > 0;
    result.ok = true;

    // 简报原文归档 COS（独立于采集轮的归档水位）
    try {
      await archiveArticles([{
        source_id: sourceId,
        source_name: '每日简报',
        source_type: 'briefing',
        title, content: md, summary: md.slice(0, 300),
        url: '', author: 'DeepSeek',
        published_at: dateBj, fetched_at: new Date().toISOString(),
        category: '简报', tags: ['每日简报', dateBj],
        content_hash: contentHash,
      }]);
    } catch (e: any) {
      console.error(`[briefing] COS 归档失败（不影响简报入库）: ${e.message}`);
    }

    // 采集日志
    try {
      await ownSql`
        INSERT INTO fetch_logs (action, status, articles_count, detail, started_at, duration_ms)
        VALUES (${'daily_briefing'}, ${'success'}, ${articles.length},
                ${`groups=${groupSummaries.size} inserted=${result.inserted}`.slice(0, 500)},
                ${new Date().toISOString()}, 0)`;
    } catch { /* 日志失败不影响主流程 */ }

    console.log(`[briefing] 完成 ${dateBj}: ${articles.length} 篇 → ${groupSummaries.size} 组 → inserted=${result.inserted}`);
    return result;
  } catch (e: any) {
    result.error = e.message;
    console.error(`[briefing] 失败: ${e.message}`);
    try {
      await ownSql`
        INSERT INTO fetch_logs (action, status, articles_count, detail, started_at, duration_ms)
        VALUES (${'daily_briefing'}, ${'error'}, 0, ${(e.message || '').slice(0, 500)}, ${new Date().toISOString()}, 0)`;
    } catch { /* ignore */ }
    return result;
  } finally {
    if (!sql) await (ownSql as any).end({ timeout: 1 });
  }
}

/** 启动每日调度：北京时间 21:50，失败重试最多 2 次（间隔 40 分钟） */
export function startDailyBriefing(sql: Sql): void {
  const attemptRun = async (retriesLeft: number) => {
    const r = await runDailyBriefing(sql);
    if (!r.ok && retriesLeft > 0 && r.error !== '今日无参与简报的文章') {
      console.warn(`[briefing] 40 分钟后重试（剩余 ${retriesLeft - 1} 次）`);
      setTimeout(() => attemptRun(retriesLeft - 1), 40 * 60_000);
    }
  };

  const schedule = () => {
    const delay = msUntilNextRun(21, 50);
    console.log(`[briefing] 下次简报约 ${Math.round(delay / 60000)} 分钟后`);
    setTimeout(async () => {
      await attemptRun(2).catch(e => console.error(`[briefing] 调度异常: ${e.message}`));
      schedule();
    }, delay);
  };
  schedule();
}
