# 双向同步方案：OB ↔ PG

> 版本：v1.0 | 日期：2026-04-29 | 作者：AI 助手

---

## 1. 问题背景

InfoHub 的核心数据存在于两个地方：

| 存储 | 位置 | 用途 |
|------|------|------|
| **PostgreSQL**（PG） | Docker `infohub-db` | 程序读写、Web 前端、采集入库 |
| **Obsidian 仓库**（OB） | `~/Documents/infohub/` | 人工阅读、笔记、标注、引用 |

当前状态：**数据流动是单向的**（PG → OB）。每次采集入库后，`saveArticleFile()` 将 PG 中的文章写为 OB Markdown 文件。但用户在 OB 中做的修改（标注阅读状态、打标签、修改笔记、删除文件）**不会被写回 PG**。反过来，如果通过 Web 前端修改了文章的标签或阅读状态，**OB 端的 Markdown 文件不会同步更新**。

结果就是：两边的数据会逐渐「走偏」——PG 和 OB 变成了两套独立的视图，失去一致性。

---

## 2. 现状分析

### 2.1 PG 侧（articles 表）

关键字段：

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | `integer` (PK) | 自增主键 |
| `content_hash` | `varchar(32)` (UNIQUE) | URL 的 MD5，去重标识 |
| `title` | `text` | 标题 |
| `content` | `text` | 正文 |
| `url` | `text` | 原文链接 |
| `source_id` | `integer` | 来源 ID（关联 sources 表） |
| `tags` | `text[]` | 标签数组 |
| `is_read` | `boolean` | 已读标记 |
| `is_starred` | `boolean` | 星标收藏 |
| `is_watch_later` | `boolean` | 稍后读 |
| `category` | `varchar(50)` | 分类 |
| `author` | `varchar(100)` | 作者 |
| `extra` | `jsonb` | 扩展数据 |

### 2.2 OB 侧（Markdown frontmatter）

当前 frontmatter 格式（示例）：

```yaml
---
id: 4290
source: "数字生命卡兹克"
source_type: "wechat"
url: "https://mp.weixin.qq.com/s/..."
published_at: "2026-04-24T02:10:15"
category: "综合"
tags: ["AI"]
author: "数字生命卡兹克"
is_read: false
is_starred: false
---
```

### 2.3 关联机制

- **文件名**：`YYYYMMDD-标题.md`（不可靠，标题可能被用户修改）
- **frontmatter `id`**：关联 articles.id（可靠但可能被删除/变更）
- **index.json**：本地映射 `{ article_id → OB文件路径 }`（仅存在于 `data/`，不上 Git/OB）
- **目前没有**：双向链路追踪字段（如 `content_hash`）

### 2.4 同步缺口

| 场景 | 当前行为 | 期望行为 |
|------|----------|----------|
| PG 新增文章 → OB | ✅ 自动写入 | — |
| PG 更新内容/标签 → OB | ❌ 不更新 | ✅ 选择性更新 |
| OB 标记已读 → PG | ❌ 不同步 | ✅ 写回 PG |
| OB 修改标签 → PG | ❌ 不同步 | ✅ 写回 PG |
| OB 删除文件 → PG | ❌ 不删除数据 | ✅ 可选清理 |
| Web 前端操作 → OB | ❌ 不同步 | ✅ 选择性更新 |

---

## 3. 设计目标

1. **双向可写**：PG 和 OB 都能作为修改入口，修改能同步到对端
2. **无损校对**：用户对 OB 文件的任何手动修改（标签、阅读状态、标题）不丢失
3. **稳定匹配**：找到一种不依赖文件名、不易被用户误删的标识机制，确保两端数据能对上
4. **增量执行**：不每次都全量扫描，按需同步
5. **安全第一**：同步是「合并」不是「覆盖」，不要因为同步覆盖了用户的手动修改

---

## 4. 标识方案：新增 frontmatter 字段

核心思路：在 OB Markdown 的 frontmatter 中增加一个**不依赖 PG ID 的稳定标识符**，用于两端匹配。

### 4.1 新增字段

