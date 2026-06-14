#!/bin/bash
# watchdog-all.sh — InfoHub 全服务健康检查看门狗
# 检查 PostgreSQL / Redis / RSSHub / Backend / bili-service
# 异常时自动通过 launchctl 重启对应服务
# 用法: 由 LaunchAgent 每 5 分钟调用

LOG_FILE="/tmp/infohub-watchdog.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

# ====== 1. PostgreSQL（brew 管理，理论上有 KeepAlive） ======
PG_READY=$(pg_isready -h localhost -p 5432 2>/dev/null | grep -c "accepting")
if [ "$PG_READY" -ne 1 ]; then
    log "⚠️ PostgreSQL 无响应，尝试重启..."
    brew services restart postgresql@16 >> "$LOG_FILE" 2>&1
    sleep 5
    PG_READY2=$(pg_isready -h localhost -p 5432 2>/dev/null | grep -c "accepting")
    if [ "$PG_READY2" -ne 1 ]; then
        log "❌ PostgreSQL 重启后仍无响应！需人工检查"
    else
        log "✅ PostgreSQL 重启成功"
    fi
fi

# ====== 2. Redis（brew 管理） ======
REDIS_PING=$(redis-cli ping 2>/dev/null)
if [ "$REDIS_PING" != "PONG" ]; then
    log "⚠️ Redis 无响应，尝试重启..."
    brew services restart redis >> "$LOG_FILE" 2>&1
    sleep 3
    REDIS_PING2=$(redis-cli ping 2>/dev/null)
    if [ "$REDIS_PING2" != "PONG" ]; then
        log "❌ Redis 重启后仍无响应！"
    else
        log "✅ Redis 重启成功"
    fi
fi

# ====== 3. RSSHub（端口 1200） ======
# RSSHub 设置了 ACCESS_KEY，未认证请求会返回 503（但服务本身正常运行）
# 只有关闭服务时端口才完全不通
RSSHUB_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:1200/healthz?access_key=linhu50115" 2>/dev/null)
if [ "$RSSHUB_CODE" != "200" ] && [ "$RSSHUB_CODE" != "204" ] && [ "$RSSHUB_CODE" != "503" ]; then
    log "⚠️ RSSHub 无响应(HTTP $RSSHUB_CODE)，尝试重启..."
    launchctl kickstart -k "gui/$(id -u)/com.infohub.rsshub" >> "$LOG_FILE" 2>&1
    sleep 5
    RSSHUB_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:1200/healthz?access_key=linhu50115" 2>/dev/null)
    if [ "$RSSHUB_CODE2" = "200" ] || [ "$RSSHUB_CODE2" = "204" ] || [ "$RSSHUB_CODE2" = "503" ]; then
        log "✅ RSSHub 重启成功"
    else
        log "❌ RSSHub 重启后仍无响应(HTTP $RSSHUB_CODE2)"
    fi
fi

# ====== 4. bili-service（端口 8978） ======
BILI_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:8978/health" 2>/dev/null)
if [ "$BILI_CODE" != "200" ]; then
    log "⚠️ bili-service 无响应(HTTP $BILI_CODE)，尝试重启..."
    launchctl kickstart -k "gui/$(id -u)/com.infohub.bili-service" >> "$LOG_FILE" 2>&1
    sleep 5
    BILI_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:8978/health" 2>/dev/null)
    if [ "$BILI_CODE2" = "200" ]; then
        log "✅ bili-service 重启成功"
    else
        log "❌ bili-service 重启后仍无响应(HTTP $BILI_CODE2)"
    fi
fi

# ====== 5. InfoHub Backend（端口 3001） ======
BACKEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:3001/api/sources" 2>/dev/null)
if [ "$BACKEND_CODE" != "200" ]; then
    log "⚠️ Backend 无响应(HTTP $BACKEND_CODE)，尝试重启..."
    launchctl kickstart -k "gui/$(id -u)/com.infohub.backend" >> "$LOG_FILE" 2>&1
    sleep 8
    BACKEND_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://localhost:3001/api/sources" 2>/dev/null)
    if [ "$BACKEND_CODE2" = "200" ]; then
        log "✅ Backend 重启成功"
    else
        log "❌ Backend 重启后仍无响应(HTTP $BACKEND_CODE2)，需人工检查"
    fi
fi

# 如果一切正常，只在整点记录一次
MINUTE=$(date '+%M')
if [ "$MINUTE" = "00" ]; then
    log "✅ 全部服务正常 (PG=$PG_READY, Redis=$REDIS_PING, RSSHub=$RSSHUB_CODE, bili=$BILI_CODE, backend=$BACKEND_CODE)"
fi
