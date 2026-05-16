# WeFlow 调试知识库

> 记录 InfoHub 微信公众号采集模块与 WeFlow 之间的调试经验和原理分析。
> 每次调试成功后整理归档，持续更新。

---

## 1. WeFlow Messages API 调用规范

### 1.1 必需参数：cursor=0

**发现时间：** 2026-04-28

WeFlow messages API 必须显式传递 `cursor=0` 参数，否则返回空消息（count=0 或 hasMore=false）。

**原因分析：**
- WeFlow 内部维护每个公众号的 WCDB 消息游标位置
- 不传 `cursor` 时，WCDB 层返回"当前位置无消息"（游标可能已越界）
- 传 `cursor=0` 强制从 DB 起点开始扫描

**正确调用：**
```
GET /api/v1/messages?talker={ghId}&limit={n}&cursor=0
```

**错误调用：**
```
GET /api/v1/messages?talker={ghId}&limit={n}
```

### 1.2 三种 API 返回状态

| cursor 值 | 含义 | 原因 | 解决方案 |
|-----------|------|------|----------|
| `-3` | WCDB 解密失败/账号未初始化 | bizMsgDbList 里没有这个账号 | 在 WeFlow UI 打开该公众号一次触发初始化 |
| 其他数值 | 有消息 | WCDB 正常读取 | 正常返回 |
| `count=0` | DB 已初始化但无消息 | WeFlow 重启后 indexed_count 丢失，或该账号确实没有新消息 | 等待新消息自然补充 |

### 1.3 为什么 message DB 是加密的

WeChat Mac 客户端的 `message_0.db` 和 `biz_message_0.db` 使用 **WCDB 加密格式**（不是普通 SQLite），文件头不是标准 SQLite 格式。因此：
- `sqlite3` 直接读取会报错 `file is not a database`
- 必须通过 WeFlow 的 WCDB 解密层才能访问
- session DB（`session.db`）是普通 SQLite，可以直接读取

---

## 2. WCDB 索引状态分析

### 2.1 indexed_count 从 31687 到 0 的根因

**关键日志路径：** `~/Library/Application Support/weflow/logs/wcdb.log`

**正常状态（4月23日）：**
```json
{"is_indexing":true,"indexed_count":31687,"total_dbs":1}
```

**重启后状态（4月28日）：**
```json
{"is_indexing":false,"indexed_count":0,"total_dbs":0}
```

**分析结论：**
- `total_dbs: 0` 不是指 DB 文件不存在，而是 WCDB 扫描器在重启后未能成功打开任何一个 message DB
- `indexed_count: 0` 说明历史消息索引全部丢失
- 在 WeFlow UI 里打开过的公众号（如量子位）能恢复读取，因为 UI 触发了 bizMsgDbList 的初始化
- 未在 UI 打开过的公众号，biz_message DB 虽然文件存在，但 WCDB 层面无法访问

### 2.2 公众号在 WeFlow 的两种 DB

| DB 文件 | 用途 | 加密 |
|---------|------|------|
| `message_0.db` | 私聊/群聊消息 | WCDB 加密 |
| `biz_message_0.db` | 公众号（服务号/订阅号）消息 | WCDB 加密 |

两种 DB 都无法用 sqlite3 直接读取，必须通过 WeFlow。

---

## 3. contacts API 的特殊价值

### 3.1 contacts API 不需要 WCDB

```
GET /api/v1/contacts?limit=500
```

返回 198 个公众号账号，包含 `username`（即 gh_id）和 `displayName`，无需访问加密的 message DB。

**应用场景：**
- 作为 gh_id 的主数据源（sessions API 也需要 WCDB）
- 定期同步公众号列表，获取最新的 gh_id 和名称映射

---

## 4. 公众号来源匹配逻辑

InfoHub 的 `refreshWechatSources` 通过**名称精确匹配**将 WeFlow sessions 与 sources 表关联：

1. 从 WeFlow sessions API 获取所有公众号（`gh_id` + `displayName`）
2. 从 sources 表查询 `parent_id` 不为空的微信公众号（启用的子账号）
3. 用 `displayName` 与 sources 表的 `name` 字段精确匹配
4. 匹配成功后，用 gh_id 调用 messages API 抓取文章

**注意：** sources 表的 `config->>'ghId'` 字段大多数为 NULL，所以不能通过 ghId 查询，必须依赖名称匹配。

---

## 5. cursor=-3 的完整处理流程

### 5.1 判断方法

```python
result = requests.get(f"{weflowUrl}/api/v1/messages", params={
    "talker": gh_id,
    "limit": 1,
    "cursor": 0
}, headers=headers)
data = result.json()
cursor = data.get("cursor", -1)
if cursor == -3:
    # 需要 UI 初始化
```

### 5.2 解决方案

在 WeFlow Mac App UI 中搜索并打开该公众号的聊天窗口，触发 WCDB 初始化。

**已知的 cursor=-3 账号（截至 2026-04-28）：**
- 饭统戴老板（`gh_f05e41738ac2`）

---

## 6. 踩坑记录

### 6.1 WeFlow 重启后 indexed_count 归零

- **现象：** 重启后 `is_indexing: false, indexed_count: 0, total_dbs: 0`，messages API 全部返回空
- **根因：** WeFlow 重启后 WCDB 扫描器未重新初始化 message DB 访问
- **解决：** 在 UI 中打开一个公众号，触发 WCDB 重新扫描；或者等待 WeFlow 官方修复

### 6.2 不带 cursor 参数导致 API 返回空

- **现象：** `limit=3` 返回 `count=0, hasMore=false`，但 UI 里明明有消息
- **根因：** WCDB 游标管理机制，不传 cursor 时使用内部游标，可能已越界
- **解决：** 显式传递 `cursor=0`

### 6.3 message_0.db 无法用 sqlite3 打开

- **现象：** `sqlite3.connect()` 报错 `file is not a database`
- **根因：** WeChat 使用 WCDB 加密格式，不是标准 SQLite
- **解决：** 通过 WeFlow WCDB API 访问，不要尝试直接读文件

---

## 7. 快速命令参考

```bash
# 检查 WeFlow 是否运行
ps aux | grep "WeFlow.app/Contents/MacOS/WeFlow$" | grep -v grep

# 查看 WCDB 日志
tail -50 ~/Library/Application\ Support/weflow/logs/wcdb.log

# 测试单个公众号的 messages API
curl -s -H "Authorization: Bearer {TOKEN}" \
  "http://127.0.0.1:5031/api/v1/messages?talker={ghId}&limit=3&cursor=0"

# 获取所有公众号 gh_id（通过 contacts API）
curl -s -H "Authorization: Bearer {TOKEN}" \
  "http://127.0.0.1:5031/api/v1/contacts?limit=500" | \
  python3 -c "import json,sys; [print(c['username'], c['displayName']) for c in json.load(sys.stdin).get('contacts',[]) if c.get('type')=='official']"

# 检查微信 DB 文件是否在更新（修改时间）
stat -f "%Sm %N" ~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wuhuahui3249_79cf/db_storage/message/message_0.db
```
