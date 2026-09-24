/**
 * token-web · 美团扫码登录取 token 的本地小服务
 *
 * 职责单一：
 *   扫码登录 → 展示 / 复制 token → 导出成青龙可用的环境变量
 *
 * 零第三方依赖，只用 Node 内置模块；所有敏感数据只在本机流转，
 * 服务只监听 127.0.0.1。
 *
 * 登录能力依赖官方专家包 meituan-living-assistant 的 scripts/run.js：
 * 默认按当前用户主目录自动探测，可用环境变量 MT_RUN_JS 指定绝对路径覆盖。
 *
 * 启动：node server.js   →   http://127.0.0.1:5178
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 自动定位官方专家包里的 run.js（登录能力由它提供）。
// 不再写死某个机器的绝对路径：先用 MT_RUN_JS 覆盖，再按当前用户主目录探测。
function resolveRunJs() {
  const candidates = [
    process.env.MT_RUN_JS,
    path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
              'meituan-living-assistant', 'scripts', 'run.js'),
    path.join(os.homedir(), '.codebuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
              'meituan-living-assistant', 'scripts', 'run.js'),
    path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
              'meituan-living-deals-assistant', 'scripts', 'run.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* 继续探测 */ }
  }
  return null;
}

const RUN_JS = resolveRunJs();
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 5178);
const HOST = '127.0.0.1';

const COUPON_API = 'https://media.meituan.com/fulishemini/couponActivity/sendCouponWork';
const AI_SCENE = (process.env.MT_AI_SCENE || '').trim();

/* ------------------------------------------------------------------ *
 * run.js 子进程调用（登录相关）
 * ------------------------------------------------------------------ */

function runCli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!RUN_JS) {
      return resolve({
        ok: false,
        error: 'RUN_JS_NOT_FOUND',
        message: '未找到美团专家包的 run.js，请安装「领券下单找我」专家，或用 MT_RUN_JS 指定其绝对路径',
      });
    }
    let child;
    try {
      child = spawn(process.execPath, [RUN_JS, ...args], {
        windowsHide: true,
        cwd: path.dirname(RUN_JS),
      });
    } catch (err) {
      return resolve({ ok: false, error: 'SPAWN_FAILED', message: String(err) });
    }

    let out = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done({ ok: false, error: 'TIMEOUT' });
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (e) => done({ ok: false, error: 'SPAWN_ERROR', message: String(e) }));
    child.on('close', () => {
      const text = out.trim();
      if (!text) return done({ ok: false, error: 'EMPTY_OUTPUT' });
      try { done(JSON.parse(text)); } catch (_) { done({ ok: false, error: 'PARSE_ERROR', raw: text.slice(0, 300) }); }
    });
  });
}

const COMMANDS = {
  'get-token': { timeout: 60000 },
  'auth-get-code': { timeout: 120000 },
  qrcode: { timeout: 60000 },
  'auth-poll-token': { timeout: 900000, async: true },
  logout: { timeout: 60000 },
};

/* ------------------------------------------------------------------ *
 * 异步任务（扫码轮询可能持续几分钟）
 * ------------------------------------------------------------------ */

const tasks = new Map();
let taskSeq = 0;

function startTask(cmd, argv) {
  const id = `t${++taskSeq}_${Date.now()}`;
  const record = { id, cmd, status: 'pending', result: null };
  tasks.set(id, record);
  const spec = COMMANDS[cmd];

  (async () => {
    const args = cmd === 'qrcode' ? ['qrcode', ...argv] : [cmd];
    record.result = await runCli(args, spec.timeout);
    record.status = 'done';
    setTimeout(() => tasks.delete(id), 10 * 60 * 1000).unref?.();
  })();

  return id;
}

/* ------------------------------------------------------------------ *
 * 直接用 token 调领券接口（验证 token 是否可用）
 * 与青龙脚本走完全相同的请求，不经过任何签名组件
 * ------------------------------------------------------------------ */

