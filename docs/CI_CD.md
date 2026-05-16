# InfoHub CI/CD 集成指南

> **目的**：建立从代码提交到生产部署的自动化流水线，确保每次变更经过类型检查、测试验证、可重现部署。
>
> 包含：GitHub Actions 工作流设计、Docker 化方案、Secrets 管理、部署策略、操作手册。

---

## 目录

1. [当前状态](#1-当前状态)
2. [工作流架构](#2-工作流架构)
3. [CI 工作流：PR 质量门禁](#3-ci-工作流pr-质量门禁)
4. [部署工作流：一键部署](#4-部署工作流一键部署)
5. [Docker 化方案](#5-docker-化方案)
6. [Secrets 管理](#6-secrets-管理)
7. [本地预提交检查](#7-本地预提交检查)
8. [部署到 VPS](#8-部署到-vps)
9. [操作手册](#9-操作手册)
10. [未来扩展](#10-未来扩展)

---

## 1. 当前状态

| 维度 | 现状 |
|------|------|
| GitHub 仓库 | `wanhuhou1983/infohub` ✅，仅 main 分支 |
| 测试框架 | `bun test` ✅，84 个测试 |
| TypeScript | 严格模式 ✅，`tsc --noEmit` 可检查类型 |
| GitHub Actions | ❌ 未配置 |
| Dockerfile | ❌ 不存在 |
| docker-compose | 仅 PostgreSQL（非项目内管理） |
| 生产部署 | ❌ 手动 |
| 预提交检查 | ❌ 未配置 |

### 目标状态

```
提交代码 → GitHub Push → CI 自动检查 → 合并到 main → 自动部署
                                      ↓                          ↓
                          bun test + tsc --noEmit          Docker 构建 + 推送 + 重启
```

---

## 2. 工作流架构

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub Actions                          │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐  │
│  │  ci.yml       │     │  deploy.yml  │     │  cleanup.yml │  │
│  │  (push/PR)    │ ──► │  (手动触发)   │     │  (定期)      │  │
│  │               │     │               │     │              │  │
│  │ • bun install │     │ • Docker 构建 │     │ • 清理旧包   │  │
│  │ • tsc --check │     │ • 推送到 GHCR │     │ • 保留近 N 版│  │
│  │ • bun test    │     │ • SSH 部署    │     │              │  │
│  └──────┬───────┘     └──────┬───────┘     └──────────────┘  │
│         │                    │                                │
│         └──── 合并 main ─────┘                                │
└─────────────────────────────────────────────────────────────┘
```

### 工作流一览

| 工作流 | 触发条件 | 耗时预估 | 失败怎么办 |
|--------|----------|----------|------------|
| **CI** | push 任意分支 + PR → main | ~30s | PR 阻止合并，联系开发者修复 |
| **Deploy** | `workflow_dispatch` 手动触发 | ~2min | 回滚上一版镜像，排查日志 |
| **Cleanup** | 每周日凌晨（cron） | ~10s | 无影响，跳过即可 |

### 文件位置

```
.github/workflows/
├── ci.yml          # CI 质量门禁
└── deploy.yml      # 部署流水线
```

---

## 3. CI 工作流：PR 质量门禁

### 3.1 触发条件

```yaml
on:
  push:
    branches: [main]
    paths-ignore: ['docs/**', '**.md']    # 文档变更不触发
  pull_request:
    branches: [main]
```

### 3.2 工作流步骤

| 步骤 | 工具 | 干什么 | 失败后果 |
|------|------|--------|----------|
| 1. Setup Bun | `oven-sh/setup-bun` | 安装 Bun 1.x | ❌ 阻断 |
| 2. Cache Deps | `actions/cache` | 缓存 node_modules | ⚡ 加速 |
| 3. Install | `bun install` | 安装依赖 | ❌ 阻断 |
| 4. Type Check | `bun x tsc --noEmit` | 类型检查 | ❌ 阻断 |
| 5. Run Tests | `bun test` | 运行全部测试 | ❌ 阻断 |
| 6. Test Report | 自定义 | 输出测试摘要 | ✅ 可选 |

### 3.3 缓存策略

```yaml
- uses: actions/cache@v4
  with:
    path: backend/node_modules
    key: ${{ runner.os }}-bun-${{ hashFiles('backend/bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

**要点**：
- 以 `bun.lock` 内容哈希为缓存键（比 package-lock.json 更可靠）
- `bun.lock` 已加入 `.gitignore` — 需要将其加入版本控制才能用于缓存键
  - 建议：**将 `bun.lock` 从 `.gitignore` 移除**，commit 进仓库
- restore-keys 提供 fallback，部分缓存命中也能提速

### 3.4 测试环境注意事项

**当前测试不需要数据库**（纯函数测试），但如果将来添加集成测试：

- 使用 `services: postgres` 启动临时 PostgreSQL
- 环境变量 `DATABASE_URL` 指向 CI 的 PostgreSQL
- 在 `init.sql` 步骤执行建表

### 3.5 PR 状态标记

工作流运行后，结果自动出现在 PR 页面：

- ✅ 绿色：所有检查通过，可合并
- ❌ 红色：存在失败项，PR 被禁止合并
- ⏳ 黄色：正在运行

**分支保护规则**（需在 GitHub 仓库 Settings → Branches 中开启）：

```
Settings → Branches → Add branch protection rule
  - Branch name pattern: main
  - ☑ Require status checks before merging
  - ☑ Require branches to be up to date
  - ☑ Include administrators
  - Status checks: ci / test (bun), ci / type-check (tsc)
```

---

## 4. 部署工作流：一键部署

### 4.1 触发方式

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: '部署环境'
        type: choice
        default: 'staging'
        options:
          - staging
          - production
```

手动触发：GitHub → Actions → Deploy → Run workflow。

### 4.2 部署步骤

| 步骤 | 操作 | 说明 |
|------|------|------|
| 1 | CI 全量检查 | 复用 ci.yml 逻辑 |
| 2 | Build Docker | `docker build -t infohub-backend .` |
| 3 | Tag & Push | 推送到 GHCR（GitHub Container Registry） |
| 4 | SSH 到 VPS | 拉取新镜像、停止旧容器、启动新容器 |
| 5 | Health Check | `curl http://localhost:3001/api/test` 验证 |
| 6 | Slack/Telegram 通知 | 部署成功/失败通知 |

### 4.3 回滚方案

```bash
# SSH 到 VPS，切换到上一版本
docker stop infohub-backend
docker run -d --rm -p 3001:3001 \
  --name infohub-backend \
  --network infohub-net \
  ghcr.io/wanhuhou1983/infohub-backend:VERSION_PREVIOUS
```

建议保留最近 5 个镜像标签：

```yaml
# cleanup.yml — 每周清理旧镜像
on:
  schedule:
    - cron: '0 4 * * 0'    # 每周日凌晨 4 点
steps:
  - uses: actions/delete-package-versions@v5
    with:
      package-name: infohub-backend
      min-versions-to-keep: 5
```

---

## 5. Docker 化方案

### 5.1 Docker 架构

```
┌──────────────────────────────┐
│        Docker Host            │
│                               │
│  ┌──────────────────────┐     │
│  │  infohub-backend      │     │
│  │  :3001 (Hono)         │     │
│  │  ┌───────────────┐    │     │
│  │  │  data/         │    │     │  ← 挂载卷，存图片/OB
│  │  │  .env.json     │    │     │  ← 挂载，存密钥
│  │  └───────────────┘    │     │
│  └──────────┬───────────┘     │
│             │                  │
│  ┌──────────▼───────────┐     │
│  │  infohub-db           │     │
│  │  postgres:16-alpine   │     │
│  │  :5433                │     │
│  └──────────────────────┘     │
└──────────────────────────────┘
```

### 5.2 Dockerfile 设计

**文件**: `backend/Dockerfile`

分层策略：

```
Layer 0: oven/bun:1-alpine (base)
  ├── Layer 1: 复制 package.json + bun.lock
  ├── Layer 2: bun install (dependencies only, --production)
  ├── Layer 3: 复制源码
  ├── Layer 4: EXPOSE 3001
  └── Layer 5: CMD ["bun", "run", "index.ts"]
```

**关键选择**：
- **Alpine 基础镜像**：~150MB，比 Debian-based 小 3x
- **不安装 devDependencies**：减小镜像体积 + 攻击面
- **`dotenv` 支持**：`bun run` 自带 .env 加载，`dotenv/config` 配合 `.env.json` 双重配置源
- **非 root 用户**：使用 `bun` 用户运行（镜像内建）

### 5.3 镜像标签策略

```
ghcr.io/wanhuhou1983/infohub-backend:
  - latest        # 最新版
  - {SHA}         # Git commit SHA 前 7 位
  - YYYYMMDD-{N}  # 日期 + 当日构建序号（可选）
```

### 5.4 生产 docker-compose.yml

**文件**: `docker-compose.prod.yml`（放在项目根目录）

设计原则：

- 网络统一：所有服务在同一 Docker 网络
- 挂载卷持久化：`data/`、`postgres-data/`
- 依赖顺序：先启动 DB，再启动 backend
- 健康检查：backend 依赖 DB 就绪
- 重启策略：`unless-stopped`
- 日志限制：`max-size: 10m`，防日志撑爆磁盘

---

## 6. Secrets 管理

### 6.1 分层配置

```
GitHub Secrets (encrypted)
       │
       ▼
.github/workflows/deploy.yml
       │
       ▼
SSH 到 VPS → 写入 .env.json 环境变量
                           │
                           ▼
                   Docker 容器内 process.env
```

### 6.2 需要在 GitHub Secrets 中设置的变量

| Secret 名称 | 用途 | 必填 |
|-------------|------|------|
| `DOCKER_REGISTRY` | 容器仓库地址（默认 GHCR） | ✅ |
| `DEPLOY_HOST` | VPS SSH 地址 | 部署需要 |
| `DEPLOY_USER` | SSH 用户 | 部署需要 |
| `DEPLOY_KEY` | SSH 私钥 | 部署需要 |
| `ADMIN_TOKEN` | 管理员 Token | ✅ 生产必填 |
| `DATABASE_URL` | 生产数据库连接串 | ✅ |
| `REQUIRE_AUTH` | `true` — 强制认证 | ✅ |

### 6.3 本地 .env.json 管理

`.env.json` **永远不 commit**（已在 `.gitignore` 中）。

**初始化模板**（`.env.json.example`，可 commit）：

```json
{
  "ADMIN_TOKEN": "your-production-token",
  "DATABASE_URL": "postgres://infohub:infohub123@infohub-db:5432/infohub",
  "REQUIRE_AUTH": "true"
}
```

### 6.4 CI 环境变量注入

CI 中只需要跑测试，当前测试不连数据库，所以 CI 无需额外环境变量。

将来如需集成测试，在 `ci.yml` 中添加：

```yaml
- name: Run tests
  env:
    DATABASE_URL: postgres://infohub:infohub123@localhost:5432/infohub_test
  run: bun test
```

---

## 7. 本地预提交检查

### 7.1 安装 pre-commit 钩子

```bash
# 在项目根目录运行
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/sh
cd backend
echo "🔍 Running type check..."
bun x tsc --noEmit || exit 1
echo "🧪 Running tests..."
bun test || exit 1
echo "✅ Pre-commit checks passed!"
EOF
chmod +x .git/hooks/pre-commit
```

### 7.2 使用 husky（可选增强方案）

不强制使用 husky（避免额外依赖），但如有需要：

```bash
# 项目根目录
bun add -D husky
npx husky init
echo "bun x tsc --noEmit && bun test" > .husky/pre-commit
```

---

## 8. 部署到 VPS

### 8.1 前置条件

VPS 上需要：

```bash
# 1. 安装 Docker + Docker Compose
curl -fsSL https://get.docker.com | bash

# 2. 创建项目目录
mkdir -p /opt/infohub/{data,postgres-data}

# 3. 配置 .env.json
cat > /opt/infohub/.env.json << 'EOF'
{
  "ADMIN_TOKEN": "<生产 Token>",
  "REQUIRE_AUTH": "true",
  "DATABASE_URL": "postgres://infohub:infohub123@infohub-db:5432/infohub"
}
EOF
chmod 600 /opt/infohub/.env.json
```

### 8.2 首次部署（手动）

```bash
# 克隆仓库
cd /opt/infohub
git clone https://github.com/wanhuhou1983/infohub.git app

# 启动服务栈
docker compose -f docker-compose.prod.yml up -d

# 验证
curl http://localhost:3001/api/test
# → {"msg":"test ok"}
```

### 8.3 后续部署（自动化）

通过 GitHub Actions deploy.yml 自动完成：

```bash
# 流程
1. CI 确认所有检查通过
2. Docker build & push to GHCR
3. SSH 到 VPS:
   a. docker compose pull
   b. docker compose up -d --force-recreate
   c. 健康检查
```

### 8.4 健康检查

Dockerfile 中使用 healthcheck：

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:3001/api/test || exit 1
```

**注意事项**：
- `curl` 需要在 Alpine 中安装：`apk add --no-cache curl`
- 也可以使用 `wget -q -O-`（Alpine 自带 wget）

---

## 9. 操作手册

### 9.1 日常开发流程

```bash
# 1. 新建分支
git checkout -b feat/my-feature

# 2. 编码 → 本地提交前可选运行
cd backend && bun x tsc --noEmit && bun test

# 3. 提交并推送
git add .
git commit -m "feat: add xxx"
git push origin feat/my-feature

# 4. 在 GitHub 创建 PR → 自动触发 CI
# 5. 通过检查后合并到 main
# 6. 手动触发 Deploy 工作流部署到生产
```

### 9.2 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| CI 失败：测试失败 | 代码变更导致 | `bun test --update` 更新 snapshot，或修复测试 |
| CI 失败：类型错误 | 类型不匹配 | `bun x tsc --noEmit` 本地检查 |
| 部署失败：构建失败 | Dockerfile 语法或依赖问题 | 本地 `docker build` 验证 |
| 部署失败：容器退出 | 环境变量缺失 | `docker logs infohub-backend` 查看 |
| 部署失败：健康检查不过 | 服务未启动 | 检查数据库连接、端口占用 |

### 9.3 日常运维

```bash
# 查看容器状态
docker ps --filter "name=infohub"
docker compose -f docker-compose.prod.yml ps

# 查看实时日志
docker logs -f infohub-backend

# 重启服务
docker compose -f docker-compose.prod.yml restart

# 回滚到上一版本
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml run --entrypoint "" infohub-backend \
  sh -c "sed -i 's/latest/SHA_PREV/' docker-compose.prod.yml"
docker compose -f docker-compose.prod.yml up -d

# 手动触发部署
# GitHub → Actions → Deploy → Run workflow
```

---

## 10. 未来扩展

### 阶段 1（当前）— 基础 CI
- [x] GitHub Actions 工作流文件落地
- [x] Dockerfile 落地
- [ ] 将 `bun.lock` 从 `.gitignore` 移除并 commit
- [ ] 在 GitHub 仓库配置分支保护规则
- [ ] 在 GitHub Secrets 中配置必要变量

### 阶段 2 — 自动化部署
- [ ] VPS 上初始化 Docker 环境
- [ ] 在仓库配置 `DEPLOY_HOST` / `DEPLOY_KEY` 等 Secrets
- [ ] 首次手动部署验证
- [ ] 配置 deploy.yml SSH 部署步骤
- [ ] 配置 Slack/Telegram 通知

### 阶段 3 — 增强
- [ ] 集成测试（PostgreSQL in CI）
- [ ] 代码覆盖率报告（`bun test --coverage` → Codecov/Coveralls）
- [ ] 依赖漏洞扫描（Dependabot 或 `bun audit`）
- [ ] 预提交钩子通过 husky 自动化安装
- [ ] 多环境（staging / production）独立部署
- [ ] 自动部署：push 到 main 时自动部署到 staging

---

## 附录 A：快速参考卡片

```bash
# ========== CI/CD 速查 ==========

# 本地类型检查
cd backend && bun x tsc --noEmit

# 本地跑测试
cd backend && bun test

# 本地构建 Docker 镜像
docker build -t infohub-backend -f backend/Dockerfile backend/

# 运行 Docker 容器
docker run -d -p 3001:3001 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/.env.json:/app/.env.json \
  --name infohub-backend infohub-backend

# 验证容器运行
curl http://localhost:3001/api/test

# 启动完整服务栈
docker compose -f docker-compose.prod.yml up -d

# 停止并清理
docker compose -f docker-compose.prod.yml down
```

## 附录 B：文件清单

创建或修改的文件：

| 文件 | 类型 | 说明 |
|------|------|------|
| `.github/workflows/ci.yml` | 🆕 新建 | CI 质量门禁 |
| `.github/workflows/deploy.yml` | 🆕 新建 | 部署流水线 |
| `backend/Dockerfile` | 🆕 新建 | 后端 Docker 镜像 |
| `.gitignore` | 🔧 修改 | 可选：移除 `bun.lock` |

## 附录 C：关联文档

- [测试覆盖指南](./TEST_COVERAGE.md) — 测试策略和增量路线图
- [ADR-004: 测试策略 bun-test 纯函数导出](./adr/004-测试策略bun-test纯函数导出.md) — 测试框架选型决策
- [代码复杂度分析](./CODE_COMPLEXITY.md) — 需要重点测试的模块
- [审查规范](./REVIEW_GUIDELINES.md) — CI 通过的 PR 方可合并
