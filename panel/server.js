#!/usr/bin/env node
/**
 * 扫码登录面板 · 统一入口
 *
 * 普通用户：打开首页 → 选「应用宝」或「美团」→ 扫码 → 自动把凭据写进青龙。
 * 管理员： 打开 /admin → 首次引导设置密码 → 配置青龙 host / Client ID / Client Secret。
 *
 * 启动：
 *   node server.js [--host 0.0.0.0] [--port 5180]
 *
 * 零第三方依赖，只用 Node 内置模块。
 */

const http = require('http');
const path = require('path');
const { URL } = require('url');

const config = require('./lib/config');
const auth = require('./lib/auth');
const httpx = require('./lib/http');
const qinglong = require('./lib/qinglong');
const yyb = require('./lib/yyb');
const meituan = require('./lib/meituan');
const upload = require('./lib/upload');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_QR_SESSIONS = 200;

/* ---------------- 内存态 ---------------- */

// 扫到的账号会话：{ sid: { mode, sessionId, authUrl, taskId, createdAt, uploaded } }
const sessions = new Map();

function pruneSessions() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of sessions) {
    if (v.createdAt < cutoff) sessions.delete(k);
  }
  while (sessions.size > MAX_QR_SESSIONS) {
    sessions.delete(sessions.keys().next().value);
  }
}

function newSession(payload) {
  pruneSessions();
  const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(sid, Object.assign({ createdAt: Date.now() }, payload));
  return sid;
}

/* ---------------- 路由 ---------------- */

const routes = [];

function route(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, admin: !!opts.admin });
}

/* 公共 */

route('GET', '/api/health', async (req, res) => {
  const cfg = config.load();
  httpx.ok(res, {
    needsSetup: !cfg.admin.passwordHash,
    qinglongConfigured: Boolean(cfg.qinglong.host && cfg.qinglong.clientId && cfg.qinglong.clientSecret),
    yybBaseUrl: cfg.yyb.baseUrl,
  });
});

route('POST', '/api/yyb/qr', async (req, res) => {
  const cfg = config.load();
  const out = await yyb.createQR(cfg.yyb);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  const sid = newSession({ mode: 'yyb', yybSessionId: out.sessionId });
  httpx.ok(res, {
    sid,
    yybSessionId: out.sessionId,
    imageBase64: out.imageBase64,
    imageUrl: out.imageUrl,
  });
});

route('GET', '/api/yyb/poll', async (req, res, url) => {
  const sid = url.searchParams.get('sid') || '';
  const sess = sessions.get(sid);
  if (!sess || sess.mode !== 'yyb') return httpx.fail(res, 404, '扫码会话不存在或已过期，请刷新重试');

  const cfg = config.load();
  const out = await yyb.pollQR(cfg.yyb, sess.yybSessionId);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  httpx.ok(res, { status: out.status, errcode: out.errcode });
});

route('POST', '/api/yyb/confirm', async (req, res) => {
  const body = await httpx.readJSON(req);
  const sid = body.sid;
  const sess = sessions.get(sid);
  if (!sess || sess.mode !== 'yyb') return httpx.fail(res, 404, '扫码会话不存在或已过期，请刷新重试');

  const cfg = config.load();
  const conf = await yyb.confirmQR(cfg.yyb, sess.yybSessionId);
  if (!conf.ok) return httpx.fail(res, 502, conf.error);
  sessions.delete(sid);

  const up = await upload.uploadYybServer(cfg, req);
  httpx.ok(res, { account: conf.account, upload: up });
});

route('POST', '/api/meituan/start', async (req, res) => {
  const cfg = config.load();
  const runJs = meituan.normalizeRunJs(cfg);
  if (!runJs) {
    return httpx.fail(res, 500, '未找到美团专家包的 run.js，请先到管理后台填写路径');
  }

  // 官方建议先拿设备标识，失败不阻断（部分环境没有 auth.py 也能登录）
  await meituan.getDeviceToken(cfg);

  const code = await meituan.authGetCode(cfg);
  if (!code.ok && !code.type) {
    return httpx.fail(res, 502, code.message || code.error || '获取授权链接失败');
  }

  // 缓存命中：已有可用 token，直接上传
  if (code.type === 'token' && code.token) {
    const up = await upload.uploadMeituanToken(cfg, code.token);
    const sid = newSession({ mode: 'meituan', uploaded: true });
    return httpx.ok(res, { sid, mode: 'token', upload: up });
  }

  if (code.type !== 'auth_link' || !code.url) {
    return httpx.fail(res, 502, code.message || `未知返回：${JSON.stringify(code).slice(0, 200)}`);
  }

  const qr = await meituan.fetchQRCode(cfg, code.url);
  const taskId = meituan.startPollTask(cfg);
  const sid = newSession({ mode: 'meituan', taskId, authUrl: code.url });

  httpx.ok(res, {
    sid,
    mode: 'qrcode',
    authUrl: code.url,
    imageUrl: qr.ok ? qr.imageUrl || '' : '',
    imageBase64: qr.ok ? qr.imageBase64 || '' : '',
    qrError: qr.ok ? '' : qr.message || qr.error || '',
  });
});

