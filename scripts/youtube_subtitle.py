#!/usr/bin/env python3
"""
YouTube 字幕提取 + 翻译工具（供 InfoHub 后端调用）

子命令：
  check   --video-id VID   列出可用字幕语言，判断是否含原生中文
  extract --video-id VID [--lang auto|zh-Hans|en|...] [--translate]
                          提取字幕文本（原生中文优先，否则取原文）
                          若加 --translate 且原文非中文：逐段翻成中文
                            - 环境变量有 DEEPSEEK_API_KEY → 走 DeepSeek（质量最佳）
                            - 否则 → 走 MyMemory 免 key 兜底

输出（stdout，单行 JSON）：
  check:   {"video_id","available":[{"code","lang","generated"}],"has_native_zh","translatable"}
  extract: {"video_id","lang","is_generated","has_native_zh",
            "translated","translatedVia","segment_count",
            "segments":[{"text","orig","start","duration}]}
  失败：    {"error":"..."}

依赖：youtube-transcript-api（backend/.venv）
网络：通过环境变量 HTTP_PROXY/HTTPS_PROXY 走代理；每步带 signal 超时保护。
"""
import sys
import re
import os
import json
import signal
import argparse
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from youtube_transcript_api import YouTubeTranscriptApi

ZH_CODES = {"zh-Hans", "zh-CN", "zh-Hant", "zh-TW", "zh"}


def extract_video_id(url: str):
    if not url:
        return None
    m = re.search(
        r"(?:v=|youtu\.be/|/embed/|/shorts/|/live/|/watch\?.*\bv=)([A-Za-z0-9_-]{11})",
        url,
    )
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url or ""):
        return url
    return None


class _Timeout(Exception):
    pass


def _on_timeout(signum, frame):
    raise _Timeout()


def _list(vid: str, retries: int = 2, per_timeout: float = 25.0):
    last = None
    for attempt in range(retries):
        try:
            signal.setitimer(signal.ITIMER_REAL, per_timeout)
            try:
                return YouTubeTranscriptApi().list(vid)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
        except _Timeout:
            last = "timeout"
            continue
        except Exception:
            # 非超时错误（视频不可用、字幕关闭等）无需重试，直接上抛
            raise
    raise RuntimeError(f"list 重试 {retries} 次仍失败: {last}")


def _fetch(transcript, retries: int = 2, per_timeout: float = 30.0):
    last = None
    for attempt in range(retries):
        try:
            signal.setitimer(signal.ITIMER_REAL, per_timeout)
            try:
                return transcript.fetch()
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
        except _Timeout:
            last = "timeout"
            continue
        except Exception:
            raise
    raise RuntimeError(f"fetch 重试 {retries} 次仍失败: {last}")


def _has_cjk(s: str) -> bool:
    return bool(re.search(r"[一-鿿]", s or ""))


def _http_get_json(url: str, timeout: int = 8) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_post_json(url: str, payload: dict, headers: dict, timeout: int = 30) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def mymemory_translate(text: str) -> str | None:
    if not text or len(text.strip()) < 2:
        return text
    try:
        q = urllib.parse.quote(text[:500])
        # 注意：MyMemory 的 de 必须是合法邮箱格式，否则返回 403 INVALID EMAIL PROVIDED；
        # 且 responseStatus 返回的是字符串 "200" 而非整数，必须用字符串比较。
        url = f"https://api.mymemory.translated.net/get?q={q}&langpair=en|zh-CN"
        data = _http_get_json(url, 8)
        if str(data.get("responseStatus")) != "200":
            return None
        t = data.get("responseData", {}).get("translatedText")
        if not t or "MYMEMORY" in t.upper() or "QUOTA" in t.upper():
            return None
        return t
    except Exception:
        return None


