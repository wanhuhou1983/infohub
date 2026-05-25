/**
 * InfoHub 后端入口
 * 
 * 重构后的薄层路由注册，具体逻辑拆分到 routes/ 和 services/ 模块
 * 
 * 模式：
 * - 本地模式（默认）：全功能，采集 + 管理 + OB 同步
 * - 云端模式（CLOUD_MODE=true）：只读展示，禁用采集/管理/OB，接受数据同步推送
 * 
 * 修复：
 * - CORS 限制为指定域名
 * - 所有路由参数化查询，消除 sql.unsafe()
 */

import 'dotenv/config';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { readFileSync, existsSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname, extname } from 'path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'url';

import { createSourcesRoutes } from './routes/sources.js';
import { createArticlesRoutes } from './routes/articles.js';
import { createFetchRoutes } from './routes/fetch/index.js';
import { createSyncRoutes } from './routes/sync.js';
import { createWechatAdminRoutes } from './routes/wechat-admin.js';
import { createBilibiliAdminRoutes } from './routes/bilibili-admin.js';
import { createBilibiliAdminUppersRoutes } from './routes/bilibili-admin-uppers.js';
import { createWechatGroupAdminRoutes } from './routes/wechat-group-admin.js';
import { createYoutubeAdminRoutes } from './routes/youtube-admin.js';
import { createYoutubeSubtitleRoutes } from './routes/youtube-subtitle.js';
import { createPodcastAdminRoutes } from './routes/podcast-admin.js';
import { createBilibiliSubtitleRoutes } from './routes/bilibili-subtitle.js';
import { createGoogleAuthRoutes, getValidAccessToken } from './routes/google-auth.js';
import { createAiRoutes } from './routes/ai.js';
import { createPodcastTranscribeRoutes } from './routes/podcast-transcribe.js';
import { createTwitterAdminRoutes } from './routes/twitter-admin.js';
import { createCaixinRoutes } from './routes/caixin.js';
import { createSchedulerRoutes } from './services/scheduler.js';
import { invalidateEnvCache, getImagesDir, getObDir } from './file-storage.js';
import { fail } from './shared/response.js';

// 必须在任何模块初始化之前加载 .env.json
const __dirname_env = dirname(fileURLToPath(import.meta.url));
(() => {
  try {
    const envJsonPath = join(__dirname_env, '..', '.env.json');
    if (existsSync(envJsonPath)) {
      const envConfig = JSON.parse(readFileSync(envJsonPath, 'utf-8'));
      for (const [key, value] of Object.entries(envConfig)) {
        if (typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch (e) {
    console.warn('[启动] 无法加载 .env.json:', (e as Error).message);
  }
})();


const IS_CLOUD = process.env.CLOUD_MODE === 'true';
const sql = postgres(process.env.DATABASE_URL!);

const app = new Hono();

// CORS：指定允许的前端域名（开发 + 生产）
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  // 生产环境域名通过环境变量配置
  ...(process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : []),
];

app.use('/api/*', cors({
  origin: (origin) => {
    // 允许无 origin 的请求（如同源、curl）
    if (!origin) return null;
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// ============ 云端模式：禁用本地专属路由 ============

// 云端模式中间件：拦截采集/管理/OB 同步等本地专属路由
function cloudGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!IS_CLOUD) return next();
    return c.json({ error: '云端只读模式，此功能已禁用' }, 403);
  };
}

// ============ 管理员认证中间件 ============

// 管理员 Token 缓存：启动时加载一次，env 更新时刷新
let _cachedAdminToken: string | undefined = undefined;

function getAdminToken(): string {
  if (_cachedAdminToken !== undefined) return _cachedAdminToken;
  _cachedAdminToken = process.env.ADMIN_TOKEN || loadEnvConfig().ADMIN_TOKEN || '';
  return _cachedAdminToken;
}

function requireAdminAuth(c: Context): { valid: boolean; error?: string } {
  const adminToken = getAdminToken();
  
  // 🔒 REQUIRE_AUTH 环境变量：强制要求管理员 Token，防止生产环境遗漏配置
  const requireAuth = process.env.REQUIRE_AUTH === 'true';
  if (!adminToken) {
    if (requireAuth) {
      return { valid: false, error: '管理员 Token 未配置，REQUIRE_AUTH 模式下禁止写操作' };
    }
    // 本地开发模式：未配置 Token 时允许所有操作
    return { valid: true };
  }
  
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: '缺少 Authorization 头' };
  }
  
  const token = authHeader.slice(7);
  // 防时序攻击：长度不同时用空 Buffer 填充再比较，避免泄露长度差
  const tokenBuf = Buffer.from(token);
  const adminBuf = Buffer.from(adminToken);
  if (tokenBuf.length !== adminBuf.length || !timingSafeEqual(tokenBuf, adminBuf)) {
    return { valid: false, error: '管理员 Token 无效' };
  }
  
  return { valid: true };
}

/**
 * 写操作鉴权中间件工厂函数
 * 对 POST/PATCH/DELETE 要求管理员 Token，GET 放行
 * 消除 9 次重复的 `const auth = requireAdminAuth(c); if (!auth.valid)...` 模式
 */
function writeAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const auth = requireAdminAuth(c);
      if (!auth.valid) return fail(c, auth.error!, 401);
    }
    return next();
  };
}

