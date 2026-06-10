/**
 * Twitter/X 账号管理路由
 *
 * 功能：
 * - GET   /api/twitter-admin/accounts        → 获取已添加的 X 账号列表
 * - POST  /api/twitter-admin/accounts        → 添加 X 账号
 * - DELETE /api/twitter-admin/accounts/:id   → 删除 X 账号
 * - PATCH /api/twitter-admin/accounts/:id/toggle → 切换启用/禁用
 * - POST  /api/twitter-admin/refresh         → 采集已启用账号的最新推文
 *
 * 数据来源：Twitter/X GraphQL API（guest token 方式，无需 API Key）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { saveArticleFile, hashString } from '../file-storage.js';
import { cleanHtmlToText } from '../services/parser.js';
import { classifyByFeed, extractTags } from '../services/classifier.js';

// ============ Twitter API 常量 ============

/** Twitter 公开 Bearer Token（Web 客户端使用） */
const TWITTER_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** UserByScreenName GraphQL query ID */
const UBSN_QUERY_ID = '681MIj51w00Aj6dY0GXnHw';

/** UserByScreenName features */
const UBSN_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

/** UserTweets GraphQL query ID */
const UT_QUERY_ID = 'fVhuOkcsO6w1T0nmCAo_sw';

/** UserTweets features */
const UT_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: true,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ============ Twitter GraphQL API ============

let _cachedGuestToken: string | null = null;
let _guestTokenExpiry = 0;

/** 获取 guest token（带缓存，1 小时有效） */
async function getGuestToken(): Promise<string> {
  if (_cachedGuestToken && Date.now() < _guestTokenExpiry) {
    return _cachedGuestToken;
  }
  const resp = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TWITTER_BEARER}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`获取 guest token 失败: HTTP ${resp.status}`);
  const data = (await resp.json()) as any;
  _cachedGuestToken = data.guest_token;
  _guestTokenExpiry = Date.now() + 55 * 60 * 1000; // 55 分钟
  return _cachedGuestToken;
}

interface TweetData {
  id: string;
  text: string;
  created_at: string;
  retweet_count: number;
  favorite_count: number;
  reply_count: number;
  quote_count: number;
  views: number;
  media_urls: string[];
  url: string;
}

interface UserInfo {
  userId: string;
  name: string;
  screenName: string;
}

/** 通过 UserByScreenName 获取用户信息 */
async function fetchUserInfo(handle: string, guestToken: string): Promise<UserInfo | null> {
  const variables = { screen_name: handle, withSafetyModeUserFields: true };
  const url =
    `https://x.com/i/api/graphql/${UBSN_QUERY_ID}/UserByScreenName` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(UBSN_FEATURES))}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER}`,
      'x-guest-token': guestToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  const result = data?.data?.user?.result;
  if (!result) return null;

  return {
    userId: result.rest_id,
    name: result.legacy?.name || `@${handle}`,
    screenName: result.legacy?.screen_name || handle,
  };
}

/** 通过 UserTweets GraphQL 获取推文列表 */
async function fetchUserTweets(
  userId: string,
  handle: string,
  guestToken: string,
): Promise<TweetData[]> {
  const variables = {
    userId,
    count: 20,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  };
  const url =
    `https://x.com/i/api/graphql/${UT_QUERY_ID}/UserTweets` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(UT_FEATURES))}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TWITTER_BEARER}`,
      'x-guest-token': guestToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`UserTweets API HTTP ${resp.status}`);
  const data = (await resp.json()) as any;

  const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions || [];
  const tweets: TweetData[] = [];

  for (const inst of instructions) {
    // 格式 1: inst.entry.content.itemContent.tweet_results.result（单条推文）
    const entryResult = inst.entry?.content?.itemContent?.tweet_results?.result;
    if (entryResult) {
      const td =
        entryResult.__typename === 'TweetWithVisibilityResults' ? entryResult.tweet : entryResult;
      if (td?.legacy) {
        tweets.push(formatTweet(td, handle));
      }
    }

    // 格式 2: inst.type === "TimelineAddEntries" → inst.entries[]
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      for (const entry of inst.entries) {
        const r = entry?.content?.itemContent?.tweet_results?.result;
        if (!r) continue;
        const td =
          r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
        if (td?.legacy) {
          tweets.push(formatTweet(td, handle));
        }
      }
    }
  }

  return tweets;
}

/** 将 GraphQL 返回的推文数据格式化为统一结构 */
function formatTweet(tweetData: any, handle: string): TweetData {
  const l = tweetData.legacy;
  return {
    id: l.id_str || tweetData.rest_id,
    text: l.full_text || '',
    created_at: l.created_at || new Date().toISOString(),
    retweet_count: l.retweet_count || 0,
    favorite_count: l.favorite_count || 0,
    reply_count: l.reply_count || 0,
    quote_count: l.quote_count || 0,
    views: tweetData.views?.count || 0,
    media_urls: (l.extended_entities?.media || []).map((m: any) => m.media_url_https || m.media_url),
    url: `https://x.com/${handle}/status/${l.id_str}`,
  };
}

