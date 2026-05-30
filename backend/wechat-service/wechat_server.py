#!/usr/bin/env python3
"""
WeChat Article Service — Playwright browser for reliable article extraction.
HTTP API: GET /fetch?url=<wechat_article_url> → JSON {title, content, author, ...}
"""
import json, re, sys, os, threading, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from bs4 import BeautifulSoup, Tag, NavigableString
from playwright.sync_api import sync_playwright, Browser, Route

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", "8978"))
TIMEOUT_MS = int(os.environ.get("TIMEOUT_MS", "45000"))
REQUEST_TIMEOUT_MS = int(os.environ.get("REQUEST_TIMEOUT_MS", "60000"))
MAX_TEXT_LEN = 200 * 1024

_browser: Browser | None = None
_browser_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Browser management
# ---------------------------------------------------------------------------
def get_browser() -> Browser:
    global _browser
    if _browser is None or not _browser.is_connected():
        with _browser_lock:
            if _browser is None or not _browser.is_connected():
                p = sync_playwright().start()
                _browser = p.chromium.launch(
                    headless=True,
                    args=[
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        "--disable-extensions",
                        "--no-first-run",
                    ],
                )
                print("[wechat-service] Browser launched", flush=True)
    return _browser


# ---------------------------------------------------------------------------
# Content extraction
# ---------------------------------------------------------------------------
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

    if tag == "img":
        src = node.get("data-src") or node.get("src") or ""
        if src and not src.startswith("data:"):
            return f"\n__IMG__{src}__IMG__\n"
        return ""

    if tag in ("h1","h2","h3","h4","h5","h6"):
        lv = int(tag[1])
        t = _inline(node)
        return f"\n{'#'*lv} {t}\n" if t else ""

    if tag == "pre":
        ct = _raw(node).strip()
        return f"\n```\n{ct}\n```\n" if ct else ""

    if tag == "code":
        if node.parent and node.parent.name == "pre":
            return _raw(node)
        ct = _raw(node)
        return f"`{ct}`" if ct else ""

    if tag == "a":
        href = node.get("href","")
        t = _inline(node)
        if t and href and not href.startswith(("javascript:","#")):
            return f"[{t}]({href})"
        return t if t else ""

    if tag in ("strong","b"):
        t = _inline(node)
        return f"**{t}**" if t else ""

    if tag in ("em","i"):
        t = _inline(node)
        return f"*{t}*" if t else ""

    if tag == "li":
        t = _inline(node)
        return f"- {t}\n" if t else ""

    if tag == "blockquote":
        inner = _node_to_md(node)
        lines = [l for l in inner.strip().split("\n") if l.strip()]
        return "\n".join(f"> {l}" for l in lines) + "\n"

    if tag in ("p","section","div"):
        t = _inline(node)
        return f"\n{t}\n" if t else "\n"

    if tag == "br":
        return "\n"

    if tag == "hr":
        return "\n---\n"

    if tag == "table":
        rows = []
        for tr in node.find_all("tr", recursive=False):
            cells = [_inline(td) for td in tr.find_all(["td","th"], recursive=False)]
            rows.append(" | ".join(cells))
        return "\n"+"\n".join(rows)+"\n" if rows else ""

    if tag in ("span","label","font","small","sub","sup","u","s","del","ins","mark","abbr","cite","q"):
        return _inline(node)

    parts = []
    for c in node.children:
        r = _node_to_md(c)
        if r: parts.append(r)
    return "".join(parts)

def _inline(node):
    parts = []
    for c in node.children:
        if isinstance(c, NavigableString):
            t = str(c).strip()
            if t: parts.append(t)
        elif isinstance(c, Tag):
            tag = c.name.lower() if c.name else ""
            if tag == "img":
                src = c.get("data-src") or c.get("src") or ""
                if src and not src.startswith("data:"):
                    parts.append(f"__IMG__{src}__IMG__")
            elif tag in ("strong","b"):
                t = _inline(c)
                if t: parts.append(f"**{t}**")
            elif tag in ("em","i"):
                t = _inline(c)
                if t: parts.append(f"*{t}*")
            elif tag == "a":
                href = c.get("href","")
                t = _inline(c)
                if t and href and not href.startswith(("javascript:","#")):
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
                if t: parts.append(t)
    return "".join(parts).strip()

