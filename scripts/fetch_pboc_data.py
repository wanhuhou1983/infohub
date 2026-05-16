#!/usr/bin/env python3
"""
中国人民银行（PBOC）宏观数据采集脚本
基于 AKShare 获取结构化数据，输出为 JSON 格式，供 InfoHub 后端入库。
支持增量采集（记录最新时间戳）。

用法：
  python3 fetch_pboc_data.py                    # 全部采集
  python3 fetch_pboc_data.py --category money   # 仅货币供应
  python3 fetch_pboc_data.py --output /tmp/     # 指定输出目录

数据分类：
  money     - 货币供应量 (M0/M1/M2)
  rate      - 利率 (LPR, SHIBOR, 准备金率)
  fx        - 外汇储备 & 汇率
  central   - 央行资产负债表
  macro     - 宏观指标 (GDP/CPI/PPI/PMI/工业增加值)
  credit    - 信贷 & 社融
  all       - 以上全部（默认）
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import pandas as pd

try:
    import akshare as ak
except ImportError:
    print("❌ 请先安装 akshare: pip install akshare")
    sys.exit(1)

# 抑制 urllib3 SSL 警告（macOS LibreSSL）
import urllib3
urllib3.disable_warnings(urllib3.exceptions.NotOpenSSLWarning)

# ==== 时间戳处理 ====

def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat()

def _iso_convert(val):
    """将 date/datetime 对象转为 iso 字符串"""
    return val.isoformat() if hasattr(val, "isoformat") else val

def df_to_records(df: pd.DataFrame) -> list:
    """DataFrame → JSON 可序列化的 record 列表"""
    if df is None or df.empty:
        return []
    df = df.fillna("")
    for col in df.columns:
        if df[col].dtype.name == "object":
            df[col] = df[col].apply(_iso_convert)
    return json.loads(df.to_json(orient="records", force_ascii=False))

def latest_record(df: pd.DataFrame) -> dict:
    """获取最后一行作为可序列化 dict"""
    if df is None or df.empty:
        return {}
    records = df_to_records(df.tail(1))
    return records[0] if records else {}

# ==== 采集函数 ====

def fetch_central_bank_balance() -> Dict[str, Any]:
    """央行资产负债表"""
    try:
        df = ak.macro_china_central_bank_balance()
        return {
            "name": "央行资产负债表",
            "function": "macro_china_central_bank_balance",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "央行资产负债表", "error": str(e)}


def fetch_money_supply() -> Dict[str, Any]:
    """货币供应量 M0/M1/M2"""
    try:
        df = ak.macro_china_money_supply()
        return {
            "name": "货币供应量",
            "function": "macro_china_money_supply",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "货币供应量", "error": str(e)}


def fetch_lpr() -> Dict[str, Any]:
    """LPR 利率"""
    try:
        df = ak.macro_china_lpr()
        return {
            "name": "LPR利率",
            "function": "macro_china_lpr",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "LPR利率", "error": str(e)}


def fetch_shibor() -> Dict[str, Any]:
    """SHIBOR 利率"""
    try:
        df = ak.macro_china_shibor_all()
        return {
            "name": "SHIBOR",
            "function": "macro_china_shibor_all",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "SHIBOR", "error": str(e)}


def fetch_reserve_ratio() -> Dict[str, Any]:
    """存款准备金率"""
    try:
        df = ak.macro_china_reserve_requirement_ratio()
        return {
            "name": "存款准备金率",
            "function": "macro_china_reserve_requirement_ratio",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "存款准备金率", "error": str(e)}


def fetch_foreign_exchange_gold() -> Dict[str, Any]:
    """外汇储备与黄金储备"""
    try:
        df = ak.macro_china_foreign_exchange_gold()
        return {
            "name": "外汇储备与黄金储备",
            "function": "macro_china_foreign_exchange_gold",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "外汇储备与黄金储备", "error": str(e)}


def fetch_rmb_rate() -> Dict[str, Any]:
    """人民币汇率中间价"""
    try:
        df = ak.macro_china_rmb()
        return {
            "name": "人民币汇率",
            "function": "macro_china_rmb",
            "rows": len(df),
            "columns": df.columns.tolist(),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "人民币汇率", "error": str(e)}


def fetch_macro_gdp() -> Dict[str, Any]:
    """GDP"""
    try:
        df = ak.macro_china_gdp_yearly()
        return {
            "name": "GDP",
            "function": "macro_china_gdp_yearly",
            "rows": len(df),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "GDP", "error": str(e)}


def fetch_macro_cpi() -> Dict[str, Any]:
    """CPI"""
    try:
        df = ak.macro_china_cpi_yearly()
        return {
            "name": "CPI",
            "function": "macro_china_cpi_yearly",
            "rows": len(df),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "CPI", "error": str(e)}


def fetch_macro_ppi() -> Dict[str, Any]:
    """PPI"""
    try:
        df = ak.macro_china_ppi_yearly()
        return {
            "name": "PPI",
            "function": "macro_china_ppi_yearly",
            "rows": len(df),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "PPI", "error": str(e)}


def fetch_macro_pmi() -> Dict[str, Any]:
    """PMI"""
    try:
        df = ak.macro_china_pmi_yearly()
        return {
            "name": "PMI",
            "function": "macro_china_pmi_yearly",
            "rows": len(df),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "PMI", "error": str(e)}


def fetch_industrial_production() -> Dict[str, Any]:
    """工业增加值"""
    try:
        df = ak.macro_china_industrial_production_yoy()
        return {
            "name": "工业增加值",
            "function": "macro_china_industrial_production_yoy",
            "rows": len(df),
            "latest": latest_record(df),
            "records": df_to_records(df),
        }
    except Exception as e:
        return {"name": "工业增加值", "error": str(e)}


# ==== 分类调度 ====

CATEGORY_MAP = {
    "central": ["央行资产负债表"],
    "money": ["货币供应量"],
    "rate": ["LPR利率", "SHIBOR", "存款准备金率"],
    "fx": ["外汇储备与黄金储备", "人民币汇率"],
    "macro": ["GDP", "CPI", "PPI", "PMI", "工业增加值"],
    "credit": ["社会融资规模"],
}

ALL_FUNCS = {
    "央行资产负债表": fetch_central_bank_balance,
    "货币供应量": fetch_money_supply,
    "LPR利率": fetch_lpr,
    "SHIBOR": fetch_shibor,
    "存款准备金率": fetch_reserve_ratio,
    "外汇储备与黄金储备": fetch_foreign_exchange_gold,
    "人民币汇率": fetch_rmb_rate,
    "GDP": fetch_macro_gdp,
    "CPI": fetch_macro_cpi,
    "PPI": fetch_macro_ppi,
    "PMI": fetch_macro_pmi,
    "工业增加值": fetch_industrial_production,
}


def collect(category: str = "all") -> Dict[str, Any]:
    if category == "all":
        names = list(ALL_FUNCS.keys())
    elif category in CATEGORY_MAP:
        names = CATEGORY_MAP[category]
    else:
        print(f"❌ 未知分类: {category}")
        print(f"   可选: {list(CATEGORY_MAP.keys()) + ['all']}")
        sys.exit(1)

    results: Dict[str, Any] = {}
    for name in names:
        fn = ALL_FUNCS.get(name)
        if not fn:
            continue
        print(f"  📡 采集 {name}...", end=" ", flush=True)
        t0 = time.time()
        try:
            data = fn()
            elapsed = time.time() - t0
            if "error" in data:
                print(f"❌ {data['error']} ({elapsed:.1f}s)")
            else:
                print(f"✅ {data['rows']}行 ({elapsed:.1f}s)")
            results[name] = data
        except Exception as e:
            elapsed = time.time() - t0
            print(f"❌ {e} ({elapsed:.1f}s)")
            results[name] = {"name": name, "error": str(e)}

    return results


def main():
    parser = argparse.ArgumentParser(description="PBOC 宏观数据采集")
    parser.add_argument("--category", "-c", default="all",
                        choices=["all", "money", "rate", "fx", "central", "macro", "credit"],
                        help="数据分类")
    parser.add_argument("--output", "-o", default=None,
                        help="输出目录（默认打印到 stdout）")
    parser.add_argument("--pretty", "-p", action="store_true",
                        help="JSON 格式化输出")
    args = parser.parse_args()

    print(f"🔍 PBOC 数据采集 - 分类: {args.category}")
    print(f"{'='*50}")

    result = {
        "source": "中国人民银行(PBOC) via AKShare",
        "fetched_at": now_ts(),
        "category": args.category,
        "data": collect(args.category),
    }

    output_str = json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None)

    if args.output:
        os.makedirs(args.output, exist_ok=True)
        fname = f"pboc_{args.category}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        fpath = os.path.join(args.output, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(output_str)
        print(f"\n✅ 已保存到: {fpath}")
    else:
        print(f"\n{output_str}")


if __name__ == "__main__":
    main()
