#!/usr/bin/env python3
"""
媒体采集 Playwright 服务
支持：B站视频/字幕/音频 + Twitter/X 推文采集
"""
import json
import sys
import os
import re
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

try:
    from bs4 import BeautifulSoup, Tag, NavigableString
except ImportError:
    BeautifulSoup = None  # 后面会检查

PORT = int(os.environ.get('PORT', '8979'))
CHROMIUM_PATH = os.environ.get('CHROMIUM_EXECUTABLE_PATH', '')

# ═══════════════════════════════════════════
# B站采集
# ═══════════════════════════════════════════

def fetch_videos(mid: str, max_pages: int = 1, sessdata: str = '') -> list[dict]:
    """Use Playwright to fetch UP主 video list"""
    all_videos = []
    with sync_playwright() as p:
        launch_args = {'headless': True}
        if CHROMIUM_PATH:
            launch_args['executable_path'] = CHROMIUM_PATH
        browser = p.chromium.launch(**launch_args)
        context_args = {
            'user_agent': (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        }
        if sessdata:
            context_args['extra_http_headers'] = {
                'Cookie': f'SESSDATA={sessdata}'
            }
        context = browser.new_context(**context_args)
        page = context.new_page()
        captured = {}

        def intercept_response(response):
            url = response.url
            if "/x/space/wbi/arc/search" in url and response.status == 200:
                try:
                    body = response.body()
                    data = json.loads(body)
                    if data.get("code") == 0:
                        captured["data"] = data
                except Exception:
                    pass

        page.on("response", intercept_response)

        for pn in range(1, max_pages + 1):
            captured.clear()
            url = f"https://space.bilibili.com/{mid}/video"
            for attempt in range(2):
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(3000)
                    if captured.get("data"):
                        break
                    try:
                        page.evaluate("window.scrollBy(0, 600)")
                        page.wait_for_timeout(2000)
                    except:
                        pass
                except Exception as e:
                    if attempt == 0:
                        print(f"[BiliService] Retry {mid} p{pn} after: {e}", flush=True)
                        page.wait_for_timeout(3000)
                    else:
                        print(f"[BiliService] Failed {mid} p{pn} after 2 retries: {e}", flush=True)
            if not captured.get("data"):
                break
            vlist = captured["data"].get("data", {}).get("list", {}).get("vlist", [])
            if not vlist:
                break
            all_videos.extend(vlist)
            if pn < max_pages:
                page.wait_for_timeout(1000)
        browser.close()
    return all_videos


def _bili_get(path: str, sessdata: str) -> dict:
    """Direct HTTP GET to B站 API with SESSDATA cookie"""
    req = urllib.request.Request(f"https://api.bilibili.com{path}")
    if sessdata:
        req.add_header('Cookie', f'SESSDATA={sessdata}')
    req.add_header('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))


def fetch_subtitle(bvid: str, sessdata: str = '') -> dict:
    """Fetch B站 video subtitle via direct HTTP API."""
    try:
        view = _bili_get(f'/x/web-interface/view?bvid={bvid}', sessdata)
        vdata = view.get('data', {})
        cid = vdata.get('cid', '')
        if not cid:
            pages = vdata.get('pages', [])
            if pages:
                cid = pages[0].get('cid', '')
        if not cid:
            return {'ok': False, 'error': 'no cid found'}

        player = _bili_get(f'/x/player/v2?bvid={bvid}&cid={cid}', sessdata)
        subtitle_info = player.get('data', {}).get('subtitle', {})
        subtitles = subtitle_info.get('subtitles', [])
        if not subtitles:
            return {'ok': False, 'error': 'no subtitles available', 'cid': cid}

        preferred = ['zh-CN', 'zh-Hans', 'zh-cn', 'zh-CHS', 'en-US', 'en']
        selected = None
        for lang in preferred:
            for sub in subtitles:
                if sub.get('lan_doc', '').startswith(lang) or sub.get('language', '').startswith(lang):
                    selected = sub
                    break
            if selected:
                break
        if not selected:
            selected = subtitles[0]

        sub_url = selected.get('subtitle_url', '')
        if not sub_url:
            return {'ok': False, 'error': 'no subtitle URL', 'cid': cid}

        if sub_url.startswith('//'):
            sub_url = 'https:' + sub_url

        req = urllib.request.Request(sub_url)
        req.add_header('User-Agent', 'Mozilla/5.0')
        with urllib.request.urlopen(req, timeout=15) as resp:
            sub_data = json.loads(resp.read().decode('utf-8'))

        bodies = sub_data.get('body', [])
        if not bodies:
            return {'ok': False, 'error': 'subtitle body is empty', 'cid': cid}

        text_parts = []
        for item in bodies:
            content = item.get('content', '')
            if content:
                text_parts.append(content)

        text = '\n'.join(text_parts) if text_parts else ''
        language = selected.get('lan_doc', 'unknown')

        return {
            'ok': True,
            'text': text,
            'language': language,
            'cid': cid,
            'bvid': bvid,
        }
    except Exception as e:
        return {'ok': False, 'error': str(e), 'bvid': bvid}


def fetch_audio_url(bvid: str, sessdata: str = '') -> dict:
    """Get B站 video audio stream URL."""
    try:
        view = _bili_get(f'/x/web-interface/view?bvid={bvid}', sessdata)
        vdata = view.get('data', {})
        cid = vdata.get('cid', '')
        if not cid:
            pages = vdata.get('pages', [])
            if pages:
                cid = pages[0].get('cid', '')
        if not cid:
            return {'ok': False, 'error': 'no cid found'}

        play = _bili_get(f'/x/player/playurl?bvid={bvid}&cid={cid}&qn=0&type=mp4', sessdata)
        durl = play.get('data', {}).get('durl', [])
        if durl:
            audio_url = durl[0].get('url', '')
            if audio_url:
                return {'ok': True, 'audio_url': audio_url, 'cid': cid, 'bvid': bvid}

        dash = play.get('data', {}).get('dash', {})
        audios = dash.get('audio', [])
        if audios:
            audio_url = audios[0].get('base_url', '') or audios[0].get('baseUrl', '')
            if audio_url:
                return {'ok': True, 'audio_url': audio_url, 'cid': cid, 'bvid': bvid}

        return {'ok': False, 'error': 'no audio URL found', 'cid': cid}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'bvid': bvid}


def fetch_followings(sessdata: str) -> list[dict]:
    """Fetch the current user's following list via B站 direct HTTP API."""
    nav = _bili_get('/x/web-interface/nav', sessdata)
    my_mid = str(nav.get('data', {}).get('mid', ''))
    if not my_mid:
        print("[BiliService] Failed to get user mid from nav API", flush=True)
        return []

    print(f"[BiliService] Fetching followings for mid={my_mid}", flush=True)
    all_items = []

    for pn in range(1, 20):
        try:
            data = _bili_get(f'/x/relation/followings?vmid={my_mid}&pn={pn}&ps=50', sessdata)
            if data.get('code') != 0:
                break
            items = data.get('data', {}).get('list', [])
            if not items:
                break
            for item in items:
                all_items.append({
                    'mid': str(item.get('mid', '')),
                    'name': item.get('uname', ''),
                    'avatar': item.get('face', ''),
                    'sign': item.get('sign', ''),
                })
            print(f"[BiliService] Page {pn}: {len(items)} items (total: {len(all_items)})", flush=True)
        except Exception as e:
            print(f"[BiliService] Followings page {pn} error: {e}", flush=True)
            break

    return all_items


# ═══════════════════════════════════════════
# Twitter/X 推文采集
# ═══════════════════════════════════════════

def fetch_twitter(handle: str, max_tweets: int = 20, cookies: str = '') -> list[dict]:
    """
    用 Playwright 打开 X.com 用户主页，拦截 UserTweets API 响应，抓取推文。
    
    cookies: 可选，格式为 "ct0=xxx; auth_token=xxx" 或完整 cookie 字符串。
             提供登录 cookie 可获取更多推文（包括隐藏内容）。
    """
    tweets = []
    with sync_playwright() as p:
        launch_args = {'headless': True}
        if CHROMIUM_PATH:
            launch_args['executable_path'] = CHROMIUM_PATH
        browser = p.chromium.launch(**launch_args)
        context_args = {
            'user_agent': (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/137.0.0.0 Safari/537.36"
            ),
            'viewport': {'width': 1280, 'height': 900},
        }
        if cookies:
            # 支持多种 cookie 格式
            cookie_list = []
            for pair in cookies.split(';'):
                pair = pair.strip()
                if '=' in pair:
                    k, v = pair.split('=', 1)
                    k = k.strip()
                    v = v.strip()
                    if k and v:
                        cookie_list.append({
                            'name': k,
                            'value': v,
                            'domain': '.x.com',
                            'path': '/',
                        })
                        # 也设置 .twitter.com 域名
                        cookie_list.append({
                            'name': k,
                            'value': v,
                            'domain': '.twitter.com',
                            'path': '/',
                        })
            if cookie_list:
                context_args['extra_http_headers'] = {
                    'Cookie': cookies
                }
                # 也通过 add_cookies 设置（某些场景更可靠）
                browser_context = browser.new_context(**{k: v for k, v in context_args.items() if k != 'extra_http_headers'})
                browser_context.add_cookies(cookie_list)
                context = browser_context
                if 'extra_http_headers' in context_args:
                    context = browser.new_context(**context_args)
                    context.add_cookies(cookie_list)
            else:
                context = browser.new_context(**context_args)
        else:
            context = browser.new_context(**context_args)

        page = context.new_page()
        
        # 拦截 UserTweets / UserByScreenName API
        captured_tweets = []
        captured_user = {}
        
        def intercept_response(response):
            url = response.url
            try:
                # 拦截 UserTweets API（包含推文列表）
                if ('UserTweets' in url or 'UserMedia' in url or 'UserLikes' in url) and response.status == 200:
                    body = response.body()
                    data = json.loads(body)
                    # 解析 tweets
                    _extract_tweets(data, captured_tweets)
                    
                # 拦截 UserByScreenName（获取用户信息）
                if 'UserByScreenName' in url and response.status == 200:
                    body = response.body()
                    data = json.loads(body)
                    user_result = (data.get('data', {})
                                     .get('user', {})
                                     .get('result', {}))
                    captured_user['name'] = user_result.get('legacy', {}).get('name', '')
                    captured_user['screen_name'] = user_result.get('legacy', {}).get('screen_name', '')
            except Exception as e:
                pass  # 忽略解析错误

        page.on("response", intercept_response)

        # 访问用户主页
        profile_url = f"https://x.com/{handle}"
        print(f"[Twitter] Navigating to {profile_url}", flush=True)
        
        try:
            page.goto(profile_url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
            
            # 等待推文加载
            try:
                page.wait_for_selector('[data-testid="tweetText"], article', timeout=15000)
            except:
                print("[Twitter] No tweet elements found, trying scroll...", flush=True)
            
            # 滚动加载更多推文
            scrolls = 0
            max_scrolls = min(max_tweets // 5 + 2, 10)  # 动态滚动次数
            while len(captured_tweets) < max_tweets and scrolls < max_scrolls:
                page.evaluate("window.scrollBy(0, 800)")
                page.wait_for_timeout(2000)
                scrolls += 1
                print(f"[Twitter] Scroll {scrolls}, captured {len(captured_tweets)} tweets", flush=True)
            
        except Exception as e:
            print(f"[Twitter] Error loading profile: {e}", flush=True)
        
        browser.close()
    
    # 去重（按 tweetId）
    seen = set()
    unique = []
    for t in captured_tweets:
        tid = t.get('id', '')
        if tid and tid not in seen:
            seen.add(tid)
            unique.append(t)
    
    # 限制数量
    tweets = unique[:max_tweets]
    
    print(f"[Twitter] Captured {len(captured_tweets)} total, {len(tweets)} unique for @{handle}", flush=True)
    return tweets


def _extract_tweets(data: dict, out: list):
    """从 Twitter API JSON 响应中提取推文"""
    try:
        instructions = (data.get('data', {})
                           .get('user', {})
                           .get('result', {})
                           .get('timeline_v2', {})
                           .get('timeline', {})
                           .get('instructions', []))
        
        for inst in instructions:
            entries = inst.get('entries', [])
            for entry in entries:
                content = entry.get('content', {})
                item = content.get('itemContent', {})
                tweet_results = item.get('tweet_results', {}).get('result', {})
                
                if not tweet_results:
                    # 可能嵌套在 timeline 的其他位置
                    continue
                
                # 处理 retweeted_status
                legacy = tweet_results.get('legacy', {})
                retweeted = tweet_results.get('retweeted_status_result', {}).get('result', {})
                if retweeted:
                    actual_tweet = retweeted
                    actual_legacy = retweeted.get('legacy', {})
                    is_retweet = True
                else:
                    actual_tweet = tweet_results
                    actual_legacy = legacy
                    is_retweet = False
                
                tweet_id = actual_legacy.get('id_str', '') or actual_tweet.get('rest_id', '')
                if not tweet_id:
                    continue
                
                text = actual_legacy.get('full_text', '')
                created_at = actual_legacy.get('created_at', '')
                user = actual_legacy.get('user', {})
                screen_name = user.get('screen_name', '')
                user_name = user.get('name', '')
                
                # 统计
                stats = {
                    'replies': str(actual_legacy.get('reply_count', 0)),
                    'retweets': str(actual_legacy.get('retweet_count', 0)),
                    'likes': str(actual_legacy.get('favorite_count', 0)),
                    'views': str(actual_tweet.get('views', {}).get('count', '')),
                }
                
                # 图片
                media = actual_legacy.get('extended_entities', {}).get('media', [])
                images = [m.get('media_url_https', '') for m in media if m.get('type') == 'photo']
                video_urls = []
                for m in media:
                    if m.get('type') in ('video', 'animated_gif'):
                        variants = m.get('video_info', {}).get('variants', [])
                        mp4 = [v for v in variants if v.get('content_type') == 'video/mp4']
                        if mp4:
                            best = max(mp4, key=lambda v: v.get('bitrate', 0))
                            video_urls.append(best.get('url', ''))
                
                # 转换 created_at 格式
                timestamp = created_at
                if created_at:
                    try:
                        from datetime import datetime
                        dt = datetime.strptime(created_at, '%a %b %d %H:%M:%S %z %Y')
                        timestamp = dt.isoformat()
                    except:
                        pass
                
                tweet = {
                    'id': tweet_id,
                    'text': text,
                    'url': f"https://x.com/{screen_name}/status/{tweet_id}",
                    'timestamp': timestamp,
                    'author': user_name,
                    'screen_name': screen_name,
                    'is_retweet': is_retweet,
                    'stats': stats,
                    'images': images,
                    'videos': video_urls,
                }
                out.append(tweet)
    except Exception as e:
        print(f"[Twitter] Extract error: {e}", flush=True)


# ═══════════════════════════════════════════
# HTTP Handler
# ═══════════════════════════════════════════

# ═══════════════════════════════════════════
# 微信公众号文章采集
# ═══════════════════════════════════════════

def normalize_url(url: str) -> str:
    """将协议相对 URL (//mmbiz...) 转为完整 HTTPS URL"""
    if url.startswith('//'):
        return 'https:' + url
    return url


# ═══════════════════════════════════════════
# 微信公众号正文 HTML → Markdown 转换（BeautifulSoup DOM 递归遍历）
# ═══════════════════════════════════════════

# 真正的块级标签：产生段落分隔
_WX_BLOCK_TAGS = frozenset(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
                            "pre", "ul", "ol", "li", "hr", "table", "tr", "thead",
                            "tbody"])
# 内联标签：不产生换行
_WX_INLINE_TAGS = frozenset(["span", "a", "strong", "b", "em", "i", "code", "font",
                             "small", "sub", "sup", "u", "s", "del", "ins", "mark",
                             "abbr", "cite", "q", "label", "time", "big", "tt"])
# 结构性容器（微信大量用 section/div 做样式包裹）
_WX_CONTAINER_TAGS = frozenset(["section", "div"])


def _wx_is_block(node):
    """判断一个 Tag 是否是真正的块级元素（产生段落分隔）"""
    if not isinstance(node, Tag):
        return False
    return node.name.lower() in _WX_BLOCK_TAGS


def _wx_has_block_descendant(node):
    """检查 node 内部是否包含真正的块级标签（用于判断 section/div 是否充当段落）"""
    if not isinstance(node, Tag):
        return False
    for child in node.children:
        if isinstance(child, Tag):
            if child.name.lower() in _WX_BLOCK_TAGS:
                return True
            if child.name.lower() in _WX_CONTAINER_TAGS and _wx_has_block_descendant(child):
                return True
    return False


def _wx_render_children(node):
    """递归渲染子节点列表，返回 (parts_list) —— 每个 part 是一个字符串片段"""
    parts = []
    for child in node.children:
        if isinstance(child, NavigableString):
            text = str(child)
            if text.strip():
                parts.append(("text", text.strip()))
        elif isinstance(child, Tag):
            tag = child.name.lower() if child.name else ""
            style = (child.get("style") or "").replace(" ", "")
            if "display:none" in style or "visibility:hidden" in style:
                continue

            if tag == "img":
                src = child.get("data-src") or child.get("src") or ""
                src = normalize_url(src)
                if src and not src.startswith("data:"):
                    parts.append(("block", f"__IMG__{src}__IMG__"))

            elif tag == "br":
                parts.append(("newline", "\n"))

            elif tag == "hr":
                parts.append(("block", "---"))

            elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                lv = int(tag[1])
                inline = _wx_render_inline(child)
                if inline:
                    parts.append(("block", f"{'#' * lv} {inline}"))

            elif tag == "pre":
                ct = _wx_raw(child).strip()
                if ct:
                    parts.append(("block", f"```\n{ct}\n```"))

            elif tag == "code" and not (child.parent and child.parent.name == "pre"):
                ct = _wx_raw(child).strip()
                if ct:
                    parts.append(("inline", f"`{ct}`"))

            elif tag == "li":
                inline = _wx_render_inline(child)
                if inline:
                    parts.append(("list_item", inline))

            elif tag == "blockquote":
                inner_parts = _wx_render_children(child)
                inner_text = _wx_parts_to_text(inner_parts)
                for line in inner_text.strip().split("\n"):
                    if line.strip():
                        parts.append(("block", f"> {line.strip()}"))

            elif tag == "table":
                rows = []
                for tr in child.find_all("tr", recursive=False):
                    cells = [_wx_render_inline(td) for td in tr.find_all(["td", "th"], recursive=False)]
                    rows.append(" | ".join(cells))
                if rows:
                    parts.append(("block", "\n".join(rows)))

            elif tag in _WX_INLINE_TAGS:
                inline = _wx_render_inline(child)
                if inline:
                    parts.append(("inline", inline))

            elif tag in _WX_CONTAINER_TAGS:
                # section/div：检查是否包含真正的块级子元素
                if _wx_has_block_descendant(child):
                    # 有块级子元素 → 递归渲染子节点
                    sub_parts = _wx_render_children(child)
                    parts.extend(sub_parts)
                else:
                    # 纯内联容器 → 提取内联文本，但按 <br> 和句末标点分句
                    inline = _wx_render_inline(child)
                    if inline:
                        # 如果文本较长（>150字符），尝试按句末标点分句
                        if len(inline) > 150:
                            sentences = _wx_split_sentences(inline)
                            for s in sentences:
                                if s.strip():
                                    parts.append(("text", s.strip()))
                        else:
                            parts.append(("text", inline))

            else:
                # 未知标签：尝试内联渲染
                inline = _wx_render_inline(child)
                if inline:
                    parts.append(("text", inline))
    return parts


def _wx_render_inline(node):
    """渲染一个节点为纯内联文本（不做段落分隔），处理格式标签"""
    if isinstance(node, NavigableString):
        return str(node).strip()
    if not isinstance(node, Tag):
        return ""
    tag = node.name.lower() if node.name else ""
    style = (node.get("style") or "").replace(" ", "")
    if "display:none" in style or "visibility:hidden" in style:
        return ""

    if tag == "img":
        src = node.get("data-src") or node.get("src") or ""
        src = normalize_url(src)
        if src and not src.startswith("data:"):
            return f"__IMG__{src}__IMG__"
        return ""

    if tag == "br":
        return "\n"

    # 内联格式标签
    if tag in ("strong", "b"):
        t = _wx_render_inline_children(node)
        return f"**{t}**" if t else ""
    if tag in ("em", "i"):
        t = _wx_render_inline_children(node)
        return f"*{t}*" if t else ""
    if tag == "code":
        ct = _wx_raw(node).strip()
        return f"`{ct}`" if ct else ""
    if tag == "a":
        href = node.get("href", "")
        t = _wx_render_inline_children(node)
        if t and href and not href.startswith(("javascript:", "#")):
            return f"[{t}]({href})"
        return t

    # section/div/span 等容器 → 递归取内联文本
    return _wx_render_inline_children(node)


def _wx_render_inline_children(node):
    """递归渲染子节点为内联文本（拼接，不插入段落分隔）"""
    parts = []
    for child in node.children:
        t = _wx_render_inline(child)
        if t:
            parts.append(t)
    return "".join(parts)


def _wx_split_sentences(text):
    """将长文本按中文句末标点（。！？；）和图片标记分割成句子/段落"""
    if not text:
        return []
    # 先保护 __IMG__ 标记和代码块，不让它们被拆开
    placeholders = {}
    def protect(m):
        key = f"\x00PLACEHOLDER{len(placeholders)}\x00"
        placeholders[key] = m.group(0)
        return key
    text = re.sub(r'__IMG__[^_]+__IMG__', protect, text)
    text = re.sub(r'```[\s\S]*?```', protect, text)
    text = re.sub(r'\*\*[^*]+\*\*', protect, text)  # 保护粗体

    # 按句末标点分句（保留标点）
    sentences = re.split(r'(?<=[。！？；…\n])', text)
    
    # 恢复占位符
    result = []
    for s in sentences:
        for key, val in placeholders.items():
            s = s.replace(key, val)
        if s.strip():
            result.append(s.strip())
    return result


def _wx_parts_to_text(parts):
    """将 render_children 返回的 parts 列表转换为最终文本。
    
    核心策略：
    - block 类型（pre, hr, table, 图片等）→ 独立段落
    - list_item → 独立段落（带 - 前缀）
    - text/inline → 累积到当前段落缓冲区
    - newline → 刷新当前缓冲区
    每个段落之间用 \\n\\n 分隔（标准 Markdown 段落间距）
    """
    paragraphs = []
    current_parts = []

    def flush():
        if current_parts:
            text = "".join(str(p[1]) for p in current_parts).strip()
            if text:
                paragraphs.append(text)
            current_parts.clear()

    for ptype, pval in parts:
        if ptype == "block":
            flush()
            val = str(pval).strip()
            if val:
                paragraphs.append(val)
        elif ptype == "list_item":
            flush()
            paragraphs.append(f"- {pval}")
        elif ptype == "newline":
            flush()
        else:  # text / inline
            current_parts.append((ptype, pval))
    flush()
    return "\n\n".join(paragraphs)


def _wx_node_to_md(node):
    """递归遍历 DOM 节点，将微信 HTML 转为 Markdown"""
    parts = _wx_render_children(node)
    return _wx_parts_to_text(parts)


def _wx_raw(node):
    """获取节点的原始文本内容（保留空白和换行）"""
    parts = []
    for c in node.children:
        if isinstance(c, NavigableString):
            parts.append(str(c))
        elif isinstance(c, Tag):
            parts.append(_wx_raw(c))
    return "".join(parts)


def _wx_clean(text):
    """清理 Markdown 文本：HTML实体、多余空格、规范化换行"""
    # HTML 实体清理
    for entity, char in [
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
        ("&quot;", '"'), ("&apos;", "'"), ("&ldquo;", "\u201C"),
        ("&rdquo;", "\u201D"), ("&mdash;", "\u2014"), ("&ndash;", "\u2013"),
        ("&hellip;", "\u2026"), ("&copy;", "\u00A9"), ("&reg;", "\u00AE"),
        ("&trade;", "\u2122"), ("&deg;", "\u00B0"), ("\u00A0", " "),
        ("\u200B", ""), ("\uFEFF", ""),
    ]:
        text = text.replace(entity, char)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)

    # 规范化空格（但保留代码块内的格式）
    lines = text.split("\n")
    cleaned_lines = []
    in_code_block = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            cleaned_lines.append(stripped)
            continue
        if not in_code_block:
            # 代码块外：压缩多余空格
            cleaned_lines.append(re.sub(r" {2,}", " ", stripped))
        else:
            # 代码块内：保留原样
            cleaned_lines.append(line)

    text = "\n".join(cleaned_lines)
    # 清理 Markdown 格式标记异常（微信 strong 嵌套导致）
    text = re.sub(r'\*{4,}', '**', text)  # **** → **
    text = re.sub(r'\*\*\*\*', '**', text)  # **** → **
    text = re.sub(r'(\*\*)\1+', r'\1', text)  # 连续 ** 去重
    text = re.sub(r'^\*\*', '', text, flags=re.MULTILINE)  # 行首孤立 **
    text = re.sub(r'\*\*$', '', text, flags=re.MULTILINE)  # 行尾孤立 **
    # 压缩超过 2 个的连续换行
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def fetch_wechat_article(url: str) -> dict:
    """使用 Playwright + BeautifulSoup 抓取微信公众号文章全文"""
    if BeautifulSoup is None:
        # bs4 不可用时，降级到旧的 inner_html + 正则方式
        return _fetch_wechat_fallback(url)

    launch_args = {'headless': True}
    if CHROMIUM_PATH:
        launch_args['executable_path'] = CHROMIUM_PATH

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_args)
        # 使用微信客户端 UA，降低被风控概率
        context = browser.new_context(
            viewport={"width": 414, "height": 896},
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
                "MicroMessenger/8.0.42"
            ),
            locale="zh-CN",
            extra_http_headers={"Referer": "https://mp.weixin.qq.com/"},
        )
        page = context.new_page()

        try:
            print(f"[WeChat] Fetching {url[:80]}", flush=True)

            # 使用 domcontentloaded 而非 networkidle，避免长超时
            try:
                page.goto(url, wait_until='domcontentloaded', timeout=30000)
            except Exception:
                try:
                    page.goto(url, wait_until='load', timeout=15000)
                except Exception:
                    pass

            # 检测验证页
            page_title = page.title() or ''
            if '验证' in page_title:
                print(f"[WeChat] Verification page detected", flush=True)
                return {'error': 'verification_required'}

            # 等待 #js_content 出现
            try:
                page.wait_for_selector('#js_content', timeout=15000)
            except Exception:
                html_check = page.content()
                if '验证' in html_check and len(html_check) < 10000:
                    print(f"[WeChat] Verification page detected (after wait)", flush=True)
                    return {'error': 'verification_required'}
                print(f"[WeChat] #js_content not found", flush=True)

            # 滚动触发懒加载图片
            page.evaluate("window.scrollBy(0, 300)")
            page.wait_for_timeout(800)
            page.evaluate("window.scrollBy(0, 600)")
            page.wait_for_timeout(500)

            title = (page.title() or '').strip()
            # 清理标题前缀
            title = re.sub(r'^(原创|转载)\s*', '', title).strip()

            # 获取完整 HTML 并用 BeautifulSoup 解析
            html = page.content()
            soup = BeautifulSoup(html, 'html.parser')

            # 再次检查验证页
            if soup.title and '验证' in (soup.title.string or ''):
                return {'error': 'verification_required'}

            # 提取元数据
            og_title = soup.select_one('meta[property="og:title"]')
            if og_title:
                og_title_val = (og_title.get('content') or '').strip()
                if og_title_val:
                    title = re.sub(r'^(原创|转载)\s*', '', og_title_val).strip()

            author = ''
            author_el = soup.select_one('#js_name') or soup.select_one('#js_author_name')
            if author_el:
                author = author_el.get_text(strip=True)

            og_desc = soup.select_one('meta[property="og:description"]')
            desc = (og_desc.get('content') or '').strip() if og_desc else ''

            # 获取正文
            content_div = soup.select_one('#js_content')
            if not content_div:
                print(f"[WeChat] No #js_content, returning summary", flush=True)
                return {
                    'title': title,
                    'content': desc or title,
                    'author': author,
                    'publish_date': '',
                }

            # 清除隐藏元素、广告、二维码等
            for h in content_div.select(
                '[style*="display:none"], [style*="display: none"], '
                '[style*="visibility:hidden"], script, style, '
                '.qr_code_pc, .reward_area, .rich_media_tool, '
                '.profile_container, .media_profile_meta'
            ):
                h.decompose()

            # 递归遍历 DOM 转换为 Markdown
            md = _wx_node_to_md(content_div)
            md = _wx_clean(md)

            if not md.strip() or len(md.strip()) < 20:
                # DOM 遍历结果太短，可能是特殊排版，用 desc 兜底
                md = desc or title

            print(f"[WeChat] OK: {title[:40]} ({len(md)} chars, img={'yes' if '__IMG__' in md else 'no'})", flush=True)

            return {
                'title': title,
                'content': md,
                'author': author,
                'publish_date': '',
            }
        except Exception as e:
            print(f"[WeChat] Error: {e}", flush=True)
            return {'error': str(e)}
        finally:
            browser.close()


