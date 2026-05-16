#!/usr/bin/env python3
"""
经济学人 TE-2026-04-25 入库脚本 v3
- 按分区映射入库，每章为独立文章
- 每个文章的 extra.section 记录一级分区名
- 翻译标题 + 分段翻译正文
- 入库 PG + 写入 OB
- 排除 Letters / By Invitation
"""

import json, os, re, hashlib, random, requests, psycopg2, time, sys
from datetime import datetime

# ============ 配置 ============
BOOK_DIR = "/Users/wuhuahui/.workbuddy/skills/epub-read/.epub_read_output/6c9126e8-530a-4e55-b6d6-8e09701b6661"
SOURCE_ID = 1536
ISSUE_DATE = "2026-04-25"
SOURCE_NAME = "The Economist"
OB_BASE = os.path.expanduser("~/Documents/infohub/报刊杂志/The Economist")

DB = {"host": "localhost", "port": 5433, "database": "infohub", "user": "infohub", "password": "infohub123"}

# 百度翻译
key_file = os.path.expanduser("~/.workbuddy/keys/baidu_translate.json")
with open(key_file) as f:
    cfg = json.load(f)
    APP_ID, APP_KEY = cfg["appid"], cfg["secretKey"]

# ============ 分区映射 ============
# 每个分区包含的 chapter_id 列表
SECTION_MAP = {
    "The World This Week": [
        "ch001-the-world-this-week", "ch002-politics", "ch003-business",
        "ch004-the-weekly-cartoon",
    ],
    "Leaders": [
        "ch005-leaders",
        "ch006-america-is-vulnerable-to-electoral-vandalism",
        "ch007-tim-cook-wrote-a-winning-recipe-for-apple",
        "ch008-how-to-bolster-the-arsenal-of-democracy",
        "ch009-the-high-price-of-forever-wars",
        "ch010-pomp-and-pageantry-wont-save-britains-alliance-with-america",
    ],
    "Briefing": [
        "ch012-is-the-impending-food-shock-caused-by-the-iran-war-preventable",
        "ch014-irans-insistence-on-controlling-hormuz-is-penny-smart-dollar-foolish",
        "ch015-ai-is-the-new-oracle-of-delphi-thats-bad-news",
        "ch016-briefing",
        "ch017-might-donald-trump-try-to-rig-the-midterms",
    ],
    "United States": [
        "ch018-united-states",
        "ch019-virginias-redistricting-may-be-the-nail-in-republicans-coffin",
        "ch020-wealthy-new-yorkers-grumble-as-a-new-tax-looms",
        "ch021-artificial-intelligence-is-creeping-into-american-lawmaking",
        "ch022-donald-trumps-bold-new-deportation-machine",
        "ch023-why-congress-keeps-getting-dumber",
    ],
    "The Americas": [
        "ch024-the-americas",
        "ch025-as-the-world-cup-approaches-north-american-relations-are-at-a-nadir",
        "ch026-albertans-find-it-harder-than-expected-to-break-from-canada-good",
        "ch027-a-botched-election-adds-to-perus-democratic-dysfunction",
    ],
    "Asia": [
        "ch028-asia",
        "ch029-what-do-the-geopolitical-successes-of-asim-munir-mean-for-pakistan",
        "ch030-honking-is-harming-indias-healthand-its-economy",
        "ch031-an-anti-china-protest-lands-kazakhs-in-prison",
        "ch032-why-japan-is-loosening-restrictions-on-exports-of-lethal-arms",
        "ch033-what-have-the-mughals-ever-done-for-us",
    ],
    "China": [
        "ch034-china",
        "ch035-how-chinese-satellites-have-boosted-irans-war-effort",
        "ch036-why-chinas-exports-will-keep-on-rising",
        "ch037-the-world-wants-chinese-tech-china-is-determined-to-keep-it",
    ],
    "Middle East & Africa": [
        "ch038-middle-east-africa",
        "ch039-israels-open-ended-wars-have-eroded-its-security",
        "ch040-an-extended-ceasefire-over-iran-but-for-how-long",
        "ch041-which-iran-is-america-dealing-with",
        "ch042-how-a-sudanese-militia-built-a-military-and-economic-empire",
        "ch043-abiy-ahmed-is-throttling-free-expression-in-ethiopia",
    ],
    "Europe": [
        "ch044-europe",
        "ch045-can-the-germans-fight",
        "ch046-ukraines-quest-for-new-friends-takes-it-to-turkey-and-syria",
        "ch047-as-russia-looks-to-slash-budgets-a-village-fights-to-survive",
        "ch048-how-europe-regulated-itself-into-american-vassalage",
    ],
    "Britain": [
        "ch049-britain",
        "ch050-britain-rethinks-its-special-relationship-with-america",
        "ch051-the-international-problem-of-weasel-words",
        "ch052-british-nukes-are-utterly-reliant-on-america",
        "ch053-a-wave-of-antisemitic-attacks-in-britain-reveals-a-new-threat",
        "ch054-britains-reliance-on-ukrainian-eggs-is-ruffling-feathers",
        "ch055-waterstones-shows-there-is-still-life-in-the-british-high-street",
        "ch056-sir-keir-starmer-cannot-govern-he-has-only-himself-to-blame",
    ],
    "International": [
        "ch057-international",
        "ch058-anduril-palantir-and-spacex-are-changing-how-america-wages-war",
        "ch059-there-is-no-better-spur-to-military-innovation-than-war",
        "ch060-europes-defence-startups-face-even-bigger-hurdles-than-americas",
        "ch061-a-dangerous-blind-spot-in-donald-trumps-iran-war-strategy",
    ],
    "1843": [
        "ch062-1843",
        "ch063-the-republican-congressman-taking-on-trump",
        "ch064-apples-new-boss-needs-to-restore-its-magic-for-the-ai-era",
        "ch065-jeff-bezos-is-raising-his-game-in-space",
        "ch066-why-your-ai-assistant-is-suddenly-selling-to-you",
        "ch067-from-allbirds-to-glossier-millennial-brands-have-lost-their-mojo",
        "ch068-donald-trump-is-giving-psychedelic-medicines-a-welcome-boost",
        "ch069-the-curious-rise-of-chinese-whisky",
        "ch070-americas-descent-into-state-capitalism-is-exaggerated",
    ],
    "Finance & Economics": [
        "ch071-finance-economics",
        "ch072-xi-jinping-wants-a-powerful-currency-americas-war-has-helped",
        "ch073-chinamaxxing-is-starting-to-catch-on-in-china",
        "ch074-american-corporate-profits-keep-shrugging-off-global-tumult",
        "ch075-global-energy-markets-are-on-the-verge-of-a-disaster",
        "ch076-renewables-are-shining-the-iran-war-amplifies-their-appeal",
        "ch077-the-stablecoin-market-has-got-too-stable",
        "ch078-has-the-world-bank-performed-a-u-turn-on-industrial-policy",
    ],
    "Science & Technology": [
        "ch079-science-technology",
        "ch080-scientists-are-still-learning-from-the-chernobyl-nuclear-disaster",
        "ch081-how-to-stop-colour-blind-grouse-flying-into-ski-lifts",
        "ch082-crypto-miners-are-quietly-colonising-computers",
        "ch083-is-bone-broth-good-for-you",
    ],
    "Culture": [
        "ch084-culture",
        "ch085-the-rhetoric-of-war-has-changed-not-for-the-better",
        "ch086-in-the-ai-propaganda-war-iran-is-winning",
        "ch087-in-a-new-biopic-michael-jackson-is-an-eccentric-saint-yuck",
        "ch088-judy-blumes-radical-honesty-changed-literature-for-ever",
        "ch089-runaway-success-marathon-organisers-are-seeing-record-demand",
        "ch090-ibram-x-kendis-illiberal-views-on-race-are-out-of-favour-good",
    ],
    "Economic & Financial Indicators": [
        "ch091-economic-financial-indicators",
        "ch092-economic-data-commodities-and-markets",
    ],
    "Obituary": [
        "ch093-obituary",
        "ch094-mark-mobius-dared-to-go-where-few-others-did",
    ],
}

