#!/usr/bin/env python3
"""
epub_pandoc.py — Pandoc 驱动的 EPUB → Markdown 解析器

使用 pandoc 替换自制 HTML→Markdown 转换，解决以下问题：
1. 错误换行（首字母下沉、R&D 跨 span）
2. 无图片
3. 句子重复

输出格式与 epub-read skill 的 parse_epub.py 兼容相同目录结构：
  {output_dir}/{book_id}/
    metadata.json    — 书籍元数据
    toc.json         — 目录
    book.json        — 章节列表
    manifest.json    — 清单
    chapters/        — 每章单独的 Markdown 文件
    images/          — 提取的图片

用法：
  python3 epub_pandoc.py /path/to/book.epub [--output-dir OUTPUT_DIR] [--book-id BOOK_ID]
"""

from __future__ import annotations

import argparse, json, os, re, shutil, subprocess, sys, tempfile, warnings, xml.etree.ElementTree as ET, zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

# Suppress XMLParsedAsHTMLWarning — EPUB XHTML is technically XML but HTML parser is fine
try:
    from bs4 import XMLParsedAsHTMLWarning  # type: ignore
    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)
except ImportError:
    warnings.filterwarnings("ignore", message=".*XML document using an HTML parser.*")


# ============ 常量 ============

HTML_TYPES = {"application/xhtml+xml", "text/html"}
REMOVAL_TAGS = {"nav", "script", "style", "noscript", "template"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
ALL_MEDIA = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"}


# ============ 工具函数 ============

def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def slugify(value: str, fallback: str = "item") -> str:
    import unicodedata
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    clean = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text).strip("-").lower()
    return clean or fallback


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_zip_text(archive: zipfile.ZipFile, member_path: str) -> str:
    raw = archive.read(member_path)
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def resolve_href(base_path: str, href: str) -> str:
    import posixpath
    clean = unquote((href or "").split("#", 1)[0])
    joined = posixpath.join(posixpath.dirname(base_path), clean)
    return posixpath.normpath(joined)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    ensure_dir(path.parent)
    path.write_text(content, encoding="utf-8")


# ============ HTML 预处理 ============

def preprocess_html(html_text: str) -> str:
    """
    清洗 HTML 以让 pandoc 输出更干净：
    1. 移除 nav/script/style
    2. 剥离 class/id/style/lang 属性
    3. 展开 span/em/i/b 等内联标签
    4. 移除空标签
    """
    soup = BeautifulSoup(html_text, "lxml")

    # 移除导航/脚本/样式
    for tag in soup.find_all(REMOVAL_TAGS):
        tag.decompose()

    # 剥离属性
    skip_attrs = {"class", "id", "style", "lang", "xml:lang", "dir", "role", "tabindex"}
    for tag in soup.find_all(True):
        for attr in list(tag.attrs.keys()):
            if attr in skip_attrs or attr.startswith("data-") or attr.startswith("aria-"):
                del tag.attrs[attr]

    # 展开内联标签
    for tag in soup.find_all(["span", "em", "i", "b", "small", "sup", "sub"]):
        if tag.find("img") is None:
            tag.unwrap()

    # 移除空标签
    changed = True
    while changed:
        changed = False
        for tag in soup.find_all(True):
            if tag.name in ("br", "hr", "img"):
                continue
            text = tag.get_text(strip=True)
            if not text and tag.find("img") is None and tag.find("table") is None:
                tag.decompose()
                changed = True

    return str(soup)


# ============ Pandoc 转换 ============