def _fetch_wechat_fallback(url: str) -> dict:
    """旧版降级方案：inner_html + 正则（bs4 不可用时使用）"""
    launch_args = {'headless': True}
    if CHROMIUM_PATH:
        launch_args['executable_path'] = CHROMIUM_PATH

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_args)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        try:
            page.goto(url, wait_until='networkidle', timeout=30000)
            page.wait_for_selector('#js_content', timeout=10000)

            title = (page.title() or '').strip()
            content_el = page.query_selector('#js_content')
            if content_el:
                import re
                content = content_el.inner_html()
                content = re.sub(
                    r'<img[^>]*\bdata-src=["\']((?:https?:)?//[^"\']+)["\'][^>]*>',
                    lambda m: '__IMG__' + normalize_url(m.group(1)) + '__IMG__',
                    content
                )
                content = re.sub(
                    r'<img[^>]*\bsrc=["\']((?:https?:)?//[^"\']+)["\'][^>]*>',
                    lambda m: '__IMG__' + normalize_url(m.group(1)) + '__IMG__',
                    content
                )
                content = re.sub(r'<[^>]+>', '\n', content)
                content = re.sub(r'\n{3,}', '\n\n', content)
                content = content.strip()
            else:
                content = ''

            author = ''
            author_el = page.query_selector('#js_name')
            if author_el:
                author = author_el.inner_text().strip()

            return {'title': title, 'content': content, 'author': author, 'publish_date': ''}
        except Exception as e:
            return {'error': str(e)}
        finally:
            browser.close()


class BiliHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        try:
            req = json.loads(body)
        except:
            req = {}
        
        action = req.get('action', 'videos')
        mid = req.get('mid', '')
        sessdata = req.get('sessdata', '')
        max_pages = int(req.get('max_pages', 5))
        
        if action == 'videos':
            if not mid:
                self._json(400, {'error': 'mid is required for action=videos'})
                return
            try:
                videos = fetch_videos(mid, max_pages, sessdata)
                self._json(200, {'ok': True, 'mid': mid, 'videos': videos, 'count': len(videos)})
            except Exception as e:
                self._json(500, {'error': str(e), 'mid': mid})
        
        elif action == 'followings':
            if not sessdata:
                self._json(400, {'error': 'sessdata is required for action=followings'})
                return
            try:
                followings = fetch_followings(sessdata)
                self._json(200, {'ok': True, 'followings': followings, 'count': len(followings)})
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        elif action == 'subtitle':
            bvid = req.get('bvid', '')
            if not bvid:
                self._json(400, {'error': 'bvid is required for action=subtitle'})
                return
            try:
                result = fetch_subtitle(bvid, sessdata)
                status = 200 if result.get('ok') else 404
                self._json(status, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        elif action == 'audio':
            bvid = req.get('bvid', '')
            if not bvid:
                self._json(400, {'error': 'bvid is required for action=audio'})
                return
            try:
                result = fetch_audio_url(bvid, sessdata)
                status = 200 if result.get('ok') else 404
                self._json(status, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        elif action == 'twitter':
            handle = req.get('handle', '')
            if not handle:
                self._json(400, {'error': 'handle is required for action=twitter'})
                return
            max_tweets = int(req.get('max_tweets', 20))
            cookies = req.get('cookies', '')
            try:
                tweets = fetch_twitter(handle, max_tweets, cookies)
                self._json(200, {'ok': True, 'handle': handle, 'tweets': tweets, 'count': len(tweets)})
            except Exception as e:
                self._json(500, {'error': str(e), 'handle': handle})
        
        else:
            self._json(400, {'error': f'Unknown action: {action}'})
    
    def do_GET(self):
        parsed = urlparse(self.path)
        
        if parsed.path == '/health':
            self._json(200, {'status': 'ok', 'service': 'media-fetch'})
        elif parsed.path == '/fetch':
            params = parse_qs(parsed.query)
            url = params.get('url', [None])[0]
            if not url:
                self._json(400, {'error': 'url parameter required'})
                return
            try:
                result = fetch_wechat_article(url)
                if 'error' in result:
                    self._json(500, result)
                else:
                    self._json(200, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
        else:
            self._json(404, {'error': 'Not found. POST / or GET /fetch?url='})
    
    def _json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def log_message(self, format, *args):
        print(f"[MediaService] {args[0]} {args[1]} {args[2]}")


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), BiliHandler)
    print(f"Media Playwright service running on port {PORT}", flush=True)
    server.serve_forever()
