#!/usr/bin/env python3
"""
喷嚏图卦页面采集 → Obsidian
直接抓取 dapenti.com 页面内容，不使用 RSS

用法:
  python3 fetch_penti_to_ob.py --output "/Users/wuhuahui/Documents/infohub/RSS订阅/喷嚏图卦"
"""

from __future__ import annotations
import json
import os
import re
import sys
import urllib.request
import argparse
from datetime import datetime
from html import unescape


PENTI_LIST_URL = 'https://www.dapenti.com/blog/blog.asp?subjectid=70&name=xilei'
PENTI_READ_URL = 'https://www.dapenti.com/blog/readforwx.asp?name=xilei&id={id}'


def fetch_url(url: str, referer: str = 'https://www.dapenti.com/') -> bytes:
    """获取页面原始字节"""
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': referer,
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def decode_html(content: bytes) -> str:
    """智能解码 HTML 内容"""
    # 先检查是否有编码声明
    meta_match = re.search(rb'<meta[^>]+charset=([a-zA-Z0-9\-]+)', content, re.IGNORECASE)
    if meta_match:
        charset = meta_match.group(1).decode()
        try:
            return content.decode(charset, errors='replace')
        except:
            pass
    
    # 尝试常见中文编码
    for encoding in ['gbk', 'gb2312', 'gb18030', 'utf-8', 'big5']:
        try:
            text = content.decode(encoding, errors='strict')
            # 验证：检查是否包含有效的中文字符
            # 如果解码后出现大量 � 字符，说明编码不对
            if '�' not in text[:500]:
                return text
        except:
            continue
    
    # 最后用 replace 模式
    return content.decode('gbk', errors='replace')


def parse_article_list(html: str) -> list[dict]:
    """解析列表页，获取文章 ID 和标题"""
    articles = []
    # 匹配 <a href=more.asp?name=xilei&id=xxxxx>标题</a>（无引号）
    pattern = r'<a href=more\.asp\?name=xilei&id=(\d+)[^>]*>([^<]*)</a>'
    matches = re.findall(pattern, html)
    for article_id, title in matches:
        # 清理标题
        title = title.strip()
        title = re.sub(r'\s+', ' ', title)
        if '喷嚏图卦' in title:
            articles.append({'id': article_id, 'title': title})
    return articles


def parse_article_content(html: str) -> dict:
    """解析文章页，获取标题和正文（简化版：提取所有文本段落）"""
    # 尝试不同的编码重新解析页面
    # 先尝试 GB2312/GBK
    for encoding in ['gbk', 'gb2312', 'utf-8', 'big5']:
        try:
            html = html.encode('latin1').decode(encoding, errors='replace')
            break
        except:
            continue
    
    # 提取标题
    title_match = re.search(r'<h2[^>]*>(.*?)</h2>', html, re.DOTALL)
    title = title_match.group(1).strip() if title_match else ''
    # 清理 HTML 标签
    title = re.sub(r'<[^>]+>', '', title)
    title = unescape(title).strip()
    
    # 找到正文容器（移动版页面可能没有 table）
    # 直接提取所有有内容的文字段落
    text_parts = []
    images = []
    
    # 提取所有图片
    images = re.findall(r'<img[^>]+src="([^"]+)"', html)
    images = [img for img in images if 'dapenti.com' in img or img.startswith('http')]
    
    # 提取所有段落文字（<p> 标签）
    p_matches = re.findall(r'<p[^>]*>(.*?)</p>', html, re.DOTALL)
    for p in p_matches:
        # 清理内部标签但保留链接文字
        # 先处理有链接的情况
        links = re.findall(r'<a[^>]*href="([^"]+)"[^>]*>([^<]*)</a>', p)
        
        # 移除所有 HTML 标签
        text = re.sub(r'<[^>]+>', '', p)
        text = unescape(text).strip()
        
        # 过滤无效内容
        if text and len(text) > 5:
            # 还原链接
            for url, link_text in links:
                if link_text:
                    text = text.replace(link_text, f'[{link_text}]({url})')
            
            # 排除广告、无效字符
            if not any(x in text.lower() for x in ['function', 'adsbygoogle', 'google', 'hide']):
                text_parts.append(text)
    
    # 提取 _wbtext_ 类的文字（这些是带换行的重要内容）
    wbtext_matches = re.findall(r'<span[^>]*class="_wbtext_"[^>]*>(.*?)</span>', html, re.DOTALL)
    for wt in wbtext_matches:
        # 清理标签
        wt = re.sub(r'<[^>]+>', '', wt)
        wt = unescape(wt).strip()
        if wt and len(wt) > 10:
            text_parts.append(wt)
    
    # 去重并保持顺序
    seen = set()
    unique_parts = []
    for p in text_parts:
        if p not in seen:
            seen.add(p)
            unique_parts.append(p)
    
    content = '\n\n'.join(unique_parts[:50])  # 限制内容长度
    
    return {
        'title': title,
        'content': content,
        'images': images,
    }


