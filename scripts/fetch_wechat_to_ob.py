#!/usr/bin/env python3
"""
微信公众号文章采集 → Obsidian
从 WeFlow 获取公众号最近文章 URL，用 wechat-article-spider v2.0（Playwright + markdownify）下载 MD+图片，存入 OB 目录

用法:
  python3 fetch_wechat_to_ob.py --output /Users/wuhuahui/Documents/infohub/微信公众号 --limit 5
"""

from __future__ import annotations
import json
import subprocess
import sys
import os
import re
import urllib.request
import shutil
import argparse
from datetime import datetime


def format_article_date(create_time: int) -> str:
    """将 Unix 时间戳转换为 yyyymmdd 格式"""
    if not create_time:
        return datetime.now().strftime('%Y%m%d')
    try:
        dt = datetime.fromtimestamp(create_time)
        return dt.strftime('%Y%m%d')
    except:
        return datetime.now().strftime('%Y%m%d')


WEFLOW_API = 'http://127.0.0.1:5031/api/v1'
WEFLOW_TOKEN = '3ec6f66be8234004882d7eab6ff1d2c3'

# 17 个目标公众号
TARGET_ACCOUNTS = {
    'gh_3ee45937d812': '林荣雄策略会客厅',
    'gh_a7ab52c5ae39': '仙人JUMP',
    'gh_e80b5c3c8b87': '冰川思享号',
    'gh_94dba26f8ca0': '数字生命卡兹克',
    'gh_ebf6d07b9027': 'palmmicro',
    'gh_969fe10b52f8': '董指导研究',
    'gh_eed4c5477396': '饕餮海投资',
    'gh_4ed187a4bb37': '远川研究所',
    'gh_b3d6850fe55f': '长安卫公',
    'gh_114e76fd6e5d': '量子位',
    'gh_be03e39a3848': '持有封基',
    'gh_2169c6d917f9': '新潮沉思录',
    'gh_ed48d1306766': '鑫爷低风险投资',
    'gh_ba045a96f332': '孤独大脑',
    'gh_c6a64d431303': '思想钢印',
    'gh_f05e41738ac2': '饭统戴老板',
    'gh_e39013197589': '静听烟雨任平生',
}

SPIDER_DIR = '/Users/wuhuahui/WorkBuddy/20260422122342/wechat-article-spider'
SPIDER_SCRIPT = os.path.join(SPIDER_DIR, 'scripts', 'main.py')
SPIDER_VENV = os.path.join(SPIDER_DIR, '.venv', 'bin', 'python3')
SPIDER_OUTPUT = os.path.join(SPIDER_DIR, 'output')


def weflow_request(path: str, params: dict = None) -> dict:
    """调用 WeFlow API"""
    url = f'{WEFLOW_API}{path}'
    if params:
        qs = '&'.join(f'{k}={v}' for k, v in params.items())
        url = f'{url}?{qs}'

    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {WEFLOW_TOKEN}',
        'User-Agent': 'InfoHub/1.0',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def get_article_urls(gh_id: str, limit: int = 5) -> list[dict]:
    """从 WeFlow 获取公众号最近的文章 URL 和标题"""
    data = weflow_request('/messages', {'talker': gh_id, 'limit': str(limit * 3)})
    articles = []

    for msg in data.get('messages', []):
        rc = msg.get('rawContent', '')
        create_time = msg.get('createTime', 0)
        url_m = re.search(r'<url><!\[CDATA\[(.*?)\]\]></url>', rc)
        title_m = re.search(r'<title><!\[CDATA\[(.*?)\]\]></title>', rc)
        
        if url_m and title_m:
            url = url_m.group(1)
            title = title_m.group(1)
            if 'mp.weixin.qq.com' in url:
                articles.append({'title': title, 'url': url, 'createTime': create_time})
        elif title_m:
            # 兼容没有 url 标签的情况（如孤独大脑等视频号类型）
            title = title_m.group(1)
            url = None
            articles.append({'title': title, 'url': url, 'createTime': create_time})

    return articles[:limit]


