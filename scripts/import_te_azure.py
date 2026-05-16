#!/usr/bin/env python3
"""经济学人 TE-2026-04-25 入库脚本 - Azure翻译"""
import json, os, re, hashlib, requests, psycopg2, time

BOOK_DIR = "/Users/wuhuahui/.workbuddy/skills/epub-read/.epub_read_output/6c9126e8-530a-4e55-b6d6-8e09701b6661"
SOURCE_ID = 1536
DB = {"host": "localhost", "port": 5433, "database": "infohub", "user": "infohub", "password": "infohub123"}

env = json.load(open("/Users/wuhuahui/WorkBuddy/20260422122342/infohub/.env.json"))
AZURE_KEY = env.get("AZURE_TRANSLATE_KEY")
AZURE_REGION = env.get("AZURE_TRANSLATE_REGION")
AZURE_ENDPOINT = env.get("AZURE_TRANSLATE_ENDPOINT")

EXCLUDE = ["ch011-letters", "ch013-by-invitation"]

def translate(text):
    if not text or len(text.strip()) < 2: return text
    url = f"{AZURE_ENDPOINT}translate?api-version=3.0&from=en&to=zh-Hans"
    headers = {"Ocp-Apim-Subscription-Key": AZURE_KEY, "Ocp-Apim-Subscription-Region": AZURE_REGION, "Content-Type": "application/json"}
    try:
        r = requests.post(url, json=[{"text": text}], headers=headers, timeout=20)
        j = r.json()
        if j and isinstance(j, list) and "translations" in j[0]:
            return j[0]["translations"][0]["text"]
    except Exception as e:
        print(f"TR ERR: {e}")
    return text

def proc_img(m):
    path = m.group(1)
    url = f"http://localhost:3001/data/te-2026-04-25/{path}" if path.startswith("images/") else f"http://localhost:3001/data/te-2026-04-25/images/{path}"
    return f"__IMG__{url}__IMG__"

# 连接数据库
conn = psycopg2.connect(**DB)
cur = conn.cursor()

# 读取 manifest
manifest = json.load(open(os.path.join(BOOK_DIR, "manifest.json")))
chunks = [c for c in manifest["chunks"] if c["chapter_id"] not in EXCLUDE]

# 分组
articles = {}
for c in chunks:
    cid = c["chapter_id"]
    if cid not in articles:
        articles[cid] = {"title": c["chapter_title"], "chunks": []}
    articles[cid]["chunks"].append(c)

print(f"文章数: {len(articles)}")

count = 0
for i, (cid, info) in enumerate(sorted(articles.items(), key=lambda x: int(x[0].replace("ch", "").split("-")[0])), 1):
    # 合并内容
    full = ""
    for ck in sorted(info["chunks"], key=lambda x: x["chunk_index"]):
        with open(os.path.join(BOOK_DIR, ck["file"])) as f:
            c = f.read()
        if "---" in c:
            c = c.split("---", 2)[-1]
        full += c.strip() + "\n\n"
    
    # 翻译标题
    title_zh = translate(info["title"])
    title = f"{title_zh} [{info['title']}]"
    
    # 翻译正文 - 分段处理
    paras = re.split(r'\n\s*\n', full)
    translated_paras = []
    for p in paras:
        if p.strip():
            # 每段单独翻译
            tr_p = translate(p)
            translated_paras.append(tr_p)
    
    content = "\n\n".join(translated_paras)
    # 处理图片
    content = re.sub(r'!\[\]\((images/[^)]+)\)', proc_img, content)
    
    # 入库
    h = hashlib.md5(content.encode()).hexdigest()
    try:
        cur.execute("INSERT INTO articles (source_id, title, content, published_at, fetched_at, content_hash) VALUES (%s,%s,%s,%s,NOW(),%s) ON CONFLICT (content_hash) DO NOTHING",
            (SOURCE_ID, title, content, "2026-04-25", h))
        conn.commit()
        if cur.rowcount:
            count += 1
            print(f"[{count}] {title_zh[:40]}")
    except Exception as e:
        print(f"[ERR] {title_zh[:40]}: {e}")
        conn.rollback()
    
    time.sleep(0.15)  # 减少延迟

cur.close()
conn.close()
print(f"\n完成！入库 {count} 篇")