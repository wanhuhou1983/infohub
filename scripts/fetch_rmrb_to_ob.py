#!/usr/bin/env python3
"""
人民日报批量采集 → Obsidian
调用 rmrb_daily.py，逐日采集，输出到 OB 目录

用法:
  python3 fetch_rmrb_to_ob.py --output /path/to/ob/报刊杂志/人民日报 --start 2026-03-29 --end 2026-04-29
"""

import subprocess
import sys
import os
import argparse
from datetime import datetime, timedelta


def main():
    parser = argparse.ArgumentParser(description='人民日报批量采集 → Obsidian')
    parser.add_argument('--output', required=True, help='OB 输出目录')
    parser.add_argument('--start', required=True, help='开始日期 (YYYY-MM-DD)')
    parser.add_argument('--end', required=True, help='结束日期 (YYYY-MM-DD)')
    parser.add_argument('--full', action='store_true', help='抓取完整正文（较慢）')
    args = parser.parse_args()

    output_dir = args.output
    os.makedirs(output_dir, exist_ok=True)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    rmrb_script = os.path.join(script_dir, '..', 'skills', 'rmrb-daily', 'rmrb_daily.py')

    if not os.path.exists(rmrb_script):
        print(f'❌ 找不到人民日报采集脚本: {rmrb_script}')
        sys.exit(1)

    start = datetime.strptime(args.start, '%Y-%m-%d')
    end = datetime.strptime(args.end, '%Y-%m-%d')

    dates = []
    current = start
    while current <= end:
        dates.append(current)
        current += timedelta(days=1)

    print(f'📰 开始采集人民日报，共 {len(dates)} 天，输出到 {output_dir}')
    print(f'   模式: {"全文" if args.full else "标题+链接"}')

    success = 0
    failed = 0
    skipped = 0

    for d in dates:
        date_str = d.strftime('%Y-%m-%d')
        date_compact = d.strftime('%Y%m%d')
        filename = f'{date_compact}人民日报.md'
        filepath = os.path.join(output_dir, filename)

        if os.path.exists(filepath):
            print(f'  ⏭️ {date_str} 已存在，跳过')
            skipped += 1
            continue

        cmd = [sys.executable, rmrb_script, date_str, '--output', filepath]
        if args.full:
            cmd.append('--full')

        print(f'  📅 {date_str} ...', end=' ', flush=True)
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode == 0:
                # 检查文件是否生成且有内容
                if os.path.exists(filepath) and os.path.getsize(filepath) > 100:
                    print('✅')
                    success += 1
                else:
                    print('⚠️ 文件为空或不存在')
                    failed += 1
            else:
                print(f'❌ {result.stderr.strip()[:80]}')
                failed += 1
        except subprocess.TimeoutExpired:
            print('⏰ 超时')
            failed += 1
        except Exception as e:
            print(f'❌ {e}')
            failed += 1

    print(f'\n✅ 完成！成功 {success}，跳过 {skipped}，失败 {failed}')


if __name__ == '__main__':
    main()
