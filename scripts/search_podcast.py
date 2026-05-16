#!/usr/bin/env python3
# 推荐通过 .venv311/bin/python3 运行
"""
播客搜索脚本 - 支持多平台搜索

当前支持：
- 喜马拉雅（无需认证）：通过 www.ximalaya.com/revision/search 搜索专辑
- 蜻蜓 FM（需 cookie）：通过 musicdl 的 QingtingMusicClient
- 小宇宙（需 token）：通过 api.xiaoyuzhoufm.com/v1/search/create

认证配置：在项目根目录 .env.json 中配置以下字段：
- QINGTING_ID / QINGTING_REFRESH_TOKEN → 蜻蜓 FM 搜索
- XIAOYUZHOU_ACCESS_TOKEN → 小宇宙搜索

输出：JSON 格式搜索结果，供后端路由调用
"""

import json
import os
import sys
import time
import urllib.request
import urllib.parse
import urllib.error


# ============================================================
# 配置读取
# ============================================================

def find_env_json():
    """从脚本所在目录向上查找 .env.json"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for _ in range(5):
        candidate = os.path.join(script_dir, '.env.json')
        if os.path.exists(candidate):
            return candidate
        script_dir = os.path.dirname(script_dir)
    return None

def load_podcast_config() -> dict:
    """加载播客相关认证配置"""
    env_path = find_env_json()
    if not env_path:
        return {}
    try:
        with open(env_path, 'r') as f:
            config = json.load(f)
        return {
            'qingting_id': config.get('QINGTING_ID', ''),
            'qingting_refresh_token': config.get('QINGTING_REFRESH_TOKEN', ''),
            'xiaoyuzhou_access_token': config.get('XIAOYUZHOU_ACCESS_TOKEN', ''),
        }
    except Exception:
        return {}


# ============================================================
# 喜马拉雅搜索（已有，无需认证）
# ============================================================

def search_ximalaya(keyword: str, page: int = 1, rows: int = 20) -> dict:
    """搜索喜马拉雅专辑（频道）

    API: GET https://www.ximalaya.com/revision/search
    参数:
        core=album      -> 搜索专辑
        kw=关键词       -> 搜索关键词
        page=1          -> 页码
        rows=20         -> 每页条数
        condition=relation -> 按相关度排序

    返回:
        {
            "platform": "ximalaya",
            "total": int,
            "results": [
                {
                    "id": int | str,
                    "title": str,
                    "author": str,
                    "description": str,
                    "tracks": int,
                    "play_count": int,
                    "cover_url": str,
                    "is_finished": bool,
                    "is_paid": bool,
                    "category": str,
                    "url": str
                }
            ]
        }
    """
    url = "https://www.ximalaya.com/revision/search"
    params = {
        "core": "album",
        "kw": keyword,
        "page": str(page),
        "rows": str(rows),
        "condition": "relation",
        "device": "iPhone",
        "spellchecker": "true",
    }
    full_url = url + "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(
        full_url,
        headers={
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15"
                          " (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.ximalaya.com/",
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"platform": "ximalaya", "error": str(e), "total": 0, "results": []}

    if data.get("ret") != 200:
        return {
            "platform": "ximalaya",
            "error": data.get("msg", "未知错误"),
            "total": 0,
            "results": [],
        }

    docs = data.get("data", {}).get("result", {}).get("response", {}).get("docs", [])
    total = data.get("data", {}).get("result", {}).get("response", {}).get("numFound", 0)

    results = []
    for doc in docs:
        album_id = doc.get("id")
        title = doc.get("title", "")
        title = title.replace("<em>", "").replace("</em>", "")
        author = doc.get("nickname", "")
        description = doc.get("intro", "")
        if description:
            description = description.replace("<em>", "").replace("</em>", "")

        cover = doc.get("cover_path", "")
        if cover and not cover.startswith("http"):
            cover = "https:" + cover

        results.append({
            "id": str(album_id) if album_id else "",
            "title": title,
            "author": author,
            "description": description[:200] if description else "",
            "tracks": doc.get("tracks", 0),
            "play_count": doc.get("play", 0),
            "cover_url": cover,
            "is_finished": bool(doc.get("is_finished", 0)),
            "is_paid": bool(doc.get("is_paid", False)),
            "category": doc.get("category_title", ""),
            "url": f"https://www.ximalaya.com/album/{album_id}" if album_id else "",
            "platform": "ximalaya",
        })

    return {
        "platform": "ximalaya",
        "total": total,
        "results": results,
    }


# ============================================================
# 蜻蜓 FM 搜索（需要 qingting_id + refresh_token）
# ============================================================

def search_qingting(keyword: str, page: int = 1, rows: int = 20) -> dict:
    """搜索蜻蜓 FM 频道

    需要用户在 .env.json 中配置 QINGTING_ID 和 QINGTING_REFRESH_TOKEN。
    通过 musicdl 的 QingtingMusicClient 实现。

    配置获取方式：
    1. 打开蜻蜓 FM App
    2. 从抓包工具获取 qingting_id 和 refresh_token
    3. 配置到 .env.json 中
    """
    config = load_podcast_config()
    qingting_id = config.get('qingting_id', '')
    qingting_refresh_token = config.get('qingting_refresh_token', '')

    if not qingting_id or not qingting_refresh_token:
        return {
            "platform": "qingting",
            "error": "需要配置蜻蜓 FM 认证信息",
            "hint": "请在项目根目录 .env.json 中设置 QINGTING_ID 和 QINGTING_REFRESH_TOKEN，"
                    "从蜻蜓 FM App 抓包获取",
            "total": 0,
            "results": [],
        }

    try:
        from musicdl.modules.audiobooks.qingting import QingtingMusicClient
    except ImportError:
        return {
            "platform": "qingting",
            "error": "musicdl 未安装，请运行: pip install musicdl",
            "total": 0,
            "results": [],
        }

    client = QingtingMusicClient(
        search_size_per_source=rows * 2,
        search_size_per_page=rows,
        disable_print=True,
        default_search_cookies={
            'qingting_id': qingting_id,
            'refresh_token': qingting_refresh_token,
        },
        default_download_cookies={
            'qingting_id': qingting_id,
            'refresh_token': qingting_refresh_token,
        },
    )

    try:
        result = client.search(keyword)
    except Exception as e:
        return {
            "platform": "qingting",
            "error": f"搜索失败: {e}",
            "hint": "请检查 QINGTING_ID 和 QINGTING_REFRESH_TOKEN 是否有效，或重新登录获取",
            "total": 0,
            "results": [],
        }

    results = []
    for song in result:
        if not song.song_name:
            continue
        results.append({
            "id": str(song.identifier) if song.identifier else "",
            "title": song.song_name,
            "author": song.singers or "",
            "description": song.album or "",
            "tracks": len(getattr(song, 'episodes', [])),
            "play_count": 0,
            "cover_url": song.cover_url or "",
            "is_finished": False,
            "is_paid": False,
            "category": "",
            "url": song.download_url or "",
            "platform": "qingting",
        })

    return {
        "platform": "qingting",
        "total": len(results),
        "results": results,
    }


# ============================================================
# 小宇宙搜索（需要 x-jike-access-token）
# ============================================================

XIAOYUZHOU_BASE_URL = "https://api.xiaoyuzhoufm.com"
XIAOYUZHOU_SEARCH_URL = f"{XIAOYUZHOU_BASE_URL}/v1/search/create"

# 请求头（兼容 Web 和 App 端）
# Web 端 token 需用浏览器类 User-Agent + Referer
# App 端 token 需用 iOS 原生 UA
XIAOYUZHOU_HEADERS_TEMPLATE = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Content-Type": "application/json; charset=utf-8",
    "Accept": "application/json",
    "x-jike-device-id": "infohub-search-001",
    "Referer": "https://www.xiaoyuzhoufm.com/",
}


def search_xiaoyuzhou(keyword: str, page: int = 1, rows: int = 20) -> dict:
    """搜索小宇宙播客

    需要用户在 .env.json 中配置 XIAOYUZHOU_ACCESS_TOKEN。
    API: POST https://api.xiaoyuzhoufm.com/v1/search/create

    Token 获取方式：
    1. 登录小宇宙 App
    2. 从抓包工具获取 x-jike-access-token
    3. 配置到 .env.json 中
    """
    config = load_podcast_config()
    access_token = config.get('xiaoyuzhou_access_token', '')

    if not access_token:
        return {
            "platform": "xiaoyuzhou",
            "error": "需要配置小宇宙认证信息",
            "hint": "请在项目根目录 .env.json 中设置 XIAOYUZHOU_ACCESS_TOKEN，"
                    "从小宇宙 App 抓包获取 x-jike-access-token",
            "total": 0,
            "results": [],
        }

    headers = dict(XIAOYUZHOU_HEADERS_TEMPLATE)
    headers["x-jike-access-token"] = access_token
    headers["Local-Time"] = time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.gmtime())

    payload = {
        "keyword": keyword,
        "type": "PODCAST",
    }

    try:
        import urllib.request as req_module
        data_bytes = json.dumps(payload).encode('utf-8')
        req = req_module.Request(
            XIAOYUZHOU_SEARCH_URL,
            data=data_bytes,
            headers=headers,
            method='POST',
        )
        with req_module.urlopen(req, timeout=15) as resp:
            response_data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {
                "platform": "xiaoyuzhou",
                "error": "Token 无效或已过期",
                "hint": "请重新从小宇宙 App 获取 x-jike-access-token 并更新 .env.json",
                "total": 0,
                "results": [],
            }
        return {
            "platform": "xiaoyuzhou",
            "error": f"HTTP {e.code}: {e.reason}",
            "total": 0,
            "results": [],
        }
    except Exception as e:
        return {
            "platform": "xiaoyuzhou",
            "error": str(e),
            "total": 0,
            "results": [],
        }

    # 解析结果
    data_list = response_data.get('data', [])
    if not isinstance(data_list, list):
        data_list = []

    results = []
    for item in data_list:
        podcast_info = item if isinstance(item, dict) else {}
        # 小宇宙返回的字段结构
        pid = podcast_info.get('pid') or podcast_info.get('id', '')
        title = podcast_info.get('title', '')
        author = podcast_info.get('podcasters') or podcast_info.get('author', '')
        if isinstance(author, list):
            author = ', '.join(
                a.get('nickname', '') if isinstance(a, dict) else str(a)
                for a in author
            )
        elif isinstance(author, dict):
            author = author.get('nickname', '')

        description = podcast_info.get('description', '') or podcast_info.get('brief', '')
        cover = podcast_info.get('image', {})
        if isinstance(cover, dict):
            cover = cover.get('picUrl', '') or cover.get('thumbnailUrl', '')
        elif isinstance(cover, str):
            pass
        else:
            cover = ''
        if cover and not cover.startswith('http'):
            cover = ''

        results.append({
            "id": str(pid) if pid else "",
            "title": title,
            "author": author,
            "description": description[:200] if description else "",
            "tracks": 0,
            "play_count": 0,
            "cover_url": cover,
            "is_finished": False,
            "is_paid": False,
            "category": "podcast",
            "url": f"https://www.xiaoyuzhoufm.com/podcast/{pid}" if pid else "",
            "platform": "xiaoyuzhou",
        })

    return {
        "platform": "xiaoyuzhou",
        "total": len(results),
        "results": results,
    }


# ============================================================
# 统一搜索入口
# ============================================================

def search(keyword: str, page: int = 1) -> dict:
    """搜索所有支持的播客平台"""
    if not keyword or not keyword.strip():
        return {"error": "请输入搜索关键词", "platforms": []}

    keyword = keyword.strip()
    platforms = []

    # 喜马拉雅（无认证）
    xm = search_ximalaya(keyword, page)
    platforms.append(xm)

    time.sleep(0.3)

    # 蜻蜓 FM（需 cookie）
    qt = search_qingting(keyword, page)
    platforms.append(qt)

    time.sleep(0.3)

    # 小宇宙（需 token）
    xyz = search_xiaoyuzhou(keyword, page)
    platforms.append(xyz)

    return {"keyword": keyword, "platforms": platforms}


# ============================================================
# CLI 入口
# ============================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: python3 search_podcast.py <关键词> [页码]"}, ensure_ascii=False))
        sys.exit(1)

    keyword = sys.argv[1]
    page = int(sys.argv[2]) if len(sys.argv) > 2 else 1

    result = search(keyword, page)
    print(json.dumps(result, ensure_ascii=False, indent=2))
