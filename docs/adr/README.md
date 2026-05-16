# 架构决策记录 (ADR)

本目录记录 InfoHub 项目中的重要架构决策。每个 ADR 独立成文，记录「背景 → 选项 → 决策 → 理由 → 后果」的完整链。

## 格式

```
# ADR-N: 标题
状态: [Proposed|Accepted|Deprecated|Superseded]
日期: YYYY-MM-DD
```

## 索引

| 编号 | 标题 | 状态 | 日期 |
|------|------|------|------|
| 001 | [ORM 选型：弃用 Drizzle ORM，使用裸 SQL (postgres.js)](001-orm-选型裸sql.md) | Accepted | 2026-04-23 |
| 002 | [图片存储：本地缓存 + 腾讯云 COS 双写](002-图片存储本地cos双写.md) | Accepted | 2026-04-29 |
| 003 | [前端技术选型：纯 HTML + Tailwind](003-前端技术选型纯html-tailwind.md) | Accepted | 2026-04-22 |
| 004 | [测试策略：bun test + 纯函数导出 + mock.module](004-测试策略bun-test纯函数导出.md) | Accepted | 2026-05-03 |
| 005 | [数据采集架构：去中间件化的多源直连](005-数据采集架构多源直连.md) | Accepted | 2026-04-25 |

## 阅读建议

- **新成员/新贡献者**：从 ADR-003（前端）→ ADR-001（后端）→ ADR-005（采集）顺序阅读
- **关注质量**：阅读 ADR-004（测试策略）
- **关注运维**：阅读 ADR-002（图片存储）和 ADR-005（采集）
