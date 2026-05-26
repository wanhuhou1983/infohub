#!/usr/bin/env python3
"""
B站 UP 主视频列表采集 + 关注列表同步 - HTTP 服务
使用 Playwright 绕过 412 反爬 + WBI 签名
"""
import json
import sys
import os
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get('PORT', '8979'))

def fetch_videos(mid: str, max_pages: int = 1, sessdata: str = '') -> list[dict]:
    """Use Playwright to fetch UP主 video list"""
    all_videos = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context_args = {
            'user_agent': (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        }
        if sessdata:
            context_args['extra_http_headers'] = {
                'Cookie': f'SESSDATA={sessdata}'
            }
        context = browser.new_context(**context_args)
        page = context.new_page()
        captured = {}

        def intercept_response(response):
            url = response.url
            if "/x/space/wbi/arc/search" in url and response.status == 200:
                try:
                    body = response.body()
                    data = json.loads(body)
                    if data.get("code") == 0:
                        captured["data"] = data
                except Exception:
                    pass

        page.on("response", intercept_response)

        for pn in range(1, max_pages + 1):
            captured.clear()
            url = f"https://space.bilibili.com/{mid}/video"
            for attempt in range(2):
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(3000)
                    if captured.get("data"):
                        break
                    try:
                        page.evaluate("window.scrollBy(0, 600)")
                        page.wait_for_timeout(2000)
                    except:
                        pass
                except Exception as e:
                    if attempt == 0:
                        print(f"[BiliService] Retry {mid} p{pn} after: {e}", flush=True)
                        page.wait_for_timeout(3000)
                    else:
                        print(f"[BiliService] Failed {mid} p{pn} after 2 retries: {e}", flush=True)
            if not captured.get("data"):
                break
            vlist = captured["data"].get("data", {}).get("list", {}).get("vlist", [])
            if not vlist:
                break
            all_videos.extend(vlist)
            if pn < max_pages:
                page.wait_for_timeout(1000)
        browser.close()
    return all_videos


def _bili_get(path: str, sessdata: str) -> dict:
    """Direct HTTP GET to B站 API with SESSDATA cookie"""
    req = urllib.request.Request(f"https://api.bilibili.com{path}")
    if sessdata:
        req.add_header('Cookie', f'SESSDATA={sessdata}')
    req.add_header('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))



def fetch_subtitle(bvid: str, sessdata: str = '') -> dict:
    """Fetch B站 video subtitle via direct HTTP API."""
    try:
        # Step 1: Get video info (cid)
        view = _bili_get(f'/x/web-interface/view?bvid={bvid}', sessdata)
        vdata = view.get('data', {})
        cid = vdata.get('cid', '')
        if not cid:
            # try first page
            pages = vdata.get('pages', [])
            if pages:
                cid = pages[0].get('cid', '')
        if not cid:
            return {'ok': False, 'error': 'no cid found'}

        # Step 2: Get player info (subtitle list)
        player = _bili_get(f'/x/player/v2?bvid={bvid}&cid={cid}', sessdata)
        subtitle_info = player.get('data', {}).get('subtitle', {})
        subtitles = subtitle_info.get('subtitles', [])
        if not subtitles:
            return {'ok': False, 'error': 'no subtitles available', 'cid': cid}

        # Try to get Chinese subtitle first, then English, then any
        preferred = ['zh-CN', 'zh-Hans', 'zh-cn', 'zh-CHS', 'en-US', 'en']
        selected = None
        for lang in preferred:
            for sub in subtitles:
                if sub.get('lan_doc', '').startswith(lang) or sub.get('language', '').startswith(lang):
                    selected = sub
                    break
            if selected:
                break
        if not selected:
            selected = subtitles[0]

        sub_url = selected.get('subtitle_url', '')
        if not sub_url:
            return {'ok': False, 'error': 'no subtitle URL', 'cid': cid}

        if sub_url.startswith('//'):
            sub_url = 'https:' + sub_url

        # Step 3: Download subtitle JSON
        req = urllib.request.Request(sub_url)
        req.add_header('User-Agent', 'Mozilla/5.0')
        with urllib.request.urlopen(req, timeout=15) as resp:
            sub_data = json.loads(resp.read().decode('utf-8'))

        # Extract text from subtitle body
        bodies = sub_data.get('body', [])
        if not bodies:
            return {'ok': False, 'error': 'subtitle body is empty', 'cid': cid}

        # Concatenate subtitle text
        text_parts = []
        for item in bodies:
            content = item.get('content', '')
            if content:
                text_parts.append(content)

        text = '\n'.join(text_parts) if text_parts else ''
        language = selected.get('lan_doc', 'unknown')

        return {
            'ok': True,
            'text': text,
            'language': language,
            'cid': cid,
            'bvid': bvid,
        }
    except Exception as e:
        return {'ok': False, 'error': str(e), 'bvid': bvid}


def fetch_audio_url(bvid: str, sessdata: str = '') -> dict:
    """Get B站 video audio stream URL."""
    try:
        # Step 1: Get video info (cid)
        view = _bili_get(f'/x/web-interface/view?bvid={bvid}', sessdata)
        vdata = view.get('data', {})
        cid = vdata.get('cid', '')
        if not cid:
            pages = vdata.get('pages', [])
            if pages:
                cid = pages[0].get('cid', '')
        if not cid:
            return {'ok': False, 'error': 'no cid found'}

        # Step 2: Get play URL
        play = _bili_get(f'/x/player/playurl?bvid={bvid}&cid={cid}&qn=0&type=mp4', sessdata)
        durl = play.get('data', {}).get('durl', [])
        if durl:
            audio_url = durl[0].get('url', '')
            if audio_url:
                return {'ok': True, 'audio_url': audio_url, 'cid': cid, 'bvid': bvid}

        # Try dash format
        dash = play.get('data', {}).get('dash', {})
        audios = dash.get('audio', [])
        if audios:
            audio_url = audios[0].get('base_url', '') or audios[0].get('baseUrl', '')
            if audio_url:
                return {'ok': True, 'audio_url': audio_url, 'cid': cid, 'bvid': bvid}

        return {'ok': False, 'error': 'no audio URL found', 'cid': cid}
    except Exception as e:
        return {'ok': False, 'error': str(e), 'bvid': bvid}
def fetch_followings(sessdata: str) -> list[dict]:
    """Fetch the current user's following list via B站 direct HTTP API."""
    # First get current user's mid
    nav = _bili_get('/x/web-interface/nav', sessdata)
    my_mid = str(nav.get('data', {}).get('mid', ''))
    if not my_mid:
        print("[BiliService] Failed to get user mid from nav API", flush=True)
        return []

    print(f"[BiliService] Fetching followings for mid={my_mid}", flush=True)
    all_items = []

    for pn in range(1, 20):  # max 20 pages * 50 = 1000
        try:
            data = _bili_get(f'/x/relation/followings?vmid={my_mid}&pn={pn}&ps=50', sessdata)
            if data.get('code') != 0:
                break
            items = data.get('data', {}).get('list', [])
            if not items:
                break
            for item in items:
                all_items.append({
                    'mid': str(item.get('mid', '')),
                    'name': item.get('uname', ''),
                    'avatar': item.get('face', ''),
                    'sign': item.get('sign', ''),
                })
            print(f"[BiliService] Page {pn}: {len(items)} items (total: {len(all_items)})", flush=True)
        except Exception as e:
            print(f"[BiliService] Followings page {pn} error: {e}", flush=True)
            break

    return all_items


class BiliHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        try:
            req = json.loads(body)
        except:
            req = {}
        
        action = req.get('action', 'videos')
        mid = req.get('mid', '')
        sessdata = req.get('sessdata', '')
        max_pages = int(req.get('max_pages', 5))
        
        if action == 'videos':
            if not mid:
                self._json(400, {'error': 'mid is required for action=videos'})
                return
            try:
                videos = fetch_videos(mid, max_pages, sessdata)
                self._json(200, {'ok': True, 'mid': mid, 'videos': videos, 'count': len(videos)})
            except Exception as e:
                self._json(500, {'error': str(e), 'mid': mid})
        
        elif action == 'followings':
            if not sessdata:
                self._json(400, {'error': 'sessdata is required for action=followings'})
                return
            try:
                followings = fetch_followings(sessdata)
                self._json(200, {'ok': True, 'followings': followings, 'count': len(followings)})
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        elif action == 'subtitle':
            bvid = req.get('bvid', '')
            if not bvid:
                self._json(400, {'error': 'bvid is required for action=subtitle'})
                return
            try:
                result = fetch_subtitle(bvid, sessdata)
                status = 200 if result.get('ok') else 404
                self._json(status, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        elif action == 'audio':
            bvid = req.get('bvid', '')
            if not bvid:
                self._json(400, {'error': 'bvid is required for action=audio'})
                return
            try:
                result = fetch_audio_url(bvid, sessdata)
                status = 200 if result.get('ok') else 404
                self._json(status, result)
            except Exception as e:
                self._json(500, {'error': str(e)})
        
        else:
            self._json(400, {'error': f'Unknown action: {action}'})
    
    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'service': 'bili-fetch'})
        else:
            self._json(404, {'error': 'Not found. POST /'})
    
    def _json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def log_message(self, format, *args):
        print(f"[BiliService] {args[0]} {args[1]} {args[2]}")


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), BiliHandler)
    print(f"B站 Playwright service running on port {PORT}")
    server.serve_forever()