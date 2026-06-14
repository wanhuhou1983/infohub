#!/bin/bash
# start-backend.sh — 带自动重启的 infohub 后端启动器
# 由 LaunchAgent (com.infohub.backend) 管理，崩溃后自动重启
# 兼容手动运行: bash start-backend.sh

BACKEND_DIR="/Users/linhu/WorkBuddy/2026-06-09-21-34-58/infohub/backend"
LOG_FILE="/tmp/infohub.log"
BUN="/Users/linhu/.bun/bin/bun"
RESTART_DELAY=5
MAX_RESTARTS=100

cd "$BACKEND_DIR"

# ====== 等待 PostgreSQL 就绪（最多 30 秒） ======
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 等待 PostgreSQL 就绪..." >> "$LOG_FILE"
for i in $(seq 1 15); do
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] PostgreSQL 已就绪" >> "$LOG_FILE"
    break
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 等待 PostgreSQL... ($i/15)" >> "$LOG_FILE"
  sleep 2
done

# ====== SSH 隧道（非阻塞，用于云端同步，失败不影响主流程） ======
TUNNEL_PID=$(pgrep -f "ssh.*-L 15432:localhost:5433" | head -1)
if [ -z "$TUNNEL_PID" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 建立 SSH 隧道到云端 PG（非阻塞）..." >> "$LOG_FILE"
  ssh -fN -L 15432:localhost:5433 \
    -o ServerAliveInterval=60 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 \
    ubuntu@101.35.250.154 2>>"$LOG_FILE" || \
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ SSH 隧道建立失败，云端同步暂不可用（不影响本地运行）" >> "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] SSH 隧道已存在 (PID: $TUNNEL_PID)" >> "$LOG_FILE"
fi

restart_count=0

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动 infohub backend (守护模式)..." >> "$LOG_FILE"

while [ $restart_count -lt $MAX_RESTARTS ]; do
  # 仅检查端口 3001，被占用时强制释放
  PORT_PID=$(lsof -ti :3001 2>/dev/null)
  if [ -n "$PORT_PID" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 端口 3001 被 PID=$PORT_PID 占用，强制释放..." >> "$LOG_FILE"
    kill -9 "$PORT_PID" 2>/dev/null
    sleep 2
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 启动进程 (第 $((restart_count + 1)) 次)..." >> "$LOG_FILE"
  
  # 前台运行，利用 shell 的信号处理机制
  $BUN run index.ts >> "$LOG_FILE" 2>&1
  exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 进程正常退出，不再重启" >> "$LOG_FILE"
    break
  fi

  restart_count=$((restart_count + 1))
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 进程崩溃 (exit=$exit_code)，${RESTART_DELAY}s 后重启..." >> "$LOG_FILE"
  
  # 等待端口释放后再重启
  for i in $(seq 1 5); do
    if lsof -ti :3001 >/dev/null 2>&1; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] 等待端口 3001 释放... ($i/5)" >> "$LOG_FILE"
      sleep 2
    else
      break
    fi
  done
  
  sleep $RESTART_DELAY
done
