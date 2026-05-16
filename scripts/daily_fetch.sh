#!/bin/bash
# ============================================================
# InfoHub 每日定时采集脚本（全板块）
# 
# 功能：依次采集全部 10 个信息来源（新闻联播、人民日报、
#        微信公众号、喷嚏图卦、RSS、B站、YouTube、Twitter/X），
#        通过后端 API 完成，自带深度核验。
# 不依赖 WorkBuddy，可独立运行（cron / launchd）。
#
# 覆盖板块（10 个）：新闻联播、人民日报、微信公众号、喷嚏图卦、
# RSS 订阅、B站 UP 主更新、B站稍后再看、B站收藏夹、YouTube、Twitter/X
#
# 用法：
#   bash scripts/daily_fetch.sh          # 采集今天
#   bash scripts/daily_fetch.sh --date 20260428  # 采集指定日期
# ============================================================

set -euo pipefail

# ===== 配置 =====
INFOHUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="$INFOHUB_DIR/backend"
LOG_DIR="$INFOHUB_DIR/data/logs"
API_BASE="http://localhost:3001"
BACKEND_PORT=3001
START_TIMEOUT=30        # 等待后端启动的最长秒数
SHUTDOWN_IF_STARTED=false # 如果由本脚本启动后端，采集完成后是否关闭（false=保持运行）

# 采集日期参数（可选）
TARGET_DATE=""
if [[ "${1:-}" == "--date" && -n "${2:-}" ]]; then
    TARGET_DATE="$2"
fi

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily_fetch_$(date +%Y%m%d_%H%M%S).log"

