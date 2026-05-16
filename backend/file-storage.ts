/**
 * 文件存储模块（兼容 re-export 入口）
 *
 * 职责已在以下子模块中拆分：
 * - storage/cos-storage.ts  → COS 上传、环境配置
 * - storage/image-processor.ts → 图片下载、缓存、URL 替换
 * - storage/ob-writer.ts   → OB Markdown 生成、文件写入、同步
 *
 * 此文件保留所有导出，确保现有 import 无需修改。
 * 新代码建议直接从具体子模块导入。
 */

export { getCosBaseUrl, invalidateCosCache, invalidateEnvCache } from './storage/cos-storage.js';
export { processImages, getImagesDir } from './storage/image-processor.js';
export {
  saveArticleFile,
  getArticleFilePath,
  hasArticleFile,
  hashString,
  getObDir,
  syncAllFiles,
} from './storage/ob-writer.js';
export type { ArticleMeta } from './storage/ob-writer.js';
