# InfoHub 测试覆盖指南

> **目的**：建立测试覆盖基线，明确各层测试策略和优先级，指导增量扩增测试。
> 每项包含：检查要点 ✅、好例子 👍、坏模式 ❌、当前状态 📊、推荐路径 🗺️。
>
> 适用于：新增测试、PR 审查测试覆盖、重构安全网评估、测试基础设施决策。

---

## 目录

1. [当前覆盖概览](#1-当前覆盖概览)
2. [测试金字塔与分层策略](#2-测试金字塔与分层策略)
3. [纯函数优先：零 mock 测试](#3-纯函数优先零-mock-测试)
4. [Mock 策略总览](#4-mock-策略总览)
5. [Storage 层测试](#5-storage-层测试)
6. [Services 层测试](#6-services-层测试)
7. [Routes 层测试](#7-routes-层测试)
8. [Shared 层测试](#8-shared-层测试)
9. [前端测试](#9-前端测试)
10. [集成测试](#10-集成测试)
11. [测试命名与文件约定](#11-测试命名与文件约定)
12. [运行测试](#12-运行测试)
13. [增量覆盖路线图](#13-增量覆盖路线图)
14. [常见陷阱与反模式](#14-常见陷阱与反模式)

---

## 1. 当前覆盖概览

### 测试规模 📊

| 指标 | 数值 |
|------|------|
| 测试文件数 | **2**（`image-processor.test.ts` + `ob-writer.test.ts`） |
| 总测试数 | **84**（19 + 65） |
| 覆盖层 | **仅 Storage**（2/3 个模块） |
| 覆盖模块 | `image-processor.ts` ✅、`ob-writer.ts` ✅、`cos-storage.ts` ❌ |
| 未覆盖层 | Services（5 文件）、Routes（15 文件）、Shared（2 文件）、Root（3 文件） |
| 测试运行时长 | **< 1s** |
| 测试框架 | `bun:test`（零额外依赖） |
| CI/CD | 未配置 |

### 覆盖热力图 🔥

```
Storage  ━━━━━━━━━━━━━━━━━━━━ 40% (2/5 模块, 84 tests)
Services ━━━━━━━━━━━━━━━━━━━━  0% (0/5 文件, 0 tests)
Routes   ━━━━━━━━━━━━━━━━━━━━  0% (0/15 文件, 0 tests)
Shared   ━━━━━━━━━━━━━━━━━━━━  0% (0/2 文件, 0 tests)
Root     ━━━━━━━━━━━━━━━━━━━━  0% (0/3 文件, 0 tests)
Frontend ━━━━━━━━━━━━━━━━━━━━  0% (纯 HTML, 不测)

总体      ████░░░░░░░░░░░░░░░░  ~15%
```

---

## 2. 测试金字塔与分层策略

### 本项目测试金字塔

```
         ┌──────────┐
         │ 集成测试 │   ← 少数关键路径（DB + 外部 API）
        ┌┴──────────┴┐
        │ 路由 Handler │ ← Hono app.request() 注入 mock sql
       ┌┴─────────────┴┐
       │ Service 函数测试 │ ← 依赖注入 + mock fetch
      ┌┴────────────────┴┐
      │  纯函数零 mock 测试  │ ← 主要投入，高 ROI
     ┌┴───────────────────┴┐
     │ 类型契约 / round-trip │ ← 双向前后一致性
     └──────────────────────┘
```

### 各层测试策略

| 层 | 测试策略 | 典型测试数 | Mock 需求 | 优先级 |
|----|---------|-----------|----------|--------|
| **纯函数** | 输入 → 输出，零 mock | 大量（高 ROI） | 🟢 无 | ⭐⭐⭐ |
| **Service 函数** | 依赖注入 + mock 外部 | 中等 | 🟡 少量 | ⭐⭐ |
| **Route Handler** | Hono `app.request()` + mock sql | 少量（关键路径） | 🔴 较多 | ⭐⭐ |
| **集成测试** | 真实 DB + min 外部 API | 极少量（烟雾） | 🔴 有 | ⭐ |
| **前端** | 不测试（纯 HTML） | 0 | — | ❌ |

### 决策原则

```
问：这个函数有什么副作用？
├── 无副作用（纯函数）
│   └── ✅ 直接测试，零 mock，大量覆盖
├── 只依赖入参（sql 等注入）
│   └── ✅ 注入 mock，测交互逻辑
├── 依赖全局状态（env、文件系统）
│   └── ⚠️ 考虑重构为可注入参数，或使用 mock.module
└── 依赖外部服务（COS、DeepSeek API）
    └── 🔴 mock 外部，仅测错误处理和重试逻辑
```

---

## 3. 纯函数优先：零 mock 测试

### 为什么优先测纯函数

- **执行速度快**：84 个纯函数测试 < 1s
- **零 mock**：不需要模拟数据库、网络、文件系统
- **确定性**：相同输入永远相同输出
- **重构安全网**：修改实现时立即得到反馈

### 检查要点 ✅

- [ ] 新写的业务逻辑是否优先提取为导出纯函数？
- [ ] 函数签名是否清晰（输入类型明确、输出类型单一）？
- [ ] 是否避免了模块级可变状态（module-level `let`）？
- [ ] 纯函数是否直接加 `export` 暴露给测试？

### 好例子 👍

```typescript
// ✅ 纯函数，导出即可测
// storage/ob-writer.ts:42
export function normalizeDate(val: string | null | undefined): string {
  if (!val) return new Date().toISOString().slice(0, 10);
  return val.slice(0, 10);
}

// 测试：
test('null 返回今日日期', () => {
  const result = normalizeDate(null);
  expect(result).toBe(new Date().toISOString().slice(0, 10));
});
```

### 坏模式 ❌

```typescript
// ❌ 逻辑内联在 handler 中，不可测试
router.post('/something', async (c) => {
  const { date } = await c.req.json();
  const normalized = date ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);
  // 这行逻辑永远无法单独测试
});
```

### 当前覆盖面 📊

| 已覆盖的纯函数 | 测试数 |
|---------------|--------|
| `normalizeDate` | 4 |
| `hashString` | 3 |
| `sanitizeDirName` | 5 |
| `normalizeWechatAccount` | 4 |
| `parseObFrontmatter` | 6 |
| `getObSubdir` | 14 |
| `sanitizeFilename` | 7 |
| `extractDerivedFields` | 4 |
| `computeExtraVersion` | 4 |
| `buildMarkdown` | 10 |
| round-trip 契约 | 2 |

### 下一步可提取为纯函数的候选

| 位置 | 候选逻辑 | 提取收益 |
|------|---------|---------|
| `routes/fetch.ts` | RSS 解析、URL 验证、翻译分段 | 🔴 高 |
| `services/classifier.ts` | 已为纯函数 ✅ | 直接加测试 |
| `routes/bilibili-admin.ts` | 视频 ID 提取、字幕时间轴解析 | 🟡 中 |
| `routes/sources.ts` | 源类型验证、配置更新校验 | 🟡 中 |

---

## 4. Mock 策略总览

### bun:test 可用 Mock 工具

| 工具 | 用途 | 示例 |
|------|------|------|
| `mock.module(path, factory)` | 拦截 ESM import 的模块 | `mock.module('../storage/cos-storage.js', ...)` |
| `globalThis.fetch = ...` | 模拟 HTTP 请求 | `globalThis.fetch = async () => new Response(...)` |
| `mock.fn()` | 创建可追踪的 spy 函数 | `const fn = mock.fn(); expect(fn).toHaveBeenCalled()` |
| `mock.restore()` / `afterEach` | 清理 mock 状态 | 防止跨测试污染 |

### Mock 适用场景

| 场景 | 推荐方案 | 注意事项 |
|------|---------|---------|
| 拦截 COS SDK | `mock.module('./cos-storage.js')` | specifier 必须与 import 完全一致 |
| 模拟 Fetch | `globalThis.fetch = fn` | `afterEach` 必须 restore |
| 模拟 postgres.js | 注入 mock `sql` 函数 | sql 是 tagged template 函数，需包装 |
| 模拟文件系统 | 使用临时目录 + `process.env.DATA_DIR` | 非 `mock.module('node:fs')` |
| 模拟 Hono Context | 创建最小 mock 对象 | 仅需实现 `.json()` 和 `.req` |

### 好例子 👍

```typescript
// ✅ mock.module 拦截 COS 模块
mock.module('../storage/cos-storage.js', () => ({
  getCosBaseUrl: () => COS_BASE_URL,
  uploadToCOS: async (_key: string, _body: Buffer) =>
    `${COS_BASE_URL}/${_key}`,
}));

// ✅ globalThis.fetch 模拟 HTTP
globalThis.fetch = async (url: string) => {
  if (url.includes('example.com/image.jpg')) {
    return new Response('fake-image-data', {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  return new Response('Not Found', { status: 404 });
};
```

### 坏模式 ❌

```typescript
// ❌ 忘记 restore mock，污染后续测试
globalThis.fetch = myMock;  // 无 afterEach restore

// ❌ mock.module specifier 不匹配
mock.module('../storage/cos-storage', () => ({ ... }));
// 模块实际 import './cos-storage.js'（带 .js 扩展名）

// ❌ mock 整条 SQL 查询链（过度 mock）
// 应该用纯函数提取 + 注入 mock sql，而不是 mock 整个 DB 驱动
```

---

## 5. Storage 层测试

### 5.1 image-processor.ts ✅ （19 测试，已覆盖）

**当前覆盖范围：**

| Describe | 测试数 | 内容 |
|----------|--------|------|
| 核心契约 | 7 | 所有图片→COS URL，无 __IMG__ 残留 |
| 边界条件 | 6 | localhost 跳过、data URI 跳过、并发、编码、缓存损坏 |
| Bug 回归 | 1 | URL 替换顺序不颠倒 |
| 缓存行为 | 2 | 重复 URL 只请求一次 |
| 标记剥离 | 2 | __IMG__ 完全剥离 |

### 5.2 ob-writer.ts ✅ （65 测试，已覆盖）

**当前覆盖范围：**

| Describe | 测试数 | 内容 |
|----------|--------|------|
| normalizeDate | 4 | ISO 截断、无效、null、undefined |
| hashString | 3 | 确定性、唯一性、格式 |
| sanitizeDirName | 5 | 正常/非法字符/null/undefined/空 |
| normalizeWechatAccount | 4 | 前缀剥离、空 fallback |
| parseObFrontmatter | 6 | 无标记、key:value、tags 数组、布尔、数字、空 key |
| getObSubdir | 14 | 所有 source type 目录映射 |
| sanitizeFilename | 7 | 正常/非法字符/magazine 无日期前缀/中文截断/缺日期 |
| extractDerivedFields | 4 | null/undefined/顺序/过滤 |
| computeExtraVersion | 4 | 无字段/哈希格式/确定性/唯一性 |
| buildMarkdown | 10 | 完整 frontmatter/tags/无 extra/有 extra/IMG 转换/title heading/衍生区块/round-trip |
| Round-trip 契约 | 2 | buildMarkdown → parseObFrontmatter 双向一致性 |

### 5.3 cos-storage.ts ❌ （0 测试，需新增）

**文件特征：**

- 模块级单例缓存（`_cosConfig`, `_cosClient`）
- 读取 `.env.json` 和 `~/.cos/cos.conf`
- 调用 `cos-nodejs-sdk-v5`（callback 风格 → 包 Promise）
- 已暴露 `invalidateCache()` 测试钩子

#### 测试要点 ✅

- [ ] `getCosBaseUrl()` 是否在初始化后返回正确 URL？
- [ ] `getCosBaseUrl()` 未初始化时是否返回 `''`？
- [ ] `uploadToCOS()` 成功时是否返回完整 URL？
- [ ] `uploadToCOS()` SDK 失败时是否返回 `null` 而非抛异常？
- [ ] 配置加载 fallback 链是否正确（`.env.json` → `~/.cos/cos.conf` → 默认值）？
- [ ] SDK 对象创建是否支持 `invalidateCache()` 后重新初始化？

#### 好例子 👍

```typescript
// ✅ cos-storage 测试骨架
import { describe, test, expect, mock, beforeAll, afterEach } from 'bun:test';
import { uploadToCOS, getCosBaseUrl } from '../storage/cos-storage.js';

// Mock COS SDK
mock.module('cos-nodejs-sdk-v5', () => {
  return mock.fn(() => ({
    putObject: (_params: any, cb: Function) => {
      cb(null, { statusCode: 200 });
    },
  }));
});

test('uploadToCOS 成功返回完整 URL', async () => {
  const url = await uploadToCOS('test/image.jpg', Buffer.from('data'));
  expect(url).toMatch(/^https:\/\/.*\.cos\.ap-shanghai\.myqcloud\.com\/test\/image\.jpg$/);
});

test('uploadToCOS SDK 失败返回 null', async () => {
  mock.module('cos-nodejs-sdk-v5', () => {
    return mock.fn(() => ({
      putObject: (_params: any, cb: Function) => {
        cb(new Error('Network error'), null);
      },
    }));
  });
  const result = await uploadToCOS('test/image.jpg', Buffer.from('data'));
  expect(result).toBeNull();
});
```

#### 当前状态 📊

🟥 **未覆盖**。应作为下一个 storage 层测试目标，约 15-20 个测试。

---

## 6. Services 层测试

### 6.1 classifier.ts — 纯函数分类逻辑

**文件特征：** 无外部依赖的纯函数，5 个导出函数。**最高 ROI 的测试候选。**

#### 测试要点 ✅

- [ ] `classifyByFeed(feedTitle)` 是否根据 feed 标题正确返回分类？
- [ ] 不匹配任何规则时是否返回默认值（如 `'其他'`）？
- [ ] `classifyByTitle(title)` 是否根据文章标题正确返回分类？
- [ ] 标题和 feed 同时传入时，哪个规则优先？
- [ ] `extractTags(text)` 是否正确提取标签？
- [ ] 输入为 null/undefined 时是否不崩溃？
- [ ] `extractXWLBTags(title)` 是否正确提取新闻联播标签？

#### 好例子 👍

```typescript
// ✅ classifier 纯函数测试
import { describe, test, expect } from 'bun:test';
import { classifyByFeed, classifyByTitle, extractTags } from '../services/classifier.js';

describe('classifyByFeed', () => {
  test('新闻联播 feed 返回 国内', () => {
    expect(classifyByFeed('新闻联播')).toBe('国内');
  });

  test('不匹配时返回默认分类', () => {
    expect(classifyByFeed('未知来源名称')).toBe('其他');
  });
});

describe('extractTags', () => {
  test('从标题提取标签', () => {
    const tags = extractTags('习近平主持召开中央财经委员会会议', '新闻联播');
    expect(tags).toContain('习近平');
  });

  test('空文本返回空数组', () => {
    expect(extractTags('', '')).toEqual([]);
  });
});
```

#### 当前状态 📊

🟥 **未覆盖**。预估测试数：**40-60 个**。

---

### 6.2 ai.ts — DeepSeek API 调用

**文件特征：** 依赖注入 `sql` + `fetch()` 调用外部 API。关键路径测试。

#### 测试要点 ✅

- [ ] `callDeepSeek()` 是否正确构造请求 URL 和 Header？
- [ ] API 返回非 200 时是否优雅处理错误？
- [ ] API 超时/网络错误时是否重试或报错？
- [ ] `translateArticle()` 是否正确截取前 4000 字符翻译？
- [ ] `analyzeArticle()` 是否正确截取前 6000 字符分析？
- [ ] 翻译结果回写到数据库的 SQL 是否正确？

#### 好例子 👍

```typescript
// ✅ ai.ts 测试（mock fetch + mock sql）
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { callDeepSeek, translateArticle } from '../services/ai.js';

// Mock fetch
const mockFetch = mock(async (url: string, opts: any) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({
    choices: [{ message: { content: '翻译结果' } }],
  }), { status: 200 });
});

afterEach(() => {
  mock.restore();
});

describe('callDeepSeek', () => {
  test('正确构造请求参数', async () => {
    globalThis.fetch = mockFetch;
    const result = await callDeepSeek('system prompt', 'user content', 2000);
    expect(result).toBe('翻译结果');
    expect(mockFetch).toHaveBeenCalled();
  });

  test('API 错误返回 null', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', { status: 401 }));
    const result = await callDeepSeek('test', 'test', 2000);
    expect(result).toBeNull();
  });
});
```

#### 当前状态 📊

🟥 **未覆盖**。预估测试数：**15-25 个**。

---

### 6.3 parser.ts, ob-scanner.ts, prompts.ts

| 文件 | 模式 | 测试策略 |
|------|------|---------|
| `parser.ts` | 内容解析函数 | 纯函数测试，输入 HTML/Markdown → 输出结构化数据 |
| `ob-scanner.ts` | 文件系统扫描 | 临时目录 + mock 文件系统 |
| `prompts.ts` | 字符串模板 | 纯函数测试，检查 prompt 格式和变量替换 |

---

## 7. Routes 层测试

### 策略：Hono app.request() 不启动服务器

所有路由模块都遵循 `createXxxRoutes(sql, ...extras)` 模式——直接创建 Hono 实例并调用 `app.request()` 即可测试，无需启动 HTTP 服务器。

### 测试要点 ✅

- [ ] GET 路由是否返回正确数据和状态码？
- [ ] POST 路由在授权通过时是否正常处理？
- [ ] POST 路由在授权失败时是否返回 401？
- [ ] 无效的 path 参数是否返回 400？
- [ ] 不存在的资源 ID 是否返回 404？
- [ ] `isPrivateUrl()` 是否阻止了内网请求？
- [ ] SQL 查询是否通过参数化标签，而非字符串拼接？

### 好例子 👍

```typescript
// ✅ Routes 层测试模式
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { createSourcesRoutes } from '../routes/sources.js';

function mockSql() {
  const fn = ((strings: TemplateStringsArray, ...values: any[]) => {
    // 返回模拟数据
    if (strings[0]?.includes('SELECT * FROM sources')) {
      return [{ id: 1, name: '测试源', type: 'rss' }];
    }
    return [];
  }) as any;
  fn.begin = async () => {};
  fn.commit = async () => {};
  fn.rollback = async () => {};
  return fn;
}

function mockAuth(valid: boolean) {
  return () => ({ valid, error: valid ? undefined : 'Unauthorized' });
}

describe('sources routes', () => {
  test('GET / 返回来源列表', async () => {
    const app = createSourcesRoutes(mockSql(), mockAuth(true));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
  });

  test('POST / 无授权返回 401', async () => {
    const app = createSourcesRoutes(mockSql(), mockAuth(false));
    const res = await app.request('http://localhost/', {
      method: 'POST',
      body: JSON.stringify({ name: 'test', type: 'rss' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});
```

### 当前各路由模块复杂度

| 路由模块 | 方法数 | 外部依赖 | 优先测试 |
|---------|--------|---------|---------|
| `routes/sources.ts` | 6 | sql + auth | 🥇 最简，优先覆盖 |
| `routes/articles.ts` | 5 | sql + isPrivateUrl | 🥇 次优先 |
| `routes/fetch.ts` | ~8 | sql + fetch + 子进程 | 🥉 复杂，最后覆盖 |
| `routes/podcast-admin.ts` | 4 | sql + HTTP | 🥇 可先覆盖 |
| `routes/twitter-admin.ts` | 4 | sql + HTTP | 🥇 可先覆盖 |

### 授权测试矩阵

```
每个写操作路由需测试三种场景：

测试场景        mockAuth   期望状态
─────────────────────────────────
无 Token 请求    ─          401
Token 有效       { valid }  200/201/204
Token 无效       { !valid }  401
```

---

## 8. Shared 层测试

### 8.1 response.ts

**文件特征：** 两个纯工厂函数，零外部依赖。

#### 测试要点 ✅

- [ ] `fail()` 返回 `{ ok: false, error: string }`？
- [ ] `fail()` HTTP 状态码是否与入参一致？
- [ ] `ok()` 返回 `{ ok: true, data: T }`？
- [ ] `ok()` 默认状态码是否为 200？
- [ ] 类型是否正确（TypeScript `satisfies` 可验证类型契约）？

#### 好例子 👍

```typescript
// ✅ response.ts 测试
import { describe, test, expect } from 'bun:test';
import { fail, ok } from '../shared/response.js';

// 最小 mock Hono Context
function mockContext(): any {
  return {
    json: (body: any, status: number) => new Response(JSON.stringify(body), { status }),
  };
}

describe('fail', () => {
  test('返回 { ok: false, error } + 默认 400', async () => {
    const res = fail(mockContext(), '参数错误');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: '参数错误' });
  });

  test('自定义状态码', async () => {
    const res = fail(mockContext(), '未找到', 404);
    expect(res.status).toBe(404);
  });
});

describe('ok', () => {
  test('返回 { ok: true, data } + 200', async () => {
    const res = ok(mockContext(), { id: 1, name: 'test' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ id: 1, name: 'test' });
  });
});
```

### 8.2 api-types.ts

仅包含类型定义和 `SOURCE_TYPES` const 对象。测试价值低，可选做**契约检查**：

```typescript
// 可选：检查 SOURCE_TYPES 定义完整性
test('SOURCE_TYPES 定义完整', () => {
  expect(SOURCE_TYPES.rss).toBe('rss');
  expect(SOURCE_TYPES.wechat).toBe('wechat');
  // ... 确保类型枚举不遗漏 key
});
```

---

## 9. 前端测试

### 当前立场：不测试

前端为两个纯 HTML 文件（`index.html` 和 `infohub-admin.html`），无构建工具链、无 npm 依赖、无 JS 框架。

| 原因 | 说明 |
|------|------|
| 无 JS 框架 | 无 React/Vue/Angular，无组件库可测 |
| 无构建工具 | 无 Webpack/Vite，无模块化导入 |
| 测试成本高 | 需引入 Playwright/Selenium，配置远大于收益 |
| 覆盖替代 | 后端 API 测试已覆盖数据逻辑 |

### 未来可能的前端测试

**前提条件**：前端 JS 从 inline script 抽为独立 `.js` 文件后。

```
1. 从 inline script → 独立 js/api-client.js + js/app-core.js
2. import/export 可用 → vitest 或 bun:test 可加载
3. 覆盖程度：api() 函数 → 数据渲染函数 → 事件处理函数
4. 估计测试数：15-30 个，覆盖 api-client.js 和渲染函数
```

---

## 10. 集成测试

### 适用场景

- **数据库集成**：验证 SQL 查询在真实 PostgreSQL 上的正确性
- **端到端**：验证路由→服务→DB 的完整流程
- **外部 API**：验证与 DeepSeek/COS 等外部服务的交互（可选）

### 策略

| 类型 | 推荐度 | 实现方式 | 适用场景 |
|------|--------|---------|---------|
| **Testcontainers** | 🟡 可选 | Docker PostgreSQL | 复杂查询的正确性验证 |
| **SQLite in-memory** | 🔴 不推荐 | SQL 语法差异大 | 不适合本项目（postgres.js 特有语法） |
| **Mock DB** | 🟢 推荐 | mock sql 函数 | 绝大多少场景够用 |
| **生产 DB 快照测试** | 🟡 可选 | 导出 PG dump 到测试 | 回归检查 |

### 何时添加集成测试

```
存在以下情况时，考虑集成测试：
├── SQL 查询涉及复杂 JOIN / CTE / 窗口函数
│   └── 例如：articles + sources + tags 三表联查
├── 迁移脚本正确性（ADR-001 裸 SQL）
│   └── 例如：新增列、改数据类型、重建索引
└── 数据完整性约束
    └── 例如：唯一索引、外键约束、check 约束
```

### 好例子 👍

```typescript
// ✅ 集成测试骨架（使用 real DB）
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';

// 需要 TEST_DATABASE_URL 环境变量
const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const runIntTest = TEST_DB_URL ? describe : describe.skip;

runIntTest('数据库集成', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(TEST_DB_URL!);
  });

  afterAll(async () => {
    await sql.end();
  });

  test('INSERT + SELECT round-trip', async () => {
    await sql`INSERT INTO sources (name, type) VALUES (${'集成测试源'}, ${'test'})`;
    const rows = await sql`SELECT * FROM sources WHERE name = ${'集成测试源'}`;
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe('test');
    await sql`DELETE FROM sources WHERE name = ${'集成测试源'}`;
  });
});
```

---

## 11. 测试命名与文件约定

### 文件命名

```
backend/
├── storage/
│   ├── ob-writer.ts                ← 被测模块
│   └── tests/
│       └── ob-writer.test.ts       ← 测试文件（同一目录）
├── services/
│   ├── classifier.ts
│   └── tests/
│       └── classifier.test.ts
├── routes/
│   ├── sources.ts
│   └── tests/
│       └── sources.test.ts
└── shared/
    ├── response.ts
    └── tests/
        └── response.test.ts
```

### 命名规则

| 要素 | 约定 | 示例 |
|------|------|------|
| 测试文件名 | `{模块名}.test.ts` | `ob-writer.test.ts` |
| describe 外层 | `{函数名} — {场景}` | `normalizeDate — 边界条件` |
| describe 内层 | 按场景分组 | `classifyByFeed` |
| test 描述 | 中文，陈述期望行为 | `不匹配时返回默认分类` |
| 契约测试 | `CONTRACT: ...` 前缀 | `CONTRACT: 所有图片为 COS URL` |
| 回归测试 | `REGRESSION: ...` 前缀 | `REGRESSION: URL 替换顺序` |

### 好例子 👍

```typescript
// ✅ 命名清晰，结构一致
describe('image-processor.ts — 核心契约', () => {
  // ...
});

describe('边界条件', () => {
  test('空内容返回空字符串', () => { ... });
  test('data: URI 的图片跳过不处理', () => { ... });
});

describe('已知 Bug 回归测试', () => {
  test('REGRESSION: URL 替换顺序不颠倒', () => { ... });
});
```

---

## 12. 运行测试

### 基本命令

```bash
# 运行所有测试
cd backend && bun test

# 运行单个测试文件
bun test tests/ob-writer.test.ts

# 按名称模式运行
bun test --test-name-pattern="classify"

# 运行特定 describe 块
bun test --test-name-pattern="边界条件"

# 更新 snapshot（如适用）
bun test --update-snapshots
```

### 常用 Flag

| Flag | 用途 |
|------|------|
| `--watch` | 监听文件变化，自动重新运行 |
| `--rerun-every 2000` | 每 2 秒自动运行 |
| `--timeout 10000` | 单测试超时（默认 5000ms） |
| `--bail` | 遇到第一个失败即停止 |
| `--coverage` | 输出覆盖率报告（Bun 内置） |
| `--test-name-pattern` | 按名称过滤 |

### CI 集成（未来）

```
# .github/workflows/test.yml（参考配置）
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test
```

#### 当前状态 📊

🟨 **测试命令已就绪**（`bun test`），CI 未配置。

---

## 13. 增量覆盖路线图

### 第一阶段：低挂果实（~150 新增测试）

| 模块 | 预估测试数 | 难度 | 优先级 |
|------|-----------|------|--------|
| `services/classifier.ts` | 40-60 | 🟢 极易 | ⭐⭐⭐ |
| `shared/response.ts` | 10-15 | 🟢 极易 | ⭐⭐⭐ |
| `storage/cos-storage.ts` | 15-20 | 🟡 中等 | ⭐⭐ |
| `services/parser.ts` | 15-20 | 🟢 容易 | ⭐⭐ |
| **小计** | **~100** | | |

### 第二阶段：核心路由（~80 新增测试）

| 模块 | 预估测试数 | 难度 | 优先级 |
|------|-----------|------|--------|
| `routes/sources.ts` | 15-20 | 🟡 中等 | ⭐⭐ |
| `routes/articles.ts` | 15-20 | 🟡 中等 | ⭐⭐ |
| `routes/podcast-admin.ts` | 10-15 | 🟡 中等 | ⭐⭐ |
| `routes/twitter-admin.ts` | 10-15 | 🟡 中等 | ⭐⭐ |
| **小计** | **~60** | | |

### 第三阶段：复杂模块（~100 新增测试）

| 模块 | 预估测试数 | 难度 | 优先级 |
|------|-----------|------|--------|
| `services/ai.ts` | 15-25 | 🔴 较难 | ⭐⭐ |
| `routes/fetch.ts` | 20-30 | 🔴 较难 | ⭐ |
| `routes/bilibili-admin.ts` | 15-20 | 🔴 较难 | ⭐ |
| `routes/wechat-group-admin.ts` | 10-15 | 🟡 中等 | ⭐ |
| **小计** | **~70** | | |

### 路线图总览

```
Phase 1: 纯函数速胜       (今日起 ~2 小时)    → +100 测试, 覆盖率 ~35%
Phase 2: 核心路由覆盖      (Phase 1 后 ~3 小时) → +60 测试, 覆盖率 ~55%
Phase 3: 复杂模块攻坚      (Phase 2 后 ~4 小时) → +70 测试, 覆盖率 ~70%
Phase 4: 集成 + CI/CD       (持续)              → 稳定性保障
```

---

## 14. 常见陷阱与反模式

### 陷阱 1：过度 mock

```typescript
// ❌ 过度 mock：mock 了整个 SQL 层为了测试一个条件判断
test('标题为空时返回空字符串', async () => {
  const mockSql = mock.fn();
  mockSql.mockResolvedValue([{ title: null }]);
  // ... 20 行 mock 设置
  const result = await someFunction(mockSql, 1);
  expect(result).toBe('');
});

// ✅ 正确做法：提取条件逻辑为纯函数
function normalizeTitle(title: string | null): string {
  return title ?? '';
}
test('标题为空时返回空字符串', () => {
  expect(normalizeTitle(null)).toBe('');
});
```

### 陷阱 2：测试依赖顺序

```typescript
// ❌ 测试 A 修改全局状态，测试 B 依赖修改后的状态
let counter = 0;

test('A: 计数器加一', () => {
  counter++;
  expect(counter).toBe(1);
});

test('B: 依赖前序状态', () => {
  // 如果 A 先运行，ok；B 先运行，fail
  expect(counter).toBe(1);
});

// ✅ 正确做法：每个测试独立设置状态
test('A: 计数器加一', () => {
  counter = 0;
  counter++;
  expect(counter).toBe(1);
});

test('B: 独立的测试', () => {
  counter = 5;
  expect(counter).toBe(5);
});
```

### 陷阱 3：测试过于关注实现细节

```typescript
// ❌ 测试内部实现细节（私有函数、变量名）
test('内部调用 deepSeek API', async () => {
  const result = await translateArticle(mockSql, 1);
  expect(internalApiCallCount).toBe(1);  // 私有状态
  expect(result.translation).toBeDefined();
});

// ✅ 正确做法：测试外部行为（输入/输出契约）
test('翻译结果写入数据库', async () => {
  const result = await translateArticle(mockSql, 1);
  expect(result).toMatchObject({
    articleId: 1,
    translation: expect.any(String),
  });
});
```

### 陷阱 4：测试文件位置不一致

```typescript
// ❌ 测试文件散落各处
backend/
├── tests/ob-writer.test.ts
├── storage/ob-writer.test.ts    ← 另一个测试
├── test-ob-writer.ts            ← 又一个

// ✅ 统一约定：测试文件放在模块同级 tests/ 目录
backend/
└── storage/
    └── tests/
        └── ob-writer.test.ts
```

### 陷阱 5：数值断言过度精确

```typescript
// ❌ 依赖具体数值（今日日期、随机数、时间戳）
test('文件名包含日期', () => {
  expect(sanitizeFilename({ date: '2026-05-03', title: 'test' }))
    .toBe('20260503-test.md');
});

// ✅ 正确做法：测试格式而非具体值
test('文件名包含日期前缀', () => {
  const result = sanitizeFilename({ date: null, title: 'test' });
  expect(result).toMatch(/^\d{8}-test\.md$/);
});
```

---

## 附录 A：测试覆盖速查表

| 检查项 | 当前状态 | 目标状态 | 行动 |
|--------|---------|---------|------|
| Storage 层测试 | ✅ 84 测试 | ✅ 维持 | 补充 cos-storage.ts |
| Services 层测试 | ❌ 0 测试 | ✅ 优先 | classifier → ai → parser |
| Routes 层测试 | ❌ 0 测试 | ✅ 覆盖 | sources → articles → podcast |
| Shared 层测试 | ❌ 0 测试 | ✅ 快速 | 1 小时内完成 |
| 集成测试 | ❌ 无 | ⏳ 可选 | 复杂 SQL 时添加 |
| CI/CD | ❌ 无 | ⏳ 可选 | Phase 4 |
| 前端测试 | ❌ 不测 | ❌ 不测 | 除非 JS 分离 |

## 附录 B：各层测试模板

### 纯函数模板

```typescript
import { describe, test, expect } from 'bun:test';
import { myFunction } from '../my-module.js';

describe('myFunction — 正常情况', () => {
  test('描述期望行为', () => {
    expect(myFunction('input')).toBe('expected');
  });
});

describe('边界条件', () => {
  test('null 输入', () => {
    expect(myFunction(null)).toBe('fallback');
  });
  test('空字符串', () => {
    expect(myFunction('')).toBe('');
  });
});
```

### Route 测试模板

```typescript
import { describe, test, expect } from 'bun:test';
import { createXxxRoutes } from '../routes/xxx.js';

function mockSql() { /* 返回模拟 postgres 函数 */ }
function mockAuth(valid: boolean) { /* 返回模拟 auth */ }

describe('xxx routes — 正常流程', () => {
  test('GET / 返回数据', async () => {
    const app = createXxxRoutes(mockSql(), mockAuth(true));
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
  });
});

describe('xxx routes — 权限验证', () => {
  test('无授权返回 401', async () => {
    const app = createXxxRoutes(mockSql(), mockAuth(false));
    const res = await app.request('http://localhost/', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
```

## 附录 C：测试优先的开发流程

### 新增功能的"先思考再写"流程

```
1. 需求拆解
   ├── 纯逻辑（可提取为纯函数）→ 先写测试，后写实现
   ├── 路由编排（请求→响应）→ 先写路由测试，后写 handler
   └── 外部集成（DB/API）→ 先设计接口，mock 测试

2. 先写测试的好处
   ├── 接口设计更清晰（从调用者角度思考）
   ├── 自动获得可测试的代码
   └── 重构时测试作为安全网
```

### PR 测试检查清单

```
□ 新增的纯函数是否有对应的单元测试？
□ 新增的写操作路由是否有授权测试？
□ 修改已有函数时，已有测试是否通过？
□ 是否引入了新的外部依赖（mock 模式是否正确）？
□ 覆盖率是否下降？（`bun test --coverage` 检查）
```

---

## 附录 D：ADR 关联

- [ADR-004](adr/004-测试策略bun-test纯函数导出.md)：核心测试策略决策（bun test + 纯函数优先）
- [ADR-001](adr/001-orm-选型裸sql.md)：裸 SQL → 测试替代编译期校验
- 未完成的 ADR-006（路由组织）：路由层测试是下一个里程碑

---

*最后更新：2026-05-03*
*基于 InfoHub 项目真实代码覆盖率，随测试增量更新。*