def main():
    parser = argparse.ArgumentParser(description='喷嚏图卦页面采集 → Obsidian')
    parser.add_argument('--output', required=True, help='OB 输出目录')
    parser.add_argument('--limit', type=int, default=5, help='采集条数')
    args = parser.parse_args()

    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    print(f'📋 抓取喷嚏图卦列表页...')

    try:
        list_bytes = fetch_url(PENTI_LIST_URL)
        list_html = decode_html(list_bytes)
    except Exception as e:
        print(f'❌ 获取列表页失败: {e}')
        return

    articles = parse_article_list(list_html)
    print(f'  找到 {len(articles)} 篇文章')

    if not articles:
        # 备选：直接从页面提取所有链接
        print('  ⚠️ 尝试备选解析方式...')
        pattern = r'<a href="more\.asp\?name=xilei&id=(\d+)"[^>]*>([^<]*)</a>'
        matches = re.findall(pattern, list_html)
        for article_id, title in matches[:args.limit]:
            title = title.strip() or f'喷嚏图卦 {article_id}'
            articles.append({'id': article_id, 'title': title})

    total = 0
    for i, art in enumerate(articles[:args.limit], 1):
        article_id = art['id']
        title = art['title']
        
        # 提取日期（从标题中）
        date_match = re.search(r'(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})', title)
        if date_match:
            date_str = f'{date_match.group(1)}{int(date_match.group(2)):02d}{int(date_match.group(3)):02d}'
        else:
            date_str = datetime.now().strftime('%Y%m%d')
        
        # 文件名
        safe_title = re.sub(r'[<>:"/\\|?*]', '', title).strip()[:60]
        filename = f'{date_str}-{safe_title}.md'
        target_file = os.path.join(output_dir, filename)

        if os.path.exists(target_file):
            print(f'  ⏭️ [{i}] {title[:30]}... 已存在')
            continue

        print(f'  📥 [{i}] {title[:40]}...', end=' ', flush=True)

        try:
            read_url = PENTI_READ_URL.format(id=article_id)
            article_bytes = fetch_url(read_url, referer=PENTI_LIST_URL)
            article_html = decode_html(article_bytes)
            article_data = parse_article_content(article_html)
        except Exception as e:
            print(f'❌ 获取正文失败: {e}')
            continue

        # 生成 Markdown
        md_content = f'''---
title: "{title}"
date: {datetime.now().strftime('%Y-%m-%d')}
source: 喷嚏网
url: {read_url}
tags:
  - 喷嚏图卦
---

> 每天一图卦，让我们更清楚地了解这个世界

## 正文

{article_data['content']}

---

**图片列表：**
'''
        for img_url in article_data.get('images', []):
            md_content += f'\n![图片]({img_url})'

        with open(target_file, 'w', encoding='utf-8') as f:
            f.write(md_content)

        print('✅')
        total += 1

    print(f'\n✅ 完成！采集 {total} 篇')


if __name__ == '__main__':
    main()