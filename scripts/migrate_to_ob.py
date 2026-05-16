#!/usr/bin/env python3
"""
迁移 data/ 下的采集数据到 Obsidian 仓库 /Users/wuhuahui/Documents/infohub/
同时清理 OB 仓库中的旧内容。
"""

import os
import re
import shutil
import json
from datetime import datetime

# 路径配置
DATA_DIR = "/Users/wuhuahui/WorkBuddy/20260422122342/infohub/data"
OB_DIR = "/Users/wuhuahui/Documents/infohub"

# 源类型 → OB目录映射
SOURCE_MAP = {
    "xwlb":     ("报刊杂志/新闻联播", False),
    "rmrb":     ("报刊杂志/人民日报",  True),   # 有ID
    "magazine": ("报刊杂志/喷嚏图卦",  True),   # 有ID
    "tencent":  ("报刊杂志/腾讯新闻",  True),   # 有ID
    "wechat":   ("微信公众号",        True),   # 有ID，需要子目录
    "rss":      ("RSS订阅",           True),   # 有ID
    "bilibili": ("哔哩哩哔",          True),   # 有ID
    "youtube":  ("YouTube",           True),   # 有ID
}

# 公众号名规范化（去掉 "微信公众号-" 前缀）
WECHAT_NORMALIZE = re.compile(r"^微信公众号[-_]")

# 统计
total_copied = 0
total_cleaned = 0
total_errors = 0
errors = []


def normalize_wechat_account(name):
    """规范化公众号名称"""
    name = WECHAT_NORMALIZE.sub("", name)
    return name


def clean_directory(path):
    """清空目录下的所有 .md 文件和 images/ 目录"""
    global total_cleaned
    if not os.path.isdir(path):
        return
    count = 0
    for entry in os.listdir(path):
        full = os.path.join(path, entry)
        if entry == "images" and os.path.isdir(full):
            shutil.rmtree(full)
            count += 1
            print(f"  [清理] 删除 images/ 目录: {full}")
        elif entry.endswith(".md") and os.path.isfile(full):
            os.remove(full)
            count += 1
    total_cleaned += count
    if count > 0:
        print(f"  [清理] 清空 {path}: 移除 {count} 项")


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def parse_filename_has_id(fname):
    """
    解析有 ID 的文件名: YYYYMMDD_SOURCE_ID_TITLE.md
    返回 (date_str, source, id, title) 或 None
    """
    if not fname.endswith(".md"):
        return None
    base = fname[:-3]  # remove .md
    parts = base.split("_")
    if len(parts) < 4:
        return None
    date_str = parts[0]
    if not (len(date_str) == 8 and date_str.isdigit()):
        return None
    source = parts[1]
    id_str = parts[2]
    if not id_str.isdigit():
        return None
    title = "_".join(parts[3:])
    return (date_str, source, id_str, title)


def parse_filename_xwlb(fname):
    """
    解析新闻联播文件名: YYYYMMDD_新闻联播_TITLE.md
    """
    if not fname.endswith(".md"):
        return None
    base = fname[:-3]
    # 格式: 8位日期_新闻联播_标题
    parts = base.split("_", 2)
    if len(parts) < 3:
        return None
    date_str = parts[0]
    if not (len(date_str) == 8 and date_str.isdigit()):
        return None
    title = parts[2]
    return (date_str, title)


def migrate_xwlb():
    """迁移新闻联播"""
    global total_copied, total_errors
    src_dir = os.path.join(DATA_DIR, "xwlb")
    dst_base = os.path.join(OB_DIR, "报刊杂志/新闻联播")
    ensure_dir(dst_base)

    if not os.path.isdir(src_dir):
        print("[跳过] xwlb 目录不存在")
        return

    for fname in sorted(os.listdir(src_dir)):
        parsed = parse_filename_xwlb(fname)
        if not parsed:
            print(f"  [跳过] 无法解析: {fname}")
            continue
        date_str, title = parsed
        new_fname = f"{date_str}-{title}.md"
        src = os.path.join(src_dir, fname)
        dst = os.path.join(dst_base, new_fname)
        try:
            shutil.copy2(src, dst)
            total_copied += 1
        except Exception as e:
            total_errors += 1
            errors.append(f"xwlb/{fname}: {e}")


