# InfoHub 📡

多源信息汇总系统 —— 采集、存储、展示来自新闻联播、RSS、微信公众号等多渠道的信息。

## 功能特性

- 📺 **新闻联播** — 自动采集 CCTV 官网每日文字稿
- 📡 **RSS 订阅** — 通过 Miniflux 同步 RSS 源，自动创建子信息源
- 💬 **微信公众号** — 识别并抓取微信公众号文章正文
- 📂 **本地存储** — 文章同步存储为本地 Markdown 文件，图片自动上传图床
- 🔍 **全文搜索** — 支持标题、内容搜索
- ⭐ **星标 & 已读** — 标记重要文章，追踪阅读状态
- 🏷️ **自动分类** — 按内容自动分类（国内/国际/财经/科技/民生等）和标签提取
- 🌳 **信息源树** — 父源-子源层级结构，清晰管理多源信息

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | [Hono](https://hono.dev/) + [postgres.js](https://github.com/porsager/postgres) |
| 数据库 | PostgreSQL (Docker) |
| 前端 | 纯 HTML + [Tailwind CSS](https://tailwindcss.com/) |
| 运行时 | [Bun](https://bun.sh/) / Node.js |
| HTML 解析 | [cheerio](https://cheerio.js.org/) |
| 图床 | [EasyImages](https://github.com/icret/EasyImages2.0) |
| RSS | [Miniflux](https://miniflux.app/) |

## 项目结构

```
infohub/
├── backend/               # Hono 后端
│   ├── index.ts           # 入口 + 路由注册
│   ├── routes/            # 路由模块
│   │   ├── articles.ts    # 文章 CRUD + 正文抓取
│   │   ├── sources.ts     # 信息源管理
│   │   ├── fetch.ts       # 采集（新闻联播 + RSS）
│   │   └── sync.ts        # 同步 + 统计 + 日志
│   ├── services/          # 业务逻辑
│   │   ├── parser.ts      # HTML 解析（cheerio）
│   │   └── classifier.ts  # 分类 + 标签提取
│   ├── file-storage.ts    # 本地文件存储 + 图床上传
│   ├── schema.ts          # 数据库 Schema (Drizzle ORM)
│   ├── init.sql           # 数据库初始化 SQL
│   └── package.json
├── frontend/              # 前端
│   └── index.html         # 单页应用
├── data/                  # 本地文章存储（git 忽略）
│   ├── xwlb/              # 新闻联播文章
│   ├── rss/               # RSS 文章
│   ├── wechat/            # 公众号文章
│   ├── .img_cache.json    # 图片上传缓存
│   └── index.json         # 文章 ID → 文件路径映射
└── adapters/              # 适配器（预留）
```

## 快速开始

### 前置依赖

- [Bun](https://bun.sh/) >= 1.0 或 Node.js >= 18
- [Docker](https://www.docker.com/) (运行 PostgreSQL)
- [Miniflux](https://miniflux.app/) (可选，用于 RSS 同步)
- [EasyImages](https://github.com/icret/EasyImages2.0) (可选，用于图床)

### 1. 启动 PostgreSQL

```bash
docker run -d \
  --name infohub-db \
  -e POSTGRES_USER=infohub \
  -e POSTGRES_PASSWORD=infohub123 \
  -e POSTGRES_DB=infohub \
  -p 5433:5432 \
  postgres:16
```

### 2. 初始化数据库

```bash
cd backend
psql -h localhost -p 5433 -U infohub -d infohub -f init.sql
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入实际配置（IMGBED_TOKEN 为必填项）
```

### 4. 安装依赖 & 启动

```bash
cd backend
bun install
bun run dev
```

后端默认运行在 `http://localhost:3001`。

### 5. 打开前端

直接在浏览器中打开 `frontend/index.html`，或通过任意静态服务器访问。

## 环境变量

| 变量 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接串 | ✅ | - |
| `PORT` | 后端服务端口 | ❌ | `3001` |
| `DATA_DIR` | 本地文章存储目录 | ❌ | `../data` |
| `IMGBED_URL` | 图床 API 地址 | ❌ | `http://localhost:8085/api/` |
| `IMGBED_BASE` | 图床基础 URL | ❌ | `http://localhost:8085` |
| `IMGBED_TOKEN` | 图床 API Token | ✅ | - |
| `MINIFLUX_URL` | Miniflux 地址 | ❌ | `http://localhost:8084` |
| `MINIFLUX_USER` | Miniflux 用户名 | ❌ | `admin` |
| `MINIFLUX_PASS` | Miniflux 密码 | ❌ | `miniflux123` |

## API 接口

### 信息源

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sources` | 获取所有信息源 |
| GET | `/api/sources/tree` | 获取信息源树（含子源） |

### 文章

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/articles` | 文章列表（支持分页、过滤、搜索） |
| GET | `/api/articles/:id` | 文章详情（自动抓取正文） |
| PATCH | `/api/articles/:id/read` | 标记已读/未读 |
| PATCH | `/api/articles/:id/star` | 标记星标 |
| POST | `/api/articles/mark-all-read` | 批量标记已读 |

### 采集

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/fetch/xwlb` | 采集新闻联播 |
| POST | `/api/fetch/rss` | 同步 RSS（Miniflux） |

### 同步 & 统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sync/stats` | 统计信息 |
| GET | `/api/sync/logs` | 采集日志 |
| POST | `/api/sync/files` | 全量同步 DB → 本地文件 |

## 本地文件存储

每篇文章保存为 Markdown 文件，包含 YAML frontmatter：

```markdown
---
id: 42
source: "新闻联播"
source_type: "xwlb"
url: "https://tv.cctv.com/..."
published_at: "2026-04-22T19:30:00"
category: "国内"
tags: ["经济", "政策"]
---

# 文章标题

正文内容...
```

## 安全注意事项

- **图床 Token**：`IMGBED_TOKEN` 为必填环境变量，无默认值，不会泄露到代码仓库
- **CORS**：仅允许指定域名访问 API，非全开放
- **SQL 注入**：所有查询使用 `postgres.js` 参数化模板，不使用 `sql.unsafe()`
- **.env**：已被 `.gitignore` 排除，不会进入版本控制

## License

MIT