def deepseek_translate(text: str, api_key: str) -> str | None:
    if not text or len(text.strip()) < 2:
        return text
    try:
        url = os.environ.get("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        payload = {
            "model": "deepseek-chat",
            "messages": [
                {"role": "system", "content": "You are a professional translator. Translate the following English text into Simplified Chinese. Output ONLY the translation, no explanations, no notes, no original text. Preserve line breaks."},
                {"role": "user", "content": text},
            ],
            "max_tokens": 16384,
            "temperature": 0,
        }
        data = _http_post_json(url, payload, headers, 30)
        return (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip() or None
    except Exception:
        return None


def do_check(vid: str) -> dict:
    tl = _list(vid)
    available = [
        {"code": t.language_code, "lang": t.language, "generated": t.is_generated}
        for t in tl
    ]
    has_native_zh = any(a["code"] in ZH_CODES for a in available)
    return {
        "video_id": vid,
        "available": available,
        "has_native_zh": has_native_zh,
        "translatable": len(available) > 0,
    }


def _mymemory_lines(lines: list) -> list:
    """逐句翻译（并发）。用于批量拆分失败时的兜底。"""
    if not lines:
        return []
    with ThreadPoolExecutor(max_workers=6) as ex:
        return list(ex.map(lambda l: mymemory_translate(l) or l, lines))


def _mymemory_batch(lines: list) -> list:
    """批量翻译多行（拼成一段请求，再按行拆回）。行数不匹配或失败则逐句兜底。"""
    if not lines:
        return []
    joined = "\n".join(lines)
    tr = mymemory_translate(joined)
    if tr is not None:
        parts = tr.split("\n")
        if len(parts) == len(lines):
            return parts
    # 批量失败或行数不匹配：逐句兜底
    return _mymemory_lines(lines)


def translate_all(texts: list, via: str, api_key: str) -> list:
    """翻译整段列表。DeepSeek 逐句（快且保真）；MyMemory 批量（减少请求数）。"""
    if via == "deepseek":
        out = []
        with ThreadPoolExecutor(max_workers=8) as ex:
            out = list(ex.map(lambda t: (deepseek_translate(t, api_key) or t), texts))
        return out
    # MyMemory：按 ~450 字符分批，批间并发，批内按行拆回
    batches: list = []
    buf: list = []
    buf_chars = 0
    for t in texts:
        if buf_chars + len(t) + 1 > 450:
            batches.append(buf)
            buf = []
            buf_chars = 0
        buf.append(t)
        buf_chars += len(t) + 1
    if buf:
        batches.append(buf)
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(_mymemory_batch, batches))
    out: list = []
    for r in results:
        out.extend(r)
    return out


