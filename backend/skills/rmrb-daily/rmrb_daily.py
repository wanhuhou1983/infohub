#!/usr/bin/env python3
"""
人民日报每日要闻收集脚本
========================
从人民日报电子版 (paper.people.com.cn) 抓取指定日期的要闻版面文章，
输出为格式化的 Markdown 文件。

用法:
  python rmrb_daily.py                    # 抓取今日要闻
  python rmrb_daily.py 2026-04-22         # 抓取指定日期
  python rmrb_daily.py --full             # 包含正文内容（默认只抓标题）
  python rmrb_daily.py --editions 1 2 3   # 只抓指定版面编号
  python rmrb_daily.py --output out.md    # 指定输出文件路径

依赖: requests, beautifulsoup4
  pip install requests beautifulsoup4
"""

import argparse
import re
import sys
import time
import typing
from datetime import date, timedelta
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


# ============================================================
# 配置
# ============================================================
BASE_URL = "https://paper.people.com.cn/rmrb/pc"
LAYOUT_TEMPLATE = f"{BASE_URL}/layout/{{0}}/node_{{1:02d}}.html"
CONTENT_TEMPLATE = f"{BASE_URL}/content/{{}}"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 30
REQUEST_DELAY = 0.5  # 请求间隔(秒)，礼貌爬取


def build_date_path(d: date) -> str:
    """将 date 对象转为 URL 路径中的日期格式: YYYY/MM/DD"""
    return f"{d.year}{d.month:02d}/{d.day:02d}"


def fetch_html(url: str, session: requests.Session) -> typing.Optional[str]:
    """获取页面HTML，返回文本或 None（失败时）"""
    try:
        resp = session.get(url, timeout=REQUEST_TIMEOUT)
        resp.encoding = "utf-8"
        if resp.status_code == 200:
            return resp.text
        print(f"  [!] HTTP {resp.status_code}: {url}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [!] 请求失败: {url} — {e}", file=sys.stderr)
        return None


def parse_editions(html: str, date_path: str) -> list[dict]:
    """
    从第01版页面解析所有版面列表。
    返回: [{"num": int, "name": str, "node_url": str}, ...]
    """
    soup = BeautifulSoup(html, "html.parser")
    editions = []
    # 版面导航在 .swiper-box .swiper-slide a 中
    for slide in soup.select(".swiper-box .swiper-slide a"):
        href = slide.get("href", "")
        text = slide.get_text(strip=True)
        # 匹配 "01版：要闻" 格式
        m = re.match(r"(\d+)版[：:]\s*(.+)", text)
        if m:
            num = int(m.group(1))
            name = m.group(2).strip()
            node_url = urljoin(f"{BASE_URL}/layout/{date_path}/", href)
            editions.append({
                "num": num,
                "name": name,
                "node_url": node_url,
            })
    return editions


def parse_article_list(html: str, date_path: str, edition_num: int) -> list[dict]:
    """
    从版面页面(node_XX.html)解析文章列表。
    返回: [{"title": str, "url": str}, ...]
    """
    soup = BeautifulSoup(html, "html.parser")
    articles = []
    for li in soup.select(".news .news-list li a"):
        title = li.get_text(strip=True)
        if not title:
            continue
        href = li.get("href", "")
        url = urljoin(f"{BASE_URL}/layout/{date_path}/", href)
        articles.append({"title": title, "url": url})
    return articles


def parse_article_content(html: str) -> typing.Optional[dict]:
    """
    从文章详情页提取正文内容。
    返回: {"title": str, "subtitle": str|None, "body": str} 或 None
    """
    soup = BeautifulSoup(html, "html.parser")

    # 标题
    h1_el = soup.select_one("h1 p")
    title = h1_el.get_text(strip=True) if h1_el else ""

    # 副标题/日期行
    h2_el = soup.select_one("h2 p")
    subtitle = h2_el.get_text(strip=True) if h2_el else None

    # 正文在隐藏div #articleContent 中
    content_div = soup.select_one("#articleContent")
    if not content_div:
        return None

    # 提取所有 <p> 标签的文本
    paragraphs = []
    for p in content_div.find_all("p"):
        text = p.get_text(strip=True)
        if text:
            paragraphs.append(text)

    body = "\n\n".join(paragraphs)

    if not body.strip():
        return None

    return {
        "title": title,
        "subtitle": subtitle,
        "body": body,
    }


def filter_yaowen_editions(editions: list[dict]) -> list[dict]:
    """筛选出名称包含'要闻'的版面"""
    return [e for e in editions if "要闻" in e["name"]]


