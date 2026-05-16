/**
 * InfoHub 前端 API 客户端增强器
 *
 * 本脚本应在主 inline script 之后加载。
 * 它会增强 window.api 函数，增加：
 * 1. 开发调试日志
 * 2. 运行时响应格式校验
 * 3. 网络异常处理（不抛到 UI 层）
 * 4. 便捷方法 api.get/post/patch/del
 */
(function () {
  'use strict';

  var BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://' + window.location.hostname + ':3001/api'
    : '/api';

  var ENABLE_LOGGING = true;

  // ---- 内部工具 ----

  function log(level, msg, data) {
    if (!ENABLE_LOGGING) return;
    var fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
    fn('[API] ' + msg, data !== undefined ? data : '');
  }

  /** 运行时格式校验：检查响应对象是否包含期望字段 */
  function checkShape(path, data, expectedKeys) {
    if (!expectedKeys || !data || typeof data !== 'object') return;
    for (var i = 0; i < expectedKeys.length; i++) {
      var key = expectedKeys[i];
      if (data[key] === undefined) {
        log('warn', '⚠️ 契约断裂 "' + path + '" 缺少字段 "' + key + '"。后端返回了: ' + Object.keys(data).join(', '));
      }
    }
  }

  // ---- 核心请求 ----

  function buildHeaders(opts) {
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    var token = window.ADMIN_TOKEN || localStorage.getItem('admin_token') || '';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  async function safeFetch(path, opts) {
    opts = opts || {};
    opts.headers = buildHeaders(opts);

    var url = opts.url || BASE + path;
    log('log', opts.method || 'GET', url);

    try {
      var res = await fetch(url, opts);
      var data = await res.json();

      if (!res.ok) {
        log('warn', opts.method + ' ' + path + ' → ' + res.status, data);
      }

      return data;
    } catch (e) {
      log('error', opts.method + ' ' + path + ' 网络异常', e.message);
      return { error: '网络请求失败: ' + e.message };
    }
  }

  // ---- 获取原始 api 函数（如果存在） ----

  var origApi = window.api;
  var isFunction = typeof origApi === 'function';

  // ---- 便捷方法 ----

  window.api = window.api || {};
  window.api.get = function (path) { return safeFetch(path, { method: 'GET' }); };
  window.api.post = function (path, body) { return safeFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); };
  window.api.patch = function (path, body) { return safeFetch(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }); };
  window.api.del = function (path) { return safeFetch(path, { method: 'DELETE' }); };
  window.api.validate = checkShape;

  // ---- 保留原有 api(path, opts) 兼容性 ----
  // 把 window.api 同时做成可调用函数
  var enhanced = async function apiCompat(path, opts) {
    if (opts && opts.method) {
      return safeFetch(path, opts);
    }
    return safeFetch(path, { method: 'GET' });
  };

  // 复制便捷方法
  enhanced.get = window.api.get;
  enhanced.post = window.api.post;
  enhanced.patch = window.api.patch;
  enhanced.del = window.api.del;
  enhanced.validate = window.api.validate;

  // 替换
  window.api = enhanced;

  // ---- 如果是增强模式（原本有 api 函数），保留旧引用 ----
  window.api.__orig = isFunction ? origApi : null;

  log('log', 'API 客户端增强器已加载');
})();
