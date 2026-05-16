#!/usr/bin/env python3
"""
新闻联播批量采集 → Obsidian
直接从 CCTV 官网抓取，输出 MD 文件到 OB 目录，不走 PG

用法:
  python3 fetch_xwlb_to_ob.py --output /path/to/ob/报刊杂志/新闻联播 --start 20260329 --end 20260429
  python3 fetch_xwlb_to_ob.py --output /path/to/ob/报刊杂志/新闻联播 --date 20260429
"""

import urllib.request
import re
import html as html_module
import os
import sys
import argparse
from datetime import datetime, timedelta


def fetch_day(date_str: str) -> list[dict]:
    """抓取单日新闻联播列表"""
    url = f'https://tv.cctv.com/lm/xwlb/day/{date_str}.shtml'
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            page_html = resp.read().decode('utf-8')
    except Exception as e:
        print(f'  ⚠️ {date_str} 页面获取失败: {e}')
        return []

    articles = []
    seen = set()
    year = date_str[:4]
    month = date_str[4:6]
    day = date_str[6:8]
    published_at = f'{year}-{month}-{day}T19:30:00'

    # 匹配 VIDE 链接
    pattern = r'<a[^>]*href="(https?://tv\.cctv\.com/\d{4}/\d{2}/\d{2}/VIDE\w+\.shtml)"[^>]*?(?:alt|title)="([^"]*)"'
    for match in re.finditer(pattern, page_html):
        href = match.group(1)
        title = html_module.unescape(match.group(2)).strip()
        title = re.sub(r'^\[视频\]\s*', '', title)
        if not title or title.startswith('《新闻联播》'):
            continue
        if '完整版' in title and '新闻联播' in title:
            continue
        if href in seen:
            continue
        seen.add(href)
        articles.append({'title': title, 'url': href, 'published_at': published_at})

    # 也尝试 alt/title 在 href 之前的情况
    pattern2 = r'(?:alt|title)="([^"]*)"[^>]*?href="(https?://tv\.cctv\.com/\d{4}/\d{2}/\d{2}/VIDE\w+\.shtml)"'
    for match in re.finditer(pattern2, page_html):
        title = html_module.unescape(match.group(1)).strip()
        href = match.group(2)
        title = re.sub(r'^\[视频\]\s*', '', title)
        if not title or title.startswith('《新闻联播》'):
            continue
        if '完整版' in title and '新闻联播' in title:
            continue
        if href in seen:
            continue
        seen.add(href)
        articles.append({'title': title, 'url': href, 'published_at': published_at})

    return articles


def fetch_article_content(url: str) -> str:
    """抓取单条新闻正文"""
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            page_html = resp.read().decode('utf-8')
    except Exception as e:
        print(f'    ⚠️ 正文获取失败: {e}')
        return ''

    # 提取 content_area
    match = re.search(r'<div[^>]*id="content_area"[^>]*>(.*?)</div>', page_html, re.DOTALL)
    if not match:
        match = re.search(r'<div[^>]*class="content_area"[^>]*>(.*?)</div>', page_html, re.DOTALL)
    if not match:
        return ''

    content = match.group(1)
    # 去 HTML 标签
    content = re.sub(r'<[^>]+>', '', content)
    # HTML 实体
    content = html_module.unescape(content)
    # 清理空行
    content = re.sub(r'\n{3,}', '\n\n', content.strip())
    return content


def save_to_ob(articles: list[dict], date_str: str, output_dir: str):
    """保存为 OB 的 MD 文件"""
    if not articles:
        return

    year = date_str[:4]
    month = date_str[4:6]
    day = date_str[6:8]
    filename = f'{date_str}新闻联播文字稿.md'
    filepath = os.path.join(output_dir, filename)

    if os.path.exists(filepath):
        print(f'  ⏭️ {filename} 已存在，跳过')
        return

    lines = [
        f'---',
        f'source: 新闻联播',
        f'date: {year}-{month}-{day}',
        f'type: xwlb',
        f'---',
        f'',
        f'# {year}年{int(month)}月{int(day)}日 新闻联播',
        f'',
    ]

    for i, art in enumerate(articles, 1):
        lines.append(f'## {i}. {art["title"]}')
        lines.append('')
        if art.get('content'):
            lines.append(art['content'])
        else:
            lines.append(f'链接：{art["url"]}')
        lines.append('')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print(f'  ✅ {filename} ({len(articles)} 条)')


def main():
    parser = argparse.ArgumentParser(description='新闻联播批量采集 → Obsidian')
    parser.add_argument('--output', required=True, help='OB 输出目录')
    parser.add_argument('--date', help='抓取单日 (YYYYMMDD)')
    parser.add_argument('--start', help='开始日期 (YYYYMMDD)')
    parser.add_argument('--end', help='结束日期 (YYYYMMDD)')
    parser.add_argument('--with-content', action='store_true', help='是否抓取正文（较慢）')
    args = parser.parse_args()

    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    # 确定日期范围
    if args.date:
        dates = [args.date]
    elif args.start and args.end:
        start = datetime.strptime(args.start, '%Y%m%d')
        end = datetime.strptime(args.end, '%Y%m%d')
        dates = []
        current = start
        while current <= end:
            dates.append(current.strftime('%Y%m%d'))
            current += timedelta(days=1)
    else:
        dates = [datetime.now().strftime('%Y%m%d')]

    print(f'📰 开始采集新闻联播，共 {len(dates)} 天，输出到 {output_dir}')

    total_articles = 0
    for date_str in dates:
        print(f'\n📅 {date_str}')
        articles = fetch_day(date_str)
        if not articles:
            print(f'  ⚠️ 无数据')
            continue

        if args.with_content:
            for art in articles:
                art['content'] = fetch_article_content(art['url'])

        save_to_ob(articles, date_str, output_dir)
        total_articles += len(articles)

    print(f'\n✅ 完成！共 {total_articles} 条新闻')


if __name__ == '__main__':
    main()
