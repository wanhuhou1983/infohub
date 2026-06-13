# RSS 新闻采集 - 自动化执行记录

## 最近一次运行结果

- 时间: 2026-06-13 15:47 (自动化触发)
- 启用源数: 17 个
- API 响应: {"ok":true,"status":"started","totalSources":17}
- 状态: 已触发，后台并发抓取中
- 最新结果文件(14:48完成的那轮): 27篇入库 (IT之家13, 格隆汇5, 金十数据5, 财联社4)

## 上一轮结果(14:48完成)

- 时间: 2026-06-13 14:41 (自动化触发)
- 启用源数: 17 个
- 入库总数: 12 篇
- 成功入库源: IT之家(5), 格隆汇快讯(4), 金十数据(2), 财联社-电报(1)
- 0入库源(OK): 苔藓之火, 忽左忽右, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 下午时段12篇入库，IT之家5篇为主力，格隆汇4篇/金十2篇/财联社1篇，海外源超时/解析失败模式不变

## 历史运行结果

- 时间: 2026-06-13 12:40 (自动化触发)
- 启用源数: 17 个
- 入库总数: 18 篇
- 成功入库源: IT之家(7), 格隆汇快讯(5), 金十数据(3), 财联社-电报(3)
- 0入库源(OK): 苔藓之火, 忽左忽右, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 中午时段18篇入库，IT之家7篇(+较上轮12:32的10篇略降)，格隆汇/金十/财联社稳定，海外源超时/解析失败模式不变

## 端点修复记录

- `POST /api/scheduler/trigger-source-fetch/rss` 已改为非阻塞模式
- 现在立即返回 202 Accepted，后台并发抓取所有启用的 RSS 源
- 抓取结果写入 `/tmp/infohub-rss-last-result.json`
- 抓取逻辑改为 `Promise.allSettled` 并发，不再串行

## 最近一次运行结果

- 时间: 2026-06-13 04:19 (自动化触发)
- 启用源数: 17 个
- 入库总数: 10 篇
- 成功入库源: 格隆汇快讯(4), 金十数据(4), 财联社-电报(2)
- 0入库源(OK): Claude Code Releases, IT之家, 创业内幕 Startup Insider, 知行小酒馆, 苔藓之火, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, The New Quantum Era, Latent Space, Nathan Lambert, Hacker News 精选
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 凌晨4点时段仅10篇入库，格隆汇/金十/财联社少量更新，IT之家本次0篇，海外源超时/解析失败模式不变

- 时间: 2026-06-13 03:15 (自动化触发)
- 启用源数: 17 个
- 入库总数: 0 篇
- 0入库源(OK): 苔藓之火, 忽左忽右, 金十数据, 创业内幕 Startup Insider, 财联社-电报, 格隆汇快讯, 知行小酒馆, Claude Code Releases, IT之家
- 失败源(超时): GitHub Blog, Simon Willison, Latent Space, Hacker News 精选, Nathan Lambert, The New Quantum Era
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 凌晨3点时段0篇入库，所有国内源均无新内容(正常)，海外源超时/解析失败模式不变

- 时间: 2026-06-13 02:11 (自动化触发)
- 启用源数: 17 个
- 入库总数: 1 篇
- 成功入库源: IT之家(1)
- 0入库源(OK): 格隆汇快讯, Claude Code Releases, 财联社-电报, 苔藓之火, 创业内幕 Startup Insider, 知行小酒馆, 金十数据, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 凌晨时段入库仅1篇，国内源多数0入库(正常，凌晨少有新内容)，海外源持续超时/解析失败

- 时间: 2026-06-13 00:11 (自动化触发)
- 启用源数: 17 个
- 入库总数: 63 篇
- 成功入库源: 金十数据(21), 财联社-电报(16), 格隆汇快讯(15), IT之家(11)
- 0入库源(OK): 苔藓之火, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 与上次(00:05)结果一致63篇，国内源稳定，海外源持续超时/解析失败模式不变

## 前一次运行结果

