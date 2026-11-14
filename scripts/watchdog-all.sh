#!/bin/bash
# watchdog-all.sh — InfoHub 全服务健康检查看门狗 v2
# 检查 PostgreSQL / Redis / RSSHub / Backend / bili-service / SSH隧道(云端同步)
# v2 修复:
#   1. pg_isready 用绝对路径 + 127.0.0.1（LaunchAgent 环境 localhost 解析不可靠）
#   2. 重启 brew 服务改用 launchctl kickstart（brew services 有 stop_timeout bug）
#   3. 新增 SSH 隧道(15432→云端PG)自愈：端口不通自动重建
#   4. 失败时记录原始输出便于诊断
# 用法: 由 LaunchAgent 每 5 分钟调用

LOG_FILE="/tmp/infohub-watchdog.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PG_BIN="/opt/homebrew/opt/postgresql@16/bin"
UID_N=$(id -u)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# ====== 1. PostgreSQL（brew 管理） ======
# 注意: 不能 grep 输出文本（中文 locale 下输出"接受连接"而非"accepting"）
# 必须用退出码判断: 0=接受连接 1=拒绝 2=无响应
"$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1
PG_READY=$?
if [ "$PG_READY" -ne 0 ]; then
    PG_OUT=$("$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 2>&1)
    log "⚠️ PostgreSQL 无响应 (raw: $PG_OUT)，尝试重启..."
    launchctl kickstart -k "gui/$UID_N/homebrew.mxcl.postgresql@16" >> "$LOG_FILE" 2>&1 &
    sleep 6
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p 5432 >/dev/null 2>&1
    PG_READY2=$?
    if [ "$PG_READY2" -ne 0 ]; then
        log "❌ PostgreSQL 重启后仍无响应！需人工检查"
    else
        log "✅ PostgreSQL 重启成功"
    fi
fi

# ====== 2. Redis（brew 管理） ======
REDIS_PING=$(redis-cli -h 127.0.0.1 ping 2>/dev/null)
if [ "$REDIS_PING" != "PONG" ]; then
    log "⚠️ Redis 无响应，尝试重启..."
    launchctl kickstart -k "gui/$UID_N/homebrew.mxcl.redis" >> "$LOG_FILE" 2>&1 &
    sleep 3
    REDIS_PING2=$(redis-cli -h 127.0.0.1 ping 2>/dev/null)
    if [ "$REDIS_PING2" != "PONG" ]; then
        log "❌ Redis 重启后仍无响应！"
    else
        log "✅ Redis 重启成功"
    fi
fi

# ====== 2.5 SSH 隧道（云端 PG 同步，本地 15432 → 云端 5433） ======
# 根因修复: 2026-08 隧道静默死亡后无人重建，导致云同步停摆 24 天
TUNNEL_OK=$(nc -z 127.0.0.1 15432 2>/dev/null && echo "yes" || echo "no")
if [ "$TUNNEL_OK" != "yes" ]; then
    log "⚠️ SSH 隧道(15432)不通，重建..."
    # 清掉可能存在的僵尸隧道进程
    pkill -f "ssh.*-L 15432:localhost:5433" 2>/dev/null
    sleep 1
    ssh -fN -L 15432:localhost:5433 \
        -o ServerAliveInterval=60 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=10 \
        -o BatchMode=yes \
        ubuntu@101.35.250.154 >> "$LOG_FILE" 2>&1
    sleep 3
    TUNNEL_OK2=$(nc -z 127.0.0.1 15432 2>/dev/null && echo "yes" || echo "no")
    if [ "$TUNNEL_OK2" = "yes" ]; then
        log "✅ SSH 隧道重建成功"
    else
        log "❌ SSH 隧道重建失败（云端服务器不可达或密钥问题）"
    fi
fi

# ====== 3. RSSHub（端口 1200） ======
# 兜底: launchd 注册失效时（node 版本目录变化导致），直接以独立会话拉起
RSSHUB_OK=$(nc -z 127.0.0.1 1200 2>/dev/null && echo yes || echo no)
if [ "$RSSHUB_OK" != "yes" ]; then
    log "⚠️ RSSHub 端口 1200 不通，尝试恢复..."
    launchctl kickstart -k "gui/$UID_N/com.infohub.rsshub" >> "$LOG_FILE" 2>&1
    sleep 5
    RSSHUB_OK2=$(nc -z 127.0.0.1 1200 2>/dev/null && echo yes || echo no)
    if [ "$RSSHUB_OK2" = "yes" ]; then
        log "✅ RSSHub 经 launchd 恢复成功"
    else
        # launchd 注册不可用时，直接启动（double-fork 脱离当前会话）
        NODE_BIN="/Users/linhu/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
        RSS_DIR="/Users/linhu/RSSHub"
        if [ -x "$NODE_BIN" ] && [ -f "$RSS_DIR/dist/index.mjs" ]; then
            cd "$RSS_DIR"
            python3 -c "
import os
node='$NODE_BIN'
env=dict(os.environ, NODE_ENV='production', NODE_OPTIONS='--max-http-header-size=32768')
pid=os.fork()
if pid==0:
    os.setsid()
    p2=os.fork()
    if p2==0:
        f=open('/tmp/rsshub-stdout.log','a'); e=open('/tmp/rsshub-stderr.log','a')
        os.dup2(f.fileno(),1); os.dup2(e.fileno(),2); os.dup2(os.open('/dev/null',os.O_RDONLY),0)
        os.execve(node,[node,'dist/index.mjs'],env)
    os._exit(0)
os.waitpid(pid,0)
"
            sleep 6
            RSSHUB_OK3=$(nc -z 127.0.0.1 1200 2>/dev/null && echo yes || echo no)
            if [ "$RSSHUB_OK3" = "yes" ]; then
                log "✅ RSSHub 已直接拉起（launchd 注册不可用）"
            else
                log "❌ RSSHub 恢复失败，需人工检查"
            fi
        else
            log "❌ RSSHub node 或 dist/index.mjs 缺失，需人工检查"
        fi
    fi
fi

# ====== 4. bili-service（端口 8978） ======
BILI_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:8978/health" 2>/dev/null)
if [ "$BILI_CODE" != "200" ]; then
    log "⚠️ bili-service 无响应(HTTP $BILI_CODE)，尝试重启..."
    launchctl kickstart -k "gui/$UID_N/com.infohub.bili-service" >> "$LOG_FILE" 2>&1 &
    sleep 5
    BILI_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:8978/health" 2>/dev/null)
    if [ "$BILI_CODE2" = "200" ]; then
        log "✅ bili-service 重启成功"
    else
        log "❌ bili-service 重启后仍无响应(HTTP $BILI_CODE2)"
    fi
fi

# ====== 5. InfoHub Backend（端口 3001） ======
BACKEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:3001/api/sources" 2>/dev/null)
if [ "$BACKEND_CODE" != "200" ]; then
    log "⚠️ Backend 无响应(HTTP $BACKEND_CODE)，尝试重启..."
    launchctl kickstart -k "gui/$UID_N/com.infohub.backend" >> "$LOG_FILE" 2>&1 &
    sleep 8
    BACKEND_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:3001/api/sources" 2>/dev/null)
    if [ "$BACKEND_CODE2" = "200" ]; then
        log "✅ Backend 重启成功"
    else
        log "❌ Backend 重启后仍无响应(HTTP $BACKEND_CODE2)，需人工检查"
    fi
fi

# 整点记录一次（仅正常时）
MINUTE=$(date '+%M')
if [ "$MINUTE" = "00" ]; then
    [ "$PG_READY" -eq 0 ] && PG_ST="ok" || PG_ST="fail"
    log "✅ 全部服务正常 (PG=$PG_ST, Redis=$REDIS_PING, tunnel=$TUNNEL_OK, RSSHub=$RSSHUB_OK, bili=$BILI_CODE, backend=$BACKEND_CODE)"
fi

# ======================================================================
# 6. 汇总健康状态 → 机读 JSON（供后台「系统监控」页面读取，不花 token）
#    结果写到 <项目>/data/health/（非 /tmp，重启不丢），含 24h 环形历史。
# ======================================================================
HEALTH_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/health"
mkdir -p "$HEALTH_DIR"

# 终端延迟探测（仅用于展示，不影响自愈判定）
RSSHUB_LATENCY=$(curl -s -o /dev/null -w "%{time_total}" --max-time 8 "http://127.0.0.1:1200/healthz?access_key=linhu50115" 2>/dev/null)
BILI_LATENCY=$(curl -s -o /dev/null -w "%{time_total}" --max-time 8 "http://127.0.0.1:8978/health" 2>/dev/null)
BACKEND_LATENCY=$(curl -s -o /dev/null -w "%{time_total}" --max-time 8 "http://127.0.0.1:3001/api/sources" 2>/dev/null)

# 导出状态给 python 装配 JSON
export WB_PG_OK=$([ "$PG_READY" -eq 0 ] && echo 1 || echo 0)
export WB_REDIS_OK=$([ "$REDIS_PING" = "PONG" ] && echo 1 || echo 0)
export WB_TUNNEL_OK=$([ "$TUNNEL_OK" = "yes" ] && echo 1 || echo 0)
export WB_RSSHUB_OK=$([ "$RSSHUB_CODE" = "200" ] || [ "$RSSHUB_CODE" = "204" ] || [ "$RSSHUB_CODE" = "503" ] && echo 1 || echo 0)
export WB_BILI_OK=$([ "$BILI_CODE" = "200" ] && echo 1 || echo 0)
export WB_BACKEND_OK=$([ "$BACKEND_CODE" = "200" ] && echo 1 || echo 0)
export WB_RSSHUB_CODE="$RSSHUB_CODE"; export WB_RSSHUB_LAT="$RSSHUB_LATENCY"
export WB_BILI_CODE="$BILI_CODE";     export WB_BILI_LAT="$BILI_LATENCY"
export WB_BACKEND_CODE="$BACKEND_CODE"; export WB_BACKEND_LAT="$BACKEND_LATENCY"
export WB_HEALTH_DIR="$HEALTH_DIR"
export WB_LOG_FILE="/tmp/infohub-watchdog.log"
export WB_BACKUP_DIR="/Users/linhu/WorkBuddy/infohub-backups"

/usr/bin/python3 - <<'PYEOF'
import os, json, time, datetime, subprocess, re, tempfile

health_dir = os.environ.get('WB_HEALTH_DIR', '')
status_file = os.path.join(health_dir, 'status.json')
history_file = os.path.join(health_dir, 'history.json')
now = datetime.datetime.now()
iso = now.strftime('%Y-%m-%d %H:%M:%S')

def b(v):
    return str(v) == '1'

services = [
    {"key": "pg", "name": "PostgreSQL", "ok": b(os.environ.get('WB_PG_OK')),
     "detail": "127.0.0.1:5432", "latency_ms": None},
    {"key": "redis", "name": "Redis", "ok": b(os.environ.get('WB_REDIS_OK')),
     "detail": "PONG" if b(os.environ.get('WB_REDIS_OK')) else "无响应", "latency_ms": None},
    {"key": "backend", "name": "InfoHub 后端", "ok": b(os.environ.get('WB_BACKEND_OK')),
     "detail": "HTTP " + str(os.environ.get('WB_BACKEND_CODE')),
     "latency_ms": float(os.environ['WB_BACKEND_LAT']) if os.environ.get('WB_BACKEND_LAT') else None},
    {"key": "rsshub", "name": "RSSHub", "ok": b(os.environ.get('WB_RSSHUB_OK')),
     "detail": "HTTP " + str(os.environ.get('WB_RSSHUB_CODE')),
     "latency_ms": float(os.environ['WB_RSSHUB_LAT']) if os.environ.get('WB_RSSHUB_LAT') else None},
    {"key": "bili", "name": "bili-service", "ok": b(os.environ.get('WB_BILI_OK')),
     "detail": "HTTP " + str(os.environ.get('WB_BILI_CODE')),
     "latency_ms": float(os.environ['WB_BILI_LAT']) if os.environ.get('WB_BILI_LAT') else None},
    {"key": "tunnel", "name": "SSH 隧道(云同步)", "ok": b(os.environ.get('WB_TUNNEL_OK')),
     "detail": "15432 通" if b(os.environ.get('WB_TUNNEL_OK')) else "15432 不通", "latency_ms": None},
]
overall = "ok" if all(s["ok"] for s in services) else "degraded"

system = {}
# 磁盘占用
try:
    out = subprocess.run(["df", "-k", "/"], capture_output=True, text=True, timeout=10).stdout.splitlines()
    if len(out) >= 2:
        system["disk_pct"] = int(out[-1].split()[4].replace('%', ''))
except Exception:
    pass
# 内存占用（vm_stat + sysctl hw.memsize，避免 top 的权限依赖）
try:
    phys = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10).stdout.strip())
    out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=10).stdout
    pagesize = 4096
    m = re.search(r'page size of (\d+) bytes', out)
    if m:
        pagesize = int(m.group(1))
    d = {}
    for line in out.splitlines():
        mm = re.match(r'\s*Pages\s+([\w\s]+?):\s*(\d+)\.', line)
        if not mm:
            continue
        d[mm.group(1).strip().lower().replace(' ', '_')] = int(mm.group(2))
    active = d.get('active', 0)
    wired = d.get('wired_down', d.get('wired', 0))
    compressed = d.get('occupied_by_compressor', d.get('compressed', 0))
    used_bytes = (active + wired + compressed) * pagesize
    system["mem_used_pct"] = round(used_bytes / phys * 100)
