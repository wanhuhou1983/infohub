/**
 * InfoHub 閸氬海顏崗銉ュ經
 * 
 * 闁插秵鐎崥搴ｆ畱閽栧嫬鐪扮捄顖滄暠濞夈劌鍞介敍灞藉徔娴ｆ捇鈧槒绶幏鍡楀瀻閸?routes/ 閸?services/ 濡€虫健
 * 
 * 濡€崇础閿?
 * - 閺堫剙婀村Ο鈥崇础閿涘牓绮拋銈忕礆閿涙艾鍙忛崝鐔诲厴閿涘矂鍣伴梿?+ 缁狅紕鎮?+ OB 閸氬本顒?
 * - 娴滄垹顏Ο鈥崇础閿涘湑LOUD_MODE=true閿涘绱伴崣顏囶嚢鐏炴洜銇氶敍宀€顩﹂悽銊╁櫚闂?缁狅紕鎮?OB閿涘本甯撮崣妤佹殶閹诡喖鎮撳銉﹀腹闁?
 * 
 * 娣囶喖顦查敍?
 * - CORS 闂勬劕鍩楁稉鐑樺瘹鐎规艾鐓欓崥?
 * - 閹碘偓閺堝鐭鹃悽鍗炲棘閺佹澘瀵查弻銉嚄閿涘本绉烽梽?sql.unsafe()
 */

