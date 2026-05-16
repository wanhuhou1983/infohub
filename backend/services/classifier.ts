/**
 * 分类与标签提取模块
 * 将文章自动分类并提取标签，规则可配置
 */

// ============ 分类规则 ============

interface CategoryRule {
  pattern: RegExp;
  category: string;
}

const FEED_CATEGORY_RULES: CategoryRule[] = [
  { pattern: /科技|tech|AI|Hacker|Lil'|arXiv|量子位/i, category: '科技' },
  { pattern: /财经|金融|Bloomberg|market|wallstreet|财新/i, category: '财经' },
  { pattern: /BBC|CNN|新闻|News/i, category: '国际' },
  { pattern: /三联|生活|利维坦/i, category: '人文' },
  { pattern: /阑夕|饭统|喷嚏/i, category: '综合' },
];

const TITLE_CATEGORY_RULES: CategoryRule[] = [
  { pattern: /国际|外交|访华|会谈|峰会|日本|美国|伊朗|韩国|欧盟|联合国/, category: '国际' },
  { pattern: /经济|GDP|财政|央行|金融|降准|利率|投资|市场/, category: '财经' },
  { pattern: /科技|创新|数字|AI|芯片|航天|航空/, category: '科技' },
  { pattern: /农业|农村|农民|粮食|春播|扶贫/, category: '民生' },
];

// ============ 标签规则 ============

interface TagRule {
  pattern: RegExp;
  tag: string;
}

const TAG_RULES: TagRule[] = [
  { pattern: /AI|人工智能|GPT|LLM|大模型/i, tag: 'AI' },
  { pattern: /芯片|semiconductor|chip/i, tag: '芯片' },
  { pattern: /加密|crypto|bitcoin|区块链/i, tag: '加密' },
  { pattern: /石油|oil|原油/i, tag: '石油' },
  { pattern: /降息|加息|利率|interest rate/i, tag: '利率' },
  { pattern: /GDP|经济|economy/i, tag: '经济' },
  { pattern: /战争|冲突|war|conflict/i, tag: '地缘' },
  { pattern: /气候|carbon|碳/i, tag: '气候' },
  { pattern: /航天|space|火箭/i, tag: '航天' },
];

const XWLB_TAG_MAP: Record<string, string> = {
  '经济': '经济', '政策': '政策', '外交': '外交', '科技': '科技',
  '农业': '农业', '教育': '教育', '环境': '环保', '军事': '军事',
  '金融': '金融', '改革': '改革',
};

// ============ 公开函数 ============

/**
 * 根据 feed 标题判断分类
 */
export function classifyByFeed(feedTitle: string): string {
  for (const rule of FEED_CATEGORY_RULES) {
    if (rule.pattern.test(feedTitle)) return rule.category;
  }
  return '综合';
}

/**
 * 根据文章标题判断分类（新闻联播等）
 */
export function classifyByTitle(title: string, defaultCategory = '国内'): string {
  for (const rule of TITLE_CATEGORY_RULES) {
    if (rule.pattern.test(title)) return rule.category;
  }
  return defaultCategory;
}

/**
 * 从文本和 feed 标题中提取标签
 */
export function extractTags(text: string, feedTitle = ''): string[] {
  const tags: string[] = [];
  for (const { pattern, tag } of TAG_RULES) {
    if (pattern.test(text) || pattern.test(feedTitle)) {
      tags.push(tag);
    }
  }
  return tags.length > 0 ? tags : ['综合'];
}

/**
 * 从新闻联播标题中提取标签
 */
export function extractXWLBTags(title: string): string[] {
  const tags: string[] = [];
  for (const [keyword, tag] of Object.entries(XWLB_TAG_MAP)) {
    if (title.includes(keyword)) tags.push(tag);
  }
  return tags.length > 0 ? tags : ['综合'];
}
