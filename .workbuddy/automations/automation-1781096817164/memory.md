# 播客采集 - 执行历史

## 2026-06-13 01:55

- **触发方式**: 手动触发（用户 curl 调用）
- **后端状态**: 正常运行 (localhost:3001)
- **结果**: 4 个频道全部获取失败（连续第三天）
- **问题**: 同样 `Unable to connect. Is the computer able to access the url?`，服务器网络环境持续无法访问外部 RSS 源

## 2026-06-12 01:55

- **触发方式**: 自动化定时任务 (每日 02:00)
- **后端状态**: 正常运行 (localhost:3001)
- **结果**: 4 个频道全部获取失败，网络无法连接外部源（连续第二天）
- **频道列表**:
  - 创业内幕 Startup Insider
  - 苔藓之火
  - 知行小酒馆
  - 忽左忽右
- **问题**: 所有频道报 `Unable to connect. Is the computer able to access the url?`，与 06-11 相同，疑为服务器网络环境无法访问外部 RSS 源

## 2026-06-11 01:55

- **触发方式**: 自动化定时任务 (每日 02:00)
- **后端状态**: 正常运行 (localhost:3001)
- **结果**: 4 个频道全部获取失败，网络无法连接外部源
- **频道列表**:
  - 创业内幕 Startup Insider
  - 苔藓之火
  - 知行小酒馆
  - 忽左忽右
- **问题**: 所有频道报 `Unable to connect. Is the computer able to access the url?`，可能原因: 服务器所在网络环境无法访问外部 RSS 源/播客平台
