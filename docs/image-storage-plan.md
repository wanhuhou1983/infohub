# 腾讯云 COS 图床集成方案

> 文档版本：v1.0  
> 创建日期：2026-04-29  
> 决策记录：将图片存储从纯本地存储升级为「本地存储 + 腾讯云 COS 双写」，OB Markdown 使用 COS 绝对 URL

---

## 背景

原方案（v3）将图片下载到 `data/images/{source}/{hash}.{ext}`，Markdown 中使用 `/api/images/` 相对路径。该方案工作时没问题，但在 **Obsidian 阅读视图**中无法渲染图片（因为相对路径仅在后端 /api/images/ 路由下有效）。

OB 仓库需要**可公开访问的绝对 URL**才能在阅读视图中显示图片。

## 决策

将腾讯云 COS（对象存储）作为正式图床，流程改为：

1. 采集时下载远程图片
2. **同时**保存到本地 `data/images/`（供后端 /api/images/ 路由回退使用）
3. **同时**上传到腾讯云 COS
4. OB Markdown 中使用 COS 绝对 URL（`https://wanhuhou-1300445858.cos.ap-shanghai.myqcloud.com/...`）
5. 若 COS 上传失败，fallback 到 `/api/images/` 相对路径

## 配置

### COS 凭据

文件：`~/.cos/cos.conf`

```ini
[common]
secret_id = <从 ~/.cos/cos.conf 或 .env.json 中读取>
secret_key = <从 ~/.cos/cos.conf 或 .env.json 中读取>
bucket = wanhuhou-1300445858
region = ap-shanghai
```

### 代码配置

通过 `.env.json` 或环境变量注入 COS 配置：

```json
{
  "COS_SECRET_ID": "xxxx",
  "COS_SECRET_KEY": "xxxx",
  "COS_BUCKET": "wanhuhou-1300445858",
  "COS_REGION": "ap-shanghai"
}
```

若 `.env.json` 中未配置，回退读取 `~/.cos/cos.conf`。
若两者都不可用，则**仅执行本地存储**，不做 COS 上传。

## URL 格式

| 存储位置 | URL 格式 |
|----------|----------|
| 腾讯云 COS | `https://wanhuhou-1300445858.cos.ap-shanghai.myqcloud.com/images/{source}/{hash}.{ext}` |
| 本地存储 | `/api/images/{source}/{hash}.{ext}`（fallback） |
| OB Markdown | 优先使用 COS URL；上传失败用本地 URL |

## 实现变更

### 需要修改的文件

| 文件 | 变更 |
|------|------|
| `backend/file-storage.ts` | 新增 `uploadToCOS()` 函数；修改 `downloadAndSaveImage()` 返回 COS URL |
| `backend/package.json` | 新增依赖 `cos-nodejs-sdk-v5` |
| 前端 | 无需修改（图片 URL 来自后端返回的 processedContent） |

### 关键逻辑

```ts
async function downloadAndSaveImage(url, sourceType): Promise<string> {
  // 1. 下载图片 → buffer
  // 2. 计算 MD5，保存到 data/images/{source}/{hash}.{ext}
  // 3. 尝试上传到 COS
  //    - 成功 → 返回 COS URL
  //    - 失败 → 返回 /api/images/ 相对路径（fallback）
}
```

### 图片去重

- MD5 去重：相同内容的同一远程 URL 不会重复上传
- 缓存文件 `data/.img_cache.json` 保持不变
- COS 上传前检查路径是否已存在（可通过 COS HEAD 请求），避免重复上传

## 历史数据修复

已有 `data/images/` 中存储的图片和 OB 中的 `/api/images/` 相对路径，可通过一个迁移脚本统一补传到 COS：

1. 遍历 `data/images/` 下所有文件
2. 上传到 COS 对应路径
3. 更新 `data/.img_cache.json` 和 OB 中的 Markdown URL

此步骤作为后续任务单独执行，不纳入本次提交。

## 回滚方案

- COS 上传出错时自动 fallback 到本地 `/api/images/` 路径
- 本地存储始终作为完备备份
- 切换回纯本地模式只需清除 COS 配置
