#!/usr/bin/env python3
"""
B站 UP 主视频列表采集脚本
使用 Playwright 浏览器绕过 412 反爬（WBI 签名 API）
输出：JSON 数组到 stdout，每项一个视频

用法：
  python3 bilibili-fetch.py <mid> [max_pages]
  python3 bilibili-fetch.py 316568752 2
"""

import json
import sys
import os

from playwright.sync_api import sync_playwright


def fetch_bilibili_videos(mid: str, max_pages: int = 1) -> list[dict]:
    """使用 Playwright 浏览器采集 B站 UP 主视频列表"""
    all_videos = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        # 存储拦截到的 API 响应
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
            page.goto(url, wait_until="networkidle", timeout=30000)

            if not captured.get("data"):
                # 重试一次（可能页面没触发 API）
                page.wait_for_timeout(2000)
                if not captured.get("data"):
                    break

            vlist = captured["data"].get("data", {}).get("list", {}).get("vlist", [])
            if not vlist:
                break

            all_videos.extend(vlist)
            if pn < max_pages:
                # 加载下一页需要额外等待
                page.wait_for_timeout(1000)

        browser.close()

    return all_videos


def main():
    if len(sys.argv) < 2:
        print("用法: python3 bilibili-fetch.py <mid> [max_pages]", file=sys.stderr)
        sys.exit(1)

    mid = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 1

    try:
        videos = fetch_bilibili_videos(mid, max_pages)
        print(json.dumps(videos, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