// ============ 前端静态文件 ============

const FRONTEND_DIR = join(__dirname_env, 'frontend');

// ============ 前端 JS 静态文件路由 ============
// 提供 /js/api-client.js 供前端加载
app.get('/js/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (filename.includes('..') || filename.includes('/')) {
    return c.text('Invalid path', 400);
  }
  const filePath = join(FRONTEND_DIR, 'js', filename);
  if (!existsSync(filePath)) return c.text('Not found', 404);
  const ext = extname(filename).toLowerCase();
  if (ext !== '.js') return c.text('Only JS files allowed', 400);
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'no-cache');
  return c.body(readFileSync(filePath));
});

// ============ 图片静态文件路由 ============
// 本地存储的图片通过此路由访问，URL 格式：/api/images/{source}/{filename}
// 云端模式跳过：图片已在 COS，不需要本地图片服务
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

if (!IS_CLOUD) {
  app.get('/api/images/:subdir/:filename', async (c) => {
    const subdir = c.req.param('subdir');
    const filename = c.req.param('filename');
    // 安全：防止路径遍历
    if (subdir.includes('..') || filename.includes('..') || subdir.includes('/') || filename.includes('/')) {
      return c.text('Invalid path', 400);
    }
    const filePath = join(getImagesDir(), subdir, filename);
    if (!existsSync(filePath)) return c.text('Not found', 404);

    const ext = extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const buf = readFileSync(filePath);
    // 长缓存：图片内容基于 MD5，不会变
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Type', contentType);
    return c.body(buf);
  });
}

app.get('/', (c) => {
  const indexPath = join(FRONTEND_DIR, 'index.html');
  if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, 'utf-8');
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(html);
  }
  return c.text('InfoHub frontend not found', 404);
});

// Admin page (accessible in cloud mode, write ops still guarded)
app.get('/admin', (c) => {
  const adminPath = join(FRONTEND_DIR, 'infohub-admin.html');
  if (existsSync(adminPath)) {
    const html = readFileSync(adminPath, 'utf-8');
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return c.html(html);
  }
  return c.text('Admin page not found', 404);
});

// ============ 运行时环境配置（.env.json） ============

const ENV_FILE = join(__dirname_env, '..', '.env.json');

