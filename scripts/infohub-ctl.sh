#!/bin/bash
# infohub-ctl.sh — InfoHub 统一服务管理脚本
# 用法: infohub-ctl.sh [start|stop|status|restart|logs|backup|doctor]
#
# 管理以下服务（通过 macOS LaunchAgent）:
#   1. PostgreSQL 16  (brew)
#   2. Redis          (brew)
#   3. RSSHub         (port 1200)
#   4. bili-service   (port 8978)
#   5. InfoHub Backend(port 3001)
#   6. Watchdog       (每 5 分钟健康检查)
#   7. Backup         (每日凌晨 3 点)

set -euo pipefail

UID_NUM=$(id -u)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# LaunchAgent labels
LA_BACKEND="com.infohub.backend"
LA_RSSHUB="com.infohub.rsshub"
LA_BILI="com.infohub.bili-service"
LA_WATCHDOG="com.infohub.watchdog"
LA_BACKUP="com.infohub.backup"

PLIST_DIR="$HOME/Library/LaunchAgents"
SCRIPTS_DIR="/Users/linhu/WorkBuddy/2026-06-09-21-34-58/infohub/scripts"

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
info() { echo -e "${CYAN}ℹ️  $1${NC}"; }

# 检查端口健康
check_port() {
    local port=$1
    local path=${2:-"/"}
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port$path" 2>/dev/null || echo "000")
    if [ "$code" = "000" ]; then
        echo "DOWN"
    elif [ "$code" = "200" ] || [ "$code" = "204" ] || [ "$code" = "404" ]; then
        echo "OK"
    elif [ "$code" = "503" ]; then
        # 503 可能是 RSSHub 的 ACCESS_KEY 认证拒绝，说明服务本身在运行
        echo "OK"
    else
        echo "HTTP-$code"
    fi
}

check_pg() {
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && echo "OK" || echo "DOWN"
}

check_redis() {
    [ "$(redis-cli ping 2>/dev/null)" = "PONG" ] && echo "OK" || echo "DOWN"
}

get_launchctl_pid() {
    local label=$1
    launchctl list "$label" 2>/dev/null | grep -E "^\s*PID" | awk '{print $3}' || echo "-"
}

# ====== load plist ======
load_plist() {
    local label=$1
    local plist="$PLIST_DIR/$label.plist"
    if [ ! -f "$plist" ]; then
        fail "plist 不存在: $plist"
        return 1
    fi
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist" 2>/dev/null
    if [ $? -eq 0 ]; then
        ok "已加载 $label"
    else
        fail "加载失败 $label"
    fi
}

unload_plist() {
    local label=$1
    local plist="$PLIST_DIR/$label.plist"
    launchctl unload "$plist" 2>/dev/null || true
    ok "已停止 $label"
}

# ====== 命令实现 ======

cmd_start() {
    echo -e "${CYAN}═══ 启动 InfoHub 全部服务 ═══${NC}"
    # brew 服务
    brew services start postgresql@16 >/dev/null 2>&1 || true
    brew services start redis >/dev/null 2>&1 || true
    ok "PostgreSQL + Redis 已启动"

    # LaunchAgent 服务（按依赖顺序）
    load_plist "$LA_RSSHUB"
    sleep 3
    load_plist "$LA_BILI"
    sleep 2
    load_plist "$LA_BACKEND"
    sleep 2
    load_plist "$LA_WATCHDOG"
    load_plist "$LA_BACKUP"

    echo ""
    sleep 5
    cmd_status
}

cmd_stop() {
    echo -e "${CYAN}═══ 停止 InfoHub 全部服务 ═══${NC}"
    unload_plist "$LA_WATCHDOG"
    unload_plist "$LA_BACKUP"
    unload_plist "$LA_BACKEND"
    unload_plist "$LA_BILI"
    unload_plist "$LA_RSSHUB"
    echo ""
    ok "全部服务已停止（PostgreSQL/Redis 保留运行，brew 管理）"
    info "如需停止 PG/Redis: brew services stop postgresql@16 && brew services stop redis"
}