| 字段 | 类型 | 来源 | 用途 |
|------|------|------|------|
| `content_hash` | `string` (32 字符) | `md5(url)` | **主匹配标识**。与 PG `articles.content_hash` 一致，UNIQUE |
| `sync_version` | `number` | 自动递增 | 乐观锁。每次同步递增，避免覆盖冲突 |

### 4.2 升级后的 frontmatter 格式

```yaml
---
id: 4290               # PG 主键（稳定，但能被用户删除）
content_hash: "a1b2c3d..."  # 🆕 URL 的 MD5，与 PG UNIQUE KEY 一致
url: "https://..."
source: "数字生命卡兹克"
source_type: "wechat"
published_at: "2026-04-24T02:10:15"
category: "综合"
tags: ["AI"]
author: "数字生命卡兹克"
is_read: true          # 用户已在 OB 中标记为已读
is_starred: false
sync_version: 3        # 🆕 乐观锁版本号
---
```

### 4.3 为什么选 content_hash？

- `id`（articles.id）很稳定，但可能被用户误删 frontmatter 的 id 行
- `content_hash` = MD5(url)，**任何一方都能独立计算**，不依赖数据库
- PG 端已有 `UNIQUE (content_hash)` 约束，天然适合作为「分布式主键」
- 即使 frontmatter 中没有 id，只要有 url，就能算出 content_hash 来匹配

### 4.4 匹配优先级（三级降级）

```
一级：content_hash 精确匹配（最快最准）
   ↓ 不匹配？↓
二级：id 精确匹配（需 frontmatter 有 id）
   ↓ 不匹配？↓
三级：url 内容匹配（慢，但兜底）
```

---

## 5. 同步方向一：PG → OB（投递/校准）

### 5.1 当前流程（已有）

```
采集入库 → saveArticleFile()
  → processImages() 处理图片
  → buildMarkdown() 组装 frontmatter + 内容
  → 写入 OB 目录
```

### 5.2 增强方案

在 `saveArticleFile()` 写入前增加一步：

```
1. 读取现有 OB 文件（如果存在）
2. 解析其 frontmatter
3. 对比 sync_version
    - OB 版本 > PG 版本 → OB 有更新，跳过此文件（让 OB→PG 方向处理）
    - OB 版本 ≤ PG 版本 → 继续写入
4. 合并用户的手动修改：
    - tags: 保留 OB 端的用户手加标签，合并 PG 端的系统标签
    - is_read: 以 OB 端为准（用户主动标记的优先级更高）
    - is_starred: 以 OB 端为准
    - content: 以 PG 端为准（采集最新内容）
5. 写入 OB 文件，sync_version++
```

### 5.3 后端 API

```
POST /api/sync/reconcile
  → 全量校对：遍历 PG 文章 → 逐篇写 OB
  → 支持 ?source_id=N 参数，只校对特定来源
  → 支持 ?dry_run=true，只报告差异不实际写入

GET /api/sync/reconcile/check
  → 快速检查 OB 与 PG 的差异统计
  → 返回：{ out_of_sync: N, missing_in_ob: N, ob_ahead: N }
```

---

## 6. 同步方向二：OB → PG（推送）

这是**全新的流程**，需要实现一个从 OB 目录读取并写回 PG 的路径。

### 6.1 流程设计

```
1. 扫描 OB 目录（递归遍历所有 .md 文件）
   排除：工作日志/ 等非文章目录

2. 解析 frontmatter → 提取元数据
   提取：id, content_hash, url, title, tags, is_read, is_starred, sync_version

3. 匹配 PG 记录（三级降级）
   一级：content_hash 精确匹配 articles.content_hash
   二级：id 精确匹配 articles.id
   三级：url 精确匹配 articles.url

4. 比对差异（只同步有变动的字段）
   可同步字段：tags, is_read, is_starred, title
   不同步字段：content（OB 端可能不全），published_at（以 PG 为准）

5. 写入 PG
   UPDATE articles SET tags = $tags, is_read = $is_read, ... WHERE content_hash = $hash
   WHERE sync_version <= $ob_version (乐观锁防覆盖)

6. 回写 OB frontmatter 中的 sync_version++
```