def migrate_with_id(src_name, ob_path):
    """迁移有 ID 的文件类型"""
    global total_copied, total_errors
    src_dir = os.path.join(DATA_DIR, src_name)
    dst_base = os.path.join(OB_DIR, ob_path)
    ensure_dir(dst_base)

    if not os.path.isdir(src_dir):
        print(f"[跳过] {src_name} 目录不存在")
        return

    for fname in sorted(os.listdir(src_dir)):
        parsed = parse_filename_has_id(fname)
        if not parsed:
            print(f"  [跳过] 无法解析: {fname}")
            continue
        date_str, source, id_str, title = parsed
        new_fname = f"{date_str}-{title}.md"
        src = os.path.join(src_dir, fname)
        dst = os.path.join(dst_base, new_fname)
        try:
            shutil.copy2(src, dst)
            total_copied += 1
        except Exception as e:
            total_errors += 1
            errors.append(f"{src_name}/{fname}: {e}")


def migrate_wechat():
    """迁移微信公众号，按公众号名下钻子目录"""
    global total_copied, total_errors
    src_dir = os.path.join(DATA_DIR, "wechat")
    wechat_base = os.path.join(OB_DIR, "微信公众号")

    if not os.path.isdir(src_dir):
        print("[跳过] wechat 目录不存在")
        return

    for fname in sorted(os.listdir(src_dir)):
        parsed = parse_filename_has_id(fname)
        if not parsed:
            print(f"  [跳过] 无法解析: {fname}")
            continue
        date_str, source, id_str, title = parsed
        account = normalize_wechat_account(source)
        if not account:
            account = "未分类"
        dst_dir = os.path.join(wechat_base, account)
        ensure_dir(dst_dir)
        new_fname = f"{date_str}-{title}.md"
        src = os.path.join(src_dir, fname)
        dst = os.path.join(dst_dir, new_fname)
        try:
            shutil.copy2(src, dst)
            total_copied += 1
        except Exception as e:
            total_errors += 1
            errors.append(f"wechat/{fname}: {e}")


def clean_all_targets():
    """清理所有目标目录的旧内容"""
    print("\n" + "=" * 60)
    print("步骤1: 清理 OB 仓库旧内容")
    print("=" * 60)

    # 清空顶级目录
    for ob_subdir in ["RSS订阅", "YouTube", "哔哩哩哔"]:
        path = os.path.join(OB_DIR, ob_subdir)
        clean_directory(path)

    # 清空微信公众号下的每个公众号子目录
    wechat_base = os.path.join(OB_DIR, "微信公众号")
    if os.path.isdir(wechat_base):
        for account_dir in sorted(os.listdir(wechat_base)):
            account_path = os.path.join(wechat_base, account_dir)
            if os.path.isdir(account_path):
                clean_directory(account_path)

    # 清空报刊杂志下的子目录
    magazine_base = os.path.join(OB_DIR, "报刊杂志")
    if os.path.isdir(magazine_base):
        for sub in sorted(os.listdir(magazine_base)):
            sub_path = os.path.join(magazine_base, sub)
            if os.path.isdir(sub_path):
                clean_directory(sub_path)


def main():
    print("=" * 60)
    print("InfoHub 数据 → Obsidian 仓库迁移")
    print(f"源: {DATA_DIR}")
    print(f"目标: {OB_DIR}")
    print("=" * 60)

    # 步骤1: 清理旧内容
    clean_all_targets()

    # 步骤2: 迁移数据
    print("\n" + "=" * 60)
    print("步骤2: 迁移数据到 OB 仓库")
    print("=" * 60)

    # 迁移各个源
    migrate_xwlb()
    print(f"  → 新闻联播: 完成")

    for src_name, (ob_path, has_id) in SOURCE_MAP.items():
        if src_name == "xwlb":
            continue  # 已单独处理
        if src_name == "wechat":
            migrate_wechat()
            print(f"  → {src_name}: 完成")
        else:
            migrate_with_id(src_name, ob_path)
            print(f"  → {src_name} → {ob_path}: 完成")

    # 报告
    print("\n" + "=" * 60)
    print("迁移完成")
    print("=" * 60)
    print(f"  复制文件: {total_copied} 篇")
    print(f"  清理旧文件: {total_cleaned} 项")
    print(f"  错误: {total_errors} 个")

    if errors:
        print("\n错误详情:")
        for e in errors[:20]:
            print(f"  {e}")
        if len(errors) > 20:
            print(f"  ... 还有 {len(errors) - 20} 个错误")


if __name__ == "__main__":
    main()
