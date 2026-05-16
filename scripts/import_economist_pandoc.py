#!/usr/bin/env python3
"""
经济学人 EPUB 入库脚本 (Pandoc 版)
- 读取 epub_pandoc.py 的输出 (book.json + images/)
- 按分区映射入库，每章为独立文章
- 图片上传 COS，替换为 COS 绝对 URL
- 翻译标题 + 正文（分段翻译）
- 入库 PG + 写入 OB
- 排除 Letters / By Invitation
"""

import argparse
import json
import os
import re
import sys
import time
import hashlib
import random
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
import psycopg2
from qcloud_cos import CosConfig, CosS3Client

# ============ 常量 ============

COS_SUBDIR = "economist"  # COS 存储路径 images/economist/

# ============ 分区映射 ============
# chapter_id（不含 ch 前缀和后续 slug，只匹配数字部分）到分区的映射
# 格式："ch{NUM}" -> section_name
SECTION_MAP = {
    # The World This Week
    "ch001": "The World This Week",  # Masthead
    "ch002": "The World This Week",
    "ch003": "The World This Week",
    "ch004": "The World This Week",
    "ch005": "The World This Week",
    # Leaders
    "ch006": "Leaders",
    "ch007": "Leaders",
    "ch008": "Leaders",
    "ch009": "Leaders",
    "ch010": "Leaders",
    "ch011": "Leaders",
    # Briefing
    "ch013": "Briefing",
    "ch015": "Briefing",
    "ch016": "Briefing",
    "ch017": "Briefing",
    "ch018": "Briefing",
    # United States
    "ch019": "United States",
    "ch020": "United States",
    "ch021": "United States",
    "ch022": "United States",
    "ch023": "United States",
    "ch024": "United States",
    # The Americas
    "ch025": "The Americas",
    "ch026": "The Americas",
    "ch027": "The Americas",
    "ch028": "The Americas",
    # Asia
    "ch029": "Asia",
    "ch030": "Asia",
    "ch031": "Asia",
    "ch032": "Asia",
    "ch033": "Asia",
    "ch034": "Asia",
    # China
    "ch035": "China",
    "ch036": "China",
    "ch037": "China",
    "ch038": "China",
    # Middle East & Africa
    "ch039": "Middle East & Africa",
    "ch040": "Middle East & Africa",
    "ch041": "Middle East & Africa",
    "ch042": "Middle East & Africa",
    "ch043": "Middle East & Africa",
    "ch044": "Middle East & Africa",
    # Europe
    "ch045": "Europe",
    "ch046": "Europe",
    "ch047": "Europe",
    "ch048": "Europe",
    "ch049": "Europe",
    # Britain
    "ch050": "Britain",
    "ch051": "Britain",
    "ch052": "Britain",
    "ch053": "Britain",
    "ch054": "Britain",
    "ch055": "Britain",
    "ch056": "Britain",
    "ch057": "Britain",
    # International
    "ch058": "International",
    "ch059": "International",
    "ch060": "International",
    "ch061": "International",
    "ch062": "International",
    # 1843
    "ch063": "1843",
    "ch064": "1843",
    "ch065": "1843",
    "ch066": "1843",
    "ch067": "1843",
    "ch068": "1843",
    "ch069": "1843",
    "ch070": "1843",
    "ch071": "1843",
    "ch072": "1843",
    # Finance & Economics
    "ch073": "Finance & Economics",
    "ch074": "Finance & Economics",
    "ch075": "Finance & Economics",
    "ch076": "Finance & Economics",
    "ch077": "Finance & Economics",
    "ch078": "Finance & Economics",
    "ch079": "Finance & Economics",
    "ch080": "Finance & Economics",
    # Science & Technology
    "ch081": "Science & Technology",
    "ch082": "Science & Technology",
    "ch083": "Science & Technology",
    "ch084": "Science & Technology",
    "ch085": "Science & Technology",
    # Culture
    "ch086": "Culture",
    "ch087": "Culture",
    "ch088": "Culture",
    "ch089": "Culture",
    "ch090": "Culture",
    "ch091": "Culture",
    "ch092": "Culture",
    # Economic & Financial Indicators
    "ch093": "Economic & Financial Indicators",
    # Obituary
    "ch094": "Obituary",
    "ch095": "Obituary",
}

