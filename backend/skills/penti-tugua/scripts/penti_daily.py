#!/usr/bin/env python3
"""
喷嚏图卦采集脚本
用法: python3 penti_daily.py [YYYYMMDD] [--output /path/to/output.md]
依赖: requests, beautifulsoup4
"""
import sys
import json
import argparse
import os
import re
import subprocess
import tempfile

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("缺少依赖，请先安装: pip install requests beautifulsoup4", file=sys.stderr)
    sys.exit(1)


def fetch_page(url: str, timeout: int = 15) -> str:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
    }
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.encoding = 'gb2312'
    return resp.text


def find_today_link(html: str, date: str):
    """从列表页找出今天日期对应的文章链接和标题"""
    soup = BeautifulSoup(html, 'html.parser')
    short_date = date[4:8]   # 0610

    for a in soup.find_all('a', href=True):
        href = a['href']
        title = a.get_text(strip=True)
        if 'more.asp' in href and ('2026' + date[4:] in title or short_date in title):
            return href, title

    # fallback: 找最新的
    for a in soup.find_all('a', href=True):
        href = a['href']
        title = a.get_text(strip=True)
        if 'more.asp' in href:
            return href, title

    return '', ''


def extract_raw_html(html: str) -> str:
    """
    从文章页提取正文原始 HTML。
    定位 class=oblog_t_2 的 td 开口标签，
    取其后面到最后一个 </td> 之间的内容。
    """
    # 找 oblog_t_2 td 开口标签
    m = re.search(
        r'<td[^>]*class=["\']oblog_t_2["\'][^>]*>',
        html,
        re.IGNORECASE
    )
    if not m:
        # fallback: 返回整个 body
        body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL | re.IGNORECASE)
        if body_match:
            return body_match.group(1)
        return html

    start = m.end()
    # 找最后一个 </td>（正文区域的结束）
    end = html.rfind('</td>')
    if end < start:
        end = len(html)
    return html[start:end]


def convert_to_markdown(raw_html: str, title: str, output_md: str) -> bool:
    """调用 html_to_md.py 将原始 HTML 转为 Markdown"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    converter = os.path.join(script_dir, 'html_to_md.py')
    if not os.path.exists(converter):
        print(f'转换器不存在: {converter}', file=sys.stderr)
        return False

    tmp_json = output_md + '.tmp.json'
    with open(tmp_json, 'w', encoding='utf-8') as f:
        json.dump({'title': title, 'html': raw_html}, f, ensure_ascii=False)

    try:
        result = subprocess.run(
            ['python3', converter, tmp_json, output_md],
            timeout=30,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f'转换失败({result.returncode}): {result.stderr}', file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f'转换异常: {e}', file=sys.stderr)
        return False
    finally:
        try:
            os.unlink(tmp_json)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('date', nargs='?', default='')
    parser.add_argument('--output', default='')
    args = parser.parse_args()

    import datetime
    from datetime import date as date_cls

    if args.date:
        date = args.date.replace('-', '')
    else:
        today = date_cls.today()
        now = datetime.datetime.now()
        # 18:00 前用昨天，18:00 后用今天
        if now.hour < 18:
            d = today - datetime.timedelta(days=1)
        else:
            d = today
        date = d.strftime('%Y%m%d')

    print(f'目标日期: {date}', file=sys.stderr)

    # Step1: 列表页
    print('[1/4] 获取列表页...', file=sys.stderr)
    list_html = fetch_page('https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei')
    href, title = find_today_link(list_html, date)
    if not href:
        print(f'未找到 {date} 的喷嚏图卦', file=sys.stderr)
        sys.exit(1)

    print(f'找到: {title} | {href}', file=sys.stderr)

    # Step2: 文章页
    print('[2/4] 获取文章页...', file=sys.stderr)
    art_url = href if href.startswith('http') else 'https://www.dapenti.com/blog/' + href
    art_html = fetch_page(art_url)

    # Step3: 提取原始 HTML
    print('[3/4] 提取正文 HTML...', file=sys.stderr)
    raw_html = extract_raw_html(art_html)
    if not raw_html.strip():
        print('未提取到正文 HTML', file=sys.stderr)
        sys.exit(1)
    print(f'  正文 HTML 长度: {len(raw_html)}', file=sys.stderr)

    # Step4: 转 Markdown
    print('[4/4] 转换为 Markdown...', file=sys.stderr)
    clean_title = title.replace('【', '').replace('】', '')

    if args.output:
        ok = convert_to_markdown(raw_html, clean_title, args.output)
        if not ok:
            print('Markdown 转换失败', file=sys.stderr)
            sys.exit(1)
        print(f'已写入: {args.output}', file=sys.stderr)
        # 在文件开头加上标题行
        with open(args.output, 'r+', encoding='utf-8') as f:
            content = f.read()
            f.seek(0)
            f.write(f'# {clean_title}\n\n{content}')
    else:
        # 输出到 stdout (JSON 格式)
        tmp_md = args.output or '/tmp/penti_out.md'
        ok = convert_to_markdown(raw_html, clean_title, tmp_md)
        if not ok:
            print('Markdown 转换失败', file=sys.stderr)
            sys.exit(1)
        with open(tmp_md, 'r', encoding='utf-8') as f:
            content = f.read()
        result = {
            'title': clean_title,
            'content': content,
            'url': art_url,
            'date': date,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
