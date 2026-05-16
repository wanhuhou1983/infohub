/**
 * ob-writer.ts 核心契约测试
 *
 * 测试范围：
 *   1. buildMarkdown — Markdown 生成（frontmatter、IMG 标记、衍生区块）
 *   2. getObSubdir — 目录映射逻辑
 *   3. sanitizeFilename — 文件名生成
 *   4. parseObFrontmatter — frontmatter 解析
 *   5. 辅助函数（normalizeDate, sanitizeDirName, extractDerivedFields 等）
 *
 * 测试策略：
 *   - 纯函数测试，无需 mock
 *   - saveArticleFile 端到端测试需要 mock processImages + 文件系统，单独覆盖
 */

import { describe, test, expect } from 'bun:test';

import {
  normalizeDate,
  hashString,
  sanitizeDirName,
  normalizeWechatAccount,
  parseObFrontmatter,
  getObSubdir,
  sanitizeFilename,
  buildMarkdown,
  extractDerivedFields,
  computeExtraVersion,
} from '../storage/ob-writer.js';

// ============ 辅助：构建 ArticleMeta ============

function makeMeta(overrides: Record<string, any> = {}): any {
  return {
    id: 123,
    title: '测试文章标题',
    source_type: 'rss',
    source_name: 'My RSS Feed',
    url: 'https://example.com/article',
    published_at: '2026-05-03T12:00:00Z',
    category: '技术',
    tags: ['javascript', 'testing'],
    author: '张三',
    is_read: false,
    is_starred: true,
    content_hash: 'abc123def456',
    sync_version: 2,
    extra: null,
    ...overrides,
  };
}

// ============================================================
// normalizeDate
// ============================================================

describe('normalizeDate', () => {

  test('ISO 字符串截取到 19 字符', () => {
    expect(normalizeDate('2026-05-03T12:34:56.789Z')).toBe('2026-05-03T12:34:56');
  });

  test('无效日期返回原字符串截取前 19 字符', () => {
    expect(normalizeDate('not-a-date')).toBe('not-a-date');
  });

  test('null 返回空字符串', () => {
    expect(normalizeDate(null)).toBe('');
  });

  test('undefined 返回空字符串', () => {
    expect(normalizeDate(undefined)).toBe('');
  });

});

// ============================================================
// hashString
// ============================================================

describe('hashString', () => {

  test('相同输入产生相同输出', () => {
    const h1 = hashString('hello');
    const h2 = hashString('hello');
    expect(h1).toBe(h2);
  });

  test('不同输入产生不同输出', () => {
    const h1 = hashString('hello');
    const h2 = hashString('world');
    expect(h1).not.toBe(h2);
  });

  test('输出是 32 位 MD5 十六进制', () => {
    const h = hashString('test');
    expect(h).toMatch(/^[a-f0-9]{32}$/);
  });

});

// ============================================================
// sanitizeDirName
// ============================================================

describe('sanitizeDirName', () => {

  test('普通名称原样返回', () => {
    expect(sanitizeDirName('My Channel')).toBe('My Channel');
  });

  test('含非法字符的名称被清理', () => {
    expect(sanitizeDirName('My/Channel\\Test:*?"<>|')).toBe('MyChannelTest');
  });

  test('null 返回未分类', () => {
    expect(sanitizeDirName(null)).toBe('未分类');
  });

  test('undefined 返回未分类', () => {
    expect(sanitizeDirName(undefined)).toBe('未分类');
  });

  test('所有非法字符被移除后为空返回未分类', () => {
    expect(sanitizeDirName('/\\:*?"<>|')).toBe('未分类');
  });

});

// ============================================================
// normalizeWechatAccount
// ============================================================

describe('normalizeWechatAccount', () => {

  test('普通名称不变', () => {
    expect(normalizeWechatAccount('机器之心')).toBe('机器之心');
  });

  test('去掉 "微信公众号-" 前缀', () => {
    expect(normalizeWechatAccount('微信公众号-机器之心')).toBe('机器之心');
  });

  test('去掉 "微信公众号_" 前缀', () => {
    expect(normalizeWechatAccount('微信公众号_机器之心')).toBe('机器之心');
  });

  test('空字符串回退', () => {
    expect(normalizeWechatAccount('')).toBe('未分类');
  });

});