# 排除的 chapter_id
EXCLUDED = {"ch012", "ch014"}  # Letters, By Invitation

# 分区标题章节（短篇概述，保留但标记为 header）
SECTION_HEADERS = {
    "ch002",  # The world this week
    "ch006",  # Leaders
    "ch017",  # Briefing
    "ch019",  # United States
    "ch025",  # The Americas
    "ch029",  # Asia
    "ch035",  # China
    "ch039",  # Middle East & Africa
    "ch045",  # Europe
    "ch050",  # Britain
    "ch058",  # International
    "ch063",  # 1843
    "ch073",  # Finance & economics
    "ch081",  # Science & technology
    "ch086",  # Culture
    "ch093",  # Economic & financial indicators
    "ch094",  # Obituary
}


# ============ COS 工具 ============

class CosManager:
    """腾讯云 COS 上传管理器"""

    def __init__(self, config_path: str = os.path.expanduser("~/.cos/cos.conf")):
        self.config: dict[str, str] = {}
        self.client: Optional[CosS3Client] = None
        self.bucket: str = ""
        self.region: str = ""
        self._load_config(config_path)
        self._init_client()

    def _load_config(self, path: str) -> None:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("[") or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    self.config[k.strip()] = v.strip()
        self.bucket = self.config.get("bucket", "")
        self.region = self.config.get("region", "")

    def _init_client(self) -> None:
        secret_id = self.config.get("secret_id", "")
        secret_key = self.config.get("secret_key", "")
        if not secret_id or not secret_key:
            print("[COS] 未找到 COS 配置，跳过上传")
            return
        cfg = CosConfig(SecretId=secret_id, SecretKey=secret_key, Region=self.region)
        self.client = CosS3Client(cfg)

    def upload(self, local_path: str, key: str) -> Optional[str]:
        """上传文件到 COS，返回 COS URL"""
        if not self.client:
            return None
        try:
            self.client.upload_file(
                Bucket=self.bucket,
                Key=key,
                LocalFilePath=local_path,
            )
            return f"https://{self.bucket}.cos.{self.region}.myqcloud.com/{key}"
        except Exception as e:
            print(f"  [COS ERR] {key}: {e}")
            return None


# ============ 翻译工具 ============

class Translator:
    """百度翻译"""

    def __init__(self):
        key_file = os.path.expanduser("~/.workbuddy/keys/baidu_translate.json")
        with open(key_file) as f:
            cfg = json.load(f)
        self.app_id = cfg["appid"]
        self.app_key = cfg["secretKey"]

    def translate(self, text: str) -> str:
        if not text or len(text.strip()) < 2:
            return text
        url = "https://fanyi-api.baidu.com/api/trans/vip/translate"
        salt = str(random.randint(32768, 65536))
        sign_str = self.app_id + text + salt + self.app_key
        sign = hashlib.md5(sign_str.encode()).hexdigest()
        try:
            r = requests.post(url, data={
                "q": text, "from": "en", "to": "zh",
                "appid": self.app_id, "salt": salt, "sign": sign,
            }, timeout=15)
            j = r.json()
            if "trans_result" in j:
                return j["trans_result"][0]["dst"]
        except Exception as e:
            print(f"  [TR ERR] {e}")
        return text


# ============ 图片处理 ============

def extract_img_refs(content: str) -> list[str]:
    """从 Markdown 内容中提取图片引用路径
    处理 ![](images/xxx.jpg) 和 ![](images/xxx.jpg "alt text") 两种格式
    """
    refs = re.findall(r'!\[.*?\]\((images/[^\s")]+)', content)
    return list(set(refs))


def replace_img_refs(content: str, img_map: dict[str, str]) -> str:
    """替换图片引用为 ![](COS_URL) 格式"""
    for rel_path, cos_url in img_map.items():
        # 替换 ![](images/xxx.jpg) 为 ![](COS_URL)
        content = content.replace(
            f"![]({rel_path})",
            f"![]({cos_url})"
        )
        # 也处理有 alt text 的: ![](images/xxx.jpg "alt") -> ![](COS_URL)
        content = re.sub(
            rf'!\[.*?\]\({re.escape(rel_path)}(?:\s+"[^"]*")?\)',
            f"![]({cos_url})",
            content,
        )
    return content