// 閳跨媴绗?韫囧懘銆忛崷銊ゆ崲娴ｆ洘膩閸?import 娑斿澧犻崝鐘烘祰 .env.json閿?
// 閸氾箑鍨?translate.ts 缁涘膩閸фぞ鑵戦惃鍕埗闁插骏绱橠EEPSEEK_API_KEY閵嗕俯LAMA_BASE_URL 缁涘绱?
// 娴兼艾婀?import 閺冭泛姘ㄩ崚婵嗩潗閸栨牭绱濈€佃壈鍤?.env.json 闁插瞼娈戦柊宥囩枂娑撳秶鏁撻弫鍫涒偓?
import { readFileSync as _readFileSync, existsSync as _existsSync } from 'fs';
import { join as _join, dirname as _dirname } from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';
(() => {
  try {
    const _dir = _dirname(_fileURLToPath(import.meta.url));
    const _p = _join(_dir, '..', '.env.json');
    if (_existsSync(_p)) {
      const envConfig = JSON.parse(_readFileSync(_p, 'utf-8'));
      for (const [key, value] of Object.entries(envConfig)) {
        if (typeof value === 'string' && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch (e) {
    console.warn('[閸氼垰濮 閺冪姵纭堕崝鐘烘祰 .env.json:', (e as Error).message);
  }
})();

import 'dotenv/config';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { readFileSync, existsSync, writeFileSync, chmodSync } from 'fs';
import { execSync } from 'node:child_process';
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
import { createSchedulerRoutes, runDailyFetch, pushToCloud } from './services/scheduler.js';
import { invalidateEnvCache, getImagesDir, getObDir } from './file-storage.js';
import { fail } from './shared/response.js';


const IS_CLOUD = process.env.CLOUD_MODE === 'true';
const __dirname_env = dirname(fileURLToPath(import.meta.url));
const sql = postgres(process.env.DATABASE_URL!);

const app = new Hono();

// CORS閿涙碍瀵氱€规艾鍘戠拋鍝ユ畱閸撳秶顏崺鐔锋倳閿涘牆绱戦崣?+ 閻㈢喍楠?+ Capacitor App閿?
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  // Capacitor Android/iOS App
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
  // 閻㈢喍楠囬悳顖氼暔閸╃喎鎮曢柅姘崇箖閻滎垰顣ㄩ崣姗€鍣洪柊宥囩枂
  ...(process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : []),
];

app.use('/api/*', cors({
  origin: (origin) => {
    // 閸忎浇顔忛弮?origin 閻ㄥ嫯顕Ч鍌︾礄婵″倸鎮撳┃鎰┾偓涔rl閿?
    if (!origin) return null;
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ============ 娴滄垹顏Ο鈥崇础閿涙氨顩﹂悽銊︽拱閸﹂绗撶仦鐐剁熅閻?============

// 娴滄垹顏Ο鈥崇础娑擃參妫挎禒璁圭窗閹凤附鍩呴柌鍥肠/缁狅紕鎮?OB 閸氬本顒炵粵澶嬫拱閸﹂绗撶仦鐐剁熅閻?
function cloudGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!IS_CLOUD) return next();
    return c.json({ error: '娴滄垹顏崣顏囶嚢濡€崇础閿涘本顒濋崝鐔诲厴瀹歌尙顩﹂悽? }, 403);
  };
}

// ============ 缁狅紕鎮婇崨妯款吇鐠囦椒鑵戦梻缈犳 ============

// 缁狅紕鎮婇崨?Token 缂傛挸鐡ㄩ敍姘儙閸斻劍妞傞崝鐘烘祰娑撯偓濞嗏槄绱漞nv 閺囧瓨鏌婇弮璺哄煕閺?
let _cachedAdminToken: string | undefined = undefined;

function getAdminToken(): string {
  if (_cachedAdminToken !== undefined) return _cachedAdminToken;
  _cachedAdminToken = process.env.ADMIN_TOKEN || loadEnvConfig().ADMIN_TOKEN || '';
  return _cachedAdminToken;
}

function requireAdminAuth(c: Context): { valid: boolean; error?: string } {
  const adminToken = getAdminToken();
  
  // 棣冩晙 REQUIRE_AUTH 閻滎垰顣ㄩ崣姗€鍣洪敍姘繁閸掓儼顩﹀Ч鍌滎吀閻炲棗鎲?Token閿涘矂妲诲銏㈡晸娴溠呭箚婢у啴浠愬蹇涘帳缂?
  const requireAuth = process.env.REQUIRE_AUTH === 'true';
  if (!adminToken) {
    if (requireAuth) {
      return { valid: false, error: '缁狅紕鎮婇崨?Token 閺堫亪鍘ょ純顕嗙礉REQUIRE_AUTH 濡€崇础娑撳顩﹀銏犲晸閹垮秳缍? };
    }
    // 閺堫剙婀村鈧崣鎴災佸蹇ョ窗閺堫亪鍘ょ純?Token 閺冭泛鍘戠拋鍛婂閺堝鎼锋担?
    return { valid: true };
  }
  
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { valid: false, error: '缂傚搫鐨?Authorization 婢? };
  }
  
  const token = authHeader.slice(7);
  // 闂冨弶妞傛惔蹇旀暰閸戜紮绱伴梹鍨娑撳秴鎮撻弮鍓佹暏缁?Buffer 婵夘偄鍘栭崘宥嗙槷鏉堝喛绱濋柆鍨帳濞夊嫰婀堕梹鍨瀹?
  const tokenBuf = Buffer.from(token);
  const adminBuf = Buffer.from(adminToken);
  if (tokenBuf.length !== adminBuf.length || !timingSafeEqual(tokenBuf, adminBuf)) {
    return { valid: false, error: '缁狅紕鎮婇崨?Token 閺冪姵鏅? };
  }
  
  return { valid: true };
}

/**
 * 閸愭瑦鎼锋担婊堝閺夊啩鑵戦梻缈犳瀹搞儱宸堕崙鑺ユ殶
 * 鐎?POST/PATCH/DELETE 鐟曚焦鐪扮粻锛勬倞閸?Token閿涘瓘ET 閺€鎹愵攽
 * 濞戝牓娅?9 濞嗭繝鍣告径宥囨畱 `const auth = requireAdminAuth(c); if (!auth.valid)...` 濡€崇础
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

// ============ 閸撳秶顏棃娆愨偓浣规瀮娴?============

const FRONTEND_DIR = join(__dirname_env, 'frontend');

// ============ 閸撳秶顏?JS 闂堟瑦鈧焦鏋冩禒鎯扮熅閻?============
// 閹绘劒绶?/js/api-client.js 娓氭稑澧犵粩顖氬鏉?
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

// ============ 閸ュ墽澧栭棃娆愨偓浣规瀮娴犳儼鐭鹃悽?============
// 閺堫剙婀寸€涙ê鍋嶉惃鍕禈閻楀洭鈧俺绻冨銈堢熅閻㈣精顔栭梻顕嗙礉URL 閺嶇厧绱￠敍?api/images/{source}/{filename}
// 娴滄垹顏Ο鈥崇础鐠哄疇绻冮敍姘禈閻楀洤鍑￠崷?COS閿涘奔绗夐棁鈧憰浣规拱閸︽澘娴橀悧鍥ㄦ箛閸?
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

app.get('/api/images/:subdir/:filename', async (c) => {
    const subdir = c.req.param('subdir');
    const filename = c.req.param('filename');
    // 鐎瑰鍙忛敍姘舵Щ濮濄垼鐭惧鍕憾閸?
    if (subdir.includes('..') || filename.includes('..') || subdir.includes('/') || filename.includes('/')) {
      return c.text('Invalid path', 400);
    }
    const filePath = join(getImagesDir(), subdir, filename);
    if (!existsSync(filePath)) return c.text('Not found', 404);

    const ext = extname(filename).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const buf = readFileSync(filePath);
    // 闂€璺ㄧ处鐎涙﹫绱伴崶鍓у閸愬懎顔愰崺杞扮艾 MD5閿涘奔绗夋导姘綁
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Type', contentType);
    return c.body(buf);
  });

// 閸ュ墽澧栨禒锝囨倞閿涙碍婀囬崝锛勵伂鐠囬攱鐪版径鏍劥閸ュ墽澧栭敍鍫濐洤瀵邦喕淇?mmbiz閿涘鑻熸潻鏂挎礀缂佹瑥澧犵粩顖ょ礉缂佹洝绻冮梼鑼磵闁?
app.get('/api/image-proxy', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.text('Missing url parameter', 400);

  // 閸欘亜鍘戠拋闀愬敩閻炲棛澹掔€规艾鐓欓崥?
  const allowedHosts = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn', 'wx.qlogo.cn'];
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return c.text('Invalid URL', 400);
  }
  if (!allowedHosts.some(h => parsedUrl.hostname.endsWith(h))) {
    return c.text('Domain not allowed', 403);
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'Referer': 'https://mp.weixin.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });
    if (!resp.ok) return c.text(`Upstream error: ${resp.status}`, 502);

    const contentType = resp.headers.get('content-type') || 'image/png';
    const buf = await resp.arrayBuffer();
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=86400');
    c.header('Access-Control-Allow-Origin', '*');
    return c.body(Buffer.from(buf));
  } catch (e: any) {
    return c.text(`Proxy error: ${e.message}`, 502);
  }
});

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

// ============ 鏉╂劘顢戦弮鍓佸箚婢у啴鍘ょ純顕嗙礄.env.json閿?============

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
    chmodSync(ENV_FILE, 0o600); // 棣冩晙 闂呮劖鍋?6 娣囶喖顦查敍姘矌 owner 閸欘垵顕伴崘娆欑礉娣囨繃濮㈤弰搴㈡瀮鐎靛棝鎸?
  } catch { /* chmod 閸欘垵鍏樻径杈Е閿涘牆顩?Docker 閹稿倽娴囬崡鍑ょ礆閿涘奔绗夎ぐ鍗炴惙閸旂喕鍏?*/ }
}

// 閼惧嘲褰囬悳顖氼暔闁板秶鐤嗛敍鍫濇値楠?.env.json + process.env閿?env.json 娴兼ê鍘涢悽銊ょ艾闂堢偞鏅遍幇鐔笺€嶉敍?
app.get('/api/sources/config/env', async (c) => {
  const fileConfig = loadEnvConfig();

  // 濡偓閺?Google OAuth 閹哄牊娼堥悩鑸碘偓?
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
    image_storage: 'local', // 瑜版挸澧犻崶鍓у鐎涙ê鍋嶉弬鐟扮础
    weflow_url: fileConfig.WEFLOW_URL || process.env.WEFLOW_URL || '',
    weflow_token: fileConfig.WEFLOW_TOKEN ? '******' : '',
    miniflux_url: fileConfig.MINIFLUX_URL || process.env.MINIFLUX_URL || '',
    miniflux_user: fileConfig.MINIFLUX_USER || process.env.MINIFLUX_USER || '',
    // 缂堟槒鐦?API 闁板秶鐤?
    google_translate_key: fileConfig.GOOGLE_TRANSLATE_KEY ? '******' : '',
    azure_translate_key: fileConfig.AZURE_TRANSLATE_KEY ? '******' : '',
    azure_translate_region: fileConfig.AZURE_TRANSLATE_REGION || 'eastasia',
    azure_translate_endpoint: fileConfig.AZURE_TRANSLATE_ENDPOINT || 'https://api.cognitive.microsofttranslator.com/',
    baidu_translate_configured: existsSync(join(process.env.HOME || '/root', '.workbuddy/keys/baidu_translate.json')),
    // Google OAuth 闁板秶鐤嗛悩鑸碘偓?
    google_oauth_client_id: fileConfig.GOOGLE_OAUTH_CLIENT_ID || '',
    google_oauth_configured: !!fileConfig.GOOGLE_OAUTH_CLIENT_ID,
    google_oauth_authorized: googleOAuthAuthorized,
    google_oauth_user: googleOAuthUser,
  });
});

// 閺囧瓨鏌婇悳顖氼暔闁板秶鐤嗛敍鍫濆晸閸?.env.json閿涘苯鎮撻弮鑸垫纯閺?process.env 娴ｅ灝鍙剧粩瀣祮閻㈢喐鏅ラ敍? 闂団偓缁狅紕鎮婇崨妯款吇鐠?
// 娴滄垹顏Ο鈥崇础缁備胶鏁ら敍姘瑝鎼存柨婀禍鎴狀伂娣囶喗鏁奸柊宥囩枂
app.patch('/api/sources/config/env', (c) => {
  if (IS_CLOUD) return c.json({ error: '娴滄垹顏崣顏囶嚢濡€崇础閿涘瞼骞嗘晶鍐帳缂冾喕绗夐崣顖欐叏閺€? }, 403);
  return c.req.json().then(async (body: any) => {
    // 缁狅紕鎮婇崨妯款吇鐠囦焦顥呴弻?
    const auth = requireAdminAuth(c);
    if (!auth.valid) return c.json({ error: auth.error }, 401);
    
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid body' }, 400);

    const fileConfig = loadEnvConfig();

    // 閺勭姴鐨犻崜宥囶伂鐎涙顔岄崥宥呭煂閻滎垰顣ㄩ崣姗€鍣洪崥?
    const mapping: Record<string, string> = {
      weflow_url: 'WEFLOW_URL',
      weflow_token: 'WEFLOW_TOKEN',
      miniflux_url: 'MINIFLUX_URL',
      miniflux_user: 'MINIFLUX_USER',
      miniflux_pass: 'MINIFLUX_PASS',
      // 缂堟槒鐦?API
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
        process.env[envKey] = val;  // 缁斿宓嗛悽鐔告櫏
      }
    }

    saveEnvConfig(fileConfig);
    invalidateEnvCache(); // 鐠?file-storage 娑撳顐奸柌宥嗘煀鐠囪褰?
    _cachedAdminToken = undefined; // 閸掗攱鏌?adminToken 缂傛挸鐡?
    return c.json({ ok: true });
  }).catch(() => c.json({ error: 'Invalid JSON' }, 400));
});

// ============ 濞夈劌鍞界捄顖滄暠 ============

// 濞村鐦捄顖滄暠
app.get('/api/test', (c) => c.json({ msg: 'test ok', cloud: IS_CLOUD }));

// ============ 鐠侯垳鏁卞▔銊ュ斀 ============

// 閹碘偓閺堝鐭鹃悽杈侀崸妤呪偓姘崇箖瀹搞儱宸堕崙鑺ユ殶濞夈劌鍞介敍宀€绮烘稉鈧幒銉︽暪 sql 鐎圭偘绶?
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

// 娴滄垹顏Ο鈥崇础閿涙岸鍣伴梿?缁狅紕鎮?OB 閻╃鍙х捄顖滄暠閸忋劑鍎撮幏锔藉焻
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
// sync 閸愭瑦鎼锋担婊愮窗娴滄垹顏崣顏冪箽閻?GET閿涘牏绮虹拋?閺冦儱绻旈敍澶涚礉閸愭瑦鎼锋担婊勫閹?
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

// ============ 娴滄垹顏Ο鈥崇础閿涙碍鏆熼幑顔兼倱濮濄儲甯撮弨鍓侇伂閻?============

if (IS_CLOUD) {
  import('./routes/cloud-sync.js').then(({ createCloudSyncRoutes }) => {
    app.route('/api/cloud-sync', createCloudSyncRoutes(sql));
    console.log('[娴滄垹顏琞 閺佺増宓侀崥灞绢劄閹恒儲鏁圭粩顖滃仯瀹稿弶鏁為崘? POST /api/cloud-sync/push');
  }).catch((err) => {
    console.warn('[娴滄垹顏琞 閺冪姵纭堕崝鐘烘祰 cloud-sync 鐠侯垳鏁?', err.message);
  });
}

// ============ 閸氼垰濮?============

const port = Number(process.env.PORT || 3001);

// 棣冩晙 閸氼垰濮╅弮鑸殿梾閺?ADMIN_TOKEN 闁板秶鐤?
if (!getAdminToken()) {
  if (process.env.REQUIRE_AUTH === 'true') {
    console.error('棣冩瘍 [娑撱儵鍣哥€瑰鍙忛柨娆掝嚖] REQUIRE_AUTH=true 娴?ADMIN_TOKEN 閺堫亪鍘ょ純顕嗙磼');
    console.error('鐠囧嘲婀悳顖氼暔閸欐﹢鍣洪幋?.env.json 娑擃參鍘ょ純?ADMIN_TOKEN閿涘本鍨ㄧ粔濠氭珟 REQUIRE_AUTH');
    process.exit(1);
  }
  console.warn('閳跨媴绗? [鐎瑰鍙忕拃锕€鎲 ADMIN_TOKEN 閺堫亪鍘ょ純顕嗙礉閹碘偓閺堝鍟撻幙宥勭稊娑撳秹娓剁憰浣筋吇鐠囦緤绱濇禒鍛粹偓鍌氭値閺堫剙婀村鈧崣鎴磼');
  console.warn('   棣冩寱 閻㈢喍楠囬悳顖氼暔鐠囩柉顔曠純?ADMIN_TOKEN閿涘本鍨ㄩ崷銊у箚婢у啫褰夐柌蹇庤厬鐠佸墽鐤?REQUIRE_AUTH=true 瀵搫鍩楅崥顖滄暏鐠併倛鐦?);
}

// 棣冩晙 P2-11閿涙艾鎯庨崝銊︽濡偓閺?OB_DIR 閺勵垰鎯佺€涙ê婀敍宀勪缉閸忓秷绻嶇悰灞炬闂堟瑩绮径杈Е閿涘牅绨粩顖浤佸蹇氱儲鏉╁浄绱?
if (!IS_CLOUD) {
  const obDir = getObDir();
  if (!existsSync(obDir)) {
    console.warn(`閳跨媴绗? [鐠€锕€鎲 OB_DIR 娑撳秴鐡ㄩ崷? ${obDir}閿涘bsidian 閺傚洣娆㈤崘娆忓弳鐏忓棗銇戠拹銉磼`);
  }
}

// ============ 閸愬懎缂撶€规碍妞傜拫鍐ㄥ閸ｎ煉绱欏В蹇撶毈閺冨爼鍣伴梿?+ 娴滄垹顏崥灞绢劄閿?============
if (!IS_CLOUD) {
  const HOURLY_MS = 60 * 60 * 1000;

  // 鐠侊紕鐣绘稉瀣╃娑擃亝鏆ｉ悙鐟颁焊缁夌粯妞傞崚浼欑礄姒涙顓诲В蹇撶毈閺?HH:10閿?
  function getNextRunTarget(offsetMin: number): Date {
    const now = new Date();
    const target = new Date(now);
    target.setMinutes(offsetMin, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setHours(target.getHours() + 1);
    }
    return target;
  }

  async function scheduleNextRun() {
    try {
      // 娑撳绔寸亸蹇旀 XX:10
      const target = getNextRunTarget(10);
      const delayMs = target.getTime() - Date.now();
      const delayMin = Math.round(delayMs / 60000);

      console.log('[scheduler] next run: ' + target.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' (' + delayMin + 'min)');

      setTimeout(async () => {
        console.log('[scheduler] === hourly fetch triggering ===');
        try {
          const report = await runDailyFetch(sql);
          console.log('[scheduler] done (' + (report?.length || 0) + ' chars report)');
        } catch (e: any) {
          console.error('[scheduler] error:', e.message);
        }
        // pushToCloud 瀹告彃婀?runDailyFetch 閸愬懘鍎撮懛顏勫З鐟欙箑褰?
        await scheduleNextRun();
      }, delayMs);
    } catch (e: any) {
      console.error('[scheduler] init error:', e.message);
      setTimeout(scheduleNextRun, 60000); // 闁挎瑨顕ら弮?1 閸掑棝鎸撻崥搴ㄥ櫢鐠?
    }
  }

  scheduleNextRun();
  // 閸氼垰濮╅崥?30s 閸嬫矮绔村▎鈥冲灥婵绨粩顖氭倱濮?
  setTimeout(function() { pushToCloud(); }, 30000);
}


// 閸忋劌鐪張顏呭礋閼惧嘲绱撶敮?閹锋帞绮锋径鍕倞閿涘矂妲诲銏ｇ箻缁嬪娼ゆ妯虹┛濠?
process.on('uncaughtException', (err, origin) => {
  console.error(`[閼锋潙鎳 uncaughtException (${origin}):`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[閼锋潙鎳 unhandledRejection:', reason);
});

console.log(`InfoHub API 閸氼垰濮? http://0.0.0.0:${port}閿?{IS_CLOUD ? '娴滄垹顏崣顏囶嚢濡€崇础' : '閺堫剙婀撮崗銊ュ閼宠姤膩瀵骏绱濈仦鈧崺鐔虹秹/Tailscale 閸欘垵顔栭梻?}閿涘ˇ);

serve({ fetch: app.fetch, hostname: '0.0.0.0', port });