# 反向映射：chapter_id -> section_name
CHAPTER_TO_SECTION = {}
for sec, ch_list in SECTION_MAP.items():
    for ch in ch_list:
        CHAPTER_TO_SECTION[ch] = sec

# 排除的 chapter_id
EXCLUDED = {"ch011-letters", "ch013-by-invitation"}

# 分区中作为 section header 的章节（内容简短，仅起分区标题作用）
SECTION_HEADER_CHAPTERS = {
    "ch001-the-world-this-week", "ch005-leaders", "ch016-briefing",
    "ch018-united-states", "ch024-the-americas", "ch028-asia",
    "ch034-china", "ch038-middle-east-africa", "ch044-europe",
    "ch049-britain", "ch057-international", "ch062-1843",
    "ch071-finance-economics", "ch079-science-technology", "ch084-culture",
    "ch091-economic-financial-indicators", "ch093-obituary",
}

# ============ 翻译 ============
def translate(text):
    if not text or len(text.strip()) < 2:
        return text
    url = "https://fanyi-api.baidu.com/api/trans/vip/translate"
    salt = str(random.randint(32768, 65536))
    sign = hashlib.md5((APP_ID + text + salt + APP_KEY).encode()).hexdigest()
    try:
        r = requests.post(url, data={"q": text, "from": "en", "to": "zh", "appid": APP_ID, "salt": salt, "sign": sign}, timeout=15)
        j = r.json()
        if "trans_result" in j:
            return j["trans_result"][0]["dst"]
    except Exception as e:
        print(f"  [TR ERR] {e}")
    return text

# ============ 图片处理 ============
def process_images(content):
    """转换 ![](images/xxx.jpg) -> __IMG__url__IMG__"""
    def replace_img(m):
        path = m.group(1)
        url = f"http://localhost:3001/data/te-2026-04-25/{path}" if path.startswith("images/") else f"http://localhost:3001/data/te-2026-04-25/images/{path}"
        return f"__IMG__{url}__IMG__"
    return re.sub(r'!\[\]\((images/[^)]+)\)', replace_img, content)