# 句子/段落结尾标点（用于合并碎片段）。不含省略号，避免 "..." 被误判为句尾。
_SENT_END_CHARS = set(".!?。！？")
# 英文常见缩写，避免 "Mr.", "Dr.", "U.S." 等被误拆
_ABBR = {"mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "inc", "ltd", "co", "jr", "sr", "u.s", "e.g", "i.e", "no"}


def _is_sent_end(text: str) -> bool:
    s = text.rstrip()
    if not s or s[-1] not in _SENT_END_CHARS:
        return False
    # 连续句号（"..."）不当句尾
    if len(s) >= 2 and s[-2] == ".":
        return False
    # 英文缩写（"Mr." / "U.S." / "e.g."）不当句尾
    if not _has_cjk(s):
        last_word = re.split(r"[\s]+", s)[-1].rstrip(".!?").lower()
        if last_word in _ABBR:
            return False
    return True


def merge_segments(segs: list, max_chars: int = 200) -> list:
    """把 ASR 的碎片化小段合并成有句子/段落结构的字幕段。

    - 中文段：直接拼接（无空格），遇到 。！？ 断句
    - 英文段：空格拼接，遇到 .!? 且非缩写断句
    - 单组长度超过 max_chars 也强制断开（防止一句过长）
    合并后保留首段起始时间与末段结束时间，供 SRT 时间轴使用。
    """
    if not segs:
        return []
    merged: list = []
    buf_texts: list = []
    buf_origs: list = []
    buf_start = None
    buf_end = 0.0

    def flush():
        nonlocal buf_texts, buf_origs, buf_start, buf_end
        if not buf_texts:
            return
        is_zh = _has_cjk(buf_texts[0])
        text = "".join(buf_texts) if is_zh else " ".join(t.strip() for t in buf_texts)
        orig = " ".join(o.strip() for o in buf_origs) if buf_origs else ""
        merged.append({
            "text": text.strip(),
            "orig": orig,
            "start": buf_start if buf_start is not None else 0.0,
            "duration": max(0.0, buf_end - (buf_start or 0.0)),
        })
        buf_texts = []
        buf_origs = []
        buf_start = None
        buf_end = 0.0

    for s in segs:
        t = (s.get("text") or "").strip()
        o = (s.get("orig") if s.get("orig") is not None else (s.get("text") or "")).strip()
        if not t and not o:
            continue
        buf_texts.append(t)
        if o:
            buf_origs.append(o)
        buf_end = float(s.get("start", 0)) + float(s.get("duration", 0) or 0)
        if buf_start is None:
            buf_start = float(s.get("start", 0))
        is_zh = _has_cjk(t) if t else _has_cjk(buf_texts[0]) if buf_texts else False
        joined = "".join(buf_texts) if is_zh else " ".join(buf_texts)
        if _is_sent_end(t) or len(joined) >= max_chars:
            flush()

    flush()
    return merged


def do_extract(vid: str, lang: str, translate: bool) -> dict:
    tl = _list(vid)
    target = None
    if lang and lang != "auto":
        for t in tl:
            if t.language_code == lang:
                target = t
                break
        if target is None:
            return {"error": f"language {lang} not available", "available": [t.language_code for t in tl]}
    else:
        for t in tl:
            if t.language_code in ZH_CODES:
                target = t
                break
        if target is None:
            for t in tl:
                if t.language_code == "en":
                    target = t
                    break
            if target is None:
                target = next(iter(tl))
    sn = _fetch(target)
    raw = [
        {"text": s.text, "start": float(s.start), "duration": float(s.duration)}
        for s in sn
    ]
    src_lang = target.language_code

    if translate and src_lang not in ZH_CODES:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        via = "deepseek" if api_key else "mymemory"
        # 跳过已是中文的段，其余翻译
        to_translate = [s["text"] for s in raw]
        translated_texts = translate_all(to_translate, via, api_key or "")
        segs = []
        for i, s in enumerate(raw):
            if _has_cjk(s["text"]) or not translated_texts[i]:
                segs.append({**s, "orig": s["text"], "text": s["text"]})
            else:
                segs.append({**s, "orig": s["text"], "text": translated_texts[i]})
        # 翻译是否成功以「结果是否含中文」为准（MyMemory 额度耗尽时可能返回
        # 与原文不同但仍为英文的字符串，不能靠 text!=orig 判断）。
        translated_count = sum(1 for s in segs if _has_cjk(s["text"]))
        total = len(segs)
        if translated_count == 0 or translated_count < total * 0.8:
            # 大面积失败 → 统一回退原文，避免中英混杂
            for s in segs:
                s["text"] = s["orig"]
            translated = False
        else:
            translated = True
        segs = merge_segments(segs)
        return {
            "video_id": vid,
            "lang": src_lang,
            "is_generated": target.is_generated,
            "has_native_zh": src_lang in ZH_CODES,
            "translated": translated,
            "translatedVia": via,
            "segment_count": len(segs),
            "segments": segs,
        }

    # 不翻译：原样返回（但仍按句子合并，避免碎片化）
    segs = [{**s, "orig": s["text"]} for s in raw]
    segs = merge_segments(segs)
    return {
        "video_id": vid,
        "lang": src_lang,
        "is_generated": target.is_generated,
        "has_native_zh": src_lang in ZH_CODES,
        "translated": False,
        "translatedVia": "none",
        "segment_count": len(segs),
        "segments": segs,
    }


def main():
    signal.signal(signal.SIGALRM, _on_timeout)
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pc = sub.add_parser("check")
    pc.add_argument("--video-id", required=True)
    pe = sub.add_parser("extract")
    pe.add_argument("--video-id", required=True)
    pe.add_argument("--lang", default="auto")
    pe.add_argument("--translate", action="store_true")
    args = p.parse_args()

    try:
        if args.cmd == "check":
            out = do_check(args.video_id)
        else:
            out = do_extract(args.video_id, args.lang, args.translate)
    except _Timeout:
        out = {"error": "timeout (YouTube 请求超时，可能网络/代理问题)"}
    except Exception as e:  # noqa
        out = {"error": str(e)[:300]}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if "error" not in out else 1)


if __name__ == "__main__":
    main()
