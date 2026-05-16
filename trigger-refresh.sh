#!/bin/bash
# trigger-refresh.sh - 触发所有 InfoHub 源更新
TOKEN="ZUzriy/apfeXjnX3z/qBU4PzCp4l8ffX6fwd+JfG8qg="
BASE="http://127.0.0.1:3001"
TS=$(date "+%Y-%m-%d %H:%M:%S")

echo "================================"
echo " InfoHub 全局刷新 - $TS"
echo "================================"

refresh_source() {
  local name=$1 method=$2 endpoint=$3 body=$4
  echo -n "[$name] "
  local resp
  resp=$(curl -s -X "$method" "$BASE$endpoint" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" 2>&1)
  echo "${resp:0:120}"
}

echo ""
echo "--- 抓取文章 ---"

refresh_source "xwlb" POST "/api/fetch/xwlb" "{}"
refresh_source "rss" POST "/api/fetch/rss" "{}"
refresh_source "wechat" POST "/api/fetch/wechat" "{}"
refresh_source "rmrb" POST "/api/fetch/rmrb" '{"full":true}'
refresh_source "tencent" POST "/api/fetch/tencent" '{"limit":10}'
refresh_source "penti" POST "/api/fetch/penti" "{}"

echo ""
echo "--- 其他源 ---"

refresh_source "youtube" POST "/api/youtube/refresh" "{}"
refresh_source "twitter" POST "/api/twitter/refresh" "{}"
refresh_source "podcast" POST "/api/podcast/sync" "{}"

echo ""
echo "--- 完成 ---"
date "+%Y-%m-%d %H:%M:%S"