def format_markdown(
    articles_by_edition: dict[int, dict],
    target_date: date,
    include_body: bool = False,
) -> str:
    """
    将抓取结果格式化为 Markdown 字符串。
    articles_by_edition: {edition_num: {"name": str, "articles": [dict, ...]}}
    """
    lines: list[str] = []

    lines.append(f"# 人民日报要闻汇总")
    lines.append("")
    lines.append(f"> **日期**: {target_date.strftime('%Y年%m月%d日')}")
    lines.append(
        f"> **来源**: [人民日报电子版]({BASE_URL}/layout/{build_date_path(target_date)}/node_01.html)"
    )
    lines.append("")

    total_articles = 0
    for ed_num in sorted(articles_by_edition.keys()):
        ed_data = articles_by_edition[ed_num]
        ed_name = ed_data["name"]
        articles = ed_data["articles"]

        if not articles:
            continue

        lines.append(f"---")
        lines.append(f"")
        lines.append(f"## 第{ed_num:02d}版：{ed_name}")
        lines.append("")

        for i, art in enumerate(articles, 1):
            lines.append(f"### {i}. {art['title']}")
            if include_body and art.get("body"):
                if art.get("subtitle"):
                    lines.append(f"*{art['subtitle']}*")
                    lines.append("")
                lines.append(art["body"])
                lines.append("")
            else:
                lines.append(f"- [查看原文]({art['url']})")
                lines.append("")

        total_articles += len(articles)

    lines.append("---")
    lines.append(f"")
    lines.append(f"*共 {total_articles} 篇要闻 · 数据来源: 人民网·人民日报电子版*")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="人民日报每日要闻收集脚本")
    parser.add_argument(
        "date",
        nargs="?",
        default=None,
        help="目标日期，格式 YYYY-MM-DD，默认今天",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        default=False,
        help="抓取完整正文内容（默认仅标题+链接）",
    )
    parser.add_argument(
        "--editions",
        nargs="+",
        type=int,
        default=None,
        help="指定要抓取的版面编号（如 1 2 3），默认自动筛选'要闻'版面",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default=None,
        help="输出文件路径，默认为 rmrb_YYYY-MM-DD.md",
    )

    args = parser.parse_args()

    # ---- 解析日期 ----
    if args.date:
        try:
            target_date = date.fromisoformat(args.date)
        except ValueError:
            print(f"[!] 日期格式错误: {args.date}，请使用 YYYY-MM-DD", file=sys.stderr)
            sys.exit(1)
    else:
        target_date = date.today()

    date_path = build_date_path(target_date)
    output_file = args.output or f"rmrb_{target_date.isoformat()}.md"

    print(f"人民日报要闻收集器")
    print(f"   目标日期: {target_date.isoformat()}")
    print(f"   完整模式: {'是' if args.full else '否（仅标题+链接）'}")
    print()

    # ---- 创建 session ----
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    # ---- Step 1: 获取第01版页面，解析所有版面 ----
    print("[1/3] 获取版面列表...")
    layout_url = LAYOUT_TEMPLATE.format(date_path, 1)
    html = fetch_html(layout_url, session)
    if not html:
        print(f"[!] 无法获取首页，可能该日无报纸数据或网络问题", file=sys.stderr)
        sys.exit(1)

    all_editions = parse_editions(html, date_path)
    if not all_editions:
        print("[!] 未找到任何版面信息", file=sys.stderr)
        sys.exit(1)

    print(f"   发现 {len(all_editions)} 个版面:", end="")
    for e in all_editions:
        print(f" {e['num']}({e['name']})", end="")
    print()

    # ---- Step 2: 筛选要抓取的版面 ----
    if args.editions is not None:
        target_editions = [e for e in all_editions if e["num"] in args.editions]
        if not target_editions:
            print(
                f"[!] 指定的版面 {args.editions} 不存在，可用版面: {[e['num'] for e in all_editions]}",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        target_editions = filter_yaowen_editions(all_editions)
        if not target_editions:
            print("[!] 未找到'要闻'版面，使用全部版面", file=sys.stderr)
            target_editions = all_editions

    print(f"[2/3] 将抓取以下版面: {[e['num'] for e in target_editions]}")
    print()

    # ---- Step 3: 逐版面抓取文章列表和正文 ----
    articles_by_edition: dict[int, dict] = {}
    total = 0

    for ed in target_editions:
        ed_num = ed["num"]
        print(f"   第{ed_num:02d}版（{ed['name']}）... ", end="")

        # 获取版面页面
        html = fetch_html(ed["node_url"], session)
        if not html:
            print("失败（无法获取页面）")
            continue

        articles = parse_article_list(html, date_path, ed_num)
        if not articles:
            print("无文章")
            continue

        # 如果需要全文，逐篇抓取
        if args.full:
            for art in articles:
                time.sleep(REQUEST_DELAY)
                art_html = fetch_html(art["url"], session)
                if art_html:
                    content = parse_article_content(art_html)
                    if content:
                        art["body"] = content["body"]
                        art["subtitle"] = content.get("subtitle")

        articles_by_edition[ed_num] = {
            "name": ed["name"],
            "articles": articles,
        }
        total += len(articles)
        print(f"{len(articles)} 篇")

        # 礼貌延迟
        time.sleep(REQUEST_DELAY)

    print()

    if not articles_by_edition:
        print("[!] 没有抓取到任何文章", file=sys.stderr)
        sys.exit(1)

    # ---- 输出 Markdown ----
    md_content = format_markdown(articles_by_edition, target_date, include_body=args.full)

    with open(output_file, "w", encoding="utf-8") as f:
        f.write(md_content)

    print(f"[OK] 完成！共 {total} 篇文章")
    print(f"   输出文件: {output_file}")


if __name__ == "__main__":
    main()