cmd_restart() {
    echo -e "${CYAN}═══ 重启 InfoHub 服务 ═══${NC}"
    cmd_stop
    sleep 3
    cmd_start
}

cmd_status() {
    echo -e "${CYAN}═══ InfoHub 服务状态 ═══${NC}"
    echo ""

    # PostgreSQL
    local pg=$(check_pg)
    local pg_pid=$(pgrep -f "postgres.*-D" | head -1)
    if [ "$pg" = "OK" ]; then
        ok "PostgreSQL 16     (5432)  PID=$pg_pid"
    else
        fail "PostgreSQL 16     (5432)  DOWN"
    fi

    # Redis
    local rd=$(check_redis)
    local rd_pid=$(pgrep -f "redis-server" | head -1)
    if [ "$rd" = "OK" ]; then
        ok "Redis             (6379)  PID=$rd_pid"
    else
        fail "Redis             (6379)  DOWN"
    fi

    # RSSHub
    local rh=$(check_port 1200 "/healthz?access_key=linhu50115")
    local rh_pid=$(get_launchctl_pid "$LA_RSSHUB")
    if [ "$rh" = "OK" ]; then
        ok "RSSHub            (1200)  PID=$rh_pid"
    else
        fail "RSSHub            (1200)  $rh"
    fi

    # bili-service
    local bs=$(check_port 8978 "/health")
    local bs_pid=$(get_launchctl_pid "$LA_BILI")
    if [ "$bs" = "OK" ]; then
        ok "bili-service      (8978)  PID=$bs_pid"
    else
        fail "bili-service      (8978)  $bs"
    fi

    # Backend
    local bk=$(check_port 3001 "/api/sources")
    local bk_pid=$(get_launchctl_pid "$LA_BACKEND")
    if [ "$bk" = "OK" ]; then
        ok "InfoHub Backend   (3001)  PID=$bk_pid"
    else
        fail "InfoHub Backend   (3001)  $bk"
    fi

    # Watchdog
    if launchctl list "$LA_WATCHDOG" >/dev/null 2>&1; then
        ok "Watchdog          (5min)  Active"
    else
        warn "Watchdog          (5min)  Inactive"
    fi

    # Backup
    local bp_pid=$(get_launchctl_pid "$LA_BACKUP")
    if [ "$bp_pid" != "-" ] || launchctl list "$LA_BACKUP" >/dev/null 2>&1; then
        ok "Backup            (3 AM)  Scheduled"
    else
        warn "Backup            (3 AM)  Not scheduled"
    fi

    echo ""
    # 备份文件检查
    local backup_dir="/Users/linhu/WorkBuddy/infohub-backups"
    if [ -d "$backup_dir/daily" ]; then
        local latest=$(ls -t "$backup_dir/daily/"*.sql 2>/dev/null | head -1)
        if [ -n "$latest" ]; then
            local fname=$(basename "$latest")
            local fdate=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M" "$latest")
            local fsize=$(du -h "$latest" | cut -f1)
            info "最新备份: $fname ($fsize, $fdate)"
        fi
    else
        warn "尚无备份文件（首次备份将在凌晨 3 点自动执行）"
    fi
}

cmd_logs() {
    local svc=${1:-backend}
    case "$svc" in
        backend|b)
            tail -100 /tmp/infohub.log 2>/dev/null || echo "无日志"
            ;;
        rsshub|r)
            tail -100 /tmp/rsshub-stdout.log 2>/dev/null || echo "无日志"
            ;;
        bili|bili-service|bs)
            tail -100 /tmp/bili-service-stdout.log 2>/dev/null || echo "无日志"
            ;;
        watchdog|wd)
            tail -100 /tmp/infohub-watchdog.log 2>/dev/null || echo "无日志"
            ;;
        backup|bak)
            tail -100 /tmp/infohub-backup.log 2>/dev/null || echo "无日志"
            ;;
        *)
            echo "用法: infohub-ctl.sh logs [backend|rsshub|bili|watchdog|backup]"
            ;;
    esac
}

