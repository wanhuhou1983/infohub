#!/usr/bin/env python3
"""批量探测 YouTube 文章是否可提取中文字幕。
读取 stdin 中的 JSON 数组: [{id, source_id, title, url}, ...]
"""
import sys, re, json, signal
from youtube_transcript_api import YouTubeTranscriptApi

def _timeout(signum, frame):
    raise TimeoutError("list() timeout")

signal.signal(signal.SIGALRM, _timeout)

ZH_CODES = ["zh-Hans", "zh-CN", "zh-Hant", "zh-TW", "zh"]

def extract_video_id(url):
    if not url:
        return None
    m = re.search(r"(?:v=|youtu\.be/|/embed/|/shorts/|/live/|/watch\?.*\bv=)([A-Za-z0-9_-]{11})", url)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url or ""):
        return url
    return None

def main():
    data = json.load(sys.stdin)
    api = YouTubeTranscriptApi()
    rows = []
    for art in data:
        vid = extract_video_id(art.get("url"))
        if not vid:
            rows.append({**art, "video_id": None, "status": "no_video_id"})
            continue
        sys.stdout.flush()
        try:
            signal.alarm(25)
            tl = api.list(vid)
            signal.alarm(0)
        except Exception as e:
            signal.alarm(0)
            rows.append({**art, "video_id": vid, "status": "list_error", "detail": str(e)[:160]})
            continue
        available = []
        for t in tl:
            available.append({"code": t.language_code, "lang": t.language, "generated": t.is_generated})
        zh_hit = [a for a in available if a["code"] in ZH_CODES]
        # 尝试翻译通道：若无非原生中文，取首个可翻译字幕翻成 zh-Hans
        translated_ok = False
        translated_snippet = ""
        if not zh_hit and available:
            try:
                src = tl.find_transcript([available[0]["code"]])
                zh_tr = src.translate("zh-Hans")
                snippets = zh_tr.fetch()
                translated_ok = len(snippets) > 0
                translated_snippet = snippets[0].text if snippets else ""
            except Exception as e:
                translated_snippet = f"translate_err:{str(e)[:80]}"
        rows.append({
            **art, "video_id": vid, "status": "ok",
            "available_count": len(available),
            "available": available,
            "zh_hit": zh_hit,
            "has_zh": bool(zh_hit),
            "translated_zh_ok": translated_ok,
            "translated_snippet": translated_snippet,
        })
    # 汇总
    ok = [r for r in rows if r.get("status") == "ok"]
    zh_ok = [r for r in ok if r.get("has_zh")]
    tr_ok = [r for r in ok if r.get("translated_zh_ok")]
    print(f"总记录: {len(rows)} | 可列字幕: {len(ok)} | 原生中文: {len(zh_ok)} | 翻译可得中文: {len(tr_ok)}")
    print(f"原生中文率: {len(zh_ok)/len(ok)*100:.1f}% | 翻译中文率: {len(tr_ok)/len(ok)*100:.1f}%" if ok else "无数据")
    print("-" * 70)
    for r in rows:
        if r.get("status") != "ok":
            print(f"[SKIP] id={r.get('id')} {r.get('status')} vid={r.get('video_id')} {r.get('detail','')}")
            continue
        zh = ",".join(f"{h['code']}({'ASR' if h['generated'] else '人工'})" for h in r["zh_hit"]) or "无"
        tag = "原生中文" if r["has_zh"] else ("翻译中文✓" if r["translated_zh_ok"] else "中文✗")
        print(f"[id={r['id']}] {tag} {r['title'][:36]}")
        print(f"     vid={r['video_id']} 可用语种={r['available_count']} 原生中文={zh}")
        if r.get("translated_snippet"):
            print(f"     译文样例: {r['translated_snippet'][:50]}")
    # 写出完整结果
    with open("/tmp/yt_subtitle_probe_result.json", "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print("-" * 70)
    print("完整结果已写入 /tmp/yt_subtitle_probe_result.json")

if __name__ == "__main__":
    main()
