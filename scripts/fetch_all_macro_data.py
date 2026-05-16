#!/usr/bin/env python3
"""
全量宏观数据采集脚本 - InfoHub
基于 AKShare 一次性跑完所有数据源，输出 Markdown 报告 + JSON 原始数据到 Obsidian 仓库。

数据源分类：
  中国官方：PBOC、NBS、NDRC、MOF、GACC、SAFE
  美国官方：Fed/FRED/BLS/BEA/Treasury/EIA/USDA/USTR
  国际组织：BIS、IMF、WorldBank

用法：python3 fetch_all_macro_data.py
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd
import akshare as ak

# 抑制 SSL 警告
import urllib3
urllib3.disable_warnings(urllib3.exceptions.NotOpenSSLWarning)

# ==================== 配置 ====================
OB_DIR = "/Users/wuhuahui/Documents/infohub"
REPORT_DATE = datetime.now().strftime("%Y-%m-%d")

# ==================== 工具函数 ====================

def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat()

def _iso_convert(val):
    return val.isoformat() if hasattr(val, "isoformat") else val

def df_to_records(df: pd.DataFrame) -> List[Dict]:
    if df is None or df.empty:
        return []
    df = df.copy()
    df = df.fillna('')
    for col in df.columns:
        if str(df[col].dtype).startswith('object'):
            df[col] = df[col].apply(_iso_convert)
    return json.loads(df.to_json(orient="records", force_ascii=False))

def latest_record(df: pd.DataFrame) -> Optional[Dict]:
    records = df_to_records(df.tail(1))
    return records[0] if records else None

def safe_fetch(name: str, fn, *args, **kwargs) -> tuple:
    """安全采集，返回 (success, data_or_error_msg)"""
    try:
        df = fn(*args, **kwargs)
        return (True, df)
    except Exception as e:
        return (False, str(e))

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def write_json(data: Any, path: str):
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def write_markdown(content: str, path: str):
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

def ts_filename(prefix: str, ext: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{ts}.{ext}"

# ==================== 报告生成 ====================

def generate_report(source_cn: str, source_en: str, data: Dict, fields: List[Dict]) -> str:
    """
    生成 Markdown 格式报告。
    data: {field_name: {"df": DataFrame, "success": bool, "error": str, "name": str, "desc": str}}
    fields: [{name, desc}]  描述每个字段
    """
    lines = [
        f"# {source_cn}宏观数据全量采集报告",
        "",
        f"**采集时间**：{REPORT_DATE}",
        f"**数据来源**：AKShare ({ak.__version__})",
        f"**覆盖指标**：{len(fields)}项",
        "",
        "---",
        "",
    ]

    total_rows = 0
    for f in fields:
        fname = f["name"]
        fdesc = f["desc"]
        item = data.get(fname, {})
        success = item.get("success", False)
        df = item.get("df")
        error = item.get("error", "")

        lines.append(f"## {fdesc}（{fname}）")
        lines.append("")

        if not success:
            lines.append(f"❌ **采集失败**：`{error}`")
            lines.append("")
            continue

        if df is None or df.empty:
            lines.append("⚠️ **数据为空**")
            lines.append("")
            continue

        total_rows += len(df)
        latest = latest_record(df)
        latest_str = json.dumps(latest, ensure_ascii=False, default=str) if latest else "N/A"

        lines.append(f"✅ 共 **{len(df)}** 条记录")
        lines.append(f"**最新数据**：{latest_str}")
        lines.append("")
        lines.append("### 最近5条")
        lines.append("")
        lines.append("```")
        # 显示所有列，但限制行
        display_df = df.tail(5)
        lines.append(display_df.to_string(index=False))
        lines.append("```")
        lines.append("")

    lines.append("---")
    lines.append(f"*本报告由 InfoHub 自动生成 | {now_ts()}*")

    return "\n".join(lines)

# ==================== 中国官方数据 ====================

def fetch_china_pboc():
    """PBOC 12项全量"""
    print("  [PBOC] 开始采集...")
    data = {}

    # 1. 货币供应量
    success, result = safe_fetch("money_supply", ak.macro_china_money_supply)
    data["money_supply"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 2. 存款准备金率
    success, result = safe_fetch("reserve_requirement_ratio", ak.macro_china_reserve_requirement_ratio)
    data["reserve_requirement_ratio"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 3. LPR
    success, result = safe_fetch("lpr", ak.macro_china_lpr)
    data["lpr"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 4. SHIBOR
    success, result = safe_fetch("shibor_all", ak.macro_china_shibor_all)
    data["shibor_all"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 5. 央行资产负债表
    success, result = safe_fetch("central_bank_balance", ak.macro_china_central_bank_balance)
    data["central_bank_balance"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 6. 外汇储备
    success, result = safe_fetch("fx_reserves", ak.macro_china_fx_reserves_yearly)
    data["fx_reserves"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 7. 黄金储备
    success, result = safe_fetch("gold", ak.macro_china_fx_gold)
    data["gold"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 8. 人民币汇率
    success, result = safe_fetch("rmb", ak.macro_china_rmb)
    data["rmb"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 9. 信贷数据
    success, result = safe_fetch("new_financial_credit", ak.macro_china_new_financial_credit)
    data["new_financial_credit"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 10. 社融
    success, result = safe_fetch("bank_financing", ak.macro_china_bank_financing)
    data["bank_financing"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 11. 外汇
    success, result = safe_fetch("foreign_exchange_gold", ak.macro_china_foreign_exchange_gold)
    data["foreign_exchange_gold"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    # 12. swap利率
    success, result = safe_fetch("swap_rate", ak.macro_china_swap_rate)
    data["swap_rate"] = {"df": result if success else None, "success": success, "error": result if not success else ""}

    print(f"  [PBOC] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

def fetch_china_nbs():
    """NBS 国家统计局"""
    print("  [NBS] 开始采集...")
    data = {}

    funcs = [
        ("gdp", "GDP", ak.macro_china_gdp),
        ("cpi", "CPI", ak.macro_china_cpi),
        ("ppi", "PPI", ak.macro_china_ppi),
        ("pmi", "PMI官方", ak.macro_china_pmi),
        ("non_man_pmi", "非制造业PMI", ak.macro_china_non_man_pmi),
        ("cx_pmi", "财新PMI", ak.macro_china_cx_pmi_yearly),
        ("industrial_production_yoy", "工业增加值同比", ak.macro_china_industrial_production_yoy),
        ("urban_unemployment", "城镇失业率", ak.macro_china_urban_unemployment),
        ("consumer_goods_retail", "社会消费品零售", ak.macro_china_consumer_goods_retail),
        ("gdzctz", "固定资产投资", ak.macro_china_gdzctz),
        ("gyzjz", "工业增加值累计", ak.macro_china_gyzjz),
        ("trade_balance", "贸易差额", ak.macro_china_trade_balance),
        ("exports_yoy", "出口同比", ak.macro_china_exports_yoy),
        ("imports_yoy", "进口同比", ak.macro_china_imports_yoy),
        ("cpi_monthly", "CPI月度明细", ak.macro_china_cpi_monthly),
        ("ppi_yearly", "PPI月度明细", ak.macro_china_ppi_yearly),
        ("gdp_yearly", "GDP年度", ak.macro_china_gdp_yearly),
        ("fdi", "实际使用外资", ak.macro_china_fdi),
        ("cx_services_pmi", "财新服务业PMI", ak.macro_china_cx_services_pmi_yearly),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [NBS] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

def fetch_china_ndrc():
    """发改委 NDRC"""
    print("  [NDRC] 开始采集...")
    data = {}

    funcs = [
        ("gdzctz", "固定资产投资", ak.macro_china_gdzctz),
        ("gyzjz", "工业增加值", ak.macro_china_gyzjz),
        ("consumer_goods_retail", "社会消费品零售总额", ak.macro_china_consumer_goods_retail),
        ("energy_index", "能源指数", ak.macro_china_energy_index),
        ("construction_index", "建筑业指数", ak.macro_china_construction_index),
        ("agricultural_index", "农业指数", ak.macro_china_agricultural_index),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [NDRC] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

def fetch_china_mof():
    """财政部 MOF"""
    print("  [MOF] 开始采集...")
    data = {}

    funcs = [
        ("national_tax_receipts", "全国税收收入", ak.macro_china_national_tax_receipts),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [MOF] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

def fetch_china_gacc():
    """海关总署 GACC"""
    print("  [GACC] 开始采集...")
    data = {}

    funcs = [
        ("exports_yoy", "出口同比", ak.macro_china_exports_yoy),
        ("imports_yoy", "进口同比", ak.macro_china_imports_yoy),
        ("trade_balance", "贸易差额", ak.macro_china_trade_balance),
        ("hgjck", "进出口总值", ak.macro_china_hgjck),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [GACC] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

def fetch_china_safe():
    """外汇管理局 SAFE"""
    print("  [SAFE] 开始采集...")
    data = {}

    funcs = [
        ("fx_reserves_yearly", "外汇储备年度", ak.macro_china_fx_reserves_yearly),
        ("fx_gold", "黄金储备", ak.macro_china_fx_gold),
        ("foreign_exchange_gold", "外汇和黄金储备", ak.macro_china_foreign_exchange_gold),
        ("rmb_rate", "人民币汇率中间价", ak.macro_china_rmb),
        ("international_tourism_fx", "国际旅游外汇收入", ak.macro_china_international_tourism_fx),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [SAFE] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

# ==================== 美国数据 ====================

USA_FIELDS = [
    ("gdp_monthly", "美国GDP"),
    ("cpi_monthly", "美国CPI月率"),
    ("cpi_yoy", "美国CPI年率"),
    ("core_ppi", "美国核心PPI"),
    ("ppi", "美国PPI月率"),
    ("unemployment_rate", "美国失业率"),
    ("non_farm", "美国非农就业"),
    ("retail_sales", "美国零售销售"),
    ("industrial_production", "美国工业生产"),
    ("pmi", "美国制造业PMI"),
    ("services_pmi", "美国服务业PMI"),
    ("house_starts", "美国新屋开工"),
    ("exist_home_sales", "美国成屋销售"),
    ("new_home_sales", "美国新屋销售"),
    ("durable_goods_orders", "美国耐用品订单"),
    ("initial_jobless", "美国初请失业金"),
    ("michigan_consumer_sentiment", "美国密歇根消费者信心"),
    ("cb_consumer_confidence", "美国消费者信心"),
    ("trade_balance", "美国贸易差额"),
    ("personal_spending", "美国个人支出"),
    ("core_pce_price", "美国核心PCE"),
    ("building_permits", "美国营建许可"),
    ("factory_orders", "美国工厂订单"),
    ("business_inventories", "美国商业库存"),
    ("adp_employment", "美国ADP就业"),
    (" ISM_pmi", "美国ISM制造业PMI"),
    ("ism_non_pmi", "美国ISM非制造业PMI"),
    ("house_price_index", "美国房价指数"),
    ("new_home_sales2", "美国新屋销售"),
    ("pending_home_sales", "美国待售房屋销售"),
]

def fetch_usa():
    """美联储/FRED/BLS/BEA数据"""
    print("  [USA] 开始采集...")
    data = {}

    funcs = [
        ("gdp_monthly", "美国GDP", ak.macro_usa_gdp_monthly),
        ("cpi_monthly", "美国CPI月率", ak.macro_usa_cpi_monthly),
        ("cpi_yoy", "美国CPI年率", ak.macro_usa_cpi_yoy),
        ("core_ppi", "美国核心PPI", ak.macro_usa_core_ppi),
        ("ppi", "美国PPI月率", ak.macro_usa_ppi),
        ("unemployment_rate", "美国失业率", ak.macro_usa_unemployment_rate),
        ("non_farm", "美国非农就业", ak.macro_usa_non_farm),
        ("retail_sales", "美国零售销售", ak.macro_usa_retail_sales),
        ("industrial_production", "美国工业生产", ak.macro_usa_industrial_production),
        ("pmi", "美国制造业PMI", ak.macro_usa_pmi),
        ("services_pmi", "美国服务业PMI", ak.macro_usa_services_pmi),
        ("house_starts", "美国新屋开工", ak.macro_usa_house_starts),
        ("exist_home_sales", "美国成屋销售", ak.macro_usa_exist_home_sales),
        ("new_home_sales", "美国新屋销售", ak.macro_usa_new_home_sales),
        ("durable_goods_orders", "美国耐用品订单", ak.macro_usa_durable_goods_orders),
        ("initial_jobless", "美国初请失业金人数", ak.macro_usa_initial_jobless),
        ("michigan_consumer_sentiment", "美国密歇根消费者信心", ak.macro_usa_michigan_consumer_sentiment),
        ("cb_consumer_confidence", "美国消费者信心CB", ak.macro_usa_cb_consumer_confidence),
        ("trade_balance", "美国贸易差额", ak.macro_usa_trade_balance),
        ("personal_spending", "美国个人支出", ak.macro_usa_personal_spending),
        ("core_pce_price", "美国核心PCE物价指数", ak.macro_usa_core_pce_price),
        ("building_permits", "美国营建许可", ak.macro_usa_building_permits),
        ("factory_orders", "美国工厂订单", ak.macro_usa_factory_orders),
        ("business_inventories", "美国商业库存", ak.macro_usa_business_inventories),
        ("adp_employment", "美国ADP就业", ak.macro_usa_adp_employment),
        ("ism_pmi", "美国ISM制造业PMI", ak.macro_usa_ism_pmi),
        ("ism_non_pmi", "美国ISM非制造业PMI", ak.macro_usa_ism_non_pmi),
        ("house_price_index", "美国房价指数", ak.macro_usa_house_price_index),
        ("pending_home_sales", "美国待售房屋销售", ak.macro_usa_pending_home_sales),
        ("real_consumer_spending", "美国实际消费者支出", ak.macro_usa_real_consumer_spending),
        ("export_price", "美国出口价格指数", ak.macro_usa_export_price),
        ("import_price", "美国进口价格指数", ak.macro_usa_import_price),
        ("exist_home_sales2", "美国成屋销售", ak.macro_usa_exist_home_sales),
        ("lmci", "美国LMCI", ak.macro_usa_lmci),
        ("nahb_house_market_index", "美国NAHB房产市场指数", ak.macro_usa_nahb_house_market_index),
        ("nfib_small_business", "美国NFIB小企业信心", ak.macro_usa_nfib_small_business),
        ("job_cuts", "美国裁员计划", ak.macro_usa_job_cuts),
    ]

    for fname, fdesc, fn in funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [USA] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

# ==================== 国际组织数据 ====================

def fetch_international():
    """BIS/IMF/WorldBank"""
    print("  [International] 开始采集...")
    data = {}

    # BIS 数据
    bis_funcs = [
        ("agricultural_product", "BIS农产品价格指数", ak.macro_china_agricultural_product),
        ("commodity_price_index", "BIS大宗商品价格指数", ak.macro_china_commodity_price_index),
        ("energy_index", "BIS能源指数", ak.macro_china_energy_index),
        ("bdti_index", "BIS BDTI指数", ak.macro_china_bdti_index),
        ("bsi_index", "BIS BSI指数", ak.macro_china_bsi_index),
    ]

    for fname, fdesc, fn in bis_funcs:
        success, result = safe_fetch(fname, fn)
        data[fname] = {"df": result if success else None, "success": success, "error": result if not success else "", "name": fdesc, "desc": fdesc}

    print(f"  [International] 完成，{sum(1 for v in data.values() if v['success'])}/{len(data)} 项成功")
    return data

# ==================== 主流程 ====================

def save_source_data(source_name: str, source_cn: str, data: Dict, ob_subdir: str):
    """保存单个数据源的报告和JSON"""
    ts = datetime.now().strftime("%Y%m%d")
    base_dir = os.path.join(OB_DIR, source_name, ob_subdir)
    ensure_dir(base_dir)

    # 合并所有 df 为一个大 JSON
    all_records = {}
    total_rows = 0
    for fname, item in data.items():
        df = item.get("df")
        if df is not None and not df.empty:
            all_records[fname] = df_to_records(df)
            total_rows += len(df)

    # 写原始 JSON
    json_path = os.path.join(base_dir, f"rawdata_{source_name}_{ts}.json")
    write_json(all_records, json_path)
    print(f"    JSON: {json_path} ({total_rows} 条记录)")

    # 生成报告
    fields = [{"name": k, "desc": v.get("desc", k)} for k, v in data.items()]
    report = generate_report(source_cn, source_name, data, fields)

    # 写 Markdown 报告
    report_path = os.path.join(base_dir, f"{source_name}_全量采集报告.md")
    write_markdown(report, report_path)
    print(f"    报告: {report_path}")

    # 写最新数据摘要 JSON（方便快速查阅）
    summary = {}
    for fname, item in data.items():
        df = item.get("df")
        if df is not None and not df.empty:
            summary[fname] = latest_record(df)
    summary_path = os.path.join(base_dir, f"latest_{source_name}_{ts}.json")
    write_json(summary, summary_path)

    return total_rows

def main():
    parser = argparse.ArgumentParser(description="全量宏观数据采集")
    parser.add_argument("--source", choices=["china", "usa", "all"], default="all")
    args = parser.parse_args()

    print(f"=== InfoHub 全量宏观数据采集 ===")
    print(f"OB目录: {OB_DIR}")
    print(f"开始时间: {now_ts()}")
    print()

    total_records = 0

    if args.source in ("china", "all"):
        # PBOC
        print("[1/6] 中国人民银行...")
        data_pboc = fetch_china_pboc()
        total_records += save_source_data("PBOC", "中国人民银行", data_pboc, "")

        # NBS
        print("[2/6] 国家统计局...")
        data_nbs = fetch_china_nbs()
        total_records += save_source_data("NBS", "国家统计局", data_nbs, "")

        # NDRC
        print("[3/6] 发改委...")
        data_ndrc = fetch_china_ndrc()
        total_records += save_source_data("NDRC", "国家发展和改革委员会", data_ndrc, "")

        # MOF
        print("[4/6] 财政部...")
        data_mof = fetch_china_mof()
        total_records += save_source_data("MOF", "财政部", data_mof, "")

        # GACC
        print("[5/6] 海关总署...")
        data_gacc = fetch_china_gacc()
        total_records += save_source_data("GACC", "海关总署", data_gacc, "")

        # SAFE
        print("[6/6] 外汇管理局...")
        data_safe = fetch_china_safe()
        total_records += save_source_data("SAFE", "国家外汇管理局", data_safe, "")

    if args.source in ("usa", "all"):
        print("[USA] 美国官方数据...")
        data_usa = fetch_usa()
        total_records += save_source_data("USA", "美国官方数据源", data_usa, "美国官方数据源")

    if args.source in ("all",):
        print("[International] 国际组织数据...")
        data_intl = fetch_international()
        total_records += save_source_data("International", "国际组织数据源", data_intl, "国际组织数据源")

    print()
    print(f"=== 采集完成 ===")
    print(f"总记录数: {total_records}")
    print(f"结束时间: {now_ts()}")

if __name__ == "__main__":
    main()
