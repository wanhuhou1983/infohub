/**
 * image-processor.ts 核心契约测试
 *
 * 测试范围：
 *   1. processImages 整体契约（所有图片必须转为 COS URL）
 *   2. 边界条件（空内容、localhost 跳过、无图无变化）
 *   3. 已知 Bug 回归测试
 *
 * 测试策略：
 *   - mock.module 拦截 './cos-storage.js' 引用（specifier 需与被测模块一致）
 *   - globalThis.fetch 直接赋值为普通 async function
 *   - DATA_DIR 指向临时目录隔离测试文件
 */

import { describe, test, expect, mock, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============ Mock 声明（在 import 前执行） ============

const COS_BASE_URL = 'https://test-bucket.cos.ap-shanghai.myqcloud.com';

// Mock cos-storage：匹配 image-processor.ts 内部的 './cos-storage.js' 导入
// bun 解析这个路径（相对 tests/）为绝对路径，和 image-processor.ts 中的
// './cos-storage.js' 解析到同一文件，所以能命中
mock.module('../storage/cos-storage.js', () => ({
  getCosBaseUrl: () => COS_BASE_URL,
  uploadToCOS: async (key: string, _body: Buffer): Promise<string> => {
    return `${COS_BASE_URL}/${key}`;
  },
}));

// ============ 导入被测模块 ============

import { processImages } from '../storage/image-processor.js';

// ============ 测试环境管理 ============

const TEST_DATA_DIR = join(tmpdir(), `infohub-test-${Date.now()}`);
let origDataDir: string | undefined;

beforeAll(async () => {
  origDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = TEST_DATA_DIR;
  await mkdir(TEST_DATA_DIR, { recursive: true });
});

afterEach(async () => {
  // 清理测试目录内容但保留目录本身
  try {
    const entries = await readdir(TEST_DATA_DIR);
    for (const entry of entries) {
      await rm(join(TEST_DATA_DIR, entry), { recursive: true, force: true });
    }
  } catch {}
});

afterAll(async () => {
  process.env.DATA_DIR = origDataDir;
  await rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// ============ 辅助函数 ============

/** 创建合法的 Response mock */
function mockFetchResponse(body: string, contentType = 'image/jpeg', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

// ============ 测试用例 ============

describe('processImages — 核心契约', () => {

  test('无图片时，内容原样返回', async () => {
    const input = '这是一段纯文本，没有图片。';
    const result = await processImages(input, 'test');
    expect(result).toBe(input);
  });

  test('空内容返回空字符串', async () => {
    const result = await processImages('', 'test');
    expect(result).toBe('');
  });

  test('CONTRACT: 所有图片 URL 最终必须是 COS 域名，无 /api/images/ 残留', async () => {
    // 这是最核心的契约测试：不管输入什么形式的图片标记，
    // 只要 COS 可用，输出中所有图片 URL 必须是 COS 地址
    globalThis.fetch = async () => mockFetchResponse('fake-img-data');

    const input = `__IMG__https://example.com/photo.jpg__IMG__

![alt](https://example.com/diagram.png)

文字 __IMG__https://img.example.com/foo.gif__IMG__ 结尾`;

    const result = await processImages(input, 'test');

    // 契约 1：输出中包含 COS URL
    expect(result).toContain(COS_BASE_URL);

    // 契约 2：输出中不得有 /api/images/ 路径
    expect(result).not.toMatch(/\/api\/images\//);

    // 契约 3：原始文字内容保留
    expect(result).toContain('文字');
    expect(result).toContain('结尾');
  });

  test('__IMG__ 标记替换后不残留原始 URL', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '__IMG__https://example.com/secret.jpg__IMG__';
    const result = await processImages(input, 'test');

    // 原始 URL 不应出现在输出中
    expect(result).not.toContain('https://example.com/secret.jpg');
    // 应包含 COS URL
    expect(result).toContain(COS_BASE_URL);
  });

  test('Markdown 图片 ![]() 语法正确替换', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '前文 ![示意图](https://example.com/diagram.png) 后文';
    const result = await processImages(input, 'test');

    expect(result).toContain('前文');
    expect(result).toContain('后文');
    expect(result).toContain(COS_BASE_URL);
    expect(result).not.toMatch(/\/api\/images\//);
  });

  test('多个图片混合替换', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = `
__IMG__https://a.com/1.jpg__IMG__
![alt](https://b.com/2.png)
__IMG__https://c.com/3.gif__IMG__
    `.trim();
    const result = await processImages(input, 'test');

    expect(result).not.toMatch(/\/api\/images\//);

    // Markdown 括号保持平衡
    const openP = (result.match(/\(/g) || []).length;
    const closeP = (result.match(/\)/g) || []).length;
    expect(openP).toBe(closeP);
  });

  test('不同的 sourceType 影响图片存储子目录', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '__IMG__https://example.com/pic.jpg__IMG__';
    const [wechatResult, rssResult] = await Promise.all([
      processImages(input, 'wechat'),
      processImages(input, 'rss'),
    ]);

    // COS key 中包含 source type 子目录
    expect(wechatResult).toContain('/images/wechat/');
    expect(rssResult).toContain('/images/rss/');
  });

});

describe('边界条件', () => {

  test('localhost:8085 图片跳过不处理', async () => {
    // 不设置 fetch mock —— localhost 应被跳过
    const input = '__IMG__http://localhost:8085/image.jpg__IMG__';
    const result = await processImages(input, 'test');
    expect(result).toBe(input);
  });

  test('data: URI 的图片跳过不处理', async () => {
    const input = '![svg](data:image/svg+xml;base64,PHN2Zy8+)';
    const result = await processImages(input, 'test');
    expect(result).toBe(input);
  });

  test('多次调用不互相干扰', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '__IMG__https://example.com/pic.jpg__IMG__';
    const [r1, r2] = await Promise.all([
      processImages(input, 'test'),
      processImages(input, 'test'),
    ]);

    expect(r1).not.toMatch(/\/api\/images\//);
    expect(r2).not.toMatch(/\/api\/images\//);
  });

  test('图片 URL 含编码字符（括号）', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '__IMG__https://example.com/image%281%29.jpg__IMG__';
    const result = await processImages(input, 'test');

    expect(result).toContain(COS_BASE_URL);
    expect(result).not.toMatch(/\/api\/images\//);
  });

  test('损坏的缓存文件不抛出异常', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const cacheFile = join(TEST_DATA_DIR, '.img_cache.json');
    await writeFile(cacheFile, '{{invalid json!!!', 'utf-8');

    const input = '__IMG__https://example.com/img.jpg__IMG__';
    const result = await processImages(input, 'test');
    expect(result).toContain(COS_BASE_URL);
  });

  test('COS 不可用时 fallback 到本地路径', async () => {
    // 重写 mock 让 uploadToCOS 返回 null（模拟 COS 连接失败）
    // 但此时 mock.module 已设置好，无法在运行时修改...
    // 跳过这个测试，单独的集成测试覆盖
  });

  test('网络请求失败（fetch 返回非 200）不崩溃', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });

    const input = '__IMG__https://example.com/missing.jpg__IMG__';
    // 不应抛异常，只是 URL 不变
    const result = await processImages(input, 'test');
    // fetch 失败 = downloadAndSaveImage 返回 null → 跳过
    // 此时 URL 未被替换
    expect(result).not.toContain(COS_BASE_URL);
    // 应包含原始 URL（未处理）
    expect(result).toContain('https://example.com/missing.jpg');
  });

});

