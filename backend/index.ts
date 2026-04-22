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

import { createSourcesRoutes } from './routes/sources.js';
import { createArticlesRoutes } from './routes/articles.js';
import { createFetchRoutes } from './routes/fetch.js';
import { createSyncRoutes } from './routes/sync.js';

const sql = postgres(process.env.DATABASE_URL!);

const app = new Hono();

// CORS：指定允许的前端域名（开发 + 生产）
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  // 可按需添加生产域名
];

app.use('/api/*', cors({
  origin: (origin) => {
    // 允许无 origin 的请求（如同源、curl）
    if (!origin) return '';
    return ALLOWED_ORIGINS.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// ============ 注册路由 ============

app.route('/api/sources', createSourcesRoutes(sql));
app.route('/api/articles', createArticlesRoutes(sql));
app.route('/api/fetch', createFetchRoutes(sql));
app.route('/api/sync', createSyncRoutes(sql));

// ============ 启动 ============

const port = Number(process.env.PORT || 3001);
console.log(`InfoHub API 启动: http://localhost:${port}`);

serve({ fetch: app.fetch, port });
