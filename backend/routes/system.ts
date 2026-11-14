/**
 * 系统健康监控路由
 *
 * 数据来源：watchdog-all.sh 每 5 分钟写入的 <项目>/data/health/status.json
 * （由 launchd 直接驱动，零 token 消耗）。本路由只负责读取并暴露给前端。
 *
 * - GET  /api/system/health          读状态文件，秒开，不鉴权（与 /api/sources 一致）
 * - GET  /api/system/health/history  24h 趋势序列（环形 288 点）
 * - POST /api/system/health/check    同步跑一次检查（需写鉴权，本地无 token 时放行）
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { fail } from '../shared/response.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 项目根：backend/routes -> backend -> 项目根
const HEALTH_DIR = join(__dirname, '..', '..', 'data', 'health');
const STATUS_FILE = join(HEALTH_DIR, 'status.json');
const HISTORY_FILE = join(HEALTH_DIR, 'history.json');
const WATCHDOG_SCRIPT = join(__dirname, '..', '..', 'scripts', 'watchdog-all.sh');

interface AuthCheck {
  valid: boolean;
  error?: string;
}

export function createSystemRoutes(sql: Sql, requireAdminAuth: (c: any) => AuthCheck): Hono {
  const router = new Hono();

  // 读取最新状态
  router.get('/health', async (c) => {
    if (!existsSync(STATUS_FILE)) {
      return c.json({
        ok: false,
        available: false,
        message: '健康检查尚未运行，请稍候或点击「立即检查」',
      }, 200);
    }
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
      return c.json(data);
    } catch (e: any) {
      return fail(c, '状态文件解析失败: ' + e.message, 500);
    }
  });

  // 读取 24h 历史趋势
  router.get('/health/history', async (c) => {
    if (!existsSync(HISTORY_FILE)) return c.json({ points: [] });
    try {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      return c.json(data);
    } catch {
      return c.json({ points: [] });
    }
  });

  // 手动触发一次检查（同步等待 watchdog 完成并写盘）
  router.post('/health/check', async (c) => {
    const auth = requireAdminAuth(c);
    if (!auth.valid) return fail(c, auth.error!, 401);
    try {
      execFileSync('/bin/bash', [WATCHDOG_SCRIPT], { timeout: 90000, stdio: 'ignore' });
    } catch (e: any) {
      // 即便脚本出错，也可能已写入 status.json，继续尝试读取
    }
    if (!existsSync(STATUS_FILE)) {
      return fail(c, '检查脚本未产出状态文件', 500);
    }
    try {
      const data = JSON.parse(readFileSync(STATUS_FILE, 'utf-8'));
      return c.json({ ok: true, data });
    } catch (e: any) {
      return fail(c, '状态文件解析失败: ' + e.message, 500);
    }
  });

  return router;
}
