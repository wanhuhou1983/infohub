#!/usr/bin/env python3
"""
宏观数据补充采集 + 整理到 OB 正确目录
针对已知高质量接口批量补采，并写入 InfoHub OB 目录正确位置。
"""

import json
import os
import time
from datetime import datetime

import pandas as pd
import akshare as ak
import urllib3
urllib3.disable_warnings(urllib3.exceptions.NotOpenSSLWarning)

OB_DIR = "/Users/wuhuahui/Documents/infohub"
REPORT_DATE = datetime.now().strftime("%Y-%m-%d")

def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else v

def df_records(df):
    if df is None or df.empty:
        return []
    df = df.copy().fillna('')
    for c in df.columns:
        if str(df[c].dtype) == 'object':
            df[c] = df[c].apply(_iso)
    return json.loads(df.to_json(orient="records", force_ascii=False))

def latest(df):
    recs = df_records(df.tail(1))
    return recs[0] if recs else {}

def safe(fn, *a, **kw):
    try:
        return True, fn(*a, **kw)
    except Exception as e:
        return False, str(e)

def ensure(p):
    os.makedirs(p, exist_ok=True)

def write_json(data, path):
    ensure(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def write_md(content, path):
    ensure(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

# ===================== 需要补充采集的高质量接口 =====================
SUPPL_FUNCS = [
    # NBS 高质量
    ("NBS", "城镇失业率", "urban_unemployment", ak.macro_china_urban_unemployment),
    ("NBS", "工业增加值", "gyzjz", ak.macro_china_gyzjz),
    ("NBS", "非制造业PMI", "non_man_pmi", ak.macro_china_non_man_pmi),
    ("NBS", "财新制造业PMI", "cx_pmi", ak.macro_china_cx_pmi_yearly),
    ("NBS", "财新服务业PMI", "cx_services_pmi", ak.macro_china_cx_services_pmi_yearly),
    ("NBS", "社会消费品零售", "consumer_goods_retail", ak.macro_china_consumer_goods_retail),
    ("NBS", "GDP同比", "gdp_yearly", ak.macro_china_gdp_yearly),
    ("NBS", "CPI月度", "cpi_monthly", ak.macro_china_cpi_monthly),
    ("NBS", "PPI月度", "ppi_yearly", ak.macro_china_ppi_yearly),
    ("NBS", "出口同比", "exports_yoy", ak.macro_china_exports_yoy),
    ("NBS", "进口同比", "imports_yoy", ak.macro_china_imports_yoy),
    ("NBS", "实际使用外资", "fdi", ak.macro_china_fdi),

    # PBOC 高质量（部分已有但补充）
    ("PBOC", "货币供应量", "money_supply", ak.macro_china_money_supply),
    ("PBOC", "新增信贷", "new_financial_credit", ak.macro_china_new_financial_credit),
    ("PBOC", "银行理财", "bank_financing", ak.macro_china_bank_financing),

    # GACC 海关
    ("GACC", "进出口总值", "hgjck", ak.macro_china_hgjck),

    # 房地产
    ("NDRC", "房价指数", "new_house_price", ak.macro_china_new_house_price),
    ("NDRC", "房地产开发", "real_estate", ak.macro_china_real_estate),

    # 能源
    ("NDRC", "日度能源", "daily_energy", ak.macro_china_daily_energy),

    # 美国高频
    ("USA", "美初请失业金", "initial_jobless", ak.macro_usa_initial_jobless),
    ("USA", "美非农", "non_farm", ak.macro_usa_non_farm),
    ("USA", "美CPI月率", "cpi_monthly", ak.macro_usa_cpi_monthly),
    ("USA", "美核心PCE", "core_pce", ak.macro_usa_core_pce_price),
    ("USA", "美零售销售", "retail_sales", ak.macro_usa_retail_sales),
    ("USA", "美ISM制造业PMI", "ism_pmi", ak.macro_usa_ism_pmi),
    ("USA", "美ISM非制造业PMI", "ism_non_pmi", ak.macro_usa_ism_non_pmi),
    ("USA", "美新屋开工", "house_starts", ak.macro_usa_house_starts),
    ("USA", "美成屋销售", "exist_home_sales", ak.macro_usa_exist_home_sales),
    ("USA", "美个人支出", "personal_spending", ak.macro_usa_personal_spending),
    ("USA", "美工业产出", "industrial_production", ak.macro_usa_industrial_production),
]

# OB 目录映射
OB_MAP = {
    "PBOC": "中国官方数据源/中国人民银行",
    "NBS":  "中国官方数据源/国家统计局",
    "NDRC": "中国官方数据源/国家发展和改革委员会",
    "MOF":  "中国官方数据源/财政部",
    "GACC": "中国官方数据源/海关总署",
    "SAFE": "中国官方数据源/国家外汇管理局",
    "USA":  "美国官方数据源",
    "BIS":  "国际组织数据源",
    "IMF":  "国际组织数据源",
    "WB":   "国际组织数据源",
}

def main():
    print("=== 宏观数据补充采集 ===")
    all_data = {}   # (src, name) -> df
    all_latest = {}
    errors = []

    for src, fname, key, fn in SUPPL_FUNCS:
        print(f"  [{src}] {fname}...", end=" ", flush=True)
        ok, result = safe(fn)
        if ok:
            df = result
            all_data[(src, fname)] = df
            all_latest[(src, fname)] = latest(df)
            print(f"✅ {df.shape[0]}行")
        else:
            errors.append((src, fname, result))
            print(f"❌ {str(result)[:60]}")
        time.sleep(0.3)

    print(f"\n成功 {len(all_data)} 项，失败 {len(errors)} 项")

    # ===== 按源合并写入 =====
    by_source = {}
    for (src, fname), df in all_data.items():
        if src not in by_source:
            by_source[src] = {}
        by_source[src][fname] = df

    ts = datetime.now().strftime("%Y%m%d")

    for src, fields in by_source.items():
        ob_sub = OB_MAP.get(src, src)
        base = os.path.join(OB_DIR, ob_sub)
        ensure(base)

        # 写原始 JSON（按字段分）
        combined = {}
        total = 0
        for fname, df in fields.items():
            combined[fname] = df_records(df)
            total += len(df)

        json_path = os.path.join(base, f"rawdata_{src}_{ts}.json")
        write_json(combined, json_path)
        print(f"  ✅ {src} JSON: {json_path} ({total}条)")

        # 写最新值摘要（键用字符串）
        latest_path = os.path.join(base, f"latest_{src}_{ts}.json")
        latest_str_keys = {f"{src}::{fname}": lv for (s,fname), lv in all_latest.items() if s == src}
        write_json(latest_str_keys, latest_path)

        # 写 Markdown 报告
        md_lines = [
            f"# {src}宏观数据补充采集报告",
            "",
            f"**采集时间**: {REPORT_DATE}",
            f"**AKShare版本**: {ak.__version__}",
            f"**覆盖指标**: {len(fields)}项 / {total}条",
            "",
            "---",
            ""
        ]
        for fname, df in fields.items():
            md_lines.append(f"## {fname}")
            md_lines.append("")
            md_lines.append(f"共 **{len(df)}** 条记录")
            lv = latest(df)
            md_lines.append(f"**最新**: `{json.dumps(lv, ensure_ascii=False, default=str)}`")
            md_lines.append("")
            md_lines.append("```")
            md_lines.append(df.tail(5).to_string(index=False))
            md_lines.append("```")
            md_lines.append("")

        md_lines.append(f"*Auto-generated {datetime.now().isoformat()}*")
        md_path = os.path.join(base, f"{src}_补充采集报告.md")
        write_md("\n".join(md_lines), md_path)
        print(f"  ✅ {src} 报告: {md_path}")

    if errors:
        print("\n失败列表:")
        for src, fname, err in errors:
            print(f"  ❌ [{src}] {fname}: {err}")

    print("\n=== 完成 ===")

if __name__ == "__main__":
    main()
