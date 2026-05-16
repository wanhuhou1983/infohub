# ADR-004: 测试策略——bun test + 纯函数导出 + mock.module

- **状态**: Accepted
- **日期**: 2026-05-03

## 背景

项目初期（2026-04-22 至 2026-05-02）约 10 天时间内，后端代码持续增长但**零测试覆盖**。代码审查发现三类问题反复出现：

1. 图片处理（`processImages`）中的正则匹配遗漏、`__IMG__` 占位符残留
2. 文件路径/文件名生成逻辑（`sanitizeFilename`、`getObSubdir`）的分支缺失
3. 数据格式转换（`buildMarkdown`、`parseObFrontmatter`）的边界条件没覆盖

需要建立一个可持续的测试基础设施，且必须适配项目的运行时（Bun）。

## 决策选项

### 方案 A：Vitest（标准 Node.js 测试框架）

- 优点：兼容 Jest API、生态成熟、TypeScript 原生支持
- 缺点：在 Bun 运行时下需要额外的兼容层（`vitest` 内部使用 Node.js API，Bun 不完全兼容）；增量增加 CI 复杂度

### 方案 B：bun test（Bun 内建测试运行器）

- 优点：零额外依赖、Bun 原生支持 TypeScript/TSX、运行速度快
- 缺点：ESM mock 机制有限（仅支持 `mock.module` 按路径拦截模块、不支持 `vi.mock` 的 factory 回调）；生态较小

### 方案 C：测试金字塔——端到端（Playwright）+ 集成 + 单元

- 优点：覆盖全面
- 缺点：对于个人项目过度设计；前端仅 2 个静态页面，E2E 测试收益低

## 决策

**选择了方案 B：bun test**，并配套了以下测试策略：

### 核心策略：纯函数导出 + 直接单元测试

不依赖 mock 框架的复杂功能，而是**将核心业务逻辑提取为可导出的纯函数**，直接测试函数输入/输出。

```typescript
// 暴露内部纯函数（不改变核心逻辑）
export function normalizeDate(val: string | null | undefined): string { ... }
export function sanitizeFilename(meta: ArticleMeta): string { ... }
export function buildMarkdown(content: string, meta: ArticleMeta): string { ... }
```

### 策略细则

1. **优先测纯函数**：无副作用、零 mock 依赖、执行速度快（360ms 跑 65 个测试）
2. **mock 外围**：当需要测试有副作用的函数（如 COS 上传）时，使用 `mock.module()` 拦截模块
3. **round-trip 契约**：`buildMarkdown()` 的输出可被 `parseObFrontmatter()` 正确解析，保证双向一致性
4. **前端不测**：前端为纯 HTML，无测试框架；质量通过后端测试 + 手动验证保障
5. **路由层尚未覆盖**：当前测试集中在 storage 层的两个核心模块，路由层仍为空白

## 理由

1. **bun test 零配置**：不需要 `vitest.config.ts`、不安装 `@vitest/...` 包。在 Bun 运行时下，`bun test` 是最自然的测试运行器。

2. **纯函数策略避免 mock 地狱**：`processImages` 涉及网络下载、文件系统写入、COS 上传——如果要通过集成测试覆盖，需要 mock 三层外部依赖。改为导出内部纯函数（`buildMarkdown`）后，只需测输入/输出，零 mock。

3. **代码变更最小化**：导出纯函数只需加 `export` 关键字，不修改核心逻辑。不改变 `saveArticleFile` 的调用方式。

4. **mock.module 够用且简洁**：对于确实需要 mock 的场景（如 COS 拦截），`mock.module('../storage/cos-storage.js')` 的字符串匹配足以胜任。Bun 的 mock 虽然限制多，但在这个项目规模下不是瓶颈。

5. **测试作为重构安全网**：纯函数测试为后续重构（如修改文件名格式、调整 frontmatter 结构）提供了快速反馈。

## 后果

### 正面

- 84 个测试覆盖 storage 层两个核心模块（`image-processor.ts` × 19 + `ob-writer.ts` × 65）
- 所有测试纯函数级别，零外部 mock，执行 < 1s
- round-trip 契约测试保证 frontmatter 的一致性
- 为后续路由层测试打下基础（可复用 mock 模式）

### 负面

- 测试覆盖评分约 2.5/5（storage 层覆盖良好，路由层 = 0，cos-storage.ts = 0）
- 无 `stryker` 等变异测试工具评估测试质量
- 前端完全无测试
- mock.module 不支持 factory 回调，复杂 mock 场景（如模块内部状态）需变通处理

### 当前测试清单

| 测试文件 | 测试数 | 覆盖模块 |
|---------|--------|---------|
| `image-processor.test.ts` | 19 | `processImages` 的纯函数部分 |
| `ob-writer.test.ts` | 65 | 9 个导出函数（normalizeDate/hashString/sanitizeDirName/normalizeWechatAccount/parseObFrontmatter/getObSubdir/sanitizeFilename/extractDerivedFields/computeExtraVersion/buildMarkdown） |

## 关联 ADR

- [ADR-001](001-orm-选型裸sql.md)：裸 SQL 缺乏编译期类型校验，通过测试来弥补
- ADR-006（路由组织）：路由层测试是下一个目标
