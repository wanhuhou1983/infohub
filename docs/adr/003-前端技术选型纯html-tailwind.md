# ADR-003: 前端技术选型——纯 HTML + Tailwind (CDN)

- **状态**: Accepted
- **日期**: 2026-04-22

## 背景

InfoHub 是一个**内容消费型**应用：主要交互模式是浏览文章列表 → 点击阅读详情 → 管理信息源。不需要复杂的 UI 状态管理、客户端路由或表单密集型交互。

当时有两种选择：走 SPA 框架路线（React/Vue/Svelte）或保持纯 HTML 路线。

## 决策选项

### 方案 A：SPA 框架（React/Vue/Svelte）

- 优点：组件化开发、状态管理工具成熟、生态丰富
- 缺点：需要 Node.js 构建步骤（vite/webpack）、npm 依赖管理、构建产物托管；前端/后端分离部署增加复杂度；仅 2 个页面（主面板 + 管理后台）不值得框架开销

### 方案 B：纯 HTML + CDN 库

- 使用 `https://cdn.tailwindcss.com`（Play CDN）处理样式
- 使用 `marked.js` CDN 渲染 Markdown
- 所有 CRUD 操作通过后端 API 返回的 HTML 或 JSON 直接更新 DOM
- 前端逻辑在一个 HTML 文件中编写（~170KB）
- 优点：零构建步骤、零 npm 依赖、直接由后端 Hono 托管静态文件
- 缺点：无组件化（巨型 HTML 文件）、无 TypeScript 类型安全、DOM 操作散乱

### 方案 C：HTMX 风格（超媒体驱动）

- 使用 HTMX + Alpine.js 或类似库
- 优点：从后端返回 HTML 片段，前端无需维护状态
- 缺点：对于文章详情全屏覆盖层、批量操作等复杂 UI 模式，HTMX 需要后端配合返回特定 HTML 片段，反而增加后端复杂度

## 决策

**选择了方案 B：纯 HTML + Tailwind (CDN)**。

技术栈具体如下：
- 样式：TailwindCSS Play CDN (`cdn.tailwindcss.com`)
- Markdown 渲染：`marked.js` CDN
- API 请求：原生 `fetch()`，通过统一的 `api()` 封装（见 `frontend/js/api-client.js`）
- 构建步骤：无
- 托管方式：后端 `index.ts` 挂载 `app.use('/static/*')` 或直接返回 HTML 字符串

## 理由

1. **页面数量少**：仅 2 个页面（`index.html` 主面板 + `infohub-admin.html` 管理后台），远未达到 SPA 框架的收益阈值。即便未来增加页面到 5-10 个，纯 HTML 仍然可维护。

2. **内容消费型应用**：InfoHub 是"读"为主的工具，不是"写"为主的工具。核心交互是"选择文章 → 阅读内容"，不需要客户端路由、表单状态管理、复杂数据流等 SPA 强项。

3. **零构建步骤降低运维成本**：无 `vite.config`、无 `npm run build`、无 `dist/` 目录、无前端部署脚本。前端就是后端 Hono 服务静态托管的 HTML 文件。单进程部署，简单可靠。

4. **Tailwind CDN 在小型项目中够用**：Play CDN 模式在运行时解析 Tailwind 类名并生成 CSS，对于 2 个页面的项目完全够用。仅在需要自定义主题色时需内联配置 `tailwind.config`。

5. **前端复杂度处于"刚刚好"水平**：`index.html` 约 170KB（包含内联 JS 和 HTML），`infohub-admin.html` 约 168KB。虽然单个文件较大，但逻辑内聚度高，所有 API 调用通过 `api()` 统一出口（参见 ADR 中的统一 API 客户端策略），可维护性可接受。

## 后果

### 正面

- 零构建步，修改即生效（刷新浏览器即可）
- 单进程部署（Hono 同时提供 API + 静态文件），无 CORS 问题
- 无 npm 前端依赖，无版本冲突风险
- 易于调试：打开浏览器 DevTools 即可看到完整源码

### 负面

- 单个 HTML 文件膨胀（>150KB），编辑时需在大量 DOM 模板中跳转
- 无组件化：相似 UI 模式（如列表卡片、详情面板）需重复编写 HTML
- 无 TypeScript：前端代码无类型检查，API 响应格式问题只能在运行时发现（通过 `api-client.js` 的 `checkShape()` 部分弥补）
- Tailwind CDN 模式性能较低（运行时解析类名），但在低流量个人项目中可忽略

### 适用边界

当前方案适用于中小规模个人项目。如果未来出现以下信号，应考虑迁移到 SPA：
- 页面数超过 5-8 个
- 需要客户端路由（URL 直接定位到文章）
- 多人协作前端开发
- 需要复杂的状态管理（如离线支持、实时协作）

## 关联 ADR

- [ADR-001](001-orm-选型裸sql.md)：后端和前端都遵循"够用就好"的选型原则
- [ADR-004](004-测试策略bun-test纯函数导出.md)：前端无测试（当前策略），质量通过后端测试保障
