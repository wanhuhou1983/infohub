# 工作日志 2026-05-01

## 一、B站/YouTube OB子目录细分 + 前端布局优化
- file-storage.ts：bilibili → 哔哩哩哔/{更新,稍后再看,收藏}，youtube → YouTube/{更新,稍后再看,收藏}
- bilibili-admin.ts / youtube-admin.ts：来源类型同步更新
- 前端详情面板 z-index z-10 → z-40（防侧栏遮挡）

## 二、sticky标签栏滚动抖动修复
- 移除 `transform: translateZ(0)` + `will-change`，改用 `isolation: isolate` + `contain: paint`

## 三、AI解读 & 翻译功能上线
- 后端：`routes/ai.ts` + `services/ai.ts` + `services/prompts.ts`（DeepSeek API 封装）
- 前端：文章详情增加 AI解读 / 翻译按钮，动态生成/展示 AI 内容
- 翻译按钮仅对 The Economist 文章显示

## 四、图片 & 布局修复
- 图片三级降级：COS → `/api/images/` 本地 → 隐藏
- 右侧面板 `max-w-[min(42rem,50vw)]` 防止挤压中间栏
- 图片 CSS 增加 `height: auto; display: block;`
- all img 改 `loading="lazy"`
- COS 补传：94 张缺失图片已全部同步

## 五、AI翻译误显示修复
- 前端：翻译内容仅当 `showTranslateBtn && existingTranslation` 时展示
- 数据库：清理文章 4607 误存的 `extra.ai_translation`

## 六、宏观数据采集脚本
- `scripts/fetch_pboc_data.py`（AKShare 央行数据）
- `scripts/fetch_all_macro_data.py`（多源汇总）
- `scripts/fetch_macro_supplement.py`（补充数据）

## 七、COS图片迁移工具
- `scripts/migrate-images-to-cos.mjs`（批量上传迁移脚本）

## 八、B站视频功能（v6-v9）
- 字幕下载：新建 `routes/bilibili-subtitle.ts`，POST /bilibili/subtitle
  - yt-dlp 尝试下载已有字幕 → 无字幕则 bili-transcribe.sh 音频转录（30min超时）
  - 结果缓存到 `articles.extra.subtitle`
- 视频播放：粉色播放按钮 + 嵌入式 B站 iframe 播放器（纯净模式）
- 时长回填：206/207 篇 B站文章补录 duration
- AI 字幕解读：POST /ai/analyze-subtitle，用 DeepSeek 总结视频要点
- .env.json 加载修复：index.ts 启动时合并环境变量

## 九、模板字面量嵌套排查修复（折腾最久的一行代码）

### 问题现象
选择文章时前端白屏，控制台报 `SyntaxError: Unexpected token ';'`，指向 `selectArticle` 函数内部。

### 排查过程（回顾反思）
1. **错误方向**：一开始以为是后端接口或数据类型问题，检查了 API 返回、变量类型
2. **缩小范围**：确认是 `detailContent.innerHTML = \`...\`` 模板字面量语法错误后，用 `node --check` 定位到文件
3. **二分法精简**：创建约 20 个测试文件，逐步删除代码缩小问题区域（test_t1~test_t4m 系列）
4. **定位根因**：最终锁定——**模板字面量的关闭反引号被外层三元表达式"吃掉"**
   - 外层：`${showAiBtn || showTranslateBtn || isBilibili ? \`...\``（T1）
   - 内层：`${isBilibili ? \`...\``（T2）
   - 第835行 `</div>\`: ''}` 的反引号关闭了 T2，但 T1 的关闭反引号被**隐式推迟**到第910行
   - 第910行本应关闭主模板（T0）的反引号被 T1 拦截 → T0 永不关闭 → 语法错误

### 修复
一行拆两行：
```
// 第835行                     →      ` : ''}         ← 关 T2 + isBilibili 三元
// 第836行（新增）                     </div>` : ''}   ← 关 div + 关 T1 + 外层三元
```

### 教训
V8 解析模板嵌套时，**每个反引号精确关闭当前栈顶模板**。当 T1（外层三元模板）和 T2（内层模板）的 HTML 结构有重叠（`</div>` 在 T2 内部），肉眼很难看出反引号归属。以后遇到复杂模板嵌套：
1. 先确认每一层 `${condition ? \`...\`` 的闭合都在正确层级
2. 善用 `node --check` 快速验证
3. 保持模板层级和 HTML 结构层次一致，避免跨层闭合

## 待办
- 其他中国数据源采集（NBS/NDRC/MOF/GACC/SAFE）
- 美国数据源（FRED/BLS/BEA）
- 国际组织数据源（BIS/IMF/WorldBank）
