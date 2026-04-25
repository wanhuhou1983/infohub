/**
 * InfoHub 后端入口
 * 
 * 重构后的薄层路由注册，具体逻辑拆分到 routes/ 和 services/ 模块
 * 
 * 修复：
 * - CORS 限制为指定域名
 * - 所有路由参数化查询，消除 sql.unsafe()
 */

import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createSourcesRoutes } from './routes/sources.js';
import { createArticlesRoutes } from './routes/articles.js';
import { createFetchRoutes } from './routes/fetch.js';
import { createSyncRoutes } from './routes/sync.js';
import { createWechatAdminRoutes } from './routes/wechat-admin.js';
import { createBilibiliAdminRoutes } from './routes/bilibili-admin.js';
import { createBilibiliAdminUppersRoutes } from './routes/bilibili-admin-uppers.js';
import { createWechatGroupAdminRoutes } from './routes/wechat-group-admin.js';
import { createYoutubeAdminRoutes } from './routes/youtube-admin.js';

const sql = postgres(process.env.DATABASE_URL!);

const app = new Hono();

// CORS：指定允许的前端域名（开发 + 生产）
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  // 生产环境通过反向代理同域访问时 origin 相同，自动允许
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

// ============ 管理员认证中间件 ============

function requireAdminAuth(c: any): { valid: boolean; error?: string } {
  const authHeader = c.req.header('Authorization');
  const adminToken = process.env.ADMIN_TOKEN || loadEnvConfig().ADMIN_TOKEN;
  
  // 未配置管理员 Token 时，拒绝所有写操作
  if (!adminToken) {
    return { valid: false, error: '管理员认证未配置' };
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: '缺少 Authorization 头' };
  }
  
  const token = authHeader.slice(7);
  if (token !== adminToken) {
    return { valid: false, error: '管理员 Token 无效' };
  }
  
  return { valid: true };
}

// ============ 前端静态文件 ============

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(__dirname, '..', 'frontend');

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

// 管理后台页面
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

const ENV_FILE = join(__dirname, '..', '.env.json');

function loadEnvConfig(): Record<string, string> {
  try {
    if (existsSync(ENV_FILE)) return JSON.parse(readFileSync(ENV_FILE, 'utf-8'));
  } catch { /* ignore */ }
  return {};
}

function saveEnvConfig(config: Record<string, string>): void {
  writeFileSync(ENV_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 获取环境配置（合并 .env.json + process.env，.env.json 优先用于非敏感项）
app.get('/api/sources/config/env', (c) => {
  const fileConfig = loadEnvConfig();
  return c.json({
    imgbed_url: fileConfig.IMGBED_URL || process.env.IMGBED_URL || '',
    imgbed_base: fileConfig.IMGBED_BASE || process.env.IMGBED_BASE || '',
    imgbed_token: fileConfig.IMGBED_TOKEN ? '******' : '',  // 不暴露已有 token
    weflow_url: fileConfig.WEFLOW_URL || process.env.WEFLOW_URL || '',
    weflow_token: fileConfig.WEFLOW_TOKEN ? '******' : '',
    miniflux_url: fileConfig.MINIFLUX_URL || process.env.MINIFLUX_URL || '',
    miniflux_user: fileConfig.MINIFLUX_USER || process.env.MINIFLUX_USER || '',
  });
});

// 更新环境配置（写入 .env.json，同时更新 process.env 使其立即生效）- 需管理员认证
app.patch('/api/sources/config/env', (c) => {
  return c.req.json().then(async (body: any) => {
    // 管理员认证检查
    const auth = requireAdminAuth(c);
    if (!auth.valid) return c.json({ error: auth.error }, 401);
    
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

    const fileConfig = loadEnvConfig();

    // 映射前端字段名到环境变量名
    const mapping: Record<string, string> = {
      imgbed_url: 'IMGBED_URL',
      imgbed_base: 'IMGBED_BASE',
      imgbed_token: 'IMGBED_TOKEN',
      weflow_url: 'WEFLOW_URL',
      weflow_token: 'WEFLOW_TOKEN',
      miniflux_url: 'MINIFLUX_URL',
      miniflux_user: 'MINIFLUX_USER',
      miniflux_pass: 'MINIFLUX_PASS',
    };

    for (const [key, envKey] of Object.entries(mapping)) {
      if (body[key] !== undefined && body[key] !== '******') {
        const val = String(body[key]);
        fileConfig[envKey] = val;
        process.env[envKey] = val;  // 立即生效
      }
    }

    saveEnvConfig(fileConfig);
    return c.json({ ok: true });
  }).catch(() => c.json({ error: 'Invalid JSON' }, 400));
});

// ============ 注册路由 ============

// 测试路由
app.get('/api/test', (c) => c.json({ msg: 'test ok' }));

// 信息源路由（内联，避免模块加载问题）
const sourcesRouter = new Hono();
sourcesRouter.get('/', async (c) => {
  const sources = await sql`SELECT * FROM sources ORDER BY id`;
  return c.json(sources);
});
sourcesRouter.get('/tree', async (c) => {
  const sources = await sql`SELECT * FROM sources ORDER BY id`;
  const nodeMap = new Map();
  sources.forEach(s => nodeMap.set(s.id, { ...s, children: [] }));
  const roots: any[] = [];
  sources.forEach(s => {
    const node = nodeMap.get(s.id);
    if (s.parent_id === null) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(s.parent_id);
      if (parent) {
        if ((parent.type === 'wechat' || parent.type === 'wechat_group') && node.enabled === false) {
          return;
        }
        parent.children.push(node);
      }
    }
  });
  return c.json(roots);
});
sourcesRouter.patch('/:id/config', async (c) => {
  const id = Number(c.req.param('id'));
  if (isNaN(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);
  const [row] = await sql`SELECT config FROM sources WHERE id = ${id}`;
  if (!row) return c.json({ error: 'Source not found' }, 404);
  const currentConfig = row.config || {};
  const newConfig = { ...currentConfig, ...body };
  const [updated] = await sql`UPDATE sources SET config = ${sql.json(newConfig)}, updated_at = NOW() WHERE id = ${id} RETURNING id, name, type, config`;
  return c.json(updated);
});
app.route('/api/sources', sourcesRouter);
app.route('/api/articles', createArticlesRoutes(sql));
app.route('/api/fetch', createFetchRoutes(sql));
app.route('/api/sync', createSyncRoutes(sql));
app.route('/api/wechat-admin', createWechatAdminRoutes(sql));
app.route('/api/bilibili-admin', createBilibiliAdminRoutes(sql));
app.route('/api/bilibili-admin', createBilibiliAdminUppersRoutes(sql));
app.route('/api/wechat-group-admin', createWechatGroupAdminRoutes(sql));
app.route('/api/youtube-admin', createYoutubeAdminRoutes(sql));

// ============ 启动 ============

const port = Number(process.env.PORT || 3001);
console.log(`InfoHub API 启动: http://localhost:${port}`);

serve({ fetch: app.fetch, port });
