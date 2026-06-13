#!/bin/bash
# deploy-cloud.sh — 一键部署 InfoHub 到云端 (101.35.250.154)
# 用法: ./deploy-cloud.sh            # 全量部署（rsync + rebuild + restart）
#       ./deploy-cloud.sh --quick    # 仅前端变更时快速部署（rsync + restart，不 rebuild）
set -e

CLOUD_HOST="ubuntu@101.35.250.154"
CLOUD_DIR="/home/ubuntu/infohub-build-v3"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-full}"

echo "=== InfoHub 云端部署 ==="
echo "  模式: $MODE"
echo "  目标: $CLOUD_HOST:$CLOUD_DIR"
echo ""

# Step 1: rsync 代码（始终执行）
echo "--- Step 1: 同步代码 ---"
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='.workbuddy' \
  --exclude='backend/obsidian-local' \
  --exclude='backend/data' \
  --exclude='backend/node_modules' \
  --exclude='bili-service' \
  --exclude='.github' \
  "$LOCAL_DIR/" "$CLOUD_HOST:$CLOUD_DIR/"
echo ""

# Step 2: Git push 到 GitHub（始终执行）
echo "--- Step 2: Git push ---"
GIT_DIR="$LOCAL_DIR/.git" GIT_WORK_TREE="$LOCAL_DIR" git push origin main 2>&1 || echo "(git push skipped or failed)"
echo ""

# Step 3: 如果是全量模式，rebuild Docker 镜像
if [ "$MODE" != "--quick" ]; then
  echo "--- Step 3: 重建 Docker 镜像 ---"
  # 使用传统构建器，避免 buildkit 在云服务器上卡死
  ssh $CLOUD_HOST "cd $CLOUD_DIR && DOCKER_BUILDKIT=0 docker build -t infohub-build-v3-backend:latest ."
  echo ""
fi

# Step 4: 重启容器
echo "--- Step 4: 重启容器 ---"
ssh $CLOUD_HOST << 'REMOTE_SCRIPT'
set -e
docker stop infohub-backend 2>/dev/null || true
docker rm infohub-backend 2>/dev/null || true

docker run -d \
  --name infohub-backend \
  --restart unless-stopped \
  -p 3001:3001 \
  -e DATABASE_URL="postgres://infohub:infohub123@infohub-postgres-cloud:5432/infohub" \
  -e PORT="3001" \
  -e REQUIRE_AUTH="false" \
  -e ALLOWED_ORIGIN="https://wuflux.cn,https://info.wuflux.cn" \
  -e CLOUD_MODE="false" \
  -e HOME="/root" \
  -e OB_DIR="/obsidian" \
  -e TZ="Asia/Shanghai" \
  -e OB_ATTACHMENTS_DIR="/obsidian/附件" \
  -v /mnt/c/Users/linhu/Documents/infohub:/obsidian \
  -v /home/ubuntu/infohub-build-v3/frontend:/app/frontend \
  --network infohub-net \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  infohub-build-v3-backend:latest

sleep 3
echo "=== 容器状态 ==="
docker ps --filter name=infohub-backend --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
echo ""
echo "=== 启动日志 ==="
docker logs infohub-backend --tail 5
REMOTE_SCRIPT

echo ""
echo "=== 验证 ==="
curl -s -o /dev/null -w "  image-proxy: HTTP %{http_code}\n" "https://info.wuflux.cn/api/image-proxy?url=https%3A%2F%2Fmmbiz.qpic.cn%2Fsz_mmbiz_png%2Ftest%2F0&dummy=1" 2>/dev/null || echo "  image-proxy: (check manually)"
curl -s https://info.wuflux.cn/api/articles?limit=1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('  articles API: OK,', len(d if isinstance(d,list) else d.get('articles',[])), 'articles')" 2>/dev/null || echo "  articles API: (check manually)"

echo ""
echo "🎉 部署完成! https://info.wuflux.cn"