### 6.2 乐观锁冲突处理

```
场景：
  A. 用户在 OB 中修改了标签，此时 PG 也收到了采集更新
  B. OB→PG 同步时，检测到 PG 的 updated_at > 上次同步时间
  C. 冲突策略：以 OB 端为「强势方」
     - 如果字段在两端都有修改 → 以 OB 为准（用户手动操作优先）
     - 如果字段只在 PG 端修改 → 标记为「待合并」，下次 PG→OB 时应用
```

### 6.3 后端 API

```
POST /api/sync/push
  → 扫描 OB 目录 → 比对 → 写回 PG
  → 支持 ?dry_run=true，只报告差异不写入
  → 返回：{ matched: N, updated: N, conflicts: N, errors: [] }

POST /api/sync/push-file
  → 参数：{ path: "..." }
  → 单个文件的推送，用于 Web 前端触发

GET /api/sync/diff
  → 扫描 OB 与 PG 的差异汇总
  → 返回双向差异报告
```

---

## 7. 字段同步矩阵

| 字段 | 主导方 | 同步方向 | 冲突策略 |
|------|--------|----------|----------|
| `title` | PG (采集) | PG→OB | PG 覆盖 OB（标题通常不会手动改） |
| `content` | PG (采集) | PG→OB | PG 覆盖 OB（OB 端可能被裁剪） |
| `url` | PG (采集) | PG→OB | PG 覆盖 OB |
| `category` | PG (采集) | PG→OB | PG 覆盖 OB |
| `tags` | **双向** | 双向 | **合并**（保留 OB 端手加标签） |
| `is_read` | **OB 优先** | OB→PG | OB 覆盖 PG（用户主动标记更可信） |
| `is_starred` | **OB 优先** | OB→PG | OB 覆盖 PG |
| `is_watch_later` | **OB 优先** | OB→PG | OB 覆盖 PG |
| `author` | PG (采集) | PG→OB | PG 覆盖 OB |
| `published_at` | PG (采集) | PG→OB | PG 覆盖 OB |
| `source_name` | PG (采集) | PG→OB | PG 覆盖 OB |
| `content_hash` | PG (计算) | 写 OB frontmatter | 只写一次，不修改 |
| `sync_version` | 自动 | 双向递增 | 乐观锁 |

---

## 8. 代码实现路径

### Phase 1：frontmatter 升级 + 索引增强（1 天）

**1a. `file-storage.ts` — `buildMarkdown()` 改造**

在 existing `buildMarkdown()` 中增加 content_hash 和 sync_version：

```typescript
function buildMarkdown(content: string, meta: ArticleMeta): string {
  const frontmatter: Record<string, any> = {
    id: meta.id,
    content_hash: '',      // 从 meta 中取出
    url: meta.url || '',
    source: meta.source_name,
    source_type: meta.source_type,
    published_at: normalizeDate(meta.published_at),
    category: meta.category || '',
    tags: meta.tags || [],
    author: meta.author || '',
    is_read: meta.is_read,
    is_starred: meta.is_starred,
    sync_version: 1,        // 初始版本
  };
  // ...
}
```

**1b. `saveArticleFile()` 增加「读前先读」逻辑**

```typescript
export async function saveArticleFile(/*...*/) {
  // 1. 检查 OB 中是否已有此文件（通过 content_hash 或 id）
  // 2. 如果有，读取现有 frontmatter
  // 3. 比较 sync_version：
  //    - OB 版本 > PG 版本 → 跳过（OB 有手动修改）
  //    - 否则 → 合并用户修改后写入
  // 4. 如果没有 → 新建写入
}
```

**1c. 全量刷新 index.json**

重新运行 `POST /api/sync/files`，刷新所有文件的 index 映射，同时补齐新字段。

### Phase 2：OB→PG 扫描引擎（2 天）

**2a. 新建 `backend/services/ob-scanner.ts`**

核心扫描函数：