def download_with_spider(url: str) -> str | None:
    """用 wechat-article-spider v2.0 下载文章，返回 MD 文件路径"""
    python_cmd = SPIDER_VENV if os.path.exists(SPIDER_VENV) else sys.executable

    try:
        # v2.0: 不再接受输出目录参数，固定输出到 SPIDER_DIR/output/<title>/
        # 先记录 output 目录的当前内容
        before = set()
        if os.path.isdir(SPIDER_OUTPUT):
            before = set(os.listdir(SPIDER_OUTPUT))

        result = subprocess.run(
            [python_cmd, SPIDER_SCRIPT, url],
            capture_output=True, text=True, timeout=120,
            cwd=SPIDER_DIR,
        )
        if result.returncode != 0:
            print(f'spider 返回码 {result.returncode}: {result.stderr[:200]}')
            return None

        # v2.0: 找 output/ 下新增的目录
        if not os.path.isdir(SPIDER_OUTPUT):
            return None
        now = set(os.listdir(SPIDER_OUTPUT))
        new_dirs = now - before

        # v2.0 spider 在 output/<title>/ 下生成 <title>.md
        for d in sorted(new_dirs, reverse=True):
            dir_path = os.path.join(SPIDER_OUTPUT, d)
            if os.path.isdir(dir_path):
                md_path = os.path.join(dir_path, f'{d}.md')
                if os.path.isfile(md_path):
                    return md_path

        # fallback: 按修改时间取最新的 .md
        md_candidates = []
        for d in os.listdir(SPIDER_OUTPUT):
            dp = os.path.join(SPIDER_OUTPUT, d, f'{d}.md')
            if os.path.isfile(dp):
                md_candidates.append((os.path.getmtime(dp), dp))
        if md_candidates:
            md_candidates.sort(reverse=True)
            return md_candidates[0][1]

        return None

    except subprocess.TimeoutExpired:
        return None
    except Exception as e:
        print(f'    ⚠️ spider 异常: {e}')
        return None


def sanitize_filename(name: str) -> str:
    """清理文件名中的非法字符"""
    return re.sub(r'[<>:"/\\|?*]', '', name).strip()[:80]


def convert_frontmatter(v2_md: str, source_name: str, article_url: str,
                        create_time: int) -> tuple[str, str, str]:
    """
    将 v2.0 的 frontmatter 转换为 InfoHub/Obsidian 格式。
    返回 (body_content, new_frontmatter_yaml, images_handle_hint)
    images_handle_hint: 'subdir' 表示图片在 `<title>/images/` 下，'flat' 表示同级
    """
    # 解析 v2.0 frontmatter
    v2_title = ''
    v2_author = ''
    v2_date = ''

    if v2_md.startswith('---'):
        end_idx = v2_md.find('---', 3)
        if end_idx > 0:
            fm_block = v2_md[3:end_idx].strip()
            body = v2_md[end_idx + 3:].strip()

            for line in fm_block.split('\n'):
                m = re.match(r'^title:\s*"(.*)"\s*$', line)
                if m: v2_title = m.group(1)
                m = re.match(r'^author:\s*"(.*)"\s*$', line)
                if m: v2_author = m.group(1)
                m = re.match(r'^date:\s*"(.*)"\s*$', line)
                if m: v2_date = m.group(1)
        else:
            body = v2_md
    else:
        body = v2_md

    # 如果 v2 没有提取到 title，从正文第一行 # 取
    if not v2_title:
        title_m = re.match(r'^#\s+(.+)$', body, re.MULTILINE)
        v2_title = title_m.group(1) if title_m else ''

    # 发布日期
    published_at = ''
    if v2_date:
        try:
            dt = datetime.strptime(v2_date, '%Y-%m-%d %H:%M')
            published_at = dt.isoformat()
        except:
            published_at = v2_date
    elif create_time:
        dt = datetime.fromtimestamp(create_time)
        published_at = dt.isoformat()

    crawled_at = datetime.now().strftime('%Y-%m-%dT%H:%M:%S')

    # 构建 InfoHub 格式 frontmatter
    new_fm = (
        '---\n'
        f'source: "{source_name}"\n'
        f'source_type: "wechat"\n'
        f'url: "{article_url}"\n'
        f'published_at: "{published_at}"\n'
        f'crawled_at: "{crawled_at}"\n'
        f'title: "{v2_title}"\n'
        f'author: "{v2_author}"\n'
        'category: "综合"\n'
        'tags: ["综合"]\n'
        'is_read: false\n'
        '---\n\n'
    )

    return body, new_fm, v2_title