def _raw(node):
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
    for e,c in [("&nbsp;"," "),("&amp;","&"),("&lt;","<"),("&gt;",">"),("&quot;",'"'),("\u00A0"," ")]:
        text = text.replace(e,c)
    return text.strip()

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
def fetch_article(url: str) -> dict | None:
    browser = None
    context = None
    page = None
    try:
        browser = get_browser()
        context = browser.new_context(
            viewport={"width": 414, "height": 896},
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42",
            locale="zh-CN",
            extra_http_headers={
                "Referer": "https://mp.weixin.qq.com/",
            },
        )
        page = context.new_page()

        # Block images/fonts/media for speed, but safely
        def block_route(route: Route):
            try:
                rt = route.request.resource_type
                if rt in ("image", "media", "font", "stylesheet"):
                    route.abort()
                else:
                    route.continue_()
            except Exception:
                try:
                    route.continue_()
                except Exception:
                    pass

        page.route("**/*", block_route)

        # Navigate
        start = time.time()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT_MS)
        except Exception as e:
            print(f"[wechat-service] goto timed out ({TIMEOUT_MS}ms), trying 'load'", flush=True)
            try:
                page.goto(url, wait_until="load", timeout=10000)
            except Exception:
                pass

        elapsed = time.time() - start
        print(f"[wechat-service] Page loaded in {elapsed:.1f}s", flush=True)

        # Wait for js_content
        try:
            page.wait_for_selector("#js_content", timeout=20000)
        except Exception:
            html_check = page.content()
            if "验证" in html_check and len(html_check) < 10000:
                print("[wechat-service] Verification page!", flush=True)
                return {"error": "verification_required"}
            print("[wechat-service] #js_content not found", flush=True)

        # Scroll to trigger lazy images
        page.evaluate("window.scrollBy(0, 300)")
        page.wait_for_timeout(800)
        page.evaluate("window.scrollBy(0, 600)")
        page.wait_for_timeout(500)

        html = page.content()
        soup = BeautifulSoup(html, "html.parser")

        if soup.title and "验证" in (soup.title.string or ""):
            return {"error": "verification_required"}

        title = _meta(soup,"og:title") or _text(soup.select_one("#activity-name")) or ""
        title = re.sub(r"^(原创|转载)\s*","",title).strip()
        author = _meta(soup,"author") or _text(soup.select_one("#js_author_name")) or ""
        publish_date = _text(soup.select_one("#publish_time")) or ""
        cover = _meta(soup,"og:image") or ""
        desc = _meta(soup,"og:description") or ""

        content_div = soup.select_one("#js_content")
        if not content_div:
            print(f"[wechat-service] no js_content, returning summary: {title[:30]}", flush=True)
            return {"title":title,"content":desc or title,"author":author,"publish_date":publish_date,"cover_image":cover}

        for h in content_div.select(
            '[style*="display:none"], [style*="display: none"], '
            '[style*="visibility:hidden"], script, style, '
            ".qr_code_pc, .reward_area, .rich_media_tool, "
            ".profile_container, .media_profile_meta"
        ):
            h.decompose()

        md = _node_to_md(content_div)
        md = _clean(md)

        if len(md) > MAX_TEXT_LEN:
            md = md[:MAX_TEXT_LEN] + "\n\n[... truncated ...]"

        if not md.strip() or len(md.strip()) < 20:
            return {"title":title,"content":desc or title,"author":author,"publish_date":publish_date,"cover_image":cover}

        print(f"[wechat-service] OK: {title[:40]} ({len(md)} chars)", flush=True)
        return {"title":title,"content":md,"author":author,"publish_date":publish_date,"cover_image":cover}

    except Exception as e:
        print(f"[wechat-service] Error: {type(e).__name__}: {e}", flush=True)
        return {"error": f"fetch_failed: {type(e).__name__}"}
    finally:
        for obj in (page, context):
            if obj:
                try: obj.close()
                except Exception: pass

# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "" or path == "/health":
            self._json({"status":"ok","service":"wechat-service"})
            return

        if path == "/fetch":
            params = parse_qs(parsed.query)
            url = params.get("url",[None])[0]
            if not url:
                self._json({"error":"missing url"}, 400)
                return

            print(f"[wechat-service] Fetching: {url[:100]}", flush=True)
            result = fetch_article(url)
            if result:
                code = 200
                if "error" in result:
                    code = 503 if "verification" in str(result["error"]) else 502
                self._json(result, code)
            else:
                self._json({"error":"unknown_error"}, 500)
            return

        self._json({"error":"not found"}, 404)

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[wechat-service] Starting on port {PORT}...", flush=True)
    try:
        get_browser()
        print("[wechat-service] Browser ready", flush=True)
    except Exception as e:
        print(f"[wechat-service] Browser init warning: {e}", flush=True)

    server = HTTPServer(("0.0.0.0", PORT), Handler)
    server.timeout = REQUEST_TIMEOUT_MS / 1000
    print(f"[wechat-service] Listening on :{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[wechat-service] Shutting down", flush=True)
        if _browser:
            _browser.close()
