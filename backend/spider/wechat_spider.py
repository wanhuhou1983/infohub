#!/usr/bin/env python3
"""WeChat Article Spider - requests + BeautifulSoup, no Playwright needed"""
import sys, json, re
from datetime import datetime

import requests
from bs4 import BeautifulSoup, Tag, NavigableString

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "max-age=0",
    "Referer": "https://mp.weixin.qq.com/",
}

session = requests.Session()
session.headers.update(HEADERS)


def fetch_article(url, timeout=30):
    try:
        resp = session.get(url, timeout=timeout)
        resp.encoding = "utf-8"
        if not resp.ok:
            print(f"HTTP {resp.status_code}", file=sys.stderr)
            return None
        html = resp.text
        if len(html) < 500:
            print("Response too short, likely blocked", file=sys.stderr)
            return None

        soup = BeautifulSoup(html, "html.parser")

        if soup.title and "验证" in (soup.title.string or ""):
            print("WeChat returned verification page", file=sys.stderr)
            return None

        title = (
            _meta(soup, "og:title")
            or _text(soup.select_one("#activity-name"))
            or ""
        )
        title = re.sub(r"^(原创|转载)\s*", "", title).strip()
        author = _meta(soup, "author") or _text(soup.select_one("#js_author_name")) or ""
        publish_date = _text(soup.select_one("#publish_time")) or ""
        cover = _meta(soup, "og:image") or ""
        desc = _meta(soup, "og:description") or ""

        content_div = soup.select_one("#js_content")
        if not content_div:
            print("no js_content", file=sys.stderr)
            return dict(title=title, content=desc or title, author=author, publish_date=publish_date, cover_image=cover)

        # Remove hidden/ads
        for h in content_div.select(
            '[style*="display:none"], [style*="display: none"], '
            '[style*="visibility:hidden"], script, style, '
            ".qr_code_pc, .reward_area, .rich_media_tool, "
            ".profile_container, .media_profile_meta"
        ):
            h.decompose()

        md = _node_to_md(content_div)
        md = _clean(md)

        if not md.strip():
            return dict(title=title, content=desc or title, author=author, publish_date=publish_date, cover_image=cover)

        return dict(title=title, content=md, author=author, publish_date=publish_date, cover_image=cover)

    except requests.Timeout:
        print("Timeout", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return None


def _text(el):
    return el.get_text(strip=True) if el else ""


def _meta(soup, prop):
    m = soup.select_one(f'meta[property="{prop}"]')
    return (m.get("content") or "").strip() if m else ""


def _node_to_md(node):
    if isinstance(node, NavigableString):
        return str(node).strip()
    if not isinstance(node, Tag):
        return ""

    tag = node.name.lower() if node.name else ""
    style = (node.get("style") or "").replace(" ", "")
    if "display:none" in style or "visibility:hidden" in style:
        return ""

    # Image
    if tag == "img":
        src = node.get("data-src") or node.get("src") or ""
        if src and not src.startswith("data:"):
            return f"\n__IMG__{src}__IMG__\n"
        return ""

    # Headings
    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        lv = int(tag[1])
        t = _inline(node)
        return f"\n{'#' * lv} {t}\n" if t else ""

    # Code block
    if tag == "pre":
        ct = _raw(node).strip()
        return f"\n```\n{ct}\n```\n" if ct else ""

    # Inline code
    if tag == "code":
        if node.parent and node.parent.name == "pre":
            return _raw(node)
        ct = _raw(node)
        return f"`{ct}`" if ct else ""

    # Link
    if tag == "a":
        href = node.get("href", "")
        t = _inline(node)
        if t and href and not href.startswith(("javascript:", "#")):
            return f"[{t}]({href})"
        return t if t else ""

    # Bold
    if tag in ("strong", "b"):
        t = _inline(node)
        return f"**{t}**" if t else ""

    # Italic
    if tag in ("em", "i"):
        t = _inline(node)
        return f"*{t}*" if t else ""

    # List item
    if tag == "li":
        t = _inline(node)
        return f"- {t}\n" if t else ""

    # Blockquote
    if tag == "blockquote":
        inner = _node_to_md(node)
        lines = [l for l in inner.strip().split("\n") if l.strip()]
        return "\n".join(f"> {l}" for l in lines) + "\n"

    # Paragraph / Section / Div
    if tag in ("p", "section", "div"):
        t = _inline(node)
        if t:
            return f"\n{t}\n"
        return "\n"

    # Line break
    if tag == "br":
        return "\n"

    # Horizontal rule
    if tag == "hr":
        return "\n---\n"

    # Table
    if tag == "table":
        rows = []
        for tr in node.find_all("tr", recursive=False):
            cells = [_inline(td) for td in tr.find_all(["td", "th"], recursive=False)]
            rows.append(" | ".join(cells))
        return "\n" + "\n".join(rows) + "\n" if rows else ""

    # Inline elements
    if tag in ("span", "label", "font", "small", "sub", "sup", "u", "s", "del", "ins", "mark", "abbr", "cite", "q"):
        return _inline(node)

    # Default: recurse
    parts = []
    for c in node.children:
        r = _node_to_md(c)
        if r:
            parts.append(r)
    return "".join(parts)


def _inline(node):
    """Collect text with inline markdown formatting."""
    parts = []
    for c in node.children:
        if isinstance(c, NavigableString):
            t = str(c).strip()
            if t:
                parts.append(t)
        elif isinstance(c, Tag):
            tag = c.name.lower() if c.name else ""
            if tag == "img":
                src = c.get("data-src") or c.get("src") or ""
                if src and not src.startswith("data:"):
                    parts.append(f"__IMG__{src}__IMG__")
            elif tag in ("strong", "b"):
                t = _inline(c)
                if t:
                    parts.append(f"**{t}**")
            elif tag in ("em", "i"):
                t = _inline(c)
                if t:
                    parts.append(f"*{t}*")
            elif tag == "a":
                href = c.get("href", "")
                t = _inline(c)
                if t and href and not href.startswith(("javascript:", "#")):
                    parts.append(f"[{t}]({href})")
                elif t:
                    parts.append(t)
            elif tag == "code":
                if c.parent and c.parent.name == "pre":
                    parts.append(_raw(c))
                else:
                    ct = _raw(c)
                    parts.append(f"`{ct}`" if ct else "")
            elif tag == "br":
                parts.append("\n")
            else:
                t = _inline(c)
                if t:
                    parts.append(t)
    return "".join(parts).strip()


def _raw(node):
    """Get raw text without formatting."""
    parts = []
    for c in node.children:
        if isinstance(c, NavigableString):
            parts.append(str(c))
        elif isinstance(c, Tag):
            parts.append(_raw(c))
    return "".join(parts)


def _clean(text):
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"\n[ \t]+\n", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)
    for e, c in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("\u00A0", " ")]:
        text = text.replace(e, c)
    return text.strip()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: wechat_spider.py <url>"}, ensure_ascii=False))
        sys.exit(1)
    result = fetch_article(sys.argv[1])
    if result:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps({"error": "Failed to fetch article"}, ensure_ascii=False))
        sys.exit(1)
