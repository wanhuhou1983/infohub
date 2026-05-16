#!/usr/bin/env python3
"""经济学人 TE-2026-04-25 入库脚本 v2 - 分步处理"""
import json, os, re, hashlib, random, requests, psycopg2, time

BOOK_DIR = "/Users/wuhuahui/.workbuddy/skills/epub-read/.epub_read_output/6c9126e8-530a-4e55-b6d6-8e09701b6661"
SOURCE_ID = 1536

DB = {"host": "localhost", "port": 5433, "database": "infohub", "user": "infohub", "password": "infohub123"}

with open(os.path.expanduser("~/.workbuddy/keys/baidu_translate.json")) as f:
    cfg = json.load(f)
    APP_ID, APP_KEY = cfg["appid"], cfg["secretKey"]

EXCLUDE = ["ch011-letters", "ch013-by-invitation"]

def tr(text):
    if not text or len(text.strip()) < 2: return text
    url = "https://fanyi-api.baidu.com/api/trans/vip/translate"
    salt = str(random.randint(32768, 65536))
    sign = hashlib.md5((APP_ID + text + salt + APP_KEY).encode()).hexdigest()
    try:
        r = requests.post(url, data={"q": text, "from": "en", "to": "zh", "appid": APP_ID, "salt": salt, "sign": sign}, timeout=15)
        j = r.json()
        if "trans_result" in j: return j["trans_result"][0]["dst"]
    except Exception as e:
        print(f"  [TR ERR] {e}")
    return text

def proc_img(m):
    path = m.group(1)
    url = f"http://localhost:3001/data/te-2026-04-25/{path}" if path.startswith("images/") else f"http://localhost:3001/data/te-2026-04-25/images/{path}"
    return f"__IMG__{url}__IMG__"

# 删除旧数据
conn = psycopg2.connect(**DB)
cur = conn.cursor()
cur.execute("DELETE FROM articles WHERE source_id = %s", (SOURCE_ID,))
conn.commit()
print(f"已删除旧数据")

# 读取并过滤
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
        # 去掉 frontmatter
        if "---" in c:
            c = c.split("---", 2)[-1]
        full += c.strip() + "\n\n"
    
    # 翻译标题
    title_zh = tr(info["title"])
    title = f"{title_zh} [{info['title']}]"
    
    # 翻译正文 - 分段翻译，每段最多 1000 字符
    paras = re.split(r'\n\s*\n', full)
    translated_paras = []
    for p in paras:
        if len(p) > 1000:
            # 长段落分段
            for j in range(0, len(p), 1000):
                sub = p[j:j+1000]
                translated_paras.append(tr(sub))
        else:
            translated_paras.append(tr(p))
    
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
            print(f"[{count}] {title_zh[:35]}")
    except Exception as e:
        print(f"[ERR] {title_zh[:35]}: {e}")
        conn.rollback()
    time.sleep(0.3)

cur.close()
conn.close()
print(f"\n完成！入库 {count} 篇")
