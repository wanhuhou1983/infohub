#!/bin/bash
# watchdog.sh — 检测 infohub backend 是否存活，挂了就重启

HEALTH_URL="http://localhost:3001/api/sources"
BACKEND_DIR="/Users/linhu/WorkBuddy/2026-06-09-21-34-58/infohub/backend"
LOG_FILE="/tmp/infohub-watchdog.log"

# 健康检查
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  exit 0  # 正常，什么都不做
fi

# 挂了，记录并重启
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 后端无响应(HTTP $HTTP_CODE)，准备重启..." >> "$LOG_FILE"

# 杀掉残留进程
pkill -f "bun run index.ts" 2>/dev/null
sleep 2

# 重启
cd "$BACKEND_DIR"
nohup /Users/linhu/.bun/bin/bun run index.ts >> /tmp/infohub.log 2>&1 &
NEW_PID=$!
sleep 3

# 验证
HTTP_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)
if [ "$HTTP_CODE2" = "200" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 重启成功 PID=$NEW_PID HTTP=$HTTP_CODE2" >> "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 重启后仍无响应 HTTP=$HTTP_CODE2" >> "$LOG_FILE"
fi
