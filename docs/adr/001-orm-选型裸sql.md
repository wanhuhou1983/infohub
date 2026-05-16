# ADR-001: ORM 选型——弃用 Drizzle ORM，使用裸 SQL (postgres.js)

- **状态**: Accepted
- **日期**: 2026-04-22

## 背景

项目初始版本（`40ee992`，2026-04-22）搭建时同时引入了两套数据库访问层：

- `drizzle-orm` + `drizzle-orm/postgres-js` — 定义在 `db.ts` 和 `schema.ts` 
- `postgres` (postgres.js) — 定义在 `index.ts` 顶层

Drizzle 负责 schema 定义（`backend/schema.ts`：表结构、索引、外键），postgres.js 负责实际查询执行。这种并存状态持续了约 10 个小时（同一天晚间的 `1a4d910` 提交即删除 Drizzle）。

## 决策选项

### 方案 A：纯 Drizzle ORM（全量迁移）

将 index.ts 中所有 `sql\`...\`` 查询改写为 Drizzle Query API（如 `db.select().from(articles).where(...)`）。

- 优点：TypeScript 类型安全、schema 作为单一真相来源
- 缺点：Drizzle 动态查询（WHERE 子句条件拼装）语法复杂且不直观；中层查询（如参数化的 `WHERE ... IN (...)`、动态 `ORDER BY`）需要 `sql\`...\`` 模板回退，实际上仍需要 postgres.js

### 方案 B：Drizzle ORM 仅做 schema + postgres.js 做查询（初始方案）

Drizzle 定义 schema，postgres.js 执行查询。

- 优点：Drizzle schema 提供迁移管理和类型生成能力
- 缺点：**schema 与实际查询脱节**——schema 更新后必须保持与 SQL 查询的一致性，Drizzle 的类型推导未被实际利用；两层工具维护两套配置（`drizzle.config.ts` + 环境变量）

### 方案 C：纯 postgres.js（裸 SQL）

删除 Drizzle，仅保留 postgres.js，所有查询直接用 tagged template literals 书写。

- 优点：零抽象、查询写法与原生 SQL 一致、动态条件拼装无摩擦
- 缺点：无编译期类型校验、无自动迁移工具

## 决策

**选择了方案 C：纯 postgres.js（裸 SQL）**。

实际路线是：初始版本使用的是"方案 B"（Drizzle + postgres.js 并存），但在同一开发日的四轮审查中（`1a4d910`）发现 Drizzle 实际上**从未被任何路由使用过**（index.ts 和所有路由中的查询全部使用 `sql\`...\``），因此直接删除了 Drizzle 的依赖、db.ts 和 schema.ts。

## 理由

1. **Drizzle 未被实际使用**：`index.ts` 从初始版本就使用 `import postgres from 'postgres'` + `sql\`...\``，Drizzle 的 `db.select()` 从未在路由中出现。删除 Drizzle 是清理死代码，而非架构迁移。

2. **查询动态性强**：文章列表 API 需要根据 `source_id`、`category`、`is_read`、`is_starred`、`search`、`tab` 等参数动态拼装 WHERE 子句。Drizzle 的动态查询（`dynamic` + `sql\`...\`` 回退）在复杂度和可读性上都没有优势。

3. **postgres.js 的 tagged template 已足够安全**：参数化 SQL 是 postgres.js 的内建特性（所有 `\`${...}\`` 自动参数化），无需 ORM 提供额外注入防护。

4. **减少维护负担**：移除 Drizzle 后减少了 `drizzle.config.ts`、schema 文件、迁移文件等一整套工具链的维护工作。当时项目仅有 3 张表（sources/articles/fetch_logs），schema 定义简单，不值得使用 ORM。

5. **代码审查中识别**：该决策是在四轮代码审查中发现的"未使用代码"问题，证明代码审查（而非预先架构评审）是识别过度设计的有效手段。

## 后果

### 正面

- 依赖减少 1 个（`drizzle-orm`，~1MB），`package.json` 更简洁
- 所有 SQL 查询一目了然，无需叠加 ORM 抽象层
- 任意复杂度的 SQL（JSONB 操作、窗口函数、递归 CTE）都可以直接写，无 ORM 限制
- 后续添加的播客/RSS/Twitter 等新模块的查询模式保持一致

### 负面

- 无自动 schema 迁移工具：表结构变更需手动写 `ALTER TABLE`，但项目使用 Docker PostgreSQL，迁移频率低
- 无编译期类型校验：字段名拼写错误在运行时才暴露，通过测试弥补（参见 [ADR-004](004-测试策略bun-test纯函数导出.md)）
- 团队新成员需熟悉 postgres.js 的 tagged template 语法

### 经验教训

Drizzle 在初始搭建时被加入是一种"防御性引入"（怕未来需要 ORM），实际并未产生价值。更合理的做法是**从裸 SQL 开始，当查询复杂度确实需要 ORM 时才引入**。

## 关联 ADR

- [ADR-004](004-测试策略bun-test纯函数导出.md)：通过测试覆盖来弥补裸 SQL 缺少的类型校验