```typescript
// 扫描 OB 目录，返回所有 Markdown 文件的 frontmatter 列表
export async function scanObFiles(): Promise<ObFileMeta[]>;

// 三级降级匹配
export async function matchToPg(
  obMeta: ObFileMeta
): Promise<{ matched: boolean; pgRow: any | null; matchLevel: number }>;

// 推送单个文件的修改到 PG
export async function pushToPg(
  obMeta: ObFileMeta
): Promise<{ updated: string[]; conflicts: string[] }>;
```

**2b. `backend/routes/sync.ts` — 新增端点**

```typescript
router.post('/push', async (c) => {
  // 全量 OB→PG 推送
});

router.post('/reconcile', async (c) => {
  // 全量 PG→OB 校准
});

router.get('/diff', async (c) => {
  // 差异报告
});

router.post('/push-file', async (c) => {
  // 单文件推送
});
```

### Phase 3：自动化 + 前端集成（1 天）

**3a. 定时自动化**

创建 cron 任务（如每 30 分钟）：
```
POST /api/sync/push?dry_run=true → 如果 diff > 0 → POST /api/sync/push
POST /api/sync/reconcile?limited=true → 只处理 OB 版本落后的文章
```

**3b. 前端 UI**

在管理页面增加「同步」面板：
```
┌────────────────────────────────────┐
│  📡 同步状态                        │
│  ─────────────────────             │
│  PG → OB 差异：23 篇待同步          │
│  OB → PG 差异：5 篇待同步           │
│                                     │
│  [🔃 全量同步] [▲ 推 OB→PG]        │
│  [▼ 拉 PG→OB] [📋 查看差异报告]    │
└────────────────────────────────────┘
```

---

## 9. 风险与注意事项

| 风险 | 等级 | 缓解措施 |
|------|------|----------|
| 用户手动删除 frontmatter 中的 id | 中 | 用 content_hash 兜底匹配 |
| 用户重命名文件 | 低 | 用 frontmatter 内容匹配，不依赖文件名 |
| OB 内容被用户截断/修改 | 中 | content 只从 PG→OB 单向同步 |
| 大量 OB 文件扫描耗时 | 低 | 增量扫描（只读最近修改的文件） |
| 并发冲突（同时采集+用户在 OB 编辑） | 中 | sync_version 乐观锁 |
| 用户在 OB 中新建文件（非 InfoHub 采集） | 低 | 扫描时检查 frontmatter 是否有 id/content_hash |

---

## 10. 实施路线图

```
Phase 1: frontmatter 升级 (1天)
  ├── buildMarkdown() + content_hash + sync_version
  ├── saveArticleFile() 读前合并逻辑
  └── 全量刷新 index.json

Phase 2: OB→PG 引擎 (2天)
  ├── ob-scanner.ts 扫描/解析/匹配
  ├── sync.ts 新增 /push /reconcile /diff 端点
  └── 友好错误处理和日志

Phase 3: 自动化 + UI (1天)
  ├── 定时同步 cron
  ├── 前端同步面板
  └── 端到端测试
```

---

## 11. 参考：数据流全图

```
                    ┌──────────────────────────────────────┐
                    │             用户操作                   │
                    │  (OB) 标记已读 / 加标签 / 修改笔记     │
                    └────────────┬─────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   OB Markdown 文件       │
                    │   ~/Documents/infohub/   │
                    │   frontmatter:           │
                    │     content_hash          │
                    │     sync_version          │
                    │     tags / is_read / ...  │
                    └──────┬────────────▲──────┘
                           │            │
                    OB→PG │            │ PG→OB
                    push  │            │ reconcile
                           ▼            │
                    ┌───────────────────┴──────┐
                    │   PostgreSQL              │
                    │   articles 表              │
                    │     content_hash (UNIQUE)  │
                    │     tags / is_read / ...   │
                    └──────────┬────────────────┘
                               │
                    ┌──────────▼────────────────┐
                    │   采集层                    │
                    │   新闻联播 / 公众号 / RSS    │
                    │   YouTube / B站 / 财新     │
                    └───────────────────────────┘
```

---

*本方案设计为渐进式实施，Phase 1 做完后即可获得基础的双向校对能力（OB 修改通过 Reconcile 可保留，Push 可回写 PG），后续逐步完善自动化。*
