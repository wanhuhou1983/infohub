#!/usr/bin/env python3
"""
腾讯新闻采集 → Obsidian
调用 tencent-news-cli，解析输出，逐条抓取正文，保存到 OB 目录

用法:
  python3 fetch_tencent_to_ob.py --output /path/to/ob/报刊杂志/腾讯新闻 --limit 20
  python3 fetch_tencent_to_ob.py --output /path/to/ob/报刊杂志/腾讯新闻 --limit 20 --with-content
"""

import subprocess
import sys
import os
import re
import html as html_module
import urllib.request
import argparse
from datetime import datetime


def parse_tencent_output(text: str) -> list[dict]:
    """解析 tencent-news-cli 的文本输出"""
    articles = []
    pattern = re.compile(
        r'(\d+)\.\s*标题[：:]\s*(.+?)\n'
        r'\s*摘要[：:]\s*(.+?)\n'
        r'\s*来源[：:]\s*(.+?)\n'
        r'\s*发布时间[：:]\s*(.+?)\n'
        r'\s*链接[：:]\s*(.+?)(?:\n|$)',
        re.DOTALL
    )
    for match in pattern.finditer(text):
        articles.append({
            'index': int(match.group(1)),
            'title': match.group(2).strip(),
            'summary': match.group(3).strip(),
            'source': match.group(4).strip(),
            'published_at': match.group(5).strip(),
            'url': match.group(6).strip(),
        })
    return articles


def fetch_article_content_mineru(url: str) -> str:
    """用 MinerU 抓取正文（和后端一致的方式）"""
    mineru_script = os.path.expanduser(
        '~/.workbuddy/skills/mineru-extract/scripts/mineru_extract.py'
    )
    if not os.path.exists(mineru_script):
        print(f'    ⚠️ MinerU 脚本不存在: {mineru_script}')
        return ''

    try:
        result = subprocess.run(
            [sys.executable, mineru_script, url, '--model', 'MinerU-HTML', '--print'],
            capture_output=True, text=True, timeout=30,
            cwd=os.path.dirname(mineru_script),
        )
        if result.returncode != 0 or not result.stdout.strip():
            return ''
        content = result.stdout.strip()
        # 清理 MinerU 输出的图片格式
        content = re.sub(r'!\[.*?\]\((https?://[^)]+)\)', r'![](\1)', content)
        return content
    except subprocess.TimeoutExpired:
        print(f'    ⚠️ MinerU 超时')
        return ''
    except Exception as e:
        print(f'    ⚠️ MinerU 异常: {e}')
        return ''


def save_to_ob(articles: list[dict], output_dir: str):
    """保存为 OB 的 MD 文件"""
    if not articles:
        print('⚠️ 无文章数据')
        return

    now = datetime.now()
    date_str = now.strftime('%Y%m%d')
    filename = f'{date_str}腾讯新闻.md'
    filepath = os.path.join(output_dir, filename)

    lines = [
        f'---',
        f'source: 腾讯新闻',
        f'date: {now.strftime("%Y-%m-%d")}',
        f'type: tencent',
        f'---',
        f'',
        f'# 腾讯新闻热点 {now.strftime("%Y年%m月%d日")}',
        f'',
    ]

    for art in articles:
        lines.append(f'## {art["index"]}. {art["title"]}')
        lines.append('')
        lines.append(f'> 来源：{art["source"]} · {art["published_at"]}')
        lines.append('')
        if art.get('content'):
            lines.append(art['content'])
            lines.append('')
        else:
            lines.append(art['summary'])
            lines.append('')
        lines.append(f'[查看原文]({art["url"]})')
        lines.append('')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print(f'✅ 已保存 {filename} ({len(articles)} 条)')


def main():
    parser = argparse.ArgumentParser(description='腾讯新闻采集 → Obsidian')
    parser.add_argument('--output', required=True, help='OB 输出目录')
    parser.add_argument('--limit', type=int, default=20, help='新闻条数')
    parser.add_argument('--with-content', action='store_true', help='抓取正文（较慢）')
    args = parser.parse_args()

    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    cli_path = os.path.expanduser('~/.workbuddy/skills/tencent-news/tencent-news-cli')
    if not os.path.exists(cli_path):
        print(f'❌ 找不到腾讯新闻 CLI: {cli_path}')
        sys.exit(1)

    print(f'📰 采集腾讯新闻热点（{args.limit} 条）...')
    try:
        result = subprocess.run(
            [cli_path, 'hot', '--limit', str(args.limit)],
            capture_output=True, text=True, timeout=60
        )
        if result.returncode != 0:
            print(f'❌ 采集失败: {result.stderr}')
            sys.exit(1)
    except subprocess.TimeoutExpired:
        print('❌ 采集超时')
        sys.exit(1)

    articles = parse_tencent_output(result.stdout)
    print(f'   解析到 {len(articles)} 条新闻')

    if args.with_content:
        print(f'   抓取正文中...')
        for art in articles:
            print(f'    {art["index"]}. {art["title"][:30]}...', end=' ', flush=True)
            art['content'] = fetch_article_content_mineru(art['url'])
            has_content = bool(art['content'])
            print('✅' if has_content else '⚠️ 无正文')

    save_to_ob(articles, output_dir)


if __name__ == '__main__':
    main()