def process_images_for_chapter(
    content: str,
    images_dir: str,
    cos: CosManager,
) -> tuple[str, int]:
    """
    处理章节内容中的图片引用：
    1. 提取相对路径
    2. 上传到 COS
    3. 替换为 COS URL
    返回 (处理后的内容, 成功上传数)
    """
    refs = extract_img_refs(content)
    if not refs:
        return content, 0

    img_map: dict[str, str] = {}
    uploaded = 0

    for rel_path in refs:
        local_path = os.path.join(images_dir, os.path.basename(rel_path))
        if not os.path.exists(local_path):
            print(f"  [IMG WARN] 本地图片不存在: {local_path}")
            continue

        # 用 MD5 生成文件名，避免重名
        with open(local_path, "rb") as f:
            img_data = f.read()
        ext = os.path.splitext(rel_path)[1].lower()
        if not ext:
            ext = ".jpg"
        filename = hashlib.md5(img_data).hexdigest()[:16] + ext

        cos_key = f"images/{COS_SUBDIR}/{filename}"
        cos_url = cos.upload(local_path, cos_key)
        if cos_url:
            img_map[rel_path] = cos_url
            uploaded += 1
        else:
            # fallback: 用相对于 working dir 的路径
            print(f"  [IMG WARN] COS 上传失败: {rel_path}")

    content = replace_img_refs(content, img_map)
    return content, uploaded


# ============ OB 写入 ============