# ============ OB 写入 ============
def write_ob_file(section, chapter_id, title, content, article_id, published_at):
    """写入 OB Markdown 文件"""
    date_str = published_at.replace("-", "")
    ob_dir = os.path.join(OB_BASE, date_str, section)
    os.makedirs(ob_dir, exist_ok=True)

    # 从 chapter_id 提取序号用于排序
    seq = chapter_id.replace("ch", "")
    # 文件名：序号-标题.md
    clean_title = re.sub(r'[\/\\:*?"<>|\n\r]', '', title)[:60]
    clean_title = re.sub(r'\s+', '_', clean_title)
    filename = f"{seq}-{clean_title}.md"

    # 构建 frontmatter
    date_obj = datetime.strptime(published_at, "%Y-%m-%d")
    fm = f"""---
id: {article_id}
source: "{SOURCE_NAME}"
source_type: "magazine"
published_at: "{published_at}"
section: "{section}"
---

"""
    filepath = os.path.join(ob_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(fm)
        f.write(content)
    return filepath

# ============ 主流程 ============
def main():
    # 连接 DB
    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    # 读取 manifest
    manifest_path = os.path.join(BOOK_DIR, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)

    chunks = manifest.get("chunks", [])

    # 按 chapter_id 分组 chunk
    chapter_chunks = {}
    chapter_titles = {}
    for c in chunks:
        cid = c["chapter_id"]
        if cid in EXCLUDED:
            continue
        if cid not in chapter_chunks:
            chapter_chunks[cid] = []
            chapter_titles[cid] = c["chapter_title"]
        chapter_chunks[cid].append(c)

    # 按章节编号排序
    ordered_chapters = sorted(chapter_chunks.items(), key=lambda x: int(x[0].replace("ch", "").split("-")[0]))

    total = 0
    errors = 0

    for cid, chunk_list in ordered_chapters:
        # 确定分区
        section = CHAPTER_TO_SECTION.get(cid)
        if not section:
            print(f"[SKIP] {cid}: 未找到分区映射")
            continue

        # 合并 chunk 内容
        full_content = ""
        for ck in sorted(chunk_list, key=lambda x: x["chunk_index"]):
            ck_path = os.path.join(BOOK_DIR, ck["file"])
            with open(ck_path) as f:
                text = f.read()
            # 去掉 frontmatter (--- 之间的内容)
            if text.startswith("---"):
                parts = text.split("---", 2)
                if len(parts) >= 3:
                    text = parts[2]
            full_content += text.strip() + "\n\n"

        title_en = chapter_titles[cid]
        is_header = cid in SECTION_HEADER_CHAPTERS

        # 翻译标题
        title_zh = translate(title_en)
        title_bilingual = f"{title_zh} [{title_en}]"

        # 分段翻译正文（跳过 section header 的翻译？不，也翻译）
        if full_content.strip():
            paras = re.split(r'\n\s*\n', full_content)
            translated_paras = []
            for p in paras:
                if len(p) > 1000:
                    # 长段落分段翻译
                    sub_paras = []
                    for j in range(0, len(p), 1000):
                        sub = p[j:j+1000]
                        sub_paras.append(translate(sub))
                    translated_paras.append("\n".join(sub_paras))
                else:
                    translated_paras.append(translate(p))
            content = "\n\n".join(translated_paras)
        else:
            content = full_content

        # 处理图片
        content = process_images(content)

        # 计算 content_hash (与后端 hashString 一致使用 MD5)
        content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()

        # 构建 extra
        extra = json.dumps({"section": section})

        # 入库
        try:
            cur.execute("""
                INSERT INTO articles (source_id, title, content, published_at, fetched_at, content_hash, extra, author, category)
                VALUES (%s, %s, %s, %s, NOW(), %s, %s::jsonb, %s, %s)
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
            """, (SOURCE_ID, title_bilingual, content, ISSUE_DATE, content_hash, extra, SOURCE_NAME, section))

            conn.commit()

            inserted_id = cur.fetchone()
            if cur.rowcount > 0 and inserted_id:
                article_id = inserted_id[0]
                total += 1

                # 写入 OB
                ob_path = write_ob_file(section, cid, title_bilingual, content, article_id, ISSUE_DATE)
                print(f"[{total:2d}] [{section:30s}] {title_zh[:40]}")
            else:
                print(f"[DUP] [{section:30s}] {title_zh[:40]} (已存在，跳过)")

        except Exception as e:
            conn.rollback()
            errors += 1
            print(f"[ERR] [{section:30s}] {title_en[:40]}: {e}")

        time.sleep(0.3)  # 翻译 API 限速

    cur.close()
    conn.close()
    print(f"\n===== 完成！共入库 {total} 篇，错误 {errors} 个 =====")

if __name__ == "__main__":
    main()
