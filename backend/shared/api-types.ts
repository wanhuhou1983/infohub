/**
 * InfoHub API 共享类型定义
 *
 * 这是前后端之间的契约（contract）。
 * 所有 API 响应格式必须与此文件保持一致。
 *
 * 修改此文件后，必须同步更新前端 api-client.js 中对返回字段的期望。
 * 建议工作流：改类型 → 更新后端路由 → 更新前端 api-client → 测试
 */

// ============ 信息源（Source） ============

/** 信息源数据库行 */
export interface Source {
  id: number;
  name: string;
  type: string;
  icon: string | null;
  description: string | null;
  config: Record<string, any>;
  enabled: boolean;
  parent_id: number | null;
  last_fetch: string | null;
  created_at: string;
  updated_at: string;
}

/** 信息源树节点（在 Source 基础上加 children） */
export interface SourceTreeNode extends Source {
  children: SourceTreeNode[];
}

/** 所有已知 source_type 枚举（前后端统一引用，避免拼写错误） */
export const SOURCE_TYPES = {
  XWLB: 'xwlb',
  RSS: 'rss',
  MAGAZINE: 'magazine',
  WECHAT: 'wechat',
  WECHAT_GROUP: 'wechat_group',
  BILIBILI: 'bilibili',
  BILIBILI_UPDATES: 'bilibili-updates',
  YOUTUBE: 'youtube',
  YOUTUBE_UPDATES: 'youtube-updates',
  PODCAST: 'podcast',
  PODCAST_CHANNEL: 'podcast-channel',
  IMPORT: 'import',
} as const;

// ============ 文章（Article） ============

/** 文章列表中的单篇文章（不含 content） */
export interface ArticleItem {
  id: number;
  source_id: number;
  title: string;
  url: string | null;
  author: string | null;
  source_name: string;
  source_icon: string | null;
  source_type: string;
  category: string | null;
  tags: string[] | null;
  published_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_watch_later: boolean;
  content_hash: string;
  fetched_at: string | null;
  extra: Record<string, any> | null;
}

/** 文章列表响应 */
export interface ArticleListResponse {
  articles: ArticleItem[];
  total: number;
}

/** 文章详情（含 content） */
export interface ArticleDetail extends ArticleItem {
  content: string | null;
  summary: string | null;
  needsFetch: boolean;
  // extra 子字段（前端松散解构）
  extra: {
    ai_analysis?: string;
    ai_translation?: string;
    subtitle?: string;
    subtitle_analysis?: string;
    section_analysis?: Array<{ heading: string; text: string }>;
    duration?: number;
    date?: string;
    group_name?: string;
    messages?: WechatGroupMessage[];
    [key: string]: any;
  } | null;
}

/** 群聊消息 */
export interface WechatGroupMessage {
  time: string;
  isSend: boolean;
  sender: string;
  content: string;
}

// ============ 统计（Stats） ============

/** 信息源统计 */
export interface SourceStats {
  id: number;
  article_count: number;
  unread_count: number;
}

/** 概览统计响应 */
export interface StatsResponse {
  totalArticles: number;
  todayArticles: number;
  unreadArticles: number;
  starredArticles: number;
  sources: SourceStats[];
}

// ============ 采集（Fetch） ============

/** 通用采集响应 */
export interface FetchResponse {
  ok: boolean;
  fetched: number;
  inserted: number;
  errors?: string[];
}

/** RSS 采集响应 */
export interface RssFetchResponse extends FetchResponse {
  sources: number;
  translated: number;
}

/** 公众号采集响应 */
export interface WechatFetchResponse extends FetchResponse {
  accounts: number;
}

// ============ 管理模块统一类型 ============

/** 统一 toggle 启用/禁用响应格式 */
export interface ToggleResponse {
  id: number;
  name: string;
  enabled: boolean;
}

/** 刷新响应 */
export interface RefreshResponse {
  ok: boolean;
  enabledCount: number;
  fetched: number;
  inserted: number;
  errors?: string[];
}

// ============ 文章操作响应 ============

export interface MarkReadResponse {
  ok: true;
}

export interface MarkStarResponse {
  ok: true;
}

export interface FetchContentResponse {
  ok: boolean;
  content_length?: number;
}

// ============ 配置（Config） ============

export interface EnvConfigResponse {
  image_storage: string;
  weflow_url: string;
  weflow_token: string;
  miniflux_url: string;
  miniflux_user: string;
  google_translate_key: string;
  azure_translate_key: string;
  azure_translate_region: string;
  azure_translate_endpoint: string;
  baidu_translate_configured: boolean;
  google_oauth_client_id: string;
  google_oauth_configured: boolean;
  google_oauth_authorized: boolean;
  google_oauth_user: string;
}

// ============ 播客管理 ============

export interface PodcastPlatform {
  id: string;
  name: string;
  icon: string;
}

export interface PodcastChannel {
  id: number;
  name: string;
  platform: string;
  url: string;
  playlist_url?: string;
  enabled: boolean;
}

export interface PodcastSearchResult {
  title: string;
  cover_url: string;
  description: string;
  tracks: number;
  author: string;
  url: string;
}

export interface PodcastPlatformResult {
  platform: string;
  results: PodcastSearchResult[];
  total?: number;
  error?: string;
  hint?: string;
}

// ============ 公众号/WeFlow ============

export interface WechatAccount {
  db_id: number;
  displayName: string;
  gh_id: string;
  enabled: boolean;
  latest_article_at?: string;
}

export interface WechatAccountsResponse {
  accounts: WechatAccount[];
  total: number;
  newlyCreated: number;
}

// ============ 通用错误响应 ============

export interface ErrorResponse {
  error: string;
}

export interface OkResponse {
  ok: boolean;
}
