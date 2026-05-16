/**
 * 统一响应工具函数
 *
 * 规范所有路由的错误响应格式，消除 `{ error }` 与 `{ ok: false, error }` 混用的问题。
 *
 * 用法：
 *   return fail(c, '文章不存在', 404);
 *   return ok(c, { id: 1 });
 */

import type { Context } from 'hono';

export interface ErrorResponse {
  ok: false;
  error: string;
}

export interface SuccessResponse<T = any> {
  ok: true;
  data: T;
}

/**
 * 返回统一格式的错误响应
 */
export function fail(c: Context, message: string, status: any = 400): Response {
  return c.json({ ok: false, error: message } satisfies ErrorResponse, status);
}

/**
 * 返回统一格式的成功响应
 */
export function ok<T>(c: Context, data: T, status: any = 200): Response {
  return c.json({ ok: true, data } satisfies SuccessResponse, status);
}
