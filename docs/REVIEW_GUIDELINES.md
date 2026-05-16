# InfoHub 安全检查清单

> **目的**：代码审查（Code Review）时逐项对照的安全核查点。
> 每项包含：检查要点 ✅、好例子 👍、坏模式 ❌、风险等级 🚦。
>
> 适用于：新功能 PR 审查、定期安全审计、依赖升级后回归检查。

---

## 目录

1. [管理员鉴权与时序安全](#1-管理员鉴权与时序安全)
2. [写操作权限守卫](#2-写操作权限守卫)
3. [CORS 跨域白名单](#3-cors-跨域白名单)
4. [路径遍历防护](#4-路径遍历防护)
5. [密钥文件权限](#5-密钥文件权限)
6. [启动锁与配置验证](#6-启动锁与配置验证)
7. [参数化 SQL 防注入](#7-参数化-sql-防注入)
8. [SSRF 服务端请求伪造防护](#8-ssrf-服务端请求伪造防护)
9. [OAuth Token 加密存储](#9-oauth-token-加密存储)
10. [CSRF 跨站请求伪造防护](#10-csrf-跨站请求伪造防护)
11. [XSS 跨站脚本防护](#11-xss-跨站脚本防护)
12. [子进程安全](#12-子进程安全)
13. [进程超时与兜底终止](#13-进程超时与兜底终止)
14. [并发控制与资源限制](#14-并发控制与资源限制)
15. [统一错误响应](#15-统一错误响应)

---

## 1. 管理员鉴权与时序安全

### 检查要点 ✅

- [ ] 管理员 Token 比较是否使用了 `timingSafeEqual`？
- [ ] 是否存在 `===` / `==` 直接比较 Token 的写法？
- [ ] Token 长度不同时是否用空 Buffer 填充再比较，避免泄露长度差？

### 好例子 👍

```typescript
// backend/index.ts:112-116
const tokenBuf = Buffer.from(token);
const adminBuf = Buffer.from(adminToken);
if (tokenBuf.length !== adminBuf.length || !timingSafeEqual(tokenBuf, adminBuf)) {
  return { valid: false, error: '管理员 Token 无效' };
}
```

### 坏模式 ❌

```typescript
// ❌ 时序可攻击：字符串直接比较会逐字符短路退出
if (token !== adminToken) {
  return { valid: false, error: 'Token 无效' };
}
```

### 风险等级 🚦

| 场景 | 等级 |
|------|------|
| 内网部署，无外网暴露 | 🟡 中 |
| 公网暴露 | 🔴 高 |

**说明**：时序攻击需要大量采样（通常数万次请求），内网环境下利用门槛极高。但作为防御纵深，应始终使用时序安全比较。

---

## 2. 写操作权限守卫

### 检查要点 ✅

- [ ] 所有 POST/PUT/PATCH/DELETE 路由是否被 `writeAuthGuard()` 中间件覆盖？
- [ ] 新增路由是否遗漏了中间件挂载？
- [ ] 是否存在直接内联鉴权检查（散落代码各处）？

### 好例子 👍

```typescript
// backend/index.ts:126-134 — 集中式中间件工厂，消除重复
function writeAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const auth = requireAdminAuth(c);
      if (!auth.valid) return fail(c, auth.error!, 401);
    }
    return next();
  };
}

// index.ts:317-328 — 统一挂载，一目了然
app.use('/api/fetch/*', writeAuthGuard());
app.use('/api/articles/*', writeAuthGuard());
app.use('/api/sync/*', writeAuthGuard());
```

### 坏模式 ❌

```typescript
// ❌ 每条路由内联重复鉴权，易遗漏
router.post('/something', async (c) => {
  const auth = requireAdminAuth(c);
  if (!auth.valid) return c.json({ error: auth.error }, 401);
  // ...
});
```

### 风险等级 🚦

🔴 **高**。遗漏一个写操作路由就可能导致未授权数据修改。

### 新增路由时的操作步骤

```
1. 在 index.ts 中添加 app.use('/api/new-path/*', writeAuthGuard());
2. 确认添加位置在 app.route() 之前（中间件按注册顺序执行）
3. 确认新路由没有 GET 之外的写方法绕过守卫
```

---

## 3. CORS 跨域白名单

### 检查要点 ✅

- [ ] `ALLOWED_ORIGINS` 是否是显式枚举，而非通配符 `*`？
- [ ] 生产环境是否通过环境变量 `ALLOWED_ORIGIN` 配置了正确的域名？
- [ ] 是否存在未列出的域名可以正常访问？
- [ ] 是否允许了不必要的 HTTP 方法或请求头？

### 好例子 👍

```typescript
// backend/index.ts:62-79
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  ...(process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : []),
];

app.use('/api/*', cors({
  origin: (origin) => {
    if (!origin) return null;  // 同源请求放行
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],  // 最小方法集
  allowHeaders: ['Content-Type'],
}));
```

### 坏模式 ❌

```typescript
// ❌ 通配符 CORS，任何网站都可跨域调用 API
app.use('/api/*', cors({ origin: '*' }));
```

### 风险等级 🚦

| 场景 | 等级 |
|------|------|
| 后端无敏感用户数据 | 🟡 中 |
| 后端涉及 OAuth/Token 管理 | 🔴 高 |

**说明**：CORS 仅限制浏览器端跨域请求。非浏览器客户端（curl、Postman、脚本）不受 CORS 约束，因此 CORS 不能替代服务端鉴权。

---

## 4. 路径遍历防护

### 检查要点 ✅

- [ ] 所有接受用户输入作为文件路径参数的路由，是否检查了 `..` 和 `/`？
- [ ] 检查是否覆盖了所有路径参数（如先 `includes('..')` 再 `join`）？
- [ ] 是否有文件类型白名单（如仅允许 `.js`）？

### 好例子 👍

```typescript
// backend/index.ts:144-153 — 双重防护
// 1. 路径遍历检查
if (filename.includes('..') || filename.includes('/')) {
  return c.text('Invalid path', 400);
}
// 2. 文件类型白名单
if (ext !== '.js') return c.text('Only JS files allowed', 400);
```

```typescript
// backend/index.ts:165-182 — 图片路由同样防护
if (subdir.includes('..') || filename.includes('..') || subdir.includes('/') || filename.includes('/')) {
  return c.text('Invalid path', 400);
}
```

### 坏模式 ❌

```typescript
// ❌ 未做任何路径检查，可读取任意文件
app.get('/files/:name', async (c) => {
  const filePath = join(BASE_DIR, c.req.param('name'));
  return c.body(readFileSync(filePath));
});
// 攻击：/files/../../../etc/passwd
```

### 风险等级 🚦

🔴 **高**。路径遍历可导致任意文件读取，甚至代码执行。

### 常见绕过方式

| 输入 | 风险 | 防护是否覆盖 |
|------|------|------------|
| `../../../etc/passwd` | 父目录跳转 | ✅ `includes('..')` |
| `foo/bar` | 子目录跨越 | ✅ `includes('/')` |
| URL 编码 `..%2f..%2f` | 编码绕过 | ✅ Hono 自动解码 |
| `.../...//` | 特殊拼接 | ⚠️ 部分场景需额外校验 |

---

## 5. 密钥文件权限

### 检查要点 ✅

- [ ] `.env.json` 或其他敏感配置文件是否设置了 `0o600` 权限？
- [ ] Docker 容器中 `chmod` 失败时是否有 fallback（不阻塞启动）？
- [ ] 敏感文件是否可能被版本控制系统跟踪（是否在 `.gitignore` 中）？

### 好例子 👍

```typescript
// backend/index.ts:220-224
function saveEnvConfig(config: Record<string, string>): void {
  writeFileSync(ENV_FILE, JSON.stringify(config, null, 2), 'utf-8');
  try {
    chmodSync(ENV_FILE, 0o600); // 仅 owner 可读写
  } catch { /* Docker 挂载卷可能不支持 chmod，不影响功能 */ }
}
```

### 坏模式 ❌

```typescript
// ❌ 写入敏感文件后未限制权限，所有用户可读
writeFileSync('.env.json', JSON.stringify(config));
```

### 风险等级 🚦

🟡 **中**。多用户共享服务器场景下风险高，单用户开发机风险低。

---

## 6. 启动锁与配置验证

### 检查要点 ✅

- [ ] `REQUIRE_AUTH=true` 模式下，无 ADMIN_TOKEN 是否拒绝启动？
- [ ] 是否有清晰的启动警告提示运维人员配置缺失？
- [ ] 关键目录（OB_DIR）是否存在启动时验证？

### 好例子 👍

```typescript
// backend/index.ts:348-363
if (!getAdminToken()) {
  if (process.env.REQUIRE_AUTH === 'true') {
    console.error('🚨 [严重安全错误] REQUIRE_AUTH=true 但 ADMIN_TOKEN 未配置！');
    process.exit(1);  // 拒绝启动
  }
  console.warn('⚠️ [安全警告] ADMIN_TOKEN 未配置，仅适合本地开发！');
}

// OB_DIR 存在性检查
const obDir = getObDir();
if (!existsSync(obDir)) {
  console.warn(`⚠️ [警告] OB_DIR 不存在: ${obDir}`);
}
```

### 坏模式 ❌

```typescript
// ❌ 生产环境静默启动，无 Token 时所有接口均可匿名访问
app.listen(3000);
```

### 风险等级 🚦

🔴 **高**。生产环境无认证启动 = 完全开放的管理接口。

---

## 7. 参数化 SQL 防注入

### 检查要点 ✅

- [ ] 所有 SQL 查询是否使用 postgres.js 的 `sql\`...\`` 模板标签？
- [ ] 是否存在 `sql.unsafe()` 调用？（应禁止）
- [ ] 字符串拼接构建 SQL 是否完全消除？
- [ ] 动态条件和嵌套 Fragment 是否保持参数化？

### 好例子 👍

```typescript
// 动态条件构建，全程参数化
const conditions: ReturnType<typeof sql>[] = [];
if (search) {
  const searchPattern = `%${search}%`;
  conditions.push(sql`(a.title ILIKE ${searchPattern} OR a.content ILIKE ${searchPattern})`);
}
const whereClause = conditions.length > 0
  ? conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)
  : sql`1=1`;
const articles = await sql`
  SELECT a.* FROM articles a WHERE ${whereClause}
  ORDER BY a.published_at DESC LIMIT ${numLimit} OFFSET ${numOffset}
`;
```

### 坏模式 ❌

```typescript
// ❌ 字符串拼接，注入风险
const query = `SELECT * FROM articles WHERE title ILIKE '%${search}%'`;
await sql.unsafe(query);
```

### 风险等级 🚦

🔴 **高**。SQL 注入可导致数据泄露、篡改，甚至 RCE（取决于数据库配置）。

---

## 8. SSRF 服务端请求伪造防护

### 检查要点 ✅

- [ ] 所有从 URL 参数发起的服务端 HTTP 请求，是否经过 `isPrivateUrl()` 检查？
- [ ] 内网 IP 段检查是否全面（IPv4 / IPv6 / 域名后缀）？
- [ ] URL 解析失败时是否为安全默认（拒绝访问）？
- [ ] 是否设置了合理的 User-Agent 避免被识别为脚本？

### 好例子 👍

```typescript
// routes/articles.ts:243-280 — 完整的内网地址检测
function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    // 域名检查
    if (hostname === 'localhost' || hostname === '127.0.0.1' ||
        hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return true;
    }
    // IPv4 内网段检查：10.x.x.x, 172.16-31.x.x, 192.168.x.x, etc.
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) { /* 逐段检查 */ }
    // IPv6 内网段检查
    if (isIPv6(hostname)) { /* fc00::/7, fe80::/10 */ }
    return false;
  } catch {
    return true;  // URL 解析失败视为不安全
  }
}
```

### 坏模式 ❌

```typescript
// ❌ 直接请求用户提供的 URL，无任何校验
async function fetchContent(url: string) {
  const res = await fetch(url);  // 可请求 http://localhost:6379（Redis）
  return res.text();
}
```

### 风险等级 🚦

🔴 **高**。SSRF 可被用于扫描内网、攻击内部服务（Redis、数据库、云 meta-data 端点）。

### 常见攻击目标

| 目标 | 端口 | 危害 |
|------|------|------|
| 云元数据服务 | 80 | 获取云服务临时凭证 |
| Redis | 6379 | 写入 SSH 密钥或反弹 shell |
| 数据库 | 5432/3306 | SQL 注入或数据窃取 |
| 内部管理后台 | 任意 | 横向移动 |

---

## 9. OAuth Token 加密存储

### 检查要点 ✅

- [ ] 存储到数据库前的 Token 是否经过加密？
- [ ] 加密算法是否为 AEAD（如 AES-256-GCM）？
- [ ] 是否每次加密都使用随机 IV？
- [ ] 对称密钥的来源是否足够熵（而非固定字符串）？
- [ ] 解密失败时是否有合理错误处理（不泄露密钥信息）？

### 好例子 👍

```typescript
// routes/google-auth.ts:40-63 — AES-256-GCM 加密
function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(16);               // 每次随机 IV
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}.${encrypted}.${authTag}`;  // 附带认证标签
}
```

### 坏模式 ❌

```typescript
// ❌ 明文存储 OAuth Token
await sql`INSERT INTO tokens (access_token) VALUES (${token})`;

// ❌ 弱加密：固定 IV 的 AES-CBC
const cipher = createCipheriv('aes-256-cbc', key, fixedIV);
```

### 风险等级 🦺

| 场景 | 等级 |
|------|------|
| Token 仅用于读取公开数据 | 🟢 低 |
| Token 有写权限或访问个人数据 | 🔴 高 |

---

## 10. CSRF 跨站请求伪造防护

### 检查要点 ✅

- [ ] OAuth 流程中是否有 state 参数防 CSRF？
- [ ] state 是否使用安全的随机数生成（如 `randomBytes(16)`）？
- [ ] state 是否有过期机制（如 5 分钟）？
- [ ] state 是否一次性使用（校验后立即删除）？

### 好例子 👍

```typescript
// routes/google-auth.ts:72-115
const state = randomBytes(16).toString('hex');  // 128 位随机数
stateMap.set(state, Date.now());  // 存储时间戳

// 惰性清理过期 state
if (stateMap.size > 100) {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  for (const [s, ts] of stateMap) {
    if (ts < fiveMinAgo) stateMap.delete(s);
  }
}

// callback 时验证
const incomingState = c.req.query('state');
if (!incomingState || !stateMap.has(incomingState)) {
  return fail(c, 'Invalid state (CSRF detected)', 403);
}
stateMap.delete(incomingState);  // 一次性使用
```

### 坏模式 ❌

```typescript
// ❌ 无 state 参数
const authUrl = `https://accounts.google.com/o/oauth2/auth?client_id=...&redirect_uri=...`;
return c.json({ authUrl });

// ❌ 可预测的 state
const state = 'fixed_state_string';
```

### 风险等级 🚦

🟡 **中**。OAuth 流程中缺失 state 可被攻击者利用授权码劫持攻击。

---

## 11. XSS 跨站脚本防护

### 检查要点 ✅

- [ ] 用户输入的内容返回前端前是否经过 HTML 转义？
- [ ] 是否使用了专用的转义函数（而非简单的 `replace`）？
- [ ] 前端是否使用了 `textContent` 替代 `innerHTML`？
- [ ] 内容中的 URL 是否做了 `javascript:` 协议过滤？

### 好例子 👍

```typescript
// routes/google-auth.ts:65-69
function htmlEscape(str: string): string {
  const map: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#x27;',
  };
  return str.replace(/[&<>"']/g, (ch) => map[ch] || ch);
}
```

### 坏模式 ❌

```typescript
// ❌ 直接拼接用户内容到 HTML
const html = `<div>${userContent}</div>`;

// ❌ 只过滤了尖括号
const unsafe = str.replace(/</g, '&lt;').replace(/>/g, '&gt;');  // 未处理 & " '
```

### 风险等级 🚦

| 场景 | 等级 |
|------|------|
| 前端使用 Vue/React 等自动转义框架 | 🟢 低 |
| 后端生成 HTML 或前端使用 `innerHTML` | 🔴 高 |

---

## 12. 子进程安全

### 检查要点 ✅

- [ ] 调用外部脚本时是否使用 `spawn()` 而非 `exec()` / `execSync()`？
- [ ] 参数是否通过数组传入而非拼接字符串？
- [ ] 是否设置了 `cwd` 工作目录，避免相对路径污染？
- [ ] 是否有 shell 注入风险（参数中包含用户输入）？

### 好例子 👍

```typescript
// routes/fetch.ts:531 — spawn 数组传参，shell 注入免疫
const proc = spawn('python3', args, {
  cwd: scriptDir,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

### 坏模式 ❌

```typescript
// ❌ exec 拼接字符串，shell 注入风险
const cmd = `python3 script.py ${userInput}`;
exec(cmd, (err, stdout) => { ... });
// 攻击：userInput = "'; rm -rf /; '"
```

### 风险等级 🚦

🔴 **高**。Shell 注入可导致任意命令执行。

### `spawn` vs `exec` vs `execSync` 对比

| 方法 | Shell 调用 | 注入风险 | 适用场景 |
|------|-----------|---------|---------|
| `spawn()` | ❌ 不调用 | 🟢 安全 | ✅ 默认选择 |
| `exec()` | ✅ 调用 | 🔴 危险 | ❌ 除非有充分理由 |
| `execSync()` | ✅ 调用 | 🔴 危险 | ❌ 阻塞式，更危险 |

---

## 13. 进程超时与兜底终止

### 检查要点 ✅

- [ ] 外部脚本执行是否设置了超时？
- [ ] 超时后是否先发 SIGTERM（优雅关闭）再发 SIGKILL（强制终止）？
- [ ] SIGKILL 兜底的延迟是否合理（建议 3-5 秒）？
- [ ] 两端超时处理是否有 try/catch 防止未捕获异常？

### 好例子 👍

```typescript
// routes/fetch.ts:539-544 — 二级超时机制
setTimeout(() => {
  proc.kill('SIGTERM');              // 先优雅终止
  setTimeout(() => {
    try { proc.kill('SIGKILL'); }    // 3 秒后强制终止
    catch { /* already dead */ }
  }, 3000);
}, timeout);
```

### 坏模式 ❌

```typescript
// ❌ 无超时，子进程可能永远挂起
const proc = spawn('python3', args);
const output = await new Promise(resolve => {
  proc.stdout.on('data', data => resolve(data.toString()));
});

// ❌ 只发 SIGTERM，不兜底
setTimeout(() => proc.kill('SIGTERM'), 5000);
// 如果 SIGTERM 被忽略，进程常驻
```

### 风险等级 🚦

🟡 **中**。主要影响可用性而非机密性/完整性。

---

## 14. 并发控制与资源限制

### 检查要点 ✅

- [ ] 是否有限制同时运行的子进程或外部请求数量？
- [ ] 并发池的实现是否正确（队列 + 运行计数 + 调度）？
- [ ] 超出并发上限时是排队还是拒绝？
- [ ] 是否有资源释放保证（finally 或 catch 中减计数）？

### 好例子 👍

```typescript
// routes/fetch.ts:310-324 — 简易并发池
function createConcurrencyPool(maxConcurrency: number) {
  const queue: (() => Promise<void>)[] = [];
  let running = 0;

  function next() {
    if (queue.length > 0 && running < maxConcurrency) {
      const task = queue.shift()!;
      running++;
      task().finally(() => { running--; next(); });
    }
  }

  function enqueue(fn: () => Promise<void>) {
    queue.push(fn);
    next();
  }

  return { enqueue };
}
```

### 坏模式 ❌

```typescript
// ❌ 无限制并发，服务器资源耗尽
for (const url of urls) {
  fetchContent(url);  // 同时发起 N 个进程
}
```

### 风险等级 🚦

🟡 **中**。并发失控主要影响服务器稳定性，而非数据安全。

### 并发池参数建议

| 资源类型 | 推荐最大并发数 |
|----------|---------------|
| 外部 HTTP 请求 | 5-10 |
| Python 子进程 | 2-3 |
| 数据库查询 | 连接池上限 - 5 |

---

## 15. 统一错误响应

### 检查要点 ✅

- [ ] 错误响应是否统一格式（`{ ok: false, error: string }`）？
- [ ] 是否避免在错误消息中泄露内部实现细节（堆栈、文件路径、SQL 语句）？
- [ ] HTTP 状态码是否合理（4xx 客户端错误、5xx 服务端错误）？
- [ ] 是否所有路由都使用 `fail()` / `ok()` 而非直接 `c.json()`？

### 好例子 👍

```typescript
// shared/response.ts:26-28
export function fail(c: Context, message: string, status: any = 400): Response {
  return c.json({ ok: false, error: message } satisfies ErrorResponse, status);
}

// 使用例
if (isNaN(id) || id <= 0) return fail(c, 'Invalid id', 400);
if (article.length === 0) return fail(c, 'Not found', 404);

// 内部错误不暴露细节
try {
  // ...
} catch (e: any) {
  console.error('抓取失败:', e.message);      // 日志保留
  return fail(c, '抓取失败，请稍后重试', 500);  // 返回模糊信息
}
```

### 坏模式 ❌

```typescript
// ❌ 泄露内部信息
try {
  // ...
} catch (e: any) {
  return c.json({ error: e.message, stack: e.stack }, 500);
  // 返回："Cannot read property 'id' of undefined"
  //       "at processItem (/app/backend/routes/fetch.ts:123)"
}

// ❌ 格式不统一
return c.json({ error: '发生错误' });           // { error }
return c.json({ ok: false, msg: '失败' });       // { ok, msg }
return c.json({ success: false, data: null });   // { success }
```

### 风险等级 🚦

🟢 **低**（信息泄露场景下可升至 🟡 中）。

---

## 附录 A：安全检查流程速查表

### 新增路由时必查

```
□ 是否挂了 writeAuthGuard()？
□ 路径参数是否做了路径遍历防护？
□ URL 参数发起的 HTTP 请求是否过 isPrivateUrl()？
□ SQL 是否全程参数化？
□ 错误响应是否用 fail() 统一处理？
```

### 新增外部子进程时必查

```
□ 使用 spawn() 而非 exec()？
□ 参数数组传入，不拼接字符串？
□ 设置了超时 + SIGTERM → SIGKILL 二级兜底？
□ 并发池限制了最大进程数？
```

### 新增 OAuth / 第三方集成时必查

```
□ Token 是否加密存储（AES-256-GCM）？
□ OAuth 流程是否有 state 防 CSRF？
□ 回调验证 state 后是否删除（一次性使用）？
□ 用户输入返回到前端前是否 HTML 转义？
```

---

## 附录 B：风险等级定义

| 等级 | 含义 | 行动要求 |
|------|------|---------|
| 🔴 高 | 可直接导致数据泄露/未授权访问/RCE | **必须修复**后方可合并 |
| 🟡 中 | 攻击面扩大/权限提升/可用性受损 | **应修复**，可附技术债跟踪 |
| 🟢 低 | 信息泄露/优雅降级 | 视严重程度决定修复优先级 |

---

*最后更新：2026-05-03*
*由代码审查结果自动生成，随代码变更及时更新。*
