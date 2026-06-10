#!/usr/bin/env python3
"""xiaoyuzhou audio URL extractor - called by jintiankansha.ts via subprocess"""
import json, re, sys, urllib.request

def extract_audio_url(episode_url: str) -> str | None:
    try:
        req = urllib.request.Request(episode_url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml',
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode('utf-8', errors='replace')

        # Method 1: Direct audio URL in HTML (old format)
        m = re.search(r'https?://media\.xyzcdn\.net/[^"\'\s<>]+?\.(?:m4a|mp4a|mp3)', html)
        if m:
            return m.group(0)

        # Method 2: Next.js __NEXT_DATA__ JSON (new format)
        nd = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
        if nd:
            data = json.loads(nd.group(1))
            episode = data.get('props', {}).get('pageProps', {}).get('episode', {})
            enclosure = episode.get('enclosure', {})
            if isinstance(enclosure, dict):
                url = enclosure.get('url', '')
                if url:
                    return url
            # Fallback: mediaKey
            media_key = episode.get('mediaKey', '')
            if media_key:
                return f'https://media.xyzcdn.net/{media_key}'

        return None
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        return None

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python scrape_xiaoyuzhou_audio.py <url>"}))
        sys.exit(1)
    
    url = sys.argv[1]
    result = extract_audio_url(url)
    print(json.dumps({"audio_url": result}))
