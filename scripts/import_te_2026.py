#!/usr/bin/env python3
"""
经济学人 TE-2026-04-25 入库脚本
- 过滤 Letters 和 By Invitation
- 翻译标题和正文
- 处理图片路径
"""
import json
import os
import re
import sys
import time
import hashlib
import random
import requests
from datetime import datetime

# 配置
BOOK_DIR = "/Users/wuhuahui/.workbuddy/skills/epub-read/.epub_read_output/6c9126e8-530a-4e55-b6d6-8e09701b6661"
IMAGES_DIR = "/Users/wuhuahui/WorkBuddy/20260422122342/infohub/data/te-2026-04-25/images"
SOURCE_ID = 1536
API_BASE = "http://localhost:3001"

# 百度翻译配置
key_file = os.path.expanduser("~/.workbuddy/keys/baidu_translate.json")
with open(key_file) as f:
    config = json.load(f)
    APP_ID = config.get("appid")
    APP_KEY = config.get("secretKey")

# 排除的章节
EXCLUDE_CHAPTERS = ["ch011-letters", "ch013-by-invitation"]

def translate(text):
    """百度翻译"""
    if not text or not text.strip():
        return text
    url = "https://fanyi-api.baidu.com/api/trans/vip/translate"
    salt = str(random.randint(32768, 65536))
    sign = APP_ID + text + salt + APP_KEY
    sign = hashlib.md5(sign.encode("utf-8")).hexdigest()
    data = {"q": text, "from": "en", "to": "zh", "appid": APP_ID, "salt": salt, "sign": sign}
    try:
        r = requests.post(url, data=data, timeout=10)
        result = r.json()
        if "trans_result" in result:
            return result["trans_result"][0]["dst"]
    except Exception as e:
        print(f"翻译错误: {e}")
    return text

def process_content(content, base_url):
    """处理内容：转换图片路径"""
    # 转换 ![](images/xxx.jpg) 为 __IMG__url__IMG__
    def replace_img(m):
        path = m.group(1)
        # 相对路径转绝对路径
        if path.startswith("images/"):
            full_url = f"{base_url}/data/te-2026-04-25/{path}"
        else:
            full_url = f"{base_url}/data/te-2026-04-25/images/{path}"
        return f"__IMG__{full_url}__IMG__"
    
    content = re.sub(r'!\[\]\((images/[^)]+)\)', replace_img, content)
    return content

def main():
    # 读取 manifest
    manifest_path = os.path.join(BOOK_DIR, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    
    chunks = manifest.get("chunks", [])
    
    # 过滤
    filtered = [c for c in chunks if c["chapter_id"] not in EXCLUDE_CHAPTERS]
    print(f"过滤后 chunks: {len(filtered)}")
    
    # 按文章分组
    articles = {}
    for c in filtered:
        cid = c["chapter_id"]
        if cid not in articles:
            articles[cid] = {
                "title": c["chapter_title"],
                "chunks": []
            }
        articles[cid]["chunks"].append(c)
    
    print(f"文章数: {len(articles)}")
    
    # 入库每篇文章
    base_url = "http://localhost:3001"
    count = 0
    
    for cid, info in sorted(articles.items(), key=lambda x: int(x[0].replace("ch", "").split("-")[0])):
        title = info["title"]
        
        # 合并 chunk 内容
        full_content = ""
        for chunk in sorted(info["chunks"], key=lambda x: x["chunk_index"]):
            chunk_file = os.path.join(BOOK_DIR, chunk["file"])
            with open(chunk_file) as f:
                content = f.read()
            # 去掉 frontmatter
            if "---" in content:
                content = content.split("---", 2)[-1]
            full_content += content.strip() + "\n\n"
        
        # 翻译标题
        title_zh = translate(title)
        title_bilingual = f"{title_zh} [{title}]"
        
        # 翻译正文（只翻译前 8000 字符，避免超时）
        content_to_translate = full_content[:8000]
        content_translated = translate(content_to_translate)
        
        # 如果正文被截断，后半部分不翻译
        if len(full_content) > 8000:
            content_translated += "\n\n" + full_content[8000:]
        
        # 处理图片路径
        content_final = process_content(content_translated, base_url)
        
        # 入库
        payload = {
            "source_id": SOURCE_ID,
            "title": title_bilingual,
            "content": content_final,
            "published_at": "2026-04-25"
        }
        
        try:
            r = requests.post(f"{API_BASE}/api/articles", json=payload, timeout=30)
            if r.status_code in [200, 201]:
                count += 1
                print(f"[{count}] OK: {title_zh[:40]}")
            else:
                print(f"[{count}] FAIL: {title_zh[:40]} - {r.status_code}")
        except Exception as e:
            print(f"[{count}] ERROR: {title_zh[:40]} - {e}")
        
        time.sleep(0.3)
    
    print(f"\n完成！共入库 {count} 篇")

if __name__ == "__main__":
    main()
