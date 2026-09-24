/**
 * 极简 http/https 客户端 + HTTP 服务端小工具
 * 只用 Node 内置模块，零第三方依赖。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT = 15000;

/**
 * 发一个 HTTP 请求并解析 JSON。
 * 永远 resolve，不 reject：网络错误放进 { status: 0, error }。
 * @returns {Promise<{status:number, data:any, raw:string, error?:string, headers:object}>}
 */
function requestRaw(urlStr, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = DEFAULT_TIMEOUT,
    followRedirect = false,
  } = opts;

  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (_) {
      return resolve({ status: 0, data: null, raw: '', error: `非法 URL: ${urlStr}`, headers: {} });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ status: 0, data: null, raw: '', error: `不支持的协议: ${u.protocol}`, headers: {} });
    }

    const isHttp = u.protocol === 'http:';
    const lib = isHttp ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: Object.assign(
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
          headers
        ),
      },
      (res) => {
        if (followRedirect && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(requestRaw(new URL(res.headers.location, urlStr).toString(), opts));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (_) { /* 非 JSON 响应，data 保持 null */ }
          resolve({ status: res.statusCode, data, raw, headers: res.headers });
        });
      }
    );

    req.on('error', (e) => resolve({ status: 0, data: null, raw: '', error: e.message, headers: {} }));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve({ status: 0, data: null, raw: '', error: `请求超时（${timeout}ms）`, headers: {} });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------- 服务端工具 ---------------- */

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, data) {
  sendJSON(res, 200, { ok: true, data: data === undefined ? null : data });
}

function fail(res, status, message, extra) {
  sendJSON(res, status, Object.assign({ ok: false, error: message }, extra || {}));
}

function readJSON(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 只允许读取 rootDir 内的文件，防止路径穿越 */
function serveStatic(res, rootDir, urlPath) {
  let rel = decodeURIComponent(String(urlPath).split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(rootDir, rel));
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = {
  requestRaw,
  sendJSON,
  ok,
  fail,
  readJSON,
  serveStatic,
  clientIP,
};