function loadEnvConfig(): Record<string, string> {
  try {
    if (existsSync(ENV_FILE)) return JSON.parse(readFileSync(ENV_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function saveEnvConfig(config: Record<string, string>): void {
  writeFileSync(ENV_FILE, JSON.stringify(config, null, 2), 'utf-8');
  try {
    chmodSync(ENV_FILE, 0o600); // 🔒 隐患 6 修复：仅 owner 可读写，保护明文密钥
  } catch { /* chmod 可能失败（如 Docker 挂载卷），不影响功能 */ }
}

// 获取环境配置（合并 .env.json + process.env，.env.json 优先用于非敏感项）
app.get('/api/sources/config/env', async (c) => {
  const fileConfig = loadEnvConfig();

  // 检查 Google OAuth 授权状态
  let googleOAuthAuthorized = false;
  let googleOAuthUser = '';
  try {
    const [token] = await sql`SELECT user_name, user_email FROM google_oauth_tokens WHERE id = 1 LIMIT 1`;
    if (token) {
      googleOAuthAuthorized = true;
      googleOAuthUser = token.user_name || token.user_email || '';
    }
  } catch (_) { /* ignore */ }

  return c.json({
    image_storage: 'local', // 当前图片存储方式
    weflow_url: fileConfig.WEFLOW_URL || process.env.WEFLOW_URL || '',
    weflow_token: fileConfig.WEFLOW_TOKEN ? '******' : '',
    miniflux_url: fileConfig.MINIFLUX_URL || process.env.MINIFLUX_URL || '',
    miniflux_user: fileConfig.MINIFLUX_USER || process.env.MINIFLUX_USER || '',
    // 翻译 API 配置
    google_translate_key: fileConfig.GOOGLE_TRANSLATE_KEY ? '******' : '',
    azure_translate_key: fileConfig.AZURE_TRANSLATE_KEY ? '******' : '',
    azure_translate_region: fileConfig.AZURE_TRANSLATE_REGION || 'eastasia',
    azure_translate_endpoint: fileConfig.AZURE_TRANSLATE_ENDPOINT || 'https://api.cognitive.microsofttranslator.com/',
    baidu_translate_configured: existsSync(join(process.env.HOME || '/root', '.workbuddy/keys/baidu_translate.json')),
    // Google OAuth 配置状态
    google_oauth_client_id: fileConfig.GOOGLE_OAUTH_CLIENT_ID || '',
    google_oauth_configured: !!fileConfig.GOOGLE_OAUTH_CLIENT_ID,
    google_oauth_authorized: googleOAuthAuthorized,
    google_oauth_user: googleOAuthUser,
  });
});

// 更新环境配置（写入 .env.json，同时更新 process.env 使其立即生效）- 需管理员认证
// 云端模式禁用：不应在云端修改配置
app.patch('/api/sources/config/env', (c) => {
  if (IS_CLOUD) return c.json({ error: '云端只读模式，环境配置不可修改' }, 403);
  return c.req.json().then(async (body: any) => {
    // 管理员认证检查
    const auth = requireAdminAuth(c);
    if (!auth.valid) return c.json({ error: auth.error }, 401);
    
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

    const fileConfig = loadEnvConfig();

    // 映射前端字段名到环境变量名
    const mapping: Record<string, string> = {
      weflow_url: 'WEFLOW_URL',
      weflow_token: 'WEFLOW_TOKEN',
      miniflux_url: 'MINIFLUX_URL',
      miniflux_user: 'MINIFLUX_USER',
      miniflux_pass: 'MINIFLUX_PASS',
      // 翻译 API
      google_translate_key: 'GOOGLE_TRANSLATE_KEY',
      azure_translate_key: 'AZURE_TRANSLATE_KEY',
      azure_translate_region: 'AZURE_TRANSLATE_REGION',
      azure_translate_endpoint: 'AZURE_TRANSLATE_ENDPOINT',
      // Google OAuth
      google_oauth_client_id: 'GOOGLE_OAUTH_CLIENT_ID',
      google_oauth_client_secret: 'GOOGLE_OAUTH_CLIENT_SECRET',
      google_oauth_redirect_uri: 'GOOGLE_OAUTH_REDIRECT_URI',
    };

    for (const [key, envKey] of Object.entries(mapping)) {
      if (body[key] !== undefined && body[key] !== '******') {
        const val = String(body[key]);
        fileConfig[envKey] = val;
        process.env[envKey] = val;  // 立即生效
      }
    }

    saveEnvConfig(fileConfig);
    invalidateEnvCache(); // 让 file-storage 下次重新读取
    _cachedAdminToken = undefined; // 刷新 adminToken 缓存
    return c.json({ ok: true });
  }).catch(() => c.json({ error: 'Invalid JSON' }, 400));
});

// ============ 注册路由 ============

// 测试路由
app.get('/api/test', (c) => c.json({ msg: 'test ok', cloud: IS_CLOUD }));

// ============ 路由注册 ============

// 所有路由模块通过工厂函数注册，统一接收 sql 实例
app.route('/api/sources', createSourcesRoutes(sql, requireAdminAuth));
app.route('/api/articles', createArticlesRoutes(sql));

app.use('/api/fetch/*', writeAuthGuard());
app.use('/api/articles/*', writeAuthGuard());
app.use('/api/sync/*', writeAuthGuard());
app.use('/api/wechat-admin/*', writeAuthGuard());
app.use('/api/bilibili/*', writeAuthGuard());
app.use('/api/bilibili-admin/*', writeAuthGuard());
app.use('/api/youtube-admin/*', writeAuthGuard());
app.use('/api/podcast-admin/*', writeAuthGuard());
app.use('/api/podcast/*', writeAuthGuard());
app.use('/api/twitter-admin/*', writeAuthGuard());
app.use('/api/wechat-group-admin/*', writeAuthGuard());
app.use('/api/ai/*', writeAuthGuard());
app.use('/api/scheduler/*', writeAuthGuard());

// 云端模式：采集/管理/OB 相关路由全部拦截
app.use('/api/fetch/*', cloudGuard());
app.use('/api/wechat-admin/*', cloudGuard());
app.use('/api/wechat-group-admin/*', cloudGuard());
app.use('/api/bilibili-admin/*', cloudGuard());
app.use('/api/bilibili-admin/uppers/*', cloudGuard());
app.use('/api/youtube-admin/*', cloudGuard());
app.use('/api/podcast-admin/*', cloudGuard());
app.use('/api/twitter-admin/*', cloudGuard());
app.use('/api/caixin/*', cloudGuard());
app.use('/api/scheduler/*', cloudGuard());
app.use('/api/auth/google/*', cloudGuard());
// sync 写操作：云端只保留 GET（统计/日志），写操作拦截
app.use('/api/sync/files', cloudGuard());
app.use('/api/sync/reconcile', cloudGuard());
app.use('/api/sync/push', cloudGuard());
app.use('/api/sync/push-file', cloudGuard());

app.route('/api/fetch', createFetchRoutes(sql));
app.route('/api/sync', createSyncRoutes(sql));
app.route('/api/wechat-admin', createWechatAdminRoutes(sql));
app.route('/api/bilibili', createBilibiliSubtitleRoutes(sql));
app.route('/api/bilibili-admin', createBilibiliAdminRoutes(sql));
app.route('/api/bilibili-admin/uppers', createBilibiliAdminUppersRoutes(sql));
app.route('/api/wechat-group-admin', createWechatGroupAdminRoutes(sql));
app.route('/api/youtube-admin', createYoutubeAdminRoutes(sql));
app.route('/api/youtube', createYoutubeSubtitleRoutes(sql));
app.route('/api/podcast-admin', createPodcastAdminRoutes(sql));
app.route('/api/podcast', createPodcastTranscribeRoutes(sql));
app.route('/api/twitter-admin', createTwitterAdminRoutes(sql));
app.route('/api/auth/google', createGoogleAuthRoutes(sql));
app.route('/api/ai', createAiRoutes(sql));
app.route('/api/caixin', createCaixinRoutes(sql, requireAdminAuth));
app.route('/api/scheduler', createSchedulerRoutes(sql));

// ============ 云端模式：数据同步接收端点 ============

if (IS_CLOUD) {
  import('./routes/cloud-sync.js').then(({ createCloudSyncRoutes }) => {
    app.route('/api/cloud-sync', createCloudSyncRoutes(sql));
    console.log('[云端] 数据同步接收端点已注册: POST /api/cloud-sync/push');
  }).catch((err) => {
    console.warn('[云端] 无法加载 cloud-sync 路由:', err.message);
  });
}

// ============ 启动 ============

const port = Number(process.env.PORT || 3001);

// 🔒 启动时检查 ADMIN_TOKEN 配置
if (!getAdminToken()) {
  if (process.env.REQUIRE_AUTH === 'true') {
    console.error('🚨 [严重安全错误] REQUIRE_AUTH=true 但 ADMIN_TOKEN 未配置！');
    console.error('请在环境变量或 .env.json 中配置 ADMIN_TOKEN，或移除 REQUIRE_AUTH');
    process.exit(1);
  }
  console.warn('⚠️  [安全警告] ADMIN_TOKEN 未配置，所有写操作不需要认证，仅适合本地开发！');
  console.warn('   💡 生产环境请设置 ADMIN_TOKEN，或在环境变量中设置 REQUIRE_AUTH=true 强制启用认证');
}

// 🔒 P2-11：启动时检查 OB_DIR 是否存在，避免运行时静默失败（云端模式跳过）
if (!IS_CLOUD) {
  const obDir = getObDir();
  if (!existsSync(obDir)) {
    console.warn(`⚠️  [警告] OB_DIR 不存在: ${obDir}，Obsidian 文件写入将失败！`);
  }
}

// 全局未捕获异常/拒绝处理，防止进程静默崩溃
process.on('uncaughtException', (err, origin) => {
  console.error(`[致命] uncaughtException (${origin}):`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[致命] unhandledRejection:', reason);
});

console.log(`InfoHub API 启动: http://0.0.0.0:${port}（${IS_CLOUD ? '云端只读模式' : '本地全功能模式，局域网/Tailscale 可访问'}）`);

serve({ fetch: app.fetch, hostname: '0.0.0.0', port });
