# 公众号采集自动化 — 执行记录

## 2026-06-11 00:55

**结果：** 部分成功（Token 配置已修复，WeFlow 服务不可用）

**执行摘要：**
1. 首次调用返回 `WeFlow Token 未配置` — wechat 信息源 (id=3) 的 config 为空
2. 通过 `PATCH /api/sources/3/config` 注入 `weflow_token` 和 `weflow_url`
3. 修复后重试，错误变为 `Unable to connect` — WeFlow 未运行且容器内 127.0.0.1:5031 无法访问宿主机

**关键发现：**
- wechat source config 不持久化 Token，Docker 容器环境变量也未生效
- WeFlow 必须在本机运行，且 Docker 需要能访问（需改用 host.docker.internal 或 host 网络模式）
- 建议：重启脚本执行后检查 wechat source config 是否包含 weflow_token

## 2026-06-12 00:55

**结果：** 失败 — WeFlow 服务不可用

**诊断摘要：**
- 后端运行在宿主机 (bun PID 21982, port 3001)，非 Docker 容器
- Token 配置正常 (weflow_token + weflow_url 均在 source config 中)
- 错误：`Unable to connect` — 端口 5031 无进程监听（WeFlow 未安装/未启动）
- wechat-service 容器 (port 8978) 仅为文章内容提取器，无 WeFlow 兼容 API
- WEFLOW_CACHE_PATH 文件不存在（`/weflow-cache/session-messages.json`）

**根本原因：** WeFlow 未安装于本机。公众号采集依赖 WeFlow 提供公众号会话和消息 API
- 需要安装并启动 WeFlow 在端口 5031
- 或提供包含 session-messages.json 的 WeFlow 缓存文件

## 2026-06-13 00:55

**结果：** 成功 ✅

**摘要：** API 返回 ok=true，共处理 204 篇，新增 4 篇，跳过 200 篇（已存在），0 错误。新增来源：张小珺商业访谈录、kate人不错、IT咖啡馆、小Lin说（各1篇）。WeFlow 连通性问题已解决。
