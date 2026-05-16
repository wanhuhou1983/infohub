# InfoHub Backend — 多阶段 Docker 构建
#
# 构建方式：
#   docker build -t infohub-backend -f backend/Dockerfile backend/
#
# 运行方式：
#   docker run -d -p 3001:3001 \
#     -v $(pwd)/data:/app/data \
#     -v $(pwd)/.env.json:/app/.env.json:ro \
#     --name infohub-backend infohub-backend:latest
#
# 环境变量：
#   DATABASE_URL         PostgreSQL 连接串（必填）
#   PORT                 服务端口（默认 3001）
#   DATA_DIR             数据目录（默认 ./data）
#   ADMIN_TOKEN          管理员 Token（生产必填）
#   REQUIRE_AUTH         设为 true 强制认证
#   ALLOWED_ORIGIN       允许的 CORS 域名，多域名以逗号分隔

# ============ Stage 1: 构建阶段 ============
FROM oven/bun:1-alpine AS build

WORKDIR /app

# 先复制依赖文件，利用 Docker 分层缓存
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ============ Stage 2: 运行阶段 ============
FROM oven/bun:1-alpine AS run

WORKDIR /app

# 安装运行时工具（健康检查用）
RUN apk add --no-cache curl ca-certificates tzdata

# 从构建阶段复制 node_modules 和源码
COPY --from=build /app/node_modules ./node_modules
COPY . .

# 创建数据目录并设置权限
RUN mkdir -p /app/data && \
    addgroup -S appgroup && \
    adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api/test || exit 1

# 启动服务
CMD ["bun", "run", "index.ts"]