route('GET', '/api/meituan/status', async (req, res, url) => {
  const sid = url.searchParams.get('sid') || '';
  const sess = sessions.get(sid);
  if (!sess || sess.mode !== 'meituan') return httpx.fail(res, 404, '扫码会话不存在或已过期，请刷新重试');

  if (sess.uploaded) return httpx.ok(res, { status: 'done', upload: sess.upload || null });

  const task = meituan.getTask(sess.taskId);
  if (!task) return httpx.fail(res, 404, '登录任务已过期，请刷新重试');
  if (task.status === 'running') return httpx.ok(res, { status: 'running' });
  if (task.status === 'failed') {
    sessions.delete(sid);
    return httpx.ok(res, { status: 'failed', message: task.error });
  }

  // 只有第一次轮询到成功时才真正上传，避免重复写
  const cfg = config.load();
  const up = await upload.uploadMeituanToken(cfg, task.token);
  sess.uploaded = true;
  sess.upload = up;
  sessions.delete(sid);
  httpx.ok(res, { status: 'done', upload: up });
});

/* 管理后台 */

route('GET', '/api/admin/health', async (req, res) => {
  const cfg = config.load();
  httpx.ok(res, {
    needsSetup: !cfg.admin.passwordHash,
    loggedIn: auth.isLoggedIn(req),
  });
});

route('POST', '/api/admin/setup', async (req, res) => {
  const cfg = config.load();
  if (cfg.admin.passwordHash) return httpx.fail(res, 409, '管理员密码已设置，请直接登录');

  const body = await httpx.readJSON(req);
  const password = String(body.password || '');
  if (password.length < 8) return httpx.fail(res, 400, '密码至少 8 位');
  if (password !== String(body.confirm || '')) return httpx.fail(res, 400, '两次输入的密码不一致');

  // 防止别人抢先设置密码：只允许本机或首个访问者
  auth.setPassword(password);
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession()));
  httpx.ok(res, { configured: true });
});

route('POST', '/api/admin/login', async (req, res) => {
  const ip = httpx.clientIP(req);
  if (auth.tooManyAttempts(ip)) return httpx.fail(res, 429, '尝试次数过多，请 10 分钟后再试');

  const body = await httpx.readJSON(req);
  if (!auth.verifyPassword(body.password)) {
    auth.recordFailure(ip);
    return httpx.fail(res, 401, '密码错误');
  }
  auth.clearFailures(ip);
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession()));
  httpx.ok(res, { loggedIn: true });
});

route('POST', '/api/admin/logout', async (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie());
  httpx.ok(res, { loggedIn: false });
});

route('POST', '/api/admin/password', async (req, res) => {
  const body = await httpx.readJSON(req);
  if (!auth.verifyPassword(body.oldPassword)) return httpx.fail(res, 401, '原密码错误');
  const next = String(body.newPassword || '');
  if (next.length < 8) return httpx.fail(res, 400, '新密码至少 8 位');
  if (next !== String(body.confirm || '')) return httpx.fail(res, 400, '两次输入的新密码不一致');
  auth.setPassword(next);
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession()));
  httpx.ok(res, { changed: true });
}, { admin: true });

route('GET', '/api/admin/config', async (req, res) => {
  const cfg = config.load();
  httpx.ok(res, {
    qinglong: {
      host: cfg.qinglong.host,
      clientId: cfg.qinglong.clientId,
      clientSecretSet: Boolean(cfg.qinglong.clientSecret),
    },
    yyb: {
      baseUrl: cfg.yyb.baseUrl,
      publicBaseUrl: cfg.yyb.publicBaseUrl,
    },
    meituan: {
      runJs: cfg.meituan.runJs,
      detectedRunJs: meituan.normalizeRunJs(cfg),
      aiScene: cfg.meituan.aiScene,
    },
  });
}, { admin: true });

