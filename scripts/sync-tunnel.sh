#!/bin/bash
# sync-tunnel.sh — 管理本地到云端 PG 的 SSH 隧道
#
# 用法:
#   ./scripts/sync-tunnel.sh start    # 启动隧道（后台）
#   ./scripts/sync-tunnel.sh stop     # 停止隧道
#   ./scripts/sync-tunnel.sh status   # 查看状态
#   ./scripts/sync-tunnel.sh sync     # 启动隧道 + 执行增量同步
#   ./scripts/sync-tunnel.sh sync-full # 启动隧道 + 全量同步

set -euo pipefail

SSH_HOST="ubuntu@101.35.250.154"
LOCAL_PORT=15432
REMOTE_HOST="localhost"
REMOTE_PORT=5433
PID_FILE="/tmp/sync-tunnel.pid"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

start_tunnel() {
    if status_tunnel 2>/dev/null; then
        echo -e "${YELLOW}隧道已在运行 (PID: $(cat $PID_FILE))${NC}"
        return 0
    fi

    echo -n "建立 SSH 隧道 localhost:$LOCAL_PORT → $SSH_HOST:$REMOTE_PORT ... "
    ssh -fN -L ${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT} \
        -o ServerAliveInterval=60 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no \
        $SSH_HOST

    sleep 1
    if status_tunnel 2>/dev/null; then
        PID=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}" | head -1)
        echo "$PID" > "$PID_FILE"
        echo -e "${GREEN}✓ 隧道已建立 (PID: $PID)${NC}"
    else
        echo -e "${RED}✗ 隧道建立失败，请检查 SSH 连接${NC}"
        return 1
    fi
}

stop_tunnel() {
    if ! status_tunnel 2>/dev/null; then
        echo -e "${YELLOW}隧道未在运行${NC}"
        rm -f "$PID_FILE"
        return 0
    fi

    PID=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}" | head -1)
    if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null || true
        echo -e "${GREEN}✓ 隧道已停止 (PID: $PID)${NC}"
    fi
    rm -f "$PID_FILE"
}

status_tunnel() {
    PID=$(pgrep -f "ssh.*-L ${LOCAL_PORT}:${REMOTE_HOST}:${REMOTE_PORT}" | head -1)
    if [ -n "$PID" ]; then
        echo -e "${GREEN}隧道运行中 (PID: $PID)${NC}"
        echo "  localhost:$LOCAL_PORT → $SSH_HOST:$REMOTE_PORT"
        return 0
    else
        echo -e "${RED}隧道未运行${NC}"
        return 1
    fi
}

do_sync() {
    local mode="${1:-incr}"
    local sync_args=""
    if [ "$mode" = "full" ]; then
        sync_args="--full"
    fi

    echo "--- 开始 PG 同步 ($mode) ---"
    cd "$PROJECT_DIR/backend"
    bun run "$PROJECT_DIR/scripts/sync-pg-to-cloud.ts" $sync_args
}

case "${1:-}" in
    start)
        start_tunnel
        ;;
    stop)
        stop_tunnel
        ;;
    status)
        status_tunnel
        ;;
    restart)
        stop_tunnel
        sleep 1
        start_tunnel
        ;;
    sync)
        start_tunnel && do_sync incr
        ;;
    sync-full)
        start_tunnel && do_sync full
        ;;
    *)
        echo "用法: $0 {start|stop|status|restart|sync|sync-full}"
        echo ""
        echo "  start      启动 SSH 隧道"
        echo "  stop       停止 SSH 隧道"
        echo "  status     查看隧道状态"
        echo "  restart    重启隧道"
        echo "  sync       启动隧道 + 增量同步（默认）"
        echo "  sync-full  启动隧道 + 全量同步"
        exit 1
        ;;
esac