def write_ob_file(
    section: str,
    chapter_id: str,
    title: str,
    content: str,
    article_id: int,
    published_at: str,
    source_name: str,
    ob_base: str,
) -> str:
    """写入 OB Markdown 文件"""
    date_str = published_at.replace("-", "")
    ob_dir = os.path.join(ob_base, date_str, section)
    os.makedirs(ob_dir, exist_ok=True)

    # 从 chapter_id 提取序号
    seq = chapter_id.replace("ch", "")
    clean_title = re.sub(r'[\/\\:*?"<>|\n\r]', '', title)[:60]
    clean_title = re.sub(r'\s+', '_', clean_title)
    filename = f"{seq}-{clean_title}.md"

    fm = f"""---
id: {article_id}
source: "{source_name}"
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
    parser = argparse.ArgumentParser(description="导入经济学人 Pandoc 解析结果到 InfoHub")
    parser.add_argument("--pandoc-dir", default="/tmp/epub-test/te-2026-04-25",
                        help="epub_pandoc.py 的输出目录")
    parser.add_argument("--issue-date", default="2026-04-25",
                        help="期刊日期")
    parser.add_argument("--source-id", type=int, default=1536,
                        help="Infohub source_id")
    parser.add_argument("--source-name", default="The Economist",
                        help="信息源名称")
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=5433)
    parser.add_argument("--db-name", default="infohub")
    parser.add_argument("--db-user", default="infohub")
    parser.add_argument("--db-password", default="infohub123")
    parser.add_argument("--ob-base", default=os.path.expanduser("~/Documents/infohub/报刊杂志/The Economist"),
                        help="OB 输出根目录")
    parser.add_argument("--translate", action="store_true", default=True,
                        help="是否翻译")
    parser.add_argument("--no-translate", action="store_false", dest="translate",
                        help="跳过翻译")
    parser.add_argument("--dry-run", action="store_true",
                        help="仅预览，不写入 PG/OB")
    args = parser.parse_args()

    pandoc_dir = args.pandoc_dir
    images_dir = os.path.join(pandoc_dir, "images")
    book_json_path = os.path.join(pandoc_dir, "book.json")

    if not os.path.exists(book_json_path):
        print(f"[ERR] 未找到 book.json: {book_json_path}")
        sys.exit(1)

    # ============ 初始化 ============

    print("初始化...", flush=True)
    cos = CosManager() if not args.dry_run else None
    translator = Translator() if args.translate else None

    # 连接 DB（dry-run 跳过）
    conn = None
    cur = None
    if not args.dry_run:
        conn = psycopg2.connect(
            host=args.db_host, port=args.db_port,
            dbname=args.db_name, user=args.db_user, password=args.db_password,
        )
        cur = conn.cursor()

    # ============ 读取 book.json ============

    with open(book_json_path) as f:
        book = json.load(f)

    chapters = book.get("chapters", [])
    total_chapters = len(chapters)
    print(f"共 {total_chapters} 章", flush=True)

    # ============ 开始导入 ============

    stats = {"total": 0, "inserted": 0, "duplicated": 0, "skipped": 0, "errors": 0}
    total_images_uploaded = 0

    for ch in chapters:
        chapter_id = ch["chapter_id"]  # e.g. "ch002-the-world-this-week"
        cid_prefix = chapter_id.split("-")[0]  # e.g. "ch002"
        title_en = ch["chapter_title"]
        content_md = ch.get("content_markdown", "")
        char_count = ch.get("char_count", 0)

        stats["total"] += 1

        # 排除
        if cid_prefix in EXCLUDED:
            stats["skipped"] += 1
            print(f"[SKIP] {chapter_id}: {title_en[:40]}")
            continue

        # 分区映射
        section = SECTION_MAP.get(cid_prefix)
        if not section:
            stats["skipped"] += 1
            print(f"[SKIP] {chapter_id}: 未找到分区映射")
            continue

        is_header = cid_prefix in SECTION_HEADERS

        # ===== Dry run 模式：快速输出 =====
        if args.dry_run:
            refs = extract_img_refs(content_md)
            img_note = f" ({len(refs)}张图)" if refs else ""
            print(f"[DRY] [{section:30s}] {title_en[:40]}{img_note}", flush=True)
            continue

        # ===== 图片处理 =====
        content, img_count = process_images_for_chapter(content_md, images_dir, cos)
        total_images_uploaded += img_count
        if img_count > 0:
            print(f"  [IMG] 处理 {img_count} 张图片", flush=True)

        # ===== 翻译 =====
        if translator:
            title_zh = translator.translate(title_en)
            title_bilingual = f"{title_zh} [{title_en}]"

            # 分段翻译正文（每段独立翻译，长段落 2000 字符分段）
            if content.strip():
                paras = re.split(r'\n\s*\n', content)
                translated_paras = []
                for p in paras:
                    if len(p) > 2000:
                        sub_paras = []
                        for j in range(0, len(p), 2000):
                            sub = p[j:j+2000]
                            sub_paras.append(translator.translate(sub))
                        translated_paras.append("\n".join(sub_paras))
                    else:
                        translated_paras.append(translator.translate(p))
                content = "\n\n".join(translated_paras)
        else:
            title_bilingual = title_en

        # ===== 计算 content_hash =====
        content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()

        # ===== 构建 extra =====
        extra = json.dumps({"section": section}, ensure_ascii=False)

        # ===== 入库 PG =====
        try:
            cur.execute("""
                INSERT INTO articles (source_id, title, content, published_at, fetched_at, content_hash, extra, author, category)
                VALUES (%s, %s, %s, %s, NOW(), %s, %s::jsonb, %s, %s)
                ON CONFLICT (content_hash) DO NOTHING
                RETURNING id
            """, (
                args.source_id,
                title_bilingual,
                content,
                args.issue_date,
                content_hash,
                extra,
                args.source_name,
                section,
            ))
            conn.commit()

            inserted_id = cur.fetchone()
            if cur.rowcount > 0 and inserted_id:
                article_id = inserted_id[0]
                stats["inserted"] += 1

                # ===== 写入 OB =====
                ob_path = write_ob_file(
                    section, chapter_id, title_bilingual, content,
                    article_id, args.issue_date, args.source_name, args.ob_base,
                )
                print(f"[{stats['inserted']:2d}] [{section:30s}] {title_zh[:40] if translator else title_en[:40]}", flush=True)
            else:
                stats["duplicated"] += 1
                print(f"[DUP] [{section:30s}] {title_en[:40]} (已存在)", flush=True)

        except Exception as e:
            conn.rollback()
            stats["errors"] += 1
            print(f"[ERR] [{section:30s}] {title_en[:40]}: {e}", flush=True)

        # 翻译 API 限速
        if translator:
            time.sleep(0.3)

    # ============ 统计 ============
    if cur:
        cur.close()
    if conn:
        conn.close()

    print(f"""
===== 完成！=====
总章节:   {stats['total']}
已写入:   {stats['inserted']}
已存在:   {stats['duplicated']}
已跳过:   {stats['skipped']}
错误:     {stats['errors']}
图片上传: {total_images_uploaded} 张
=====
""")


if __name__ == "__main__":
    main()