def pandoc_convert(html_text: str, timeout: int = 30) -> str:
    """用 pandoc 将 HTML 转换为 Markdown"""
    with tempfile.NamedTemporaryFile(suffix=".html", mode="w", delete=False, encoding="utf-8") as f:
        f.write(html_text)
        tmp_path = f.name
    try:
        result = subprocess.run(
            ["pandoc", tmp_path, "-f", "html", "-t", "markdown", "--wrap=none", "--no-highlight"],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def clean_markdown(md: str) -> str:
    """清洗 pandoc 输出的 Markdown"""
    # 1. 移除 {.class} 属性标记（只移除大括号部分，不碰周围空白）
    md = re.sub(r"\{[^}]*\}", "", md)

    # 2. 移除 ::: div 标记（含前导空格）
    md = re.sub(r"^[ \t]*::+[^:\n]*$", "", md, flags=re.MULTILINE)
    md = re.sub(r"^[ \t]*:+$", "", md, flags=re.MULTILINE)

    # 3. 移除裸 HTML/SVG
    md = re.sub(r"```\s*\{?=?html\}?\n.*?\n```", "", md, flags=re.DOTALL)
    md = re.sub(r"`<[^>]*>`\{=html\}", "", md)
    md = re.sub(r"`<[^>]*>`", "", md)

    # 4. 修复缩写引用 [MAGA] → MAGA
    md = re.sub(r"\[([A-Z]{2,5})\]\[?\]?", r"\1", md)

    # 5. 修复 drop cap: **L**[argely → **Largely**
    p = r"\*\*(\w)\*\*\[(\w[\w\s,.;:'\"\-!?]*?)\]"
    md = re.sub(p, lambda m: "**" + m.group(1) + m.group(2) + "**", md)

    # 6. 修复裸露的 [word]word 引用
    md = re.sub(r"\[([a-z][\w\s,.\-]*?)\]([a-zA-Z])", r"\1\2", md)
    md = re.sub(r"([a-zA-Z,.!?])\[(\w+)\]", r"\1\2", md)

    # 7. 移除 EPUB 内部链接（保留外部 http/https 链接）
    # 模式 A: feed/article/index/content 开头的相对路径
    md = re.sub(
        r"\[([^\]]+)\]\((?:feed|index|article|content)\d*[^)\s]*\)",
        r"\1", md
    )
    # 模式 B: 以 ../../ 或 ../../feed_ 等内部引用路径
    md = re.sub(
        r"\[([^\]]+)\]\((?:\.\./)+[^)\s]*\)",
        r"\1", md
    )

    # 7b. 修复 # ## 双标题 → ## 标题
    md = re.sub(r"^# +## ", "## ", md, flags=re.MULTILINE)

    # 8. 修复 R & D → R&D
    md = re.sub(r"\b([A-Z])\s+&\s+([A-Z])\b", r"\1&\2", md)

    # 9. 修复转义括号和标记
    md = re.sub(r"\\([\[\]])", r"\1", md)  # \[ → [
    md = re.sub(r"\*\*?\*\*", "", md)      # 空粗体标记
    md = re.sub(r"\!([a-zA-Z][^\[\(]+\.(?:jpg|png))", r"![](\1)", md)  # !masthead.jpg → ![](masthead.jpg)
    # 9b. 修复 !Title(image.jpg) → ![](images/image.jpg)
    md = re.sub(r"\!([a-zA-Z][^\[\(]*)\(([^)]+\.(?:jpg|png))\)", r"![](images/\2)", md)

    # 10. 修复 · 等特殊字符
    md = md.replace("·", "")

    # 11. 移除日期行
    md = re.sub(
        r"^\d+月\s+\d+,\s+\d{4}\s+\d{2}:\d{2}\s*[上午下午]*$",
        "", md, flags=re.MULTILINE
    )

    # 12. 移除 "Our cover" 等短行
    short_removals = {"Our cover", "Cover", "### Our cover", "### Cover"}
    lines = md.split("\n")
    filtered = [l for l in lines if l.strip() not in short_removals]
    md = "\n".join(filtered)

    # 13. 去重标题行（连续相同的标题只保留一个）
    lines = md.split("\n")
    unique = []
    for i, line in enumerate(lines):
        if i > 0 and line.strip() == lines[i - 1].strip() and line.startswith("#"):
            continue
        unique.append(line)
    md = "\n".join(unique)

    # 14. 压缩多余空行
    md = re.sub(r"\n{3,}", "\n\n", md)
    md = re.sub(r"\n\s+(#)", r"\n\1", md)
    md = re.sub(r"\n-{3,}\n", "\n\n", md)

    # 15. 修复中英文间可能多余的空格
    md = re.sub(r"([^\w\s]) \.", r"\1.", md)

    return md.strip()


# ============ EPUB 解析 ============

def parse_container(archive: zipfile.ZipFile) -> str:
    container_xml = read_zip_text(archive, "META-INF/container.xml")
    root = ET.fromstring(container_xml)
    for rootfile in root.findall(".//{*}rootfile"):
        full_path = rootfile.attrib.get("full-path")
        if full_path:
            return full_path
    raise ValueError("Could not locate OPF path from META-INF/container.xml")


def parse_opf(opf_text: str) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    root = ET.fromstring(opf_text)

    metadata_node = root.find(".//{*}metadata")
    manifest_node = root.find(".//{*}manifest")
    spine_node = root.find(".//{*}spine")

    if metadata_node is None or manifest_node is None or spine_node is None:
        raise ValueError("OPF is missing metadata, manifest, or spine")

    titles = [normalize_whitespace(n.text or "") for n in
              metadata_node.findall(".//{http://purl.org/dc/elements/1.1/}title")
              if normalize_whitespace(n.text or "")]
    creators = [normalize_whitespace(n.text or "") for n in
                metadata_node.findall(".//{http://purl.org/dc/elements/1.1/}creator")
                if normalize_whitespace(n.text or "")]
    languages = [normalize_whitespace(n.text or "") for n in
                 metadata_node.findall(".//{http://purl.org/dc/elements/1.1/}language")
                 if normalize_whitespace(n.text or "")]

    identifiers = []
    for node in metadata_node.findall(".//{http://purl.org/dc/elements/1.1/}identifier"):
        value = normalize_whitespace(node.text or "")
        if value:
            identifiers.append({"id": node.attrib.get("id", ""), "value": value})

    description = normalize_whitespace(
        (metadata_node.find(".//{http://purl.org/dc/elements/1.1/}description") or
         metadata_node.find(".//{http://purl.org/dc/elements/1.1/}abstract") or
         ET.Element("_")).text or ""
    )
    publisher = normalize_whitespace(
        (metadata_node.find(".//{http://purl.org/dc/elements/1.1/}publisher") or
         ET.Element("_")).text or ""
    )
    date_text = normalize_whitespace(
        (metadata_node.find(".//{http://purl.org/dc/elements/1.1/}date") or
         ET.Element("_")).text or ""
    )

    manifest_items = []
    for item in manifest_node.findall("./{*}item"):
        manifest_items.append({
            "id": item.attrib.get("id", ""),
            "href": item.attrib.get("href", ""),
            "media_type": item.attrib.get("media-type", ""),
            "properties": item.attrib.get("properties", ""),
        })

    spine = [ir.attrib.get("idref", "") for ir in spine_node.findall("./{*}itemref")
             if ir.attrib.get("idref", "")]

    metadata = {
        "title": titles[0] if titles else "Untitled",
        "titles": titles,
        "author": ", ".join(creators) if creators else "Unknown",
        "authors": creators,
        "language": languages[0] if languages else "",
        "languages": languages,
        "identifier": identifiers[0]["value"] if identifiers else "",
        "identifiers": identifiers,
        "publisher": publisher,
        "published_date": date_text,
        "description": description,
    }

    return metadata, manifest_items, spine


def extract_images(archive: zipfile.ZipFile, opf_path: str, manifest_items: list[dict],
                   images_dir: Path) -> dict[str, Path]:
    """提取 EPUB 中所有图片到 images/ 目录"""
    href_to_out: dict[str, Path] = {}
    for item in manifest_items:
        href = item.get("href", "")
        mt = item.get("media_type", "")
        if not href:
            continue
        is_image = mt in ALL_MEDIA or any(href.lower().endswith(ext) for ext in IMAGE_EXTS)
        if not is_image:
            continue

        import posixpath
        resolved = resolve_href(opf_path, href)
        out_name = posixpath.basename(resolved)
        out_path = images_dir / out_name

        try:
            with archive.open(resolved) as src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst)
        except Exception:
            continue

        href_to_out[href] = Path("images") / out_name
        href_to_out[resolved] = Path("images") / out_name

    return href_to_out