/** 采集单个账号的最新推文 */
async function fetchTwitterFeed(handle: string): Promise<{ tweets: TweetData[]; userInfo: UserInfo | null }> {
  const guestToken = await getGuestToken();

  // 获取用户信息
  const userInfo = await fetchUserInfo(handle, guestToken);
  if (!userInfo) {
    throw new Error(`无法获取 @${handle} 的用户信息`);
  }

  // 获取推文
  const tweets = await fetchUserTweets(userInfo.userId, handle, guestToken);

  return { tweets, userInfo };
}

// ============ Routes ============

export function createTwitterAdminRoutes(sql: Sql): Hono {
  const router = new Hono();

  // ============ 获取所有已添加的 X 账号列表 ============
  router.get('/accounts', async (c) => {
    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ accounts: [], total: 0 });

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ accounts: [], total: 0 });

      const accounts = await sql`
        SELECT s.id, s.name, s.enabled, s.config->>'handle' AS handle,
               (SELECT MAX(published_at) FROM articles WHERE author = s.name) AS latest_tweet_at
        FROM sources s
        WHERE s.type = 'twitter-updates' AND s.parent_id = ${updatesSource[0]!.id}
        ORDER BY s.enabled DESC, s.name ASC
      `;

      return c.json({
        accounts: accounts.map(a => ({
          id: a.id,
          name: a.name,
          handle: a.handle,
          enabled: a.enabled,
          latest_tweet_at: a.latest_tweet_at,
        })),
        total: accounts.length,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 手动添加 X 账号 ============
  router.post('/accounts', async (c) => {
    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ error: 'Twitter/X 信息源未配置' }, 400);

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ error: 'Twitter/X "更新"源未配置' }, 400);

      const body = await c.req.json();
      let { handle, name } = body;

      if (!handle) {
        return c.json({ error: '请提供 X 账号 handle（不含 @）' }, 400);
      }

      // 去掉 @ 前缀
      handle = handle.replace(/^@/, '').trim();

      // 如果没有提供名称，从 Twitter API 获取
      if (!name) {
        try {
          const info = await fetchUserInfo(handle, await getGuestToken());
          name = info?.name || `@${handle}`;
        } catch {
          name = `@${handle}`;
        }
      }

      // 检查是否已存在
      const [existing] = await sql`
        SELECT id FROM sources
        WHERE type = 'twitter-updates' AND parent_id = ${updatesSource[0]!.id} AND config->>'handle' = ${handle}
      `;
      if (existing) {
        return c.json({ error: `账号 @${handle} 已存在` }, 400);
      }

      // 插入新账号（默认禁用）
      const [inserted] = await sql`
        INSERT INTO sources (name, type, parent_id, config, enabled, created_at)
        VALUES (${name}, 'twitter-updates', ${updatesSource[0]!.id}, ${sql.json({ handle })}, false, NOW())
        RETURNING id, name, config
      `;

      return c.json({
        ok: true,
        account: {
          id: inserted!.id,
          name: inserted!.name,
          handle,
          enabled: false,
        },
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ============ 删除 X 账号 ============
  router.delete('/accounts/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const [deleted] = await sql`
      DELETE FROM sources WHERE id = ${id} AND type = 'twitter-updates'
      RETURNING id
    `;
    if (!deleted) return c.json({ error: '账号不存在' }, 404);

    return c.json({ ok: true });
  });

  // ============ 切换单个账号启用/禁用 ============
  router.patch('/accounts/:id/toggle', async (c) => {
    const id = Number(c.req.param('id'));
    if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const enabled = body.enabled === true;

    const [updated] = await sql`
      UPDATE sources SET enabled = ${enabled}, updated_at = NOW() WHERE id = ${id}
      RETURNING id, name, enabled
    `;
    if (!updated) return c.json({ error: 'Source not found' }, 404);

    return c.json(updated);
  });

  // ============ 采集已启用账号的最新推文 ============
  router.post('/refresh', async (c) => {
    const startMs = Date.now();

    try {
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (!twitterSource) return c.json({ error: 'Twitter/X 信息源未配置' }, 400);

      const updatesSource = await sql`
        SELECT id FROM sources WHERE type = 'twitter-updates' AND parent_id = ${twitterSource.id} LIMIT 1
      `;
      if (updatesSource.length === 0) return c.json({ error: 'Twitter/X "更新"源未配置' }, 400);

      const enabledAccounts = await sql`
        SELECT id, name, config->>'handle' AS handle
        FROM sources
        WHERE type = 'twitter-updates' AND parent_id = ${updatesSource[0]!.id} AND enabled = true
      `;

      if (enabledAccounts.length === 0) {
        return c.json({ ok: true, message: '没有已启用的 X 账号', inserted: 0 });
      }

      // 预获取 guest token（所有账号共用）
      const guestToken = await getGuestToken();

      let totalFetched = 0;
      let inserted = 0;
      const errors: string[] = [];

      for (const account of enabledAccounts) {
        const handle = account.handle;
        const name = account.name;

        try {
          // 获取用户信息
          const userInfo = await fetchUserInfo(handle, guestToken);
          if (!userInfo) {
            errors.push(`${name}: 无法获取用户信息`);
            continue;
          }

          // 获取推文
          const tweets = await fetchUserTweets(userInfo.userId, handle, guestToken);
          if (tweets.length === 0) {
            errors.push(`${name}: 无推文数据`);
            continue;
          }

          for (const tweet of tweets) {
            try {
              // 构建统计信息
              const statsStr = [
                tweet.retweet_count ? `🔄${tweet.retweet_count}` : '',
                tweet.favorite_count ? `❤️${tweet.favorite_count}` : '',
                tweet.reply_count ? `💬${tweet.reply_count}` : '',
                tweet.views ? `👁️${tweet.views}` : '',
              ]
                .filter(Boolean)
                .join(' ');

              // 构建正文
              let fullContent = tweet.text;
              if (statsStr) fullContent += `\n\n${statsStr}`;
              // 添加图片 URL
              for (const imgUrl of tweet.media_urls) {
                fullContent += `\n\n![图片](${imgUrl})`;
              }

              // 标题：取前 100 字符
              const title = cleanHtmlToText(tweet.text.slice(0, 100));
              const contentText = cleanHtmlToText(fullContent);

              // 去重 key
              const contentHash = hashString('twitter_' + tweet.id);

              // 检查是否已存在
              const [existing] = await sql`
                SELECT id FROM articles WHERE content_hash = ${contentHash} LIMIT 1
              `;
              if (existing) {
                totalFetched++;
                continue;
              }

              const category = classifyByFeed(name);
              const tags = extractTags(title + ' ' + contentText.slice(0, 200), name);

              const insertedRows = await sql`
                INSERT INTO articles (source_id, title, content, summary, url, published_at, category, tags, content_hash, fetched_at, author)
                VALUES (
                  ${account.id},
                  ${title.slice(0, 500)},
                  ${contentText.slice(0, 10000)},
                  ${title.slice(0, 200)},
                  ${tweet.url},
                  ${tweet.created_at},
                  ${category},
                  ${tags},
                  ${contentHash},
                  NOW(),
                  ${name}
                )
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
              `;

              if (insertedRows.length > 0) {
                inserted++;
                const newId = insertedRows[0]!.id;
                await saveArticleFile(newId, contentText, {
                  id: newId,
                  title,
                  source_type: 'twitter-updates',
                  source_name: name,
                  url: tweet.url,
                  published_at: tweet.created_at,
                  category,
                  tags,
                  author: name,
                  is_read: false,
                  is_starred: false,
                });
              }
              totalFetched++;
            } catch (e: any) {
              if (e.code !== '23505') {
                errors.push(`${name}(推文): ${e.message}`);
              }
            }
          }
        } catch (e: any) {
          errors.push(`${name}: ${e.message}`);
        }
      }

      await sql`UPDATE sources SET last_fetch = NOW() WHERE id = ${twitterSource.id}`;
      const durationMs = Date.now() - startMs;
      await sql`
        INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
        VALUES (
          ${twitterSource.id},
          'X账号推文采集',
          'success',
          ${inserted},
          ${`已启用 ${enabledAccounts.length} 个账号，获取 ${totalFetched} 条推文，入库 ${inserted} 条${errors.length ? '，错误: ' + errors.join('; ') : ''}`},
          ${durationMs}
        )
      `;

      return c.json({
        ok: true,
        enabledCount: enabledAccounts.length,
        fetched: totalFetched,
        inserted,
        errors: errors.length ? errors : undefined,
      });
    } catch (e: any) {
      const durationMs = Date.now() - startMs;
      const [twitterSource] = await sql`
        SELECT id FROM sources WHERE type = 'twitter' AND parent_id IS NULL LIMIT 1
      `;
      if (twitterSource) {
        await sql`
          INSERT INTO fetch_logs (source_id, action, status, articles_count, detail, duration_ms)
          VALUES (${twitterSource.id}, 'X账号推文采集', 'error', 0, ${e.message}, ${durationMs})
        `;
      }
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}