- 时间: 2026-06-13 00:05 (自动化触发)
- 启用源数: 17 个
- 入库总数: 63 篇
- 成功入库源: 金十数据(21), 财联社-电报(16), 格隆汇快讯(15), IT之家(11)
- 0入库源(OK): 苔藓之火, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 国内源稳定(金十/财联社/格隆汇/IT之家)，海外源持续超时/解析失败模式不变

- 时间: 2026-06-12 23:02 (自动化触发)
- 启用源数: 17 个
- 入库总数: 65 篇
- 成功入库源: 金十数据(20), 财联社-电报(20), 格隆汇快讯(15), IT之家(10)
- 0入库源(OK): 苔藓之火, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 与上次(22:02)完全一致65篇，国内源稳定，海外源持续超时/解析失败

## 前一次运行结果

- 时间: 2026-06-12 22:02 (自动化触发)
- 启用源数: 17 个
- 入库总数: 65 篇
- 成功入库源: 金十数据(20), 财联社-电报(20), 格隆汇快讯(15), IT之家(10)
- 0入库源(OK): 苔藓之火, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: IT之家10篇正常波动，金十/财联社稳定20篇，海外源超时/解析失败模式不变；知行小酒馆本次无新文章(上次有1篇)

## 前一次运行结果

- 时间: 2026-06-12 20:52 (自动化触发)
- 启用源数: 17 个
- 入库总数: 66 篇
- 成功入库源: 金十数据(20), 财联社-电报(20), 格隆汇快讯(15), IT之家(9), 知行小酒馆(1), 忽左忽右(1)
- 0入库源(OK): 苔藓之火, Claude Code Releases, 创业内幕 Startup Insider
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: IT之家本次仅9篇(上次24篇波动较大)，金十/财联社稳定20篇，海外源超时/解析失败模式不变

## 前一次运行结果

- 时间: 2026-06-12 19:49 (自动化触发)
- 启用源数: 17 个
- 状态: 已触发 (非阻塞模式，后台并发抓取中)

- 时间: 2026-06-12 18:48 (自动化触发)
- 启用源数: 17 个
- 状态: 已触发 (非阻塞模式，后台并发抓取中)

- 时间: 2026-06-12 17:44 (自动化触发)
- 启用源数: 17 个
- 入库总数: 78 篇
- 成功入库源: IT之家(24), 金十数据(21), 财联社-电报(20), 格隆汇快讯(13)
- 0入库源(OK): 苔藓之火, 忽左忽右, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 本次入库较上次(86篇)略减，IT之家从31篇回落到24篇，金十数据稳定在20+篇

## 上一次运行结果

- 时间: 2026-06-12 15:49 (自动化触发)
- 启用源数: 17 个
- 入库总数: 86 篇
- 成功入库源: IT之家(31), 金十数据(20), 财联社-电报(20), 格隆汇快讯(15)
- 0入库源(OK): 苔藓之火, 忽左忽右, Claude Code Releases, 创业内幕 Startup Insider, 知行小酒馆
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: IT之家本次入库31篇(较之前6篇大幅增加)，海外源超时/解析失败模式与往次一致

- 时间: 2026-06-12 15:43 (自动化触发)
- 启用源数: 17 个
- 状态: 已触发 (非阻塞模式，结果写入 /tmp/infohub-rss-last-result.json)

## 自动化调用方式

```bash
# 触发（非阻塞，立即返回 202）
curl -s -X POST http://localhost:3001/api/scheduler/trigger-source-fetch/rss \
  -H "Content-Type: application/json" -d '{}'

# 等待结果文件写入（通常 3-5 分钟内）
sleep 300

# 读取结果
cat /tmp/infohub-rss-last-result.json
```

- 时间: 2026-06-13 07:29 (自动化触发)
- 启用源数: 17 个
- 入库总数: 9 篇
- 成功入库源: 格隆汇快讯(7), 财联社-电报(1), Claude Code Releases(1)
- 0入库源(OK): 金十数据, 忽左忽右, 苔藓之火, 知行小酒馆, 创业内幕 Startup Insider, IT之家
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, The New Quantum Era, Hacker News 精选, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 早上7点时段9篇入库，格隆汇7篇为主力，Claude Code Releases 1篇(罕见有新内容)，海外源超时/解析失败模式不变