def is_noise_page(title: str, text: str, href: str, char_count: int) -> bool:
    """判断是否为噪音页面（目录、版权、广告等）"""
    if not text.strip() or char_count < 40:
        return True

    t = title.lower()
    h = href.lower()
    total_chars = char_count

    nav_kw = {"toc", "table of contents", "contents", "navigation", "目录", "导航"}
    copyright_kw = {"copyright", "all rights reserved", "isbn", "publisher", "published by"}
    ad_kw = {"also by", "other books", "more from", "coming soon"}

    # 链接密集说明是目录页
    if any(k in h for k in ("toc", "nav", "contents")):
        if total_chars < 2500:
            return True

    if any(k in t for k in nav_kw):
        return True

    if any(k in t for k in copyright_kw) and total_chars < 2500:
        return True

    if any(k in t for k in ad_kw) and total_chars < 3000:
        return True

    return False


def extract_title_from_markdown(md: str) -> str:
    """从 Markdown 中提取标题"""
    m = re.search(r"^#\s+(.+)$", md, re.MULTILINE)
    if m:
        return m.group(1).strip()

    # fallback: 第一行非空内容
    for line in md.split("\n"):
        s = line.strip()
        if s:
            return s[:80]
    return "Untitled"


# ============ 主逻辑 ============