cmd_backup() {
    info "手动执行 PostgreSQL 备份..."
    bash "$SCRIPTS_DIR/pg-backup.sh"
}

cmd_doctor() {
    echo -e "${CYAN}═══ InfoHub 诊断检查 ═══${NC}"
    echo ""

    # 1. 检查 plist 文件
    info "1. 检查 LaunchAgent plist 文件..."
    for plist in "$LA_BACKEND" "$LA_RSSHUB" "$LA_BILI" "$LA_WATCHDOG" "$LA_BACKUP"; do
        if [ -f "$PLIST_DIR/$plist.plist" ]; then
            ok "  $plist.plist 存在"
        else
            fail "  $plist.plist 缺失！"
        fi
    done

    # 2. 检查脚本可执行
    echo ""
    info "2. 检查脚本可执行权限..."
    for script in "start-backend.sh" "scripts/watchdog-all.sh" "scripts/pg-backup.sh"; do
        local path="/Users/linhu/WorkBuddy/2026-06-09-21-34-58/infohub/$script"
        if [ -x "$path" ]; then
            ok "  $script 可执行"
        else
            fail "  $script 不可执行"
        fi
    done

    # 3. 检查关键路径
    echo ""
    info "3. 检查关键路径..."
    if [ -f "/Users/linhu/.bun/bin/bun" ]; then
        ok "  bun 存在"
    else
        fail "  bun 不存在于 ~/.bun/bin/bun"
    fi
    local chrome="/Users/linhu/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    if [ -f "$chrome" ]; then
        ok "  Chromium 1223 存在"
    else
        fail "  Chromium 1223 缺失"
    fi
    if [ -d "/Users/linhu/RSSHub" ]; then
        ok "  RSSHub 目录存在"
    else
        fail "  RSSHub 目录缺失"
    fi

    # 4. 检查数据库连接
    echo ""
    info "4. 检查数据库..."
    local article_count=$(psql -h localhost -U linhu -d linhu -t -c "SELECT count(*) FROM articles;" 2>/dev/null | tr -d ' ')
    local source_count=$(psql -h localhost -U linhu -d linhu -t -c "SELECT count(*) FROM sources;" 2>/dev/null | tr -d ' ')
    if [ -n "$article_count" ]; then
        ok "  数据库可连接: $source_count 个源, $article_count 篇文章"
    else
        fail "  数据库连接失败"
    fi

    # 5. 检查备份
    echo ""
    info "5. 检查备份..."
    local backup_dir="/Users/linhu/WorkBuddy/infohub-backups"
    if [ -d "$backup_dir/daily" ]; then
        local count=$(find "$backup_dir/daily" -name "*.sql" | wc -l | tr -d ' ')
        ok "  备份目录存在: $count 份日备"
    else
        warn "  备份目录尚未创建（将在首次备份时自动创建）"
    fi

    echo ""
    ok "诊断完成"
}

# ====== 主入口 ======

case "${1:-}" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs "${2:-}"
        ;;
    backup)
        cmd_backup
        ;;
    doctor)
        cmd_doctor
        ;;
    *)
        echo "InfoHub 统一服务管理器"
        echo ""
        echo "用法: $0 <command> [options]"
        echo ""
        echo "命令:"
        echo "  start     启动全部 InfoHub 服务"
        echo "  stop      停止全部 InfoHub 服务"
        echo "  restart   重启全部服务"
        echo "  status    查看所有服务状态"
        echo "  logs [s]  查看日志 (backend|rsshub|bili|watchdog|backup)"
        echo "  backup    手动执行一次数据库备份"
        echo "  doctor    运行诊断检查"
        echo ""
        echo "当前状态:"
        cmd_status
        ;;
esac
