#!/usr/bin/env python3
# 推荐通过 .venv311/bin/python3 运行
"""
播客剧集采集脚本 - 获取指定播客频道的所有剧集列表

当前支持平台：
- 喜马拉雅（无需认证）：通过 www.ximalaya.com/revision/album/v1/getTracksList
- 蜻蜓 FM（需 cookie）：待实现（需要 QINGTING_ID + QINGTING_REFRESH_TOKEN）
- 小宇宙（需 token）：待实现（需要 XIAOYUZHOU_ACCESS_TOKEN）

用法：
  python3 fetch_podcast_episodes.py --platform ximalaya --url "https://www.ximalaya.com/album/12345"
  python3 fetch_podcast_episodes.py --platform ximalaya --url "https://www.ximalaya.com/album/12345" --page 2

输出：JSON 格式的剧集列表，供后端路由调用

认证配置（可选，用于需认证的平台）：
在项目根目录 .env.json 中配置以下字段：
- QINGTING_ID / QINGTING_REFRESH_TOKEN → 蜻蜓 FM
- XIAOYUZHOU_ACCESS_TOKEN → 小宇宙
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request


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
# 喜马拉雅 - 获取专辑剧集列表
# ============================================================

def extract_ximalaya_album_id(url: str) -> str | None:
    """从喜马拉雅 URL 中提取 albumId"""
    patterns = [
        r'ximalaya\.com/album/(\d+)',
        r'ximalaya\.com/albums/(\d+)',
        r'ximalaya\.com/sound/(\d+)',
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None


def ts_to_iso8601(ts_ms: int) -> str:
    """将毫秒时间戳转换为 ISO 8601 格式 (UTC+8)"""
    if not ts_ms:
        return ""
    from datetime import datetime, timezone, timedelta
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    dt_cn = dt.astimezone(timezone(timedelta(hours=8)))
    return dt_cn.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def fetch_ximalaya_tracks(album_id: str, page: int = 1, page_size: int = 30) -> dict:
    """
    获取喜马拉雅专辑剧集列表

    移动端 API（更稳定，不需要额外 cookie/sign）：
    GET https://mobile.ximalaya.com/mobile/v1/album/track/
    参数:
        albumId: 专辑 ID
        pageId: 页码（注意：参数名是 pageId，不是 page）
        pageSize: 每页条数（camelCase，不区分大小写时可能用 pagesize）

    返回: dict 包含 episodes 列表
    """
    base_url = "https://mobile.ximalaya.com/mobile/v1/album/track/"
    params = {
        "albumId": album_id,
        "pageId": str(page),
        "pageSize": str(page_size),
    }
    full_url = base_url + "?" + urllib.parse.urlencode(params)

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
        return {"platform": "ximalaya", "error": str(e), "total": 0, "page": page, "episodes": []}

    # 移动端 API 返回 ret=0 表示成功
    if data.get("ret") != 0:
        return {
            "platform": "ximalaya",
            "error": data.get("msg", f"API 返回错误 ret={data.get('ret')}"),
            "total": 0,
            "page": page,
            "episodes": [],
        }

    d = data.get("data", {})
    tracks = d.get("list", [])
    total_count = d.get("totalCount", len(tracks))
    max_page_id = d.get("maxPageId", 1)
    current_page_id = d.get("pageId", page)

    episodes = []
    for track in tracks:
        track_id = track.get("trackId", "")
        title = track.get("title", "")

        # 发布时间：createdAt 为 Unix 毫秒时间戳
        created_ms = track.get("createdAt", 0)
        published_at = ts_to_iso8601(created_ms)

        duration = track.get("duration", 0)  # 秒

        # 封面图（从大到小优选）
        cover = track.get("coverLarge", "") or track.get("coverMiddle", "") or track.get("coverSmall", "")
        if cover and not cover.startswith("http"):
            cover = "https:" + cover

        description = track.get("intro", "") or ""

        # 不直接提供 playUrl，用播放页 URL 替代
        # 用户点击时跳转到喜马拉雅播放

        episodes.append({
            "title": title,
            "description": description,
            "published_at": published_at,
            "duration": duration,
            "duration_display": format_duration(duration),
            "url": f"https://www.ximalaya.com/sound/{track_id}" if track_id else "",
            "cover_url": cover,
            "external_id": str(track_id) if track_id else "",
            "author": track.get("nickname", ""),
        })

    return {
        "platform": "ximalaya",
        "total": total_count,
        "page": current_page_id,
        "max_page_id": max_page_id,
        "has_more": current_page_id < max_page_id,
        "episodes": episodes,
    }


def format_duration(seconds: int) -> str:
    """将秒数格式化为 mm:ss 或 hh:mm:ss"""
    if not seconds:
        return ""
    h, remainder = divmod(int(seconds), 3600)
    m, s = divmod(remainder, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


# ============================================================
# 蜻蜓 FM - 获取频道剧集列表（计划实现）
# ============================================================

def fetch_qingting_episodes(channel_url: str, page: int = 1) -> dict:
    """获取蜻蜓 FM 频道剧集列表（待实现）"""
    return {
        "platform": "qingting",
        "error": "蜻蜓 FM 剧集采集尚未实现",
        "total": 0,
        "page": page,
        "episodes": [],
    }


# ============================================================
# 小宇宙 - 获取播客剧集列表（计划实现）
# ============================================================

def fetch_xiaoyuzhou_episodes(channel_url: str, page: int = 1) -> dict:
    """获取小宇宙播客剧集列表（待实现）"""
    return {
        "platform": "xiaoyuzhou",
        "error": "小宇宙剧集采集尚未实现",
        "total": 0,
        "page": page,
        "episodes": [],
    }


# ============================================================
# 统一入口
# ============================================================

def fetch_episodes(platform: str, url: str, page: int = 1) -> dict:
    """根据平台采集播客剧集列表"""
    platform = platform.lower().strip()

    if platform == 'ximalaya':
        album_id = extract_ximalaya_album_id(url)
        if not album_id:
            return {"platform": "ximalaya", "error": f"无法从 URL 中提取专辑 ID: {url}", "episodes": []}
        return fetch_ximalaya_tracks(album_id, page)

    elif platform == 'qingting':
        return fetch_qingting_episodes(url, page)

    elif platform == 'xiaoyuzhou':
        return fetch_xiaoyuzhou_episodes(url, page)

    else:
        return {"platform": platform, "error": f"不支持的平台: {platform}", "episodes": []}


# ============================================================
# CLI 入口
# ============================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="播客剧集采集脚本")
    parser.add_argument("--platform", required=True, help="播客平台 (ximalaya/qingting/xiaoyuzhou)")
    parser.add_argument("--url", required=True, help="播客频道 URL")
    parser.add_argument("--page", type=int, default=1, help="页码 (默认 1)")
    args = parser.parse_args()

    result = fetch_episodes(args.platform, args.url, args.page)
    print(json.dumps(result, ensure_ascii=False, indent=2))