def parse_book(epub_path: Path, output_root: Path, explicit_book_id: str | None = None) -> dict:
    if not epub_path.exists():
        raise FileNotFoundError(f"EPUB file not found: {epub_path}")
    if epub_path.suffix.lower() != ".epub":
        raise ValueError(f"Input file is not an .epub file: {epub_path}")

    with zipfile.ZipFile(epub_path, "r") as archive:
        opf_path = parse_container(archive)
        metadata, manifest_items, spine = parse_opf(read_zip_text(archive, opf_path))
        manifest_by_id = {item["id"]: item for item in manifest_items}

        # 图片提取
        book_id = slugify(explicit_book_id or metadata["identifier"] or metadata["title"], fallback="book")
        book_dir = ensure_dir(output_root / book_id)
        chapters_dir = ensure_dir(book_dir / "chapters")
        images_dir = ensure_dir(book_dir / "images")
        href_to_out = extract_images(archive, opf_path, manifest_items, images_dir)

        chapters = []
        skipped_pages = []
        chapter_number = 0
        total_images = 0

        for spine_idx, idref in enumerate(spine, start=1):
            item = manifest_by_id.get(idref)
            if not item:
                continue
            href = item["href"]
            mt = item.get("media-type", "")
            if mt not in HTML_TYPES and not href.endswith((".xhtml", ".html", ".htm")):
                continue

            resolved_path = resolve_href(opf_path, href)
            raw_html = read_zip_text(archive, resolved_path)

            # HTML 预处理
            if HAS_BS4:
                cleaned_html = preprocess_html(raw_html)
            else:
                # 无 bs4 时的简单回退：只移除 script/style
                cleaned_html = re.sub(r"<(script|style|nav|noscript)[^>]*>.*?</\1>", "", raw_html, flags=re.DOTALL)

            # 跳过空页面
            text_len = len(re.sub(r"<[^>]+>", "", cleaned_html).strip())
            if text_len < 80:
                continue

            # Pandoc 转换
            md = pandoc_convert(cleaned_html)
            md = clean_markdown(md)

            if len(md) < 30:
                continue

            title = extract_title_from_markdown(md)
            # 如果标题完全是图片引用（如 ![](images/xxx.jpg)），用 "Masthead" 替换
            if re.match(r"^!\[.*?\]\(.*?\)$", title):
                title = "Masthead"
            # 从标题中去掉 Heading 标记（防止 extract 提取到 ## xxx 等情况）
            title = re.sub(r"^#{1,6}\s+", "", title).strip()
            # 从正文移除第一个标题行，防止 # {title} 组装后与正文中标题重复
            md = re.sub(r"^#{1,6}\s+.+$", "", md, count=1, flags=re.MULTILINE).strip()
            char_count = len(md)

            # 噪音检测
            if is_noise_page(title, md, href, char_count):
                skipped_pages.append({
                    "spine_index": spine_idx,
                    "href": href,
                    "resolved_path": resolved_path,
                    "title": title,
                })
                continue

            chapter_number += 1
            slug = slugify(title, fallback="chapter")[:40]
            chapter_id = f"ch{chapter_number:03d}-{slug}" if chapter_number < 1000 else f"ch{chapter_number}-{slug}"
            chapter_file = chapters_dir / f"{chapter_id}.md"

            content = f"# {title}\n\n{md}\n"
            write_text(chapter_file, content)

            img_count = md.count("![")
            total_images += img_count

            chapters.append({
                "index": chapter_number,
                "spine_index": spine_idx,
                "chapter_id": chapter_id,
                "chapter_title": title,
                "source_path": resolved_path,
                "chapter_file": str(chapter_file.resolve()),
                "char_count": char_count,
                "word_count": len(md.split()),
                "image_count": img_count,
                "content_markdown": md,
            })

        # 构建输出
        total_chars = sum(c["char_count"] for c in chapters)
        total_words = sum(c["word_count"] for c in chapters)

        metadata_payload = {
            "book_id": book_id,
            "title": metadata["title"],
            "author": metadata["author"],
            "language": metadata["language"],
            "publisher": metadata["publisher"],
            "published_date": metadata["published_date"],
            "source_epub": str(epub_path.resolve()),
            "total_words": total_words,
            "total_chars": total_chars,
            "total_images": total_images,
            "chapter_count": len(chapters),
        }

        toc_payload = {
            "book_id": book_id,
            "source": "pandoc",
            "entries": [
                {"title": ch["chapter_title"], "href": ch["source_path"],
                 "level": 1, "source": "pandoc"}
                for ch in chapters
            ],
        }

        book_payload = {
            "book_id": book_id,
            "title": metadata["title"],
            "author": metadata["author"],
            "source_epub": str(epub_path.resolve()),
            "chapters": chapters,
        }

        manifest_payload = {
            "book_id": book_id,
            "title": metadata["title"],
            "author": metadata["author"],
            "source_epub": str(epub_path.resolve()),
            "output_dir": str(book_dir.resolve()),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "chapter_count": len(chapters),
            "total_words": total_words,
            "total_chars": total_chars,
            "total_images": total_images,
            "skipped_pages": skipped_pages,
            "parser": "pandoc",
            "files": {
                "metadata_json": "metadata.json",
                "toc_json": "toc.json",
                "book_json": "book.json",
                "manifest_json": "manifest.json",
                "chapters_dir": "chapters",
                "chapter_files": [f"chapters/{Path(ch['chapter_file']).name}" for ch in chapters],
            },
        }

        write_json(book_dir / "metadata.json", metadata_payload)
        write_json(book_dir / "toc.json", toc_payload)
        write_json(book_dir / "book.json", book_payload)
        write_json(book_dir / "manifest.json", manifest_payload)

        result = {
            "metadata": metadata_payload,
            "toc": toc_payload,
            "book": book_payload,
            "manifest": manifest_payload,
        }

        return result


# ============ CLI ============

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pandoc-driven EPUB to Markdown parser. Replaces parse_epub.py."
    )
    parser.add_argument("epub_path", help="Path to a single .epub file")
    parser.add_argument("--output-dir", default=".epub_read_output",
                        help="Root directory for parser outputs")
    parser.add_argument("--book-id", default=None, help="Optional explicit book identifier")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    epub_path = Path(args.epub_path).expanduser().resolve()
    output_root = Path(args.output_dir).expanduser().resolve()

    if not HAS_BS4:
        print("Warning: beautifulsoup4 not installed. HTML preprocessing will be minimal.",
              file=sys.stderr)
        print("Install with: pip3 install beautifulsoup4 lxml", file=sys.stderr)

    try:
        result = parse_book(epub_path, output_root, args.book_id)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    m = result["manifest"]
    summary = {
        "status": "ok",
        "parser": "pandoc",
        "book_id": m["book_id"],
        "title": m["title"],
        "author": m["author"],
        "chapter_count": m["chapter_count"],
        "image_count": m["total_images"],
        "total_words": m["total_words"],
        "output_dir": m["output_dir"],
        "skipped_count": len(m["skipped_pages"]),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
