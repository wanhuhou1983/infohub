/**
 * 浏览器登录鉴权（云端只读展示站的访问控制）
 *
 * 设计：
 * - 无状态签名 cookie：HMAC-SHA256(payload) 防篡改，无需 session 表
 * - 凭据从 env 读取（AUTH_USER / AUTH_PASSWORD），未配置时用初始值 admin/17512039
 * - AUTH_ENABLED=true 才启用，本地默认关闭，不影响开发
 * - 带 ADMIN_TOKEN / INTERNAL_FETCH_TOKEN 的自动化请求直接放行，不破坏采集与同步
 * - 分享页 /a/* 放行：其用途就是分享给他人阅读
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'infohub_auth';
const SESSION_DAYS = 7;
const MAX_AGE = SESSION_DAYS * 86400;

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '17512039';
// 生产务必通过 AUTH_SECRET 覆盖；未配置时用固定值，重启后会话仍有效
const AUTH_SECRET = process.env.AUTH_SECRET || 'infohub-change-this-secret-in-env';

function sign(payload: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
}

function makeToken(user: string): string {
  const body = Buffer.from(JSON.stringify({
    u: user,
    exp: Date.now() + SESSION_DAYS * 86400_000,
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data?.u || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data.u as string;
  } catch {
    return null;
  }
}

/** 从 Cookie 头解析指定 cookie（不依赖 hono/cookie 版本） */
function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); }
    }
  }
  return undefined;
}

/** 从请求里取会话用户名；未登录返回 null */
export function currentUser(c: Context): string | null {
  return verifyToken(readCookie(c, COOKIE_NAME));
}

function isSecure(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '');
  return proto === 'https';
}

function cookieFlags(c: Context): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${isSecure(c) ? '; Secure' : ''}`;
}

/**
 * 全局保护中间件。
 * 放行：登录接口、登录页、分享页 /a/*、静态 JS/图片、健康检查，
 *       以及带合法 Bearer/Internal token 的自动化请求。
 */
export function authGuard(getTokens: () => { internal: string; admin: string }): MiddlewareHandler {
  return async (c, next) => {
    if (!AUTH_ENABLED) return next();

    const { internal: internalToken, admin: adminToken } = getTokens();
    const p = c.req.path;

    // 公开路径
    if (
      p === '/login' ||
      p.startsWith('/api/auth/') ||
      p.startsWith('/a/') ||
      p.startsWith('/js/') ||
      p.startsWith('/api/images/') ||
      p === '/api/image-proxy' ||
      p === '/api/test' ||
      p === '/favicon.ico'
    ) return next();

    // 自动化请求：已有独立鉴权，直接放行
    const authHeader = c.req.header('Authorization') || '';
    if (adminToken && authHeader === `Bearer ${adminToken}`) return next();
    const internal = c.req.header('X-Internal-Fetch') || '';
    if (internalToken) {
      const a = Buffer.from(internal);
      const b = Buffer.from(internalToken);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
    }

    const user = currentUser(c);
    if (user) return next();

    // 未登录：页面跳转登录页；API 返回 401
    if (p.startsWith('/api/')) {
      return c.json({ ok: false, error: '未登录或会话已过期' }, 401);
    }
    // 只带路径+查询串（相对 URL），避免反代下 http/https 协议判断错误
    const u = new URL(c.req.url);
    const redirect = encodeURIComponent(u.pathname + u.search);
    return c.redirect(`/login?redirect=${redirect}`, 302);
  };
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  app.post('/login', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, error: '无效请求' }, 400); }
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    if (username !== AUTH_USER || password !== AUTH_PASSWORD) {
      return c.json({ ok: false, error: '用户名或密码错误' }, 401);
    }
    c.header('Set-Cookie', `${COOKIE_NAME}=${makeToken(username)}; ${cookieFlags(c)}`);
    return c.json({ ok: true, username });
  });

  app.post('/logout', (c) => {
    c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(c) ? '; Secure' : ''}`);
    return c.json({ ok: true });
  });

  app.get('/status', (c) => {
    const user = currentUser(c);
    return c.json({ ok: true, authenticated: !!user, username: user, enabled: AUTH_ENABLED });
  });

  return app;
}