# ===== 日志函数 =====
log() {
    local level="$1"
    shift
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

log_info()  { log "INFO" "$@"; }
log_ok()    { log "OK  " "$@"; }
log_warn()  { log "WARN" "$@"; }
log_error() { log "ERR " "$@"; }

# ===== 后端生命周期管理 =====
BACKEND_STARTED_BY_US=false

ensure_backend_running() {
    # 检查后端是否已运行
    if curl -sf "$API_BASE/api/test" >/dev/null 2>&1; then
        log_info "后端已在运行 (pid=$(lsof -ti :$BACKEND_PORT 2>/dev/null || echo 'auto'))"
        BACKEND_STARTED_BY_US=false
        return 0
    fi

    log_info "后端未运行，正在启动..."
    BACKEND_STARTED_BY_US=true

    # 用 nohup 启动后端（nohup 可脱离终端运行）
    cd "$BACKEND_DIR"
    nohup bun run index.ts > "$LOG_DIR/backend.log" 2>&1 &
    local PID=$!
    disown "$PID" 2>/dev/null || true
    log_info "后端进程 PID=$PID"

    # 等待后端就绪
    local waited=0
    while [ $waited -lt $START_TIMEOUT ]; do
        if curl -sf "$API_BASE/api/test" >/dev/null 2>&1; then
            log_ok "后端就绪（等待 ${waited}s）"
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done

    log_error "后端启动超时（${START_TIMEOUT}s），放弃采集"
    return 1
}

shutdown_backend_if_needed() {
    if [ "$BACKEND_STARTED_BY_US" = true ] && [ "$SHUTDOWN_IF_STARTED" = true ]; then
        log_info "关闭由本脚本启动的后端..."
        local PID
        PID=$(lsof -ti :$BACKEND_PORT 2>/dev/null || true)
        if [ -n "$PID" ]; then
            kill "$PID" 2>/dev/null || true
            log_ok "后端已关闭 (PID=$PID)"
        fi
    fi
}

# ===== 采集函数 =====
RESULTS=()

# HTTP=000 表示连不上后端，需要重试
NEED_RETRY=false

call_api() {
    local source_name="$1"
    local endpoint="$2"
    local body="$3"
    local is_retry="${4:-false}"

    log_info "━━━ 开始采集：$source_name${is_retry:+"（重试）"}━━━"

    local start_ts
    start_ts=$(date +%s)

    # 构建 curl 命令
    local curl_cmd=(curl -sf --connect-timeout 10 -w "\n%{http_code}" -X POST "$API_BASE$endpoint")
    if [ -n "$body" ]; then
        curl_cmd+=(-H "Content-Type: application/json" -d "$body")
    fi

    # 执行（捕获 stdout+stderr）
    local output
    output=$("${curl_cmd[@]}" 2>&1 || true)
    local exit_code=$?

    local end_ts
    end_ts=$(date +%s)
    local duration=$((end_ts - start_ts))

    # 提取 HTTP 状态码（最后一行）
    local http_code
    http_code=$(echo "$output" | tail -1)
    local resp_body
    resp_body=$(echo "$output" | sed '$d')

    if [ "$exit_code" -eq 0 ] && [ "$http_code" = "200" ]; then
        log_ok "$source_name 采集成功（${duration}s）"
        log_info "  响应: $resp_body"
        # 深度核验
        local has_warn
        has_warn=$(verify_response "$source_name" "$resp_body" "$http_code")
        if [ "$has_warn" = "true" ]; then
            RESULTS+=("⚠️ $source_name 成功（${duration}s）但部分子源异常")
        else
            RESULTS+=("✅ $source_name 成功（${duration}s）")
        fi
        NEED_RETRY=false
    elif [ "$http_code" = "000" ] && [ "$is_retry" = "false" ]; then
        # 后端挂了：尝试重启后端，然后重试一次
        log_warn "$source_name 采集失败（HTTP=000），后端可能已崩溃，尝试重启..."
        NEED_RETRY=true
        RESULTS+=("❌ $source_name 失败（HTTP=000，即将重试）")
    else
        log_error "$source_name 采集失败（HTTP=$http_code, exit=$exit_code, ${duration}s）"
        log_info "  响应: $resp_body"
        RESULTS+=("❌ $source_name 失败（HTTP=$http_code）")
        NEED_RETRY=false
    fi

    echo "" | tee -a "$LOG_FILE"
}

# ===== 核验函数 =====

# 对成功的 API 响应做深度核验：检查 errors 字段、统计 fetched/inserted
# 返回 "true"（有警告）或 "false"（正常）
verify_response() {
    local source_name="$1" resp_body="$2" http_code="$3"
    [ "$http_code" != "200" ] || [ -z "$resp_body" ] && echo "false" && return

    local out
    out=$(echo "$resp_body" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin)
except:
    print('PARSE_ERR|')
    sys.exit(0)

f = d.get('fetched', 0) or 0
i = d.get('inserted', 0) or 0
t = d.get('translated', 0) or 0
a = d.get('accounts', 0) or 0
e = d.get('errors')

has_err = bool(e and isinstance(e, list) and len(e) > 0)

# 构建详情
parts = []
if f: parts.append(f'获取{f}条')
if i: parts.append(f'入库{i}条')
if t: parts.append(f'翻译{t}条')
if a: parts.append(f'{a}个账号')

if has_err:
    msg = '; '.join(str(x) for x in e[:3])
    if len(e) > 3: msg += f'...等{len(e)}个'
    parts.append(f'错误[{msg}]')
    print('WARN|' + '，'.join(parts))
elif parts:
    print('OK|' + '，'.join(parts))
else:
    print('OK|')
" 2>/dev/null || echo "PARSE_ERR|")

    local status="${out%%|*}"
    local detail="${out#*|}"
    [ -z "$detail" ] && echo "false" && return

    if [ "$status" = "WARN" ]; then
        log_warn "  [复核] $source_name → $detail"
        echo "true"
    elif [ "$status" = "PARSE_ERR" ]; then
        echo "false"
    else
        log_info "  [复核] $source_name → $detail"
        echo "false"
    fi
}

# ===== 主流程 =====
main() {
    log_info "========================================"
    log_info "InfoHub 每日采集开始"
    log_info "目标日期: ${TARGET_DATE:-$(date +%Y%m%d)}"
    log_info "日志文件: $LOG_FILE"
    log_info "========================================"
    echo "" | tee -a "$LOG_FILE"

    # 1. 确保后端运行
    if ! ensure_backend_running; then
        shutdown_backend_if_needed
        log_error "后端不可用，采集终止"
        exit 1
    fi

    # 重试辅助：当 NEED_RETRY=true 时重启后端并重新调用
    retry_if_failed() {
        local name="$1" endpoint="$2" body="$3"
        if [ "$NEED_RETRY" = true ]; then
            log_info "后端已崩溃，尝试自启动..."
            sleep 1
            if ensure_backend_running; then
                sleep 2  # 等后端完全就绪
                call_api "$name" "$endpoint" "$body" true
            fi
        fi
    }

    # 2. 依次采集各来源

    # 新闻联播
    if [ -n "$TARGET_DATE" ]; then
        call_api "新闻联播" "/api/fetch/xwlb" "{\"date\":\"$TARGET_DATE\"}"
        retry_if_failed "新闻联播" "/api/fetch/xwlb" "{\"date\":\"$TARGET_DATE\"}"
    else
        call_api "新闻联播" "/api/fetch/xwlb" "{}"
        retry_if_failed "新闻联播" "/api/fetch/xwlb" "{}"
    fi

    # 人民日报
    if [ -n "$TARGET_DATE" ]; then
        # rmrb 接口接收的 date 格式为 YYYY-MM-DD
        local rmrb_date="${TARGET_DATE:0:4}-${TARGET_DATE:4:2}-${TARGET_DATE:6:2}"
        call_api "人民日报" "/api/fetch/rmrb" "{\"date\":\"$rmrb_date\",\"full\":true}"
        retry_if_failed "人民日报" "/api/fetch/rmrb" "{\"date\":\"$rmrb_date\",\"full\":true}"
    else
        call_api "人民日报" "/api/fetch/rmrb" "{}"
        retry_if_failed "人民日报" "/api/fetch/rmrb" "{}"
    fi

    # 腾讯新闻（已关闭，意义不大）
    # call_api "腾讯新闻" "/api/fetch/tencent" '{"limit":15}'

    # 微信公众号
    call_api "微信公众号" "/api/fetch/wechat" "{}"
    retry_if_failed "微信公众号" "/api/fetch/wechat" "{}"

    # 喷嚏图卦
    if [ -n "$TARGET_DATE" ]; then
        call_api "喷嚏图卦" "/api/fetch/penti" "{\"date\":\"$TARGET_DATE\"}"
        retry_if_failed "喷嚏图卦" "/api/fetch/penti" "{\"date\":\"$TARGET_DATE\"}"
    else
        call_api "喷嚏图卦" "/api/fetch/penti" "{}"
        retry_if_failed "喷嚏图卦" "/api/fetch/penti" "{}"
    fi

    # ────────── 以下为新增板块 ──────────

    # RSS 订阅
    call_api "RSS 订阅" "/api/fetch/rss" "{}"
    retry_if_failed "RSS 订阅" "/api/fetch/rss" "{}"

    # B站 UP 主更新
    call_api "B站 UP 主更新" "/api/bilibili-admin/refresh" ""
    retry_if_failed "B站 UP 主更新" "/api/bilibili-admin/refresh" ""

    # B站稍后再看
    call_api "B站稍后再看" "/api/bilibili-admin/refresh-watch-later" ""
    retry_if_failed "B站稍后再看" "/api/bilibili-admin/refresh-watch-later" ""

    # B站收藏夹
    call_api "B站收藏夹" "/api/bilibili-admin/refresh-favorites" ""
    retry_if_failed "B站收藏夹" "/api/bilibili-admin/refresh-favorites" ""

    # YouTube
    call_api "YouTube" "/api/youtube-admin/refresh" ""
    retry_if_failed "YouTube" "/api/youtube-admin/refresh" ""

    # Twitter/X
    call_api "Twitter/X" "/api/twitter-admin/refresh" ""
    retry_if_failed "Twitter/X" "/api/twitter-admin/refresh" ""

    # 3. 关闭后端（如果由本脚本启动）
    shutdown_backend_if_needed

    # 4. 输出汇总
    echo "" | tee -a "$LOG_FILE"
    log_info "========================================"
    log_info "采集汇总"
    local ok_count=0 warn_count=0 fail_count=0
    for r in "${RESULTS[@]}"; do
        log_info "  $r"
        if [[ "$r" == ✅* ]]; then
            ok_count=$((ok_count + 1))
        elif [[ "$r" == ⚠️* ]]; then
            warn_count=$((warn_count + 1))
        elif [[ "$r" == ❌* ]]; then
            fail_count=$((fail_count + 1))
        fi
    done
    log_info "----------------------------------------"
    log_info "统计：共 $((ok_count + warn_count + fail_count)) 个板块，$ok_count 个成功，$warn_count 个警告，$fail_count 个失败"
    log_info "========================================"
    log_info "日志文件: $LOG_FILE"

    # 判断是否有失败
    local has_fail=false
    for r in "${RESULTS[@]}"; do
        if [[ "$r" == ❌* ]]; then
            has_fail=true
            break
        fi
    done

    if [ "$has_fail" = true ]; then
        log_warn "部分采集失败，请查看日志"
        exit 1
    else
        log_ok "全部采集成功 ✅"
    fi
}

# ===== 执行入口 =====
# 捕获退出信号确保清理
trap shutdown_backend_if_needed EXIT INT TERM

main