// ============================================================
// parseObFrontmatter
// ============================================================

describe('parseObFrontmatter', () => {

  test('没有 --- 前缀返回空对象', () => {
    expect(parseObFrontmatter('纯文本内容')).toEqual({});
  });

  test('解析基本 key: value', () => {
    const content = `---
id: 123
url: "https://example.com"
source: "测试源"
---`;
    const result = parseObFrontmatter(content);
    expect(result.id).toBe(123);
    expect(result.url).toBe('https://example.com');
    expect(result.source).toBe('测试源');
  });

  test('解析 tags 数组', () => {
    const content = `---
tags: ["a", "b", "c"]
---`;
    const result = parseObFrontmatter(content);
    expect(result.tags).toEqual(['a', 'b', 'c']);
  });

  test('解析布尔值', () => {
    const content = `---
is_read: true
is_starred: false
---`;
    const result = parseObFrontmatter(content);
    expect(result.is_read).toBe(true);
    expect(result.is_starred).toBe(false);
  });

  test('解析数字', () => {
    const content = `---
sync_version: 42
---`;
    const result = parseObFrontmatter(content);
    expect(result.sync_version).toBe(42);
  });

  test('空值 key 被跳过', () => {
    const content = `---
empty_key:
present_key: "hello"
---`;
    const result = parseObFrontmatter(content);
    expect(result.empty_key).toBeUndefined();
    expect(result.present_key).toBe('hello');
  });

});

// ============================================================
// getObSubdir
// ============================================================

describe('getObSubdir', () => {

  test('xwlb → 报刊杂志/新闻联播', () => {
    expect(getObSubdir(makeMeta({ source_type: 'xwlb' }))).toBe('报刊杂志/新闻联播');
  });

  test('rmrb → 报刊杂志/人民日报', () => {
    expect(getObSubdir(makeMeta({ source_type: 'rmrb' }))).toBe('报刊杂志/人民日报');
  });

  test('magazine → 报刊杂志/喷嚏图卦', () => {
    expect(getObSubdir(makeMeta({ source_type: 'magazine' }))).toBe('报刊杂志/喷嚏图卦');
  });

  test('tencent → 报刊杂志/腾讯新闻', () => {
    expect(getObSubdir(makeMeta({ source_type: 'tencent' }))).toBe('报刊杂志/腾讯新闻');
  });

  test('wechat 带名称 → 微信公众号/{名称}', () => {
    expect(getObSubdir(makeMeta({ source_type: 'wechat', source_name: '微信公众号-机器之心' }))).toBe('微信公众号/机器之心');
  });

  test('wechat 无名称 → 微信公众号/未分类', () => {
    expect(getObSubdir(makeMeta({ source_type: 'wechat', source_name: '' }))).toBe('微信公众号/未分类');
  });

  test('rss → RSS订阅/{sanitized}', () => {
    expect(getObSubdir(makeMeta({ source_type: 'rss', source_name: 'My/Feed' }))).toBe('RSS订阅/MyFeed');
  });

  test('bilibili-updates → 哔哩哩哔/更新/{sanitized}', () => {
    expect(getObSubdir(makeMeta({ source_type: 'bilibili-updates', source_name: '某UP主' }))).toBe('哔哩哩哔/更新/某UP主');
  });

  test('bilibili-watch-later 有 author → 哔哩哩哔/稍后再看/{author}', () => {
    const meta = makeMeta({ source_type: 'bilibili-watch-later', source_name: '稍后再看', author: 'UP主A' });
    expect(getObSubdir(meta)).toBe('哔哩哩哔/稍后再看/UP主A');
  });

  test('bilibili-watch-later 无 author → 哔哩哩哔/稍后再看/未分类', () => {
    const meta = makeMeta({ source_type: 'bilibili-watch-later', source_name: '稍后再看', author: null });
    expect(getObSubdir(meta)).toBe('哔哩哩哔/稍后再看/未分类');
  });

  test('bilibili-favorites → 哔哩哩哔/收藏/{author}', () => {
    const meta = makeMeta({ source_type: 'bilibili-favorites', source_name: '收藏', author: 'UP主B' });
    expect(getObSubdir(meta)).toBe('哔哩哩哔/收藏/UP主B');
  });

  test('twitter-updates → twitter-updates/{source_name}', () => {
    expect(getObSubdir(makeMeta({ source_type: 'twitter-updates', source_name: 'elonmusk' }))).toBe('twitter-updates/elonmusk');
  });

  test('youtube-updates → YouTube/更新', () => {
    expect(getObSubdir(makeMeta({ source_type: 'youtube-updates' }))).toBe('YouTube/更新');
  });

  test('youtube-watch-later → YouTube/稍后再看', () => {
    expect(getObSubdir(makeMeta({ source_type: 'youtube-watch-later' }))).toBe('YouTube/稍后再看');
  });

  test('youtube-favorites → YouTube/收藏', () => {
    expect(getObSubdir(makeMeta({ source_type: 'youtube-favorites' }))).toBe('YouTube/收藏');
  });

  test('未知 source_type 回退到类型本身', () => {
    expect(getObSubdir(makeMeta({ source_type: 'custom-type' }))).toBe('custom-type');
  });

});

