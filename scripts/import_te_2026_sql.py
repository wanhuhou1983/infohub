#!/usr/bin/env python3
"""经济学人 TE-2026-04-25 直接入库脚本（SQL）"""
import json
import os
import re
import hashlib
import random
import requests
import psycopg2

BOOK_DIR = "/Users/wuhuahui/.workbuddy/skills/epub-read/.epub_read_output/6c9126e8-530a-4e55-b6d6-8e09701b6661"
SOURCE_ID = 1536

DB_CONFIG = {"host": "localhost", "port": 5433, "database": "infohub", "user": "infohub", "password": "infohub123"}

key_file = os.path.expanduser("~/.workbuddy/keys/baidu_translate.json")
with open(key_file) as f:
    config = json.load(f)
    APP_ID = config.get("appid")
    APP_KEY = config.get("secretKey")

EXCLUDE_CHAPTERS = ["ch011-letters", "ch013-by-invitation"]

def translate(text):
    if not text or not text.strip(): return text
    url = "https://fanyi-api.baidu.com/api/trans/vip/translate"
    salt = str(random.randint(32768, 65536))
    sign = APP_ID + text + salt + APP_KEY
    sign = hashlib.md5(sign.encode("utf-8")).hexdigest()
    data = {"q": text, "from": "en", "to": "zh", "appid": APP_ID, "salt": salt, "sign": sign}
    try:
        r = requests.post(url, data=data, timeout=10)
        result = r.json()
        if "trans_result" in result: return result["trans_result"][0]["dst"]
    except: pass
    return text

def process_content(content, base_url):
    def replace_img(m):
        path = m.group(1)
        full_url = f"{base_url}/data/te-2026-04-25/{path}" if path.startswith("images/") else f"{base_url}/data/te-2026-04-25/images/{path}"
        return f"__IMG__{full_url}__IMG__"
    return re.sub(r'!\[\]\((images/[^)]+)\)', replace_img, content)

conn = psycopg2.connect(**DB_CONFIG)
cur = conn.cursor()

manifest = json.load(open(os.path.join(BOOK_DIR, "manifest.json")))
chunks = [c for c in manifest.get("chunks", []) if c["chapter_id"] not in EXCLUDE_CHAPTERS]
print(f"过滤后 chunks: {len(chunks)}")

articles = {}
for c in chunks:
    cid = c["chapter_id"]
    if cid not in articles: articles[cid] = {"title": c["chapter_title"], "chunks": []}
    articles[cid]["chunks"].append(c)

print(f"文章数: {len(articles)}")

base_url = "http://localhost:3001"
count = 0

for cid, info in sorted(articles.items(), key=lambda x: int(x[0].replace("ch", "").split("-")[0])):
    title = info["title"]
    full_content = ""
    for chunk in sorted(info["chunks"], key=lambda x: x["chunk_index"]):
        with open(os.path.join(BOOK_DIR, chunk["file"])) as f:
            content = f.read()
        if "---" in content: content = content.split("---", 2)[-1]
        full_content += content.strip() + "\n\n"
    
    title_zh = translate(title)
    title_bilingual = f"{title_zh} [{title}]"
    
    content_to_translate = full_content[:8000]
    content_translated = translate(content_to_translate)
    if len(full_content) > 8000: content_translated += "\n\n" + full_content[8000:]
    
    content_final = process_content(content_translated, base_url)
    
    # 计算 content_hash
    content_hash = hashlib.md5(content_final.encode()).hexdigest()
    
    try:
        cur.execute("""
            INSERT INTO articles (source_id, title, content, published_at, fetched_at, content_hash)
            VALUES (%s, %s, %s, %s, NOW(), %s)
            ON CONFLICT (content_hash) DO NOTHING
            RETURNING id
        """, (SOURCE_ID, title_bilingual, content_final, "2026-04-25", content_hash))
        conn.commit()
        if cur.rowcount > 0:
            count += 1
            print(f"[{count}] OK: {title_zh[:40]}")
    except Exception as e:
        print(f"[{count}] FAIL: {title_zh[:40]} - {e}")
        conn.rollback()
    
    import time
    time.sleep(0.25)

cur.close()
conn.close()
print(f"\n完成！共入库 {count} 篇")