except Exception:
    pass
# 数据目录大小
try:
    project = os.path.dirname(os.path.dirname(health_dir))
    data_dir = os.path.join(project, 'data')
    if os.path.isdir(data_dir):
        o = subprocess.run(["du", "-sh", data_dir], capture_output=True, text=True, timeout=20).stdout
        system["data_size"] = o.split()[0]
except Exception:
    pass
# 最近备份
backup_dir = os.environ.get('WB_BACKUP_DIR', '')
if backup_dir and os.path.isdir(backup_dir):
    newest, nt = None, 0
    for root, dirs, files in os.walk(backup_dir):
        for f in files + dirs:
            p = os.path.join(root, f)
            try:
                t = os.path.getmtime(p)
                if t > nt:
                    nt, newest = t, p
            except Exception:
                pass
    if newest:
        system["last_backup"] = datetime.datetime.fromtimestamp(nt).strftime('%Y-%m-%d %H:%M')
        system["last_backup_age_h"] = round((time.time() - nt) / 3600)

# 异常事件（近 24h 的 ⚠️/❌/重启 行）
events = []
logf = os.environ.get('WB_LOG_FILE', '')
cutoff = time.time() - 24 * 3600
if logf and os.path.isfile(logf):
    try:
        with open(logf, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                m = re.match(r'\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]', line)
                if not m:
                    continue
                ts = m.group(1)
                try:
                    tt = time.mktime(datetime.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').timetuple())
                except Exception:
                    continue
                if tt < cutoff:
                    continue
                if '⚠️' in line or '❌' in line or '重启' in line:
                    level = 'error' if '❌' in line else ('warn' if ('⚠️' in line or '重启' in line) else 'info')
                    events.append({"time": ts, "level": level, "msg": line[m.end():].strip()})
    except Exception:
        pass

status = {
    "available": True,
    "updated_at": iso,
    "overall": overall,
    "services": services,
    "system": system,
    "events": events,
}

history = {"points": []}
if os.path.isfile(history_file):
    try:
        history = json.load(open(history_file, encoding='utf-8'))
    except Exception:
        history = {"points": []}
if "points" not in history:
    history["points"] = []
svc_map = {s["key"]: s["ok"] for s in services}
history["points"].append({"t": iso, "ok": overall == "ok", "services": svc_map})
if len(history["points"]) > 288:
    history["points"] = history["points"][-288:]

def atomic_write(path, data):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, suffix='.tmp')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

atomic_write(status_file, status)
atomic_write(history_file, history)
PYEOF