def main():
    parser = argparse.ArgumentParser(description='微信公众号文章采集 → Obsidian')
    parser.add_argument('--output', required=True, help='OB 输出目录')
    parser.add_argument('--limit', type=int, default=5, help='每个公众号采集条数')
    args = parser.parse_args()

    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    print(f'📰 采集微信公众号文章（每号 {args.limit} 篇）...')

    total = 0
    failed = 0

    for gh_id, name in TARGET_ACCOUNTS.items():
        print(f'\n📱 {name} ({gh_id})')
        account_dir = os.path.join(output_dir, name)
        os.makedirs(account_dir, exist_ok=True)

        try:
            articles = get_article_urls(gh_id, args.limit)
        except Exception as e:
            print(f'  ❌ WeFlow 获取失败: {e}')
            failed += args.limit
            continue

        if not articles:
            print(f'  ⚠️ 无文章')
            continue

        print(f'  找到 {len(articles)} 篇文章')

        for i, art in enumerate(articles, 1):
            # 获取文章日期并加前缀
            article_date = format_article_date(art.get('createTime', 0))
            title_with_date = f"{article_date}-{art['title']}"
            safe_title = sanitize_filename(title_with_date)

            # 检查是否有 URL（没有 URL 的如孤独大脑，跳过下载）
            if not art.get('url'):
                print(f'  ⏭️ [{i}] {art["title"][:30]}... 无链接(可能为视频号内容)')
                continue

            target_file = os.path.join(account_dir, f'{safe_title}.md')

            if os.path.exists(target_file):
                print(f'  ⏭️ [{i}] {art["title"][:30]}... 已存在')
                continue

            print(f'  📥 [{i}] {art["title"][:40]}...', end=' ', flush=True)

            md_path = download_with_spider(art['url'])

            if not md_path or not os.path.exists(md_path):
                print('❌ spider 下载失败')
                failed += 1
                continue

            # 读取 v2.0 输出的 MD
            with open(md_path, 'r', encoding='utf-8') as f:
                v2_content = f.read()

            body, new_fm, v2_title = convert_frontmatter(v2_content, name, art['url'], art.get('createTime', 0))

            # 写目标文件
            with open(target_file, 'w', encoding='utf-8') as f:
                f.write(new_fm)
                f.write(body)

            # 处理图片：v2.0 图片在 output/<title>/images/ 下
            # spider 输出目录名 = safe_title from spider (re.sub(r'[/\\?%*:|"<>]', "_", title)[:80])
            spider_safe_title = re.sub(r'[/\\?%*:|"<>]', '_', v2_title)[:80]
            spider_article_dir = os.path.join(SPIDER_OUTPUT, spider_safe_title)
            spider_img_dir = os.path.join(spider_article_dir, 'images')

            if os.path.isdir(spider_img_dir):
                target_img_dir = os.path.join(account_dir, 'images')
                os.makedirs(target_img_dir, exist_ok=True)
                for fname in os.listdir(spider_img_dir):
                    src = os.path.join(spider_img_dir, fname)
                    if os.path.isfile(src):
                        dst = os.path.join(target_img_dir, fname)
                        if not os.path.exists(dst):
                            shutil.copy2(src, dst)

                # 修正 MD 中的图片路径（从 ./images/ 改为 ../images/）
                with open(target_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                content = content.replace('](./images/', '](../images/').replace('](images/', '](../images/')
                with open(target_file, 'w', encoding='utf-8') as f:
                    f.write(content)

            # 清理 spider 输出
            shutil.rmtree(spider_article_dir, ignore_errors=True)

            print('✅')
            total += 1

    print(f'\n✅ 完成！成功 {total} 篇，失败 {failed} 篇')


if __name__ == '__main__':
    main()