- 时间: 2026-06-13 06:26 (自动化触发)
- 启用源数: 17 个
- 入库总数: 2 篇
- 成功入库源: 财联社-电报(2)
- 0入库源(OK): 格隆汇快讯, 金十数据, IT之家, 知行小酒馆, 创业内幕 Startup Insider, Claude Code Releases, 苔藓之火, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, The New Quantum Era, Latent Space, Nathan Lambert, Hacker News 精选
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 清晨6点时段仅2篇入库(财联社)，其余国内源均无新内容(正常)，海外源超时/解析失败模式不变

- 时间: 2026-06-13 08:35 (自动化触发)
- 启用源数: 17 个
- 入库总数: 19 篇
- 成功入库源: IT之家(8), 格隆汇快讯(4), 金十数据(4), 财联社-电报(3)
- 0入库源(OK): Claude Code Releases, 创业内幕 Startup Insider, 苔藓之火, 知行小酒馆, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, Hacker News 精选, The New Quantum Era, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 早8点段回升至19篇，IT之家恢复至8篇(凌晨多为0)，金十/格隆汇/财联社稳定，海外源超时/解析失败模式不变

- 时间: 2026-06-13 05:26 (自动化触发)
- 启用源数: 17 个
- 入库总数: 10 篇
- 成功入库源: 格隆汇快讯(4), 金十数据(4), 财联社-电报(2)
- 0入库源(OK): Claude Code Releases, IT之家, 创业内幕 Startup Insider, 知行小酒馆, 苔藓之火, 忽左忽右
- 失败源(超时): GitHub Blog, Simon Willison, The New Quantum Era, Latent Space, Nathan Lambert, Hacker News 精选
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 凌晨5点时段仅10篇入库，模式与04:19一致

- 时间: 2026-06-13 09:28 (自动化触发)
- 启用源数: 17 个
- 入库总数: 27 篇
- 成功入库源: IT之家(13), 格隆汇快讯(6), 金十数据(4), 财联社-电报(3), Claude Code Releases(1)
- 0入库源(OK): 创业内幕 Startup Insider, 忽左忽右, 知行小酒馆, 苔藓之火
- 失败源(超时): GitHub Blog, Simon Willison, Nathan Lambert, The New Quantum Era, Hacker News 精选, Latent Space
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 早9点段27篇入库，IT之家13篇为主力，格隆汇/金十/财联社稳定，Claude Code Releases 1篇，海外源超时/解析失败模式不变

- 时间: 2026-06-13 12:32 (自动化触发)
- 启用源数: 17 个
- 入库总数: 21 篇
- 成功入库源: IT之家(10), 格隆汇快讯(5), 财联社-电报(4), 金十数据(2)
- 0入库源(OK): 忽左忽右, 创业内幕 Startup Insider, 知行小酒馆, Claude Code Releases, 苔藓之火
- 失败源(超时): GitHub Blog, Simon Willison, Hacker News 精选, Nathan Lambert, Latent Space, The New Quantum Era
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: 中午时段21篇入库，IT之家10篇为主力，格隆汇/财联社/金十稳定输出，海外源超时/解析失败模式不变

- 时间: 2026-06-13 10:28 (自动化触发)
- 启用源数: 17 个
- 入库总数: 19 篇
- 成功入库源: IT之家(11), 财联社-电报(4), 格隆汇快讯(3), 金十数据(1)
- 0入库源(OK): 创业内幕 Startup Insider, 忽左忽右, 苔藓之火, 知行小酒馆, Claude Code Releases
- 失败源(超时): GitHub Blog, Simon Willison, Hacker News 精选, Latent Space, The New Quantum Era, Nathan Lambert
- 失败源(解析): Dwarkesh Podcast, The AI Daily Brief
- 备注: IT之家11篇(较上轮13篇略降)，金十数据仅1篇(上次4篇)，格隆汇3篇，财联社4篇，海外源超时/解析失败模式不变
