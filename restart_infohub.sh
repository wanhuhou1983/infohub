#!/bin/bash
# restart_infohub.sh — 重建 infohub-backend + search-hub（简化路径版）
# 使用短链接: /w -> /home/linhu/WorkBuddy, /sr -> /home/linhu/search-hub
set -e

# ====== infohub-backend ======
echo "=== infohub-backend ==="
docker stop infohub-backend 2>/dev/null || true
docker rm infohub-backend 2>/dev/null || true

docker run -d \
  --name infohub-backend \
  --restart unless-stopped \
  --network quant-network \
  -p 3001:3001 \
  -e DATABASE_URL="postgres://infohub:infohub123@quant-postgres:5432/infohub" \
  -e PORT="3001" \
  -e REQUIRE_AUTH="true" \
  -e ADMIN_TOKEN="ZUzriy/apfeXjnX3z/qBU4PzCp4l8ffX6fwd+JfG8qg=" \
  -e ALLOWED_ORIGIN="https://wuflux.cn,https://info.wuflux.cn" \
  -e CLOUD_MODE="false" \
  -e HOME="/root" \
  -e OB_DIR="/obsidian" \
  -e WEFLOW_URL="http://127.0.0.1:5031" \
  -e WEFLOW_TOKEN="86ec59e61b587f1b97ad227a1ec12476" \
  -e OLLAMA_BASE_URL="http://172.18.0.1:11435" \
  -e OLLAMA_TRANSLATE_MODEL="gemma4:26b" \
  -e OB_ATTACHMENTS_DIR="/obsidian/附件" \
  -e TZ="Asia/Shanghai" \
  -v /mnt/c/Users/linhu/Documents/infohub:/obsidian \
  -v /w/infohub/backend:/app \
  -v /w/infohub/frontend:/app/frontend \
  -v /home/linhu/.workbuddy:/root/.workbuddy \
  -v /w/infohub/skills/rmrb-daily:/skills/rmrb-daily \
  127.0.0.1:5000/infohub-backend:latest
echo "  Done: $(docker ps --filter name=infohub-backend --format '{{.Status}}')"

# ====== search-hub ======
echo "=== search-hub ==="
docker stop search-hub 2>/dev/null || true
docker rm search-hub 2>/dev/null || true

docker run -d \
  --name search-hub \
  --restart unless-stopped \
  -p 18081:18081 \
  -v /sr/main.py:/app/main.py \
  -v /sr/index.html:/app/index.html \
  -v /sr/config.py:/app/config.py \
  -v /home/linhu/Downloads:/root/Downloads \
  -v /home/linhu/.workbuddy:/root/.workbuddy \
  search-hub
echo "  Done: $(docker ps --filter name=search-hub --format '{{.Status}}')"

echo ""
echo "=== 全部就绪 ==="
docker ps --filter "name=infohub-backend|search-hub" --format "table {{.Names}}\t{{.Status}}"
