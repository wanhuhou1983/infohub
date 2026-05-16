# InfoHub 固定模式文档

> ⚠️ **重要**：以下模式已固定，任何修改必须与用户确认后方可执行。

## 核心原则：每日一篇 + 全文采集

**新闻联播** 和 **人民日报** 两个信息来源：
- 每天只生成 **1 条数据库记录 + 1 个 Obsidian 文件**
- 包含当日所有新闻的 **完整正文**（非仅标题/链接）
- 按出场顺序合并，用 `---` 分隔
- 绝不按单条新闻拆分，也绝不只存 URL

---

## 1. 新闻联播 (xwlb)

| 项目 | 值 |
|------|-----|
| source_type | `xwlb` |
| source_id | `1` |
| 数据来源 | cn.govopendata.com（全文）+ tv.cctv.com（回退用） |
| 每日篇数 | **1 篇**（聚合当日所有新闻） |
| content_hash | `hashString('xwlb_' + YYYYMMDD)` |
| 标题格式 | `新闻联播 YYYY-MM-DD 文字稿` |
| 正文格式 | `### N. 标题` + 完整正文，`---` 分隔 |
| OB 目录 | `报刊杂志/新闻联播/` |
| OB 文件名 | `YYYYMMDD-新闻联播_YYYY-MM-DD_文字稿.md` |

**采集流程**：
1. 调用 `POST /api/fetch/xwlb`，可选参数 `date`（YYYYMMDD，默认今天）
2. 从 CCTV 列表页 `tv.cctv.com/lm/xwlb/day/YYYYMMDD.shtml` 解析新闻条目（验证日期有效性）
3. **优先**从 `cn.govopendata.com/xinwenlianbo/YYYYMMDD/` 获取每条新闻的**完整正文**
4. 每条新闻格式：`### N. 标题` + 正文段落，`---` 分隔
5. 若 govopendata 不可用，**回退**为 URL 列表：`N. [标题](链接)`
6. content_hash 去重：同一日期不重复插入
7. 生成 1 个 OB Markdown 文件

**代码位置**：`backend/routes/fetch.ts` → `router.post('/xwlb')`

**解析函数**：`backend/services/parser.ts` → `parseGovopendataXWLB()`

---

## 2. 人民日报 (rmrb)

| 项目 | 值 |
|------|-----|
| source_type | `rmrb` |
| source_id | `1264` |
| 数据来源 | paper.people.com.cn（通过 Python 脚本 `rmrb_daily.py --full`） |
| 每日篇数 | **1 篇**（聚合当日所有要闻文章） |
| content_hash | `hashString('rmrb_' + YYYY-MM-DD)` |
| 标题格式 | `人民日报要闻汇总 YYYY-MM-DD` |
| 正文格式 | `## 第XX版：版名` → `### N. 标题` + 完整正文（含 `- [查看原文]` 链接） |
| OB 目录 | `报刊杂志/人民日报/` |
| OB 文件名 | `YYYYMMDD-人民日报要闻汇总_YYYY-MM-DD.md` |

**采集流程**：
1. 调用 `POST /api/fetch/rmrb`，可选参数 `date`（YYYY-MM-DD，默认今天）
2. **默认带 `--full` 参数**，抓取每条要闻的**完整正文**
3. Python 脚本 `rmrb_daily.py --full` 输出完整 Markdown 文件到 `skills/rmrb-daily/`
4. 读取整个 Markdown 文件作为文章 content
5. content_hash 去重：同一日期不重复插入
6. 生成 1 个 OB Markdown 文件

**代码位置**：`backend/routes/fetch.ts` → `router.post('/rmrb')`

**依赖**：`infohub/skills/rmrb-daily/rmrb_daily.py`，Python 包 `requests` + `beautifulsoup4`

---

## 3. 其他来源（保持现状）

| 来源 | 模式 |
|------|------|
| 喷嚏图卦 | 1 篇/天（独立采集） |
| 腾讯新闻 | 多篇/天（按文章拆分） |
| 微信公众号 | 每篇公众号文章独立 |
| RSS 订阅 | 每条 feed 独立 |
| B站 | 每条视频独立 |
| YouTube | 每条视频独立 |

---

## 4. Changelog

| 日期 | 变更 |
|------|------|
| 2026-04-29 | 修复：rmrb/xwlb 改为每日一篇，删除旧拆分数据 |
| 2026-04-29 v2 | 修复：xwlb 改为从 cn.govopendata.com 获取完整正文（非仅URL列表）；rmrb 默认 `--full` 获取全文；正反例子对比已记录 |

---

*本文档为 InfoHub 系统固定模式参考，修改前必须与用户确认。*
