#!/usr/bin/env python3
"""
播客音频 URL 解析脚本 - 从播客剧集 URL 获取直接音频流地址

用法：
  python3 podcast_audio.py --track-id 12345678 --platform ximalaya

输出：JSON { ok: true, audio_url: "...", duration: 123 }

当前支持平台：
- 喜马拉雅（无需认证）：通过官方 API + AES 解密获取音频 URL
"""

import json
import re
import sys
import time
import base64
import binascii
import urllib.request
from Crypto.Cipher import AES


def crack_ximalaya_url(ciphertext: str) -> str:
    """解密喜马拉雅加密的播放 URL"""
    if not ciphertext:
        return ""
    # 补齐 base64 填充
    padding = 4 - len(ciphertext) % 4
    if padding != 4:
        ciphertext += "=" * padding
    try:
        cipher = AES.new(
            binascii.unhexlify("aaad3e4fd540b0f79dca95606e72bf93"),
            AES.MODE_ECB
        )
        plaintext = cipher.decrypt(base64.urlsafe_b64decode(ciphertext))
        # 只保留可打印 ASCII 字符
        return re.sub(r"[^\x20-\x7E]", "", plaintext.decode("utf-8"))
    except Exception as e:
        return ""


def get_ximalaya_audio_url(track_id: str) -> dict:
    """通过喜马拉雅官方 API 获取音频播放 URL"""
    timestamp = int(time.time() * 1000)
    url = (
        f"https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/{timestamp}"
        f"?device=web&trackId={track_id}&trackQualityLevel=3"
    )

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Linux; Android 10; SM-G981B) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/80.0.3987.162 Mobile Safari/537.36"
            ),
            "Referer": "https://www.ximalaya.com/",
        }
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"API 请求失败: {e}"}

    track_info = data.get("trackInfo", {})
    if not track_info:
        return {"ok": False, "error": "API 返回中没有 trackInfo"}

    play_url_list = track_info.get("playUrlList", [])
    if not play_url_list:
        return {"ok": False, "error": "没有可用的播放 URL"}

    # 按文件大小降序排列，选最高质量
    play_url_list.sort(key=lambda x: int(x.get("fileSize", 0) or 0), reverse=True)

    audio_url = ""
    for entry in play_url_list:
        encrypted_url = entry.get("url", "")
        if not encrypted_url:
            continue
        decrypted = crack_ximalaya_url(encrypted_url)
        if decrypted and decrypted.startswith("http"):
            audio_url = decrypted
            break

    if not audio_url:
        return {"ok": False, "error": "无法解密音频 URL"}

    duration = track_info.get("duration", 0)
    return {
        "ok": True,
        "audio_url": audio_url,
        "duration": duration,
        "track_name": track_info.get("title", ""),
        "cover_url": track_info.get("cover", ""),
    }


def extract_track_id(url: str) -> str | None:
    """从 URL 中提取 trackId"""
    # https://www.ximalaya.com/sound/12345678
    m = re.search(r"ximalaya\.com/sound/(\d+)", url)
    if m:
        return m.group(1)
    return None


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="播客音频 URL 解析")
    parser.add_argument("--track-id", help="喜马拉雅 trackId")
    parser.add_argument("--url", help="喜马拉雅声音页 URL")
    parser.add_argument("--platform", default="ximalaya", help="播客平台")
    args = parser.parse_args()

    track_id = args.track_id
    if not track_id and args.url:
        track_id = extract_track_id(args.url)

    if not track_id:
        print(json.dumps({"ok": False, "error": "请提供 --track-id 或 --url"}, ensure_ascii=False))
        sys.exit(1)

    if args.platform == "ximalaya":
        result = get_ximalaya_audio_url(track_id)
    else:
        result = {"ok": False, "error": f"暂不支持的平台: {args.platform}"}

    print(json.dumps(result, ensure_ascii=False, indent=2))
