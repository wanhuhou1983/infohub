/**
 * Google OAuth 认证路由
 *
 * 功能：
 * - GET /api/auth/google  → 跳转 Google 授权页面
 * - GET /api/auth/google/callback → Google 授权回调，保存 token
 * - GET /api/auth/google/status → 检查授权状态
 * - DELETE /api/auth/google/logout → 取消授权
 */

import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 读取 .env.json 配置
function loadEnvConfig(): Record<string, string> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const envPath = join(__dirname, '..', '..', '.env.json');
    if (existsSync(envPath)) {
      return JSON.parse(readFileSync(envPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function createGoogleAuthRoutes(sql: Sql): Hono {
  const router = new Hono();

  // 读取 OAuth 配置
  function getOAuthConfig() {
    const fileConfig = loadEnvConfig();
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || fileConfig.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || fileConfig.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || fileConfig.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';
    return { clientId, clientSecret, redirectUri };
  }

  // 跳转 Google 授权页面
  router.get('/', async (c) => {
    const { clientId, redirectUri } = getOAuthConfig();

    if (!clientId) {
      return c.json({ error: 'Google OAuth 未配置，请先在系统设置中配置 Google OAuth Client ID' }, 400);
    }

    const scopes = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' ');

    const state = Math.random().toString(36).substring(7);
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);

    return c.json({ authUrl: authUrl.toString(), state });
  });

  // Google 授权回调
  router.get('/callback', async (c) => {
    const { clientId, clientSecret, redirectUri } = getOAuthConfig();

    if (!clientId || !clientSecret) {
      return c.json({ error: 'Google OAuth 未配置' }, 400);
    }

    const code = c.req.query('code');
    const error = c.req.query('error');

    if (error) {
      return c.json({ error: `授权失败: ${error}` }, 400);
    }

    if (!code) {
      return c.json({ error: '缺少授权码' }, 400);
    }

    try {
      // 换取 access_token
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResp.ok) {
        const errData = await tokenResp.json() as any;
        return c.json({ error: `Token 获取失败: ${errData.error_description || errData.error}` }, 400);
      }

      const tokenData = await tokenResp.json() as any;
      const accessToken = tokenData.access_token;
      const refreshToken = tokenData.refresh_token;

      // 获取用户信息
      const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      let userInfo = { name: 'Unknown', email: '' };
      if (userResp.ok) {
        const data = await userResp.json() as any;
        userInfo = { name: data.name || data.email || 'Unknown', email: data.email || '' };
      }

      // 保存到数据库
      await sql`
        INSERT INTO google_oauth_tokens (access_token, refresh_token, expires_at, user_name, user_email, created_at, updated_at)
        VALUES (
          ${accessToken},
          ${refreshToken || ''},
          NOW() + INTERVAL '1 hour',
          ${userInfo.name},
          ${userInfo.email},
          NOW(),
          NOW()
        )
        ON CONFLICT (id = 1) DO UPDATE SET
          access_token = EXCLUDED.access_token,
          refresh_token = COALESCE(EXCLUDED.refresh_token, google_oauth_tokens.refresh_token),
          expires_at = NOW() + INTERVAL '1 hour',
          user_name = EXCLUDED.user_name,
          user_email = EXCLUDED.user_email,
          updated_at = NOW()
      `;

      // 返回成功页面
      return c.html(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>授权成功</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
            .container { text-align: center; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
            .success { color: #4ade80; font-size: 48px; }
            h1 { margin: 20px 0 10px; }
            p { color: #94a3b8; margin: 10px 0; }
            .btn { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success">✓</div>
            <h1>授权成功！</h1>
            <p>欢迎，${userInfo.name}</p>
            <p>你现在可以获取 YouTube 关注频道了</p>
            <a href="/" class="btn">返回管理后台</a>
          </div>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>
      `);
    } catch (e: any) {
      return c.json({ error: `授权处理失败: ${e.message}` }, 500);
    }
  });

  // 检查授权状态
  router.get('/status', async (c) => {
    try {
      const [token] = await sql`SELECT * FROM google_oauth_tokens WHERE id = 1 LIMIT 1`;

      if (!token) {
        return c.json({ authorized: false });
      }

      // 检查是否即将过期（提前10分钟刷新）
      const [expiringSoon] = await sql`
        SELECT 1 FROM google_oauth_tokens
        WHERE id = 1 AND expires_at < NOW() + INTERVAL '10 minutes'
      `;

      return c.json({
        authorized: true,
        user_name: token.user_name,
        user_email: token.user_email,
        expires_at: token.expires_at,
        expiring_soon: !!expiringSoon,
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 刷新 Access Token
  router.post('/refresh', async (c) => {
    const { clientId, clientSecret } = getOAuthConfig();

    if (!clientId || !clientSecret) {
      return c.json({ error: 'Google OAuth 未配置' }, 400);
    }

    try {
      const [token] = await sql`SELECT refresh_token FROM google_oauth_tokens WHERE id = 1 LIMIT 1`;

      if (!token?.refresh_token) {
        return c.json({ error: '没有 refresh_token，需要重新授权' }, 400);
      }

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!tokenResp.ok) {
        const errData = await tokenResp.json() as any;
        return c.json({ error: `刷新失败: ${errData.error_description || errData.error}` }, 400);
      }

      const tokenData = await tokenResp.json() as any;

      // 更新数据库中的 token
      await sql`
        UPDATE google_oauth_tokens
        SET access_token = ${tokenData.access_token},
            expires_at = NOW() + INTERVAL '1 hour',
            updated_at = NOW()
        WHERE id = 1
      `;

      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 取消授权
  router.delete('/logout', async (c) => {
    try {
      await sql`DELETE FROM google_oauth_tokens WHERE id = 1`;
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  return router;
}

// 获取有效 Access Token 的辅助函数
export async function getValidAccessToken(sql: Sql): Promise<string | null> {
  try {
    const [token] = await sql`SELECT * FROM google_oauth_tokens WHERE id = 1 LIMIT 1`;

    if (!token) return null;

    // 如果即将过期，先刷新
    const [expiringSoon] = await sql`
      SELECT 1 FROM google_oauth_tokens
      WHERE id = 1 AND expires_at < NOW() + INTERVAL '10 minutes'
    `;

    if (expiringSoon) {
      // 需要刷新 token - 调用刷新接口
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

      if (!clientId || !clientSecret || !token.refresh_token) {
        return null;
      }

      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token',
        }),
      });

      if (!tokenResp.ok) return null;

      const tokenData = await tokenResp.json() as any;
      await sql`
        UPDATE google_oauth_tokens
        SET access_token = ${tokenData.access_token},
            expires_at = NOW() + INTERVAL '1 hour',
            updated_at = NOW()
        WHERE id = 1
      `;

      return tokenData.access_token;
    }

    return token.access_token;
  } catch {
    return null;
  }
}