// ============================================================
// sanitizeFilename
// ============================================================

describe('sanitizeFilename', () => {

  test('普通文章生成 {YYYYMMDD}-{title}.md', () => {
    const meta = makeMeta({ published_at: '2026-05-03T12:00:00Z', title: '我的文章' });
    const name = sanitizeFilename(meta);
    expect(name).toMatch(/^20260503-/);
    expect(name).toContain('我的文章');
    expect(name).toEndWith('.md');
  });

  test('magazine 类型不使用日期前缀', () => {
    const meta = makeMeta({ source_type: 'magazine', published_at: '2026-05-03', title: '财新周刊' });
    const name = sanitizeFilename(meta);
    // magazine: 直接 title.md
    expect(name).toBe('财新周刊.md');
  });

  test('标题中非法字符被替换', () => {
    const meta = makeMeta({ published_at: '2026-05-03', title: 'a/b:c*d' });
    const name = sanitizeFilename(meta);
    expect(name).toMatch(/^20260503-/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
    expect(name).not.toContain('*');
  });

  test('中文标题按字节截断（超过 60 字节）', () => {
    // 每个中文字符 3 字节，21 个中文 = 63 字节 > 60，应截断
    const longTitle = '中'.repeat(21); // 63 字节
    const meta = makeMeta({ published_at: '2026-05-03', title: longTitle });
    const name = sanitizeFilename(meta);
    // 应截断到 20 个中文字符（60 字节内）
    const titlePart = name.replace(/^\d{8}-/, '').replace('.md', '');
    expect(titlePart.length).toBe(20); // 截断到 20 个
  });

  test('无 published_at 使用当前日期', () => {
    const meta = makeMeta({ published_at: null });
    const name = sanitizeFilename(meta);
    // 使用当天日期（运行时动态，无法精确匹配，验证格式即可）
    expect(name).toMatch(/^\d{8}-/);
    expect(name).toEndWith('.md');
  });

  test('空标题回退到 untitled', () => {
    const meta = makeMeta({ published_at: '2026-05-03', title: '' });
    const name = sanitizeFilename(meta);
    expect(name).toMatch(/^20260503-untitled\.md$/);
  });

});

// ============================================================
// extractDerivedFields
// ============================================================

describe('extractDerivedFields', () => {

  test('null extra 返回空对象', () => {
    expect(extractDerivedFields(null)).toEqual({});
  });

  test('undefined extra 返回空对象', () => {
    expect(extractDerivedFields(undefined)).toEqual({});
  });

  test('按 EXTRA_FIELD_ORDER 顺序提取字段', () => {
    const extra = {
      subtitle: '完整字幕内容',
      ai_translation: '翻译内容',
      ai_analysis: 'AI解读内容',
    };
    const result = extractDerivedFields(extra);
    const keys = Object.keys(result);
    // 应按 EXTRA_FIELD_ORDER 顺序排列
    expect(keys[0]).toBe('ai_translation');
    expect(keys[1]).toBe('ai_analysis');
    expect(keys[2]).toBe('subtitle');
  });

  test('只提取 EXTRA_FIELD_ORDER 中的字段', () => {
    const extra = {
      ai_translation: '翻译',
      random_field: '不应出现',
    };
    const result = extractDerivedFields(extra);
    expect(result).toEqual({ ai_translation: '翻译' });
    expect(result.random_field).toBeUndefined();
  });

  test('extra 中字段值为空时不提取', () => {
    const extra = {
      ai_translation: '',
      ai_analysis: null,
    };
    const result = extractDerivedFields(extra);
    expect(Object.keys(result).length).toBe(0);
  });

});

// ============================================================
// computeExtraVersion
// ============================================================

describe('computeExtraVersion', () => {

  test('无衍生字段返回空字符串', () => {
    expect(computeExtraVersion(null)).toBe('');
    expect(computeExtraVersion({})).toBe('');
    expect(computeExtraVersion({ unrelated: 'xyz' })).toBe('');
  });

  test('有衍生字段返回 8 位哈希', () => {
    const extra = { ai_translation: '翻译内容' };
    const version = computeExtraVersion(extra);
    expect(version).toMatch(/^[a-f0-9]{8}$/);
  });

  test('相同衍生字段产生相同版本号', () => {
    const e1 = { ai_translation: '你好', ai_analysis: '分析' };
    const e2 = { ai_translation: '你好', ai_analysis: '分析' };
    expect(computeExtraVersion(e1)).toBe(computeExtraVersion(e2));
  });

  test('不同衍生字段产生不同版本号', () => {
    const e1 = { ai_translation: '你好' };
    const e2 = { ai_translation: '您好' };
    expect(computeExtraVersion(e1)).not.toBe(computeExtraVersion(e2));
  });

});

// ============================================================
// buildMarkdown
// ============================================================

describe('buildMarkdown', () => {

  test('生成完整 frontmatter（全字段）', () => {
    const meta = makeMeta();
    const md = buildMarkdown('正文内容', meta);
    const lines = md.split('\n');

    // 以 --- 开头
    expect(lines[0]).toBe('---');
    // 包含所有关键字段
    expect(md).toContain('id: 123');
    expect(md).toContain('content_hash: "abc123def456"');
    expect(md).toContain('url: "https://example.com/article"');
    expect(md).toContain('source: "My RSS Feed"');
    expect(md).toContain('source_type: "rss"');
    expect(md).toContain('published_at: "2026-05-03T12:00:00"');
    expect(md).toContain('category: "技术"');
    expect(md).toContain('author: "张三"');
    expect(md).toContain('tags: ["javascript", "testing"]');
    expect(md).toContain('is_read: false');
    expect(md).toContain('is_starred: true');
    expect(md).toContain('sync_version: 2');
  });

  test('tags 数组格式化为 [\"a\", \"b\"]', () => {
    const meta = makeMeta({ tags: ['tag1', 'tag2'] });
    const md = buildMarkdown('内容', meta);
    // tags 行应按 Obsidian 格式显示
    expect(md).toContain('tags: ["tag1", "tag2"]');
  });

  test('无衍生字段时不写入 extra_fields', () => {
    const meta = makeMeta({ extra: null });
    const md = buildMarkdown('内容', meta);
    expect(md).not.toContain('extra_fields');
    expect(md).not.toContain('extra_version');
  });

  test('有衍生字段时写入 extra_fields 和 extra_version', () => {
    const meta = makeMeta({
      extra: {
        ai_translation: '这是翻译',
        ai_analysis: '这是分析',
      },
    });
    const md = buildMarkdown('内容', meta);
    expect(md).toContain('extra_fields');
    expect(md).toContain('extra_version');
    expect(md).toContain('ai_translation');
    expect(md).toContain('ai_analysis');
  });

  test('__IMG__ 标记转换为 Markdown 图片语法', () => {
    const meta = makeMeta();
    const content = '前文 __IMG__https://example.com/img.jpg__IMG__ 后文';
    const md = buildMarkdown(content, meta);
    expect(md).toContain('前文');
    expect(md).toContain('后文');
    expect(md).toContain('![](https://example.com/img.jpg)');
    expect(md).not.toContain('__IMG__');
  });

  test('正文以 "# {title}" 开头', () => {
    const meta = makeMeta({ title: '我的文章' });
    const md = buildMarkdown('内容', meta);
    expect(md).toContain('# 我的文章');
  });

  test('衍生区块按 EXTRA_FIELD_ORDER 顺序追加', () => {
    const meta = makeMeta({
      extra: {
        subtitle_analysis: '字幕解读',
        ai_translation: '翻译内容',
        ai_analysis: 'AI分析',
        subtitle: '完整字幕',
      },
    });
    const md = buildMarkdown('正文', meta);

    // 正文后应有 --- 分隔
    expect(md).toContain('---');

    // 顺序：ai_translation → ai_analysis → subtitle_analysis → subtitle
    const transIdx = md.indexOf('🌐 AI 翻译');
    const analysisIdx = md.indexOf('🤖 AI 解读');
    const subAnalysisIdx = md.indexOf('📝 字幕解读');
    const subtitleIdx = md.indexOf('📄 完整字幕/转录');

    expect(transIdx).toBeGreaterThan(0);
    expect(analysisIdx).toBeGreaterThan(transIdx);
    expect(subAnalysisIdx).toBeGreaterThan(analysisIdx);
    expect(subtitleIdx).toBeGreaterThan(subAnalysisIdx);
  });

  test('无衍生区块时不追加 ---', () => {
    const meta = makeMeta({ extra: null });
    const md = buildMarkdown('正文内容', meta);
    // 此时 body 里不应有额外的 ---（除了 frontmatter 的）
    // 正文"正文内容"后不应有 ---
    // 注意：正文可能包含 --- 于 frontmatter 之后
    const bodyStart = md.indexOf('# 测试文章标题');
    const afterBody = md.slice(bodyStart);
    // 如果无衍生区块，bodyEnd 后不应再有 ---（除了 frontmatter 的）
    // 实际 body 部分： "# 测试文章标题\n\n正文内容\n"
    // 没有额外的分隔符
    expect(afterBody).not.toContain('\n\n---\n\n');
  });

  test('full pipeline: frontmatter + IMG 转换 + 衍生区块', () => {
    const meta = makeMeta({
      extra: {
        ai_translation: 'English translation',
      },
    });
    const content = '__IMG__https://pic.example.com/photo.jpg__IMG__';

    const md = buildMarkdown(content, meta);

    // frontmatter 包含 extra_fields
    expect(md).toContain('extra_fields');
    expect(md).toContain('extra_version');

    // IMG 标记转换
    expect(md).toContain('![](https://pic.example.com/photo.jpg)');
    expect(md).not.toContain('__IMG__');

    // 衍生区块
    expect(md).toContain('🌐 AI 翻译');
    expect(md).toContain('English translation');

    // 整体结构
    expect(md.startsWith('---')).toBe(true);
    expect(md).toContain('\n---\n\n# 测试文章标题');
  });

  test('URL 中的引号被正确转义', () => {
    // 仅验证 frontmatter 中 url 的引号转义
    const meta = makeMeta({ url: 'https://example.com/"test"' });
    const md = buildMarkdown('内容', meta);
    // url 值中的引号应被转义
    expect(md).toContain('url: "https://example.com/\\"test\\""');
  });

});

// ============================================================
// parseObFrontmatter ↔ buildMarkdown 双向契约
// ============================================================

describe('frontmatter 双向契约（round-trip）', () => {

  test('buildMarkdown 输出可被 parseObFrontmatter 正确解析', () => {
    const meta = makeMeta({
      tags: ['tag1', 'tag2'],
      extra: { ai_translation: '翻译' },
    });
    const md = buildMarkdown('内容', meta);
    const parsed = parseObFrontmatter(md);

    // 关键字段双向一致
    expect(parsed.id).toBe(123);
    expect(parsed.source).toBe('My RSS Feed');
    expect(parsed.tags).toEqual(['tag1', 'tag2']);
    expect(parsed.is_read).toBe(false);
    expect(parsed.is_starred).toBe(true);
    expect(parsed.sync_version).toBe(2);
    expect(parsed.extra_fields).toEqual(['ai_translation']);
    expect(parsed.extra_version).toMatch(/^[a-f0-9]{8}$/);
  });

  test('无衍生字段的 round-trip 不含 extra_fields', () => {
    const meta = makeMeta({ extra: null });
    const md = buildMarkdown('内容', meta);
    const parsed = parseObFrontmatter(md);
    expect(parsed.extra_fields).toBeUndefined();
    expect(parsed.extra_version).toBeUndefined();
  });

});
