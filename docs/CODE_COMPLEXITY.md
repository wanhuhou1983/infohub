# InfoHub 代码复杂度控制指南

> **目的**：建立代码复杂度基线，防止文件/函数膨胀，保持代码可维护性。
> 每项包含：检查要点 ✅、好例子 👍、坏模式 ❌、风险等级 🚦、当前热点 📍。
>
> 适用于：新功能 PR 审查、定期代码重构、项目 onboarding。

---

## 目录

1. [文件长度控制](#1-文件长度控制)
2. [函数长度控制](#2-函数长度控制)
3. [嵌套深度控制](#3-嵌套深度控制)
4. [路由 Handler 瘦身](#4-路由-handler-瘦身)
5. [前端 JS 分离](#5-前端-js-分离)
6. [CSS 复用与内联规范](#6-css-复用与内联规范)
7. [循环复杂度（Cyclomatic Complexity）](#7-循环复杂度cyclomatic-complexity)
8. [重复代码消除（DRY）](#8-重复代码消除dry)
9. [命名规范与可发现性](#9-命名规范与可发现性)
10. [注释策略](#10-注释策略)

---

## 1. 文件长度控制

### 检查要点 ✅

- [ ] 单文件是否超过 500 行？
- [ ] 超过 500 行的文件是否有计划拆分？
- [ ] 拆分是否按"单一职责"原则（一个文件只做一件事）？
- [ ] 拆分后是否保持了合理的 import/export 平衡？

### 行业参考

| 标准 | 阈值 | 来源 |
|------|------|------|
| Angular 官方 | ≤ 400 行 | Angular 编码风格指南 |
| Linux 内核 | ≤ 100 行/函数 | Linus Torvalds 标准 |
| InfoHub 标准 | ≤ **500 行/文件** | 本项目约定 |

### 好例子 👍

```typescript
// file-storage.ts:23 — 桶文件，仅 23 行，所有逻辑委托子模块
export { invalidateEnvCache, getImagesDir, getObDir, saveArticleFile } from './storage/ob-writer.js';
export { uploadToCOS, getCosBaseUrl } from './storage/cos-storage.js';
export { processImages, getImagesDir } from './storage/image-processor.js';
```

### 坏模式 ❌

```typescript
// ❌ 1560 行单文件，揉合翻译、RSS、微信抓取、并发池等无关职责
// backend/routes/fetch.ts
```

### 风险等级 🚦

🔴 **高**。超过 500 行的文件显著降低可读性和可测试性。

### 当前热点 📍

| 文件 | 行数 | 建议 |
|------|------|------|
| `routes/fetch.ts` | **1560** | 翻译 → `services/translator.ts`，RSS → `services/rss.ts` |
| `routes/bilibili-admin.ts` | **678** | `POST /refresh` handler 抽到 `services/bilibili.ts` |
| `routes/wechat-group-admin.ts` | **579** | 消息分析逻辑抽到 `services/wechat-group.ts` |

---

## 2. 函数长度控制

### 检查要点 ✅

- [ ] 函数是否超过 **50 行**？
- [ ] 是否存在超过 100 行的巨型函数？
- [ ] 巨型函数是否可以按阶段/步骤拆分为多个小函数？
- [ ] 拆分后的函数名是否能清晰表达其职责？

### 好例子 👍

```typescript
// ✅ 短函数，单一职责，函数名即文档
// routes/google-auth.ts:41
function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}.${encrypted}.${authTag}`;
}
```

### 坏模式 ❌

```typescript
// ❌ ~200 行的匿名内联函数，内含多层条件分支和模板渲染
router.post('/refresh', async (c) => {
  // 1. 解析请求参数... 20 行
  // 2. 验证权限... 15 行
  // 3. 调用外部 API... 30 行
  // 4. 遍历结果处理... 40 行
  // 5. 写入数据库... 25 行
  // 6. 更新状态... 20 行
  // 7. 返回响应... 10 行
  // 这个函数做了 7 件事！
});
```

### 风险等级 🚦

🟡 **中**。大函数难以测试、难以 debug、难以 review。

### 拆函数策略

```
原始巨型函数
  ├── parseRequestBody()        ← 提取第 1 步
  ├── validatePermissions()     ← 提取第 2 步
  ├── refreshFromExternal()     ← 提取第 3 步
  ├── processResults()          ← 提取第 4-5 步
  └── buildResponse()           ← 提取第 6-7 步
```

---

## 3. 嵌套深度控制

### 检查要点 ✅

- [ ] 缩进层级是否超过 **3 层**（if 内套 if 内套 for）？
- [ ] 是否存在回调地狱（Promise 链超过 3 个 `.then()`）？
- [ ] 是否可以通过 **early return** / **guard clause** 减少嵌套？
- [ ] 是否可以通过 async/await 替代回调链？

### 好例子 👍

```typescript
// ✅ Early return 减少嵌套
// routes/google-auth.ts:123
if (!state || !stateMap.has(state)) {
  return fail(c, 'Invalid state (CSRF detected)', 403);
}
// 不再需要 else 块，直接继续
```

### 坏模式 ❌

```typescript
// ❌ 4 层嵌套
if (conditionA) {
  if (conditionB) {
    for (const item of list) {
      if (item.active) {
        // 4 层深
      }
    }
  }
}

// ❌ Promise 链超过 3 个
c.req.json()
  .then(body => validate(body))
  .then(valid => fetch(url, { body: valid }))
  .then(res => res.json())
  .then(data => process(data))
  .catch(err => handle(err));
```

### 风险等级 🚦

🟡 **中**。深层嵌套直接关联认知负荷和 bug 率。

### 降嵌套技术

| 技术 | 效果 |
|------|------|
| Early return / Guard clause | 消除最外层 if-else |
| 提取函数 | 内层循环→独立函数 |
| async/await | 扁平化 Promise 链 |
| 策略模式 / Map | 消除巨型 switch-case |

---

## 4. 路由 Handler 瘦身

### 检查要点 ✅

- [ ] 路由 handler 是否只做"编排"（解析 → 委托 → 响应）？
- [ ] 业务逻辑是否委托给了 `services/` 或 `utils/`？
- [ ] handler 是否超过 **80 行**？
- [ ] handler 内是否包含数据库查询、外部调用、复杂计算？

### 好例子 👍

```typescript
// ✅ Handler 只做编排，逻辑委托
router.post('/:id/fetch-content', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);

  const content = await fetchArticleContent(id);  // 委托
  if (!content) return fail(c, '抓取失败', 502);

  await updateArticleWithContent(id, content);     // 委托
  return c.json({ ok: true, content_length: content.length });
});
```

### 坏模式 ❌

```typescript
// ❌ Handler 塞入所有业务逻辑，200+ 行
router.post('/refresh', async (c) => {
  const { source_id } = await c.req.json();
  const sql = postgres(DATABASE_URL);
  const results = [];
  // ... 50 行参数验证
  // ... 80 行外部 API 调用
  // ... 70 行数据入库
  return c.json({ count: results.length });
});
```

### 风险等级 🚦

🟢 **低~🟡 中**。Handler 过长影响可测试性，但不直接导致安全问题。

---

## 5. 前端 JS 分离

### 检查要点 ✅

- [ ] inline `<script>` 是否超过 **300 行**？
- [ ] 内联 JS 是否可以抽到独立 `.js` 文件？
- [ ] 两个 HTML 文件是否存在重复的 `api()` 函数定义？
- [ ] 业务逻辑是否与渲染逻辑分离？

### 好例子 👍

```typescript
// ✅ 独立的 api-client.js，两个 HTML 文件共享
// js/api-client.js:30
window.api = async function(path, opts = {}) {
  // 统一出口、异常安全、日志
};
```

### 坏模式 ❌

```html
<!-- ❌ 2787 行 inline script，占文件 80% -->
<!-- frontend/index.html -->
<html>
<head>...</head>
<body>
  ...
  <script>
  // 2787 行的 inline JS 块，包含 96 个函数定义，
  // 囊括了数据加载、渲染、AI 分析、播放器、设置管理等全部逻辑
  </script>
</body>
</html>
```

### 风险等级 🚦

🔴 **高**。Inline Script 无法被测试、无法被缓存、不可复用、不可压缩。

### 拆分建议

```
当前     index.html (3477 行, 80% JS)
        infohub-admin.html (3651 行, 69% JS)

建议     frontend/
├── index.html (~500 行骨架)
├── infohub-admin.html (~500 行骨架)
├── js/
│   ├── api-client.js        (已有)
│   ├── app-core.js          (新增: 文章/来源渲染)
│   ├── app-player.js        (新增: 播客播放器)
│   ├── app-ai.js            (新增: AI 分析交互)
│   ├── app-group.js         (新增: 群聊)
│   └── admin-core.js        (新增: 管理后台逻辑)
└── css/
    └── base.css             (新增: 通用样式)
```

---

## 6. CSS 复用与内联规范

### 检查要点 ✅

- [ ] 两个 HTML 文件是否存在重复的 CSS 声明？
- [ ] 颜色/字体/动画等常量是否统一？
- [ ] Tailwind 的 `tailwind.config` 是否在两个文件中重复定义？
- [ ] 是否有共享的 CSS 文件？

### 好例子 👍

```html
<!-- ✅ 共享 CSS 文件 + Tailwind CDN + 单文件 config -->
<link rel="stylesheet" href="/css/base.css">
<script src="https://cdn.tailwindcss.com"></script>
```

### 坏模式 ❌

```html
<!-- ❌ 两个文件各自重复配置 tailwind -->
<!-- index.html:13 -->
<script>
tailwind.config = { theme: { extend: { colors: { primary: '#...' } } } };
</script>

<!-- infohub-admin.html:8 -->
<script>
tailwind.config = { theme: { extend: { colors: { primary: '#...' } } } };
</script>

<!-- ❌ 两个文件各自定义滚动条样式 -->
<!-- 自定义滚动条、font-face、fade-in 动画跨文件重复 -->
```

### 风险等级 🚦

🟢 **低**。CSS 重复主要影响维护效率而非功能。

### 重复清单

| 声明 | index.html | admin.html | 建议 |
|------|-----------|-----------|------|
| Tailwind config | ✅ | ✅ | 合并到共享 CSS |
| 滚动条样式 | ✅ | ✅ | 集中到 base.css |
| @import Google Fonts | ✅ | ✅ | 集中到 base.css |
| fade-in animation | ✅ | ✅ | 集中到 base.css |

---

## 7. 循环复杂度（Cyclomatic Complexity）

### 检查要点 ✅

- [ ] 单个函数的分支数量（if/else/switch/case）是否超过 **10**？
- [ ] 是否存在超过 5 个 `case` 的 switch 语句？
- [ ] 是否存在超过 4 个分支的 if-else 链？
- [ ] 是否可以用 **Strategy 模式** 或 **查找表（Map）** 替代？

### 好例子 👍

```typescript
// ✅ Map 替代 if-else 链
// backend/index.ts:274
const mapping: Record<string, string> = {
  weflow_url: 'WEFLOW_URL',
  weflow_token: 'WEFLOW_TOKEN',
  miniflux_url: 'MINIFLUX_URL',
  google_translate_key: 'GOOGLE_TRANSLATE_KEY',
  // ...
};
for (const [key, envKey] of Object.entries(mapping)) {
  if (body[key] !== undefined && body[key] !== '******') {
    fileConfig[envKey] = String(body[key]);
  }
}
```

### 坏模式 ❌

```html
<!-- ❌ 16 个条件分支的模板渲染，嵌入在 template literal 中 -->
<!-- frontend/infohub-admin.html:renderSourceCards() -->
<div class="card">
  ${source.type === 'wechat' ? `<button>微信</button>` : ''}
  ${source.type === 'bilibili' ? `<button>B站</button>` : ''}
  ${source.type === 'youtube' ? `<button>YouTube</button>` : ''}
  ${source.type === 'rss' ? `<button>RSS</button>` : ''}
  ${source.type === 'twitter' ? `<button>Twitter</button>` : ''}
  <!-- ... 以此类推，共 16 种 -->
</div>
```

### 风险等级 🚦

🟡 **中**。高循环复杂度 = 高 bug 概率 + 低测试覆盖率。

### 重构技巧

| 高复杂度模式 | 重构方案 |
|-------------|---------|
| if-else 链 (4+ 分支) | Map / 策略模式 |
| 巨型 switch-case | 动态分发表 |
| 嵌套三目运算符 | 提取为纯函数 |
| 布尔参数泛滥 | 拆分函数 |

---

## 8. 重复代码消除（DRY）

### 检查要点 ✅

- [ ] 两个 HTML 文件中是否存在相同的 `api()` 函数？
- [ ] 多个 admin 面板（B站/YouTube/播客/微信）是否共享相同的 CRUD 模式？
- [ ] 是否存在相同 SQL 模式的多次复制？
- [ ] 是否存在相同的 CSS 声明、动画定义？

### 好例子 👍

```typescript
// ✅ api-client.js 提供统一出口，两边复用
// js/api-client.js
window.api = async function(path, opts = {}) { ... };
export async function safeFetch(url, opts) { ... }
export function checkShape(data, shape) { ... }
```

### 坏模式 ❌

```html
<!-- ❌ 两个文件各自定义几乎相同的 api() -->
<!-- index.html:742 -->
async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  // 25 行...
}

<!-- infohub-admin.html:2940 -->
async function api(path, opts = {}) {
  const url = `${API_BASE}${path}`;
  // 几乎相同的 25 行...
}
```

### 风险等级 🚦

🟡 **中**。重复代码 → 修复时遗漏 → bug。

### 重复模式清单

| 重复类型 | 出现位置 | 消除方案 |
|---------|---------|---------|
| `api()` 函数 | index.html + admin.html | ✅ 已有 api-client.js |
| Source admin 面板 | bilibili / youtube / podcast / twitter | 提取通用 AdminPanel 组件 |
| 错误处理 `alert()` | admin.html 多处 | 统一用 api-client.js 的 safeFetch |
| CSS 滚动条样式 | index.html + admin.html | 抽到 base.css |
| tailwind.config | index.html + admin.html | 抽到 base.css |

---

## 9. 命名规范与可发现性

### 检查要点 ✅

- [ ] 变量/函数名是否明确表达其用途（而非 `data`、`result`、`tmp`）？
- [ ] 布尔变量是否以 `is_` / `has_` / `should_` 开头？
- [ ] 函数是否以动词开头（`fetch`、`parse`、`render`、`save`）？
- [ ] 文件名与导出函数名是否一致（便于 grep 定位）？

### 好例子 👍

```typescript
// ✅ 命名即文档
function isPrivateUrl(urlStr: string): boolean       // 明确了"是什么"
function createConcurrencyPool(maxConcurrency: number) // 明确了"创建什么"
function fetchAndParseXWLBContent(url: string)         // 明确了"做什么"
```

### 坏模式 ❌

```typescript
// ❌ 命名模糊
function process(data: any)          // 什么处理？
function handleResult(result: any)   // 什么结果？
const tmp = ...                      // 这个 tmp 存活了 50 行
```

### 风险等级 🚦

🟢 **低**。不影响运行，但显著影响可维护性。

### 命名约定

| 类型 | 风格 | 示例 |
|------|------|------|
| 布尔值 | `is_` / `has_` / `should_` | `is_read`, `is_private`, `has_content` |
| 函数 | 动词 + 名词 | `fetchRssFeed()`, `parseWechatHtml()` |
| 异步函数 | 同上，无需 async 前缀 | `callDeepSeek()` (而非 `asyncCallDeepSeek()`) |
| 处理函数 | `handle` + 事件 | `handleAuthError()` |
| 私有辅助函数 | 常规命名，模块内使用 | `decodeHtml()`, `stripCommentSection()` |

---

## 10. 注释策略

### 检查要点 ✅

- [ ] 注释是否解释 **WHY** 而不是 **WHAT**？
- [ ] 代码是否已经足够自文档化（不需要 WHAT 注释）？
- [ ] 复杂算法或业务规则是否有 ASCII 图或伪代码说明？
- [ ] 注释是否与代码保持同步（旧注释比没注释更糟糕）？

### 好例子 👍

```typescript
// ✅ 解释 WHY：为什么做这个特殊处理
// routes/articles.ts:155
// 防重锁：检查 extra.fetching 是否在 30 秒内（防并发重复抓取）
const extra = (art.extra as Record<string, any>) || {};
if (extra.fetching && Date.now() - extra.fetching < 30000) {
  return fail(c, '正在抓取中，请稍候', 409);
}

// ✅ 解释 WHY：为什么参数补零
// backend/index.ts:113-114
// 防时序攻击：长度不同时用空 Buffer 填充再比较，避免泄露长度差
const tokenBuf = Buffer.from(token);
const adminBuf = Buffer.from(adminToken);
```

### 坏模式 ❌

```typescript
// ❌ 解释 WHAT（代码已经很清楚了）
// 递增计数器
counter++;

// ❌ 过时注释（比没有注释更差）
// 这里使用 Drizzle ORM 查询
const results = await sql`SELECT * FROM articles`;  // 但 Drizzle 早已删除

// ❌ 毫无信息的注释
// 设置变量
let x = 5;
```

### 风险等级 🚦

🟢 **低**。不影响运行，但影响长期可维护性。

### 注释决策树

```
这段代码容易让人困惑吗？
  ├── 是 → 先尝试优化代码本身（改名、拆分）
  │        然后判断：优化后是否足够清晰？
  │         ├── 是 → 不需要注释
  │         └── 否 → 写 WHY 注释
  └── 否 → 不需要注释
```

---

## 附录 A：复杂度基线速查表

| 指标 | 阈值 | 说明 |
|------|------|------|
| 单文件最大行数 | ≤ 500 | 超过需计划拆分 |
| 单函数最大行数 | ≤ 50 | 超过需拆分子函数 |
| 嵌套深度 | ≤ 3 层 | 超过需 early return 或提取函数 |
| 路由 handler 最大行数 | ≤ 80 | 超过需委托 services |
| 循环复杂度 | ≤ 10 | 超过需 Map/策略模式替代 |
| 函数参数数 | ≤ 4 | 超过需用 options 对象 |
| Inline script 占比 | ≤ 40% | 超过需抽到独立 .js 文件 |
| import 数/文件 | ≤ 15 | 超过考虑拆分模块 |

## 附录 B：重构优先级矩阵

| 热点 | 复杂度 | 改动量 | 优先级 |
|------|--------|--------|--------|
| fetch.ts 拆分 | 🔴 高 | 🔴 大 | C（先规划再动手） |
| 前端 JS 分离 | 🔴 高 | 🔴 大 | C（渐进式） |
| bilibili-admin handler 拆分 | 🟡 中 | 🟡 中 | B |
| wechat-group-admin 拆分 | 🟡 中 | 🟡 中 | B |
| CSS 重复消除 | 🟢 低 | 🟢 小 | A（随手改） |

优先级：A = 随手改；B = 有序推进；C = 规划后动手

---

## 附录 C：PR 审查复杂度问句

审查时问问自己：
1. "这个函数超过 50 行了吗？"
2. "这个文件超过 500 行了吗？"
3. "这段代码在哪里见过类似的？"
4. "这个函数的名字能让我不用看实现就知道它在做什么吗？"
5. "如果这个函数出 bug，我能在 5 分钟内找到根因吗？"

---

*最后更新：2026-05-03*
*基线值基于 InfoHub 项目实际代码库现状设置，可随项目演进调整。*