route('PUT', '/api/admin/config', async (req, res) => {
  const body = await httpx.readJSON(req);
  const patch = {};

  if (body.qinglong) {
    patch.qinglong = {
      host: String(body.qinglong.host || '').trim(),
      clientId: String(body.qinglong.clientId || '').trim(),
    };
    // Client Secret 留空表示不改动，避免前端拿到脱敏值后又写回去
    if (typeof body.qinglong.clientSecret === 'string' && body.qinglong.clientSecret !== '') {
      patch.qinglong.clientSecret = body.qinglong.clientSecret.trim();
    }
  }
  if (body.yyb) {
    patch.yyb = {
      baseUrl: String(body.yyb.baseUrl || '').trim() || config.DEFAULTS.yyb.baseUrl,
      publicBaseUrl: String(body.yyb.publicBaseUrl || '').trim(),
    };
  }
  if (body.meituan) {
    patch.meituan = {
      runJs: String(body.meituan.runJs || '').trim(),
      aiScene: String(body.meituan.aiScene || '').trim(),
    };
  }

  const cfg = config.update(patch);
  httpx.ok(res, {
    qinglong: { host: cfg.qinglong.host, clientId: cfg.qinglong.clientId, clientSecretSet: Boolean(cfg.qinglong.clientSecret) },
    yyb: cfg.yyb,
    meituan: { runJs: cfg.meituan.runJs, detectedRunJs: meituan.normalizeRunJs(cfg) },
  });
}, { admin: true });

route('POST', '/api/admin/config/clear-secret', async (req, res) => {
  config.update({ qinglong: { clientSecret: '' } });
  httpx.ok(res, { cleared: true });
}, { admin: true });

route('POST', '/api/admin/test/qinglong', async (req, res) => {
  const cfg = config.load();
  const out = await qinglong.testConnection(cfg.qinglong);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  httpx.ok(res, out);
}, { admin: true });

route('POST', '/api/admin/test/yyb', async (req, res) => {
  const cfg = config.load();
  const out = await yyb.health(cfg.yyb);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  httpx.ok(res, out);
}, { admin: true });

route('POST', '/api/admin/test/meituan', async (req, res) => {
  const cfg = config.load();
  const out = await meituan.environmentCheck(cfg);
  if (!out.runJs) return httpx.fail(res, 500, '未找到 run.js，请填写绝对路径');
  if (!out.ok) return httpx.fail(res, 502, out.message || out.error || '环境检查失败');
  httpx.ok(res, { runJs: out.runJs, scripts_dir: out.scripts_dir, clientType: out.clientType });
}, { admin: true });

/* ---------------- 匹配与分发 ---------------- */

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method || r.pattern !== pathname) continue;
    return r;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return httpx.fail(res, 400, '非法请求');
  }
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      const r = match(req.method, pathname);
      if (!r) return httpx.fail(res, 404, '接口不存在');
      if (r.admin && !auth.isLoggedIn(req)) return httpx.fail(res, 401, '未登录或登录已过期');
      return await r.handler(req, res, url);
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      return httpx.serveStatic(res, PUBLIC_DIR, '/admin.html');
    }
    if (req.method !== 'GET') return httpx.fail(res, 405, '方法不允许');
    return httpx.serveStatic(res, PUBLIC_DIR, pathname);
  } catch (e) {
    if (!res.headersSent) httpx.fail(res, 500, String((e && e.message) || e));
  }
});

/* ---------------- 启动 ---------------- */

function parseArgs(argv) {
  const args = { host: '0.0.0.0', port: Number(process.env.PORT || 5180) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) args.host = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cfg = config.load();
  server.listen(args.port, args.host, () => {
    console.log(`[panel] 扫码面板已启动：http://${args.host}:${args.port}`);
    console.log(`[panel] 用户入口：/        管理后台：/admin`);
    console.log(`[panel] 配置文件：${config.CONFIG_FILE}`);
    if (!cfg.admin.passwordHash) {
      console.log('[panel] 首次使用，请打开 /admin 设置管理员密码');
    }
  });
  server.on('error', (err) => {
    console.error('[panel] 启动失败：', err.message);
    process.exit(1);
  });
}

module.exports = { server };
