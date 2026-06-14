#!/bin/bash
# pg-backup.sh — InfoHub PostgreSQL 自动备份脚本
# 每日凌晨 3:00 由 LaunchAgent 调用
# 策略：每日一份完整 dump，保留 7 天，每周日额外做一份周备份（保留 4 周）
# 恢复：pg_restore -d postgres://linhu:linhu50115@localhost:5432/linhu < backup.sql

set -euo pipefail

BACKUP_DIR="/Users/linhu/WorkBuddy/infohub-backups"
LOG_FILE="/tmp/infohub-backup.log"
DB_URL="postgres://linhu:linhu50115@localhost:5432/linhu"
PG_DUMP="/opt/homebrew/opt/postgresql@16/bin/pg_dump"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
DATE=$(date '+%Y%m%d')
DAY_OF_WEEK=$(date '+%u')  # 1=Monday, 7=Sunday

log() {
    echo "[$TIMESTAMP] $1" >> "$LOG_FILE"
}

# 创建备份目录
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

log "=== 开始 PostgreSQL 备份 ==="

# ====== 每日备份 ======
DAILY_FILE="$BACKUP_DIR/daily/infohub-$DATE.sql"
log "正在导出每日备份 → $DAILY_FILE"

# 先检查 PG 是否可用
if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    log "❌ PostgreSQL 不可用，跳过备份"
    exit 1
fi

"$PG_DUMP" "$DB_URL" --no-owner --no-privileges > "$DAILY_FILE" 2>> "$LOG_FILE"

DAILY_SIZE=$(du -h "$DAILY_FILE" | cut -f1)
log "✅ 每日备份完成: $DAILY_SIZE"

# ====== 周备份（每周日）======
if [ "$DAY_OF_WEEK" = "7" ]; then
    WEEKLY_FILE="$BACKUP_DIR/weekly/infohub-week-$DATE.sql"
    cp "$DAILY_FILE" "$WEEKLY_FILE"
    log "📦 周备份已创建: $WEEKLY_FILE"
fi

# ====== 清理旧备份 ======
# 清理每日备份：保留 7 天
find "$BACKUP_DIR/daily" -name "infohub-*.sql" -mtime +7 -delete 2>/dev/null
log "已清理 7 天前的每日备份"

# 清理周备份：保留 4 周
find "$BACKUP_DIR/weekly" -name "infohub-week-*.sql" -mtime +28 -delete 2>/dev/null
log "已清理 4 周前的周备份"

# ====== 统计 ======
DAILY_COUNT=$(find "$BACKUP_DIR/daily" -name "*.sql" | wc -l | tr -d ' ')
WEEKLY_COUNT=$(find "$BACKUP_DIR/weekly" -name "*.sql" | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log "📊 备份统计: 日备=$DAILY_COUNT 份, 周备=$WEEKLY_COUNT 份, 总计=$TOTAL_SIZE"
log "=== 备份完成 ==="