function verifyToken(token) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ token, aiScene: AI_SCENE, version: 2 }), 'utf8');
    const parsed = new URL(COUPON_API);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const data = JSON.parse(raw);
            resolve({
              http: res.statusCode,
              code: data.code,
              msg: data.msg || '',
              couponCount: ((data.data || {}).couponList || []).length,
            });
          } catch (_) {
            resolve({ http: res.statusCode, code: null, msg: '响应解析失败', raw: raw.slice(0, 200) });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ http: 0, code: null, msg: `网络异常：${e.message}` }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ http: 0, code: null, msg: '请求超时' }); });
    req.write(body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 200_000) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
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

function mask(token) {
  if (!token) return '';
  return token.length > 12 ? `${token.slice(0, 8)}****${token.slice(-4)}` : '****';
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  res.setHeader('Access-Control-Allow-Origin', `http://${HOST}:${PORT}`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!url.startsWith('/api/')) return serveStatic(res, url);

  try {
    if (url === '/api/health') return sendJson(res, 200, { ok: true, service: 'token-web' });

    // GET /api/token — 返回完整 token（本页的核心用途）
    if (url === '/api/token') {
      const r = await runCli(['get-token']);
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error || 'NO_TOKEN' });
      return sendJson(res, 200, { ok: true, token: r.token, length: r.token.length, masked: mask(r.token) });
    }

    // GET /api/task/:id
    if (url.startsWith('/api/task/')) {
      const record = tasks.get(url.slice('/api/task/'.length));
      if (!record) return sendJson(res, 404, { ok: false, error: 'TASK_NOT_FOUND' });
      const result = record.status === 'done' ? record.result : null;
      const safe = result && result.token ? { ...result, token: mask(result.token) } : result;
      return sendJson(res, 200, { ok: true, status: record.status, result: safe });
    }

    // POST /api/run { cmd, argv }
    if (url === '/api/run') {
      const body = await readBody(req);
      const cmd = body.cmd;
      if (!COMMANDS[cmd]) return sendJson(res, 400, { ok: false, error: 'UNKNOWN_COMMAND' });
      const args = cmd === 'qrcode' ? ['qrcode', ...(body.argv || [])] : [cmd];
      const r = await runCli(args, COMMANDS[cmd].timeout);
      const safe = r && r.token ? { ...r, token: mask(r.token) } : r;
      return sendJson(res, 200, safe);
    }

    // POST /api/task { cmd, argv }
    if (url === '/api/task') {
      const body = await readBody(req);
      const cmd = body.cmd;
      if (!COMMANDS[cmd]) return sendJson(res, 400, { ok: false, error: 'UNKNOWN_COMMAND' });
      return sendJson(res, 200, { ok: true, taskId: startTask(cmd, body.argv || []) });
    }

    // POST /api/verify-token { token }
    if (url === '/api/verify-token') {
      const body = await readBody(req);
      if (!body.token) return sendJson(res, 400, { ok: false, error: 'MISSING_TOKEN' });
      const r = await verifyToken(body.token);
      const meaning = {
        200: r.couponCount ? `token 有效，本次领到 ${r.couponCount} 张券` : 'token 有效',
        1014: 'token 有效，但今天已经领过券了',
        401: 'token 已失效，请重新扫码登录',
        509: '请求过于频繁，稍后再试',
        50200: '请求过于频繁，稍后再试',
      }[r.code] || `未知返回 code=${r.code} msg=${r.msg}`;
      return sendJson(res, 200, { ok: r.code === 200 || r.code === 1014, ...r, meaning });
    }

    // POST /api/export-token { token, target }
    if (url === '/api/export-token') {
      const body = await readBody(req);
      if (!body.token) return sendJson(res, 400, { ok: false, error: 'MISSING_TOKEN' });
      const content = `export MT_TOKEN=${body.token}\n`;

      let target = body.target;
      if (!target) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
        target = path.join(DATA_DIR, 'mt_token.txt');
      }
      try {
        fs.writeFileSync(target, content, 'utf8');
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'WRITE_FAILED', message: e.message });
      }
      return sendJson(res, 200, { ok: true, path: target, content });
    }

    return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: 'INTERNAL', message: String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[token-web] http://${HOST}:${PORT}  (仅本机可访问)`);
});

server.on('error', (err) => {
  console.error('[token-web] 启动失败：', err.message);
  process.exit(1);
});