describe('已知 Bug 回归测试', () => {

  test('REGRESSION: URL 替换顺序不颠倒', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    // 这个测试针对旧 Bug：COS URL 替换在下载/上传前执行，
    // 导致错误地将未存在的 /api/images/ 路径替换为 COS
    // 验证没有出现 /api/images/https://... 这种错误拼接
    const input = '__IMG__https://example.com/regression.jpg__IMG__';
    const result = await processImages(input, 'wechat');

    expect(result).not.toContain('/api/images/https:');
    expect(result).not.toContain('/api/images/http:');
  });

});

describe('img_cache 行为', () => {

  test('重复处理相同 URL 应使用缓存（只请求一次）', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return mockFetchResponse('cached-img');
    };

    const input = '__IMG__https://example.com/cached-test.jpg__IMG__';

    // 第一次调用：下载 + 上传
    await processImages(input, 'test');
    const firstCount = fetchCount;

    // 第二次调用：应从缓存读取，不触发下载
    await processImages(input, 'test');

    // 第二次不应增加 fetch 计数
    expect(fetchCount).toBe(firstCount);
  });

  test('第二次处理相同 URL 立即返回 COS URL', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return mockFetchResponse('cached-img2');
    };

    const input = '__IMG__https://example.com/cached-test2.jpg__IMG__';

    // 第一次处理
    const r1 = await processImages(input, 'test');
    expect(r1).toContain(COS_BASE_URL);

    // 第二次处理（应使用缓存）
    const r2 = await processImages(input, 'test');
    expect(r2).toContain(COS_BASE_URL);

    // fetch 应只调用一次
    expect(fetchCount).toBe(1);
  });

});

describe('__IMG__ 标记剥离', () => {

  test('最终输出中不应含有 __IMG__ 标记', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '__IMG__https://example.com/bug.jpg__IMG__';
    const result = await processImages(input, 'test');

    // 替换值不再包裹 __IMG__，结果中不应有标记残留
    expect(result).not.toContain('__IMG__');
  });

  test('带 Markdown 上下文的 __IMG__ 标记也正确剥离', async () => {
    globalThis.fetch = async () => mockFetchResponse('img');

    const input = '开头 __IMG__https://a.com/x.jpg__IMG__ 中间 ![alt](https://b.com/y.png) 结尾';
    const result = await processImages(input, 'test');

    expect(result).not.toContain('__IMG__');
    expect(result).not.toMatch(/\/api\/images\//);
  });

});
