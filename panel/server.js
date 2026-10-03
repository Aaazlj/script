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
const sign = require('./lib/sign');

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

  // 账号只存在网关里，脚本运行时自动发现，扫码不写青龙
  httpx.ok(res, { account: conf.account });
});

/**
 * 取二维码 / 复用已有 token
 *
 * run.js 的 pt-passport 缓存是「单槽位」文件（键 <client_id>@prod），所以：
 *   · 没扫过 → auth-get-code 返回 AUTH_LINK → 出二维码
 *   · 扫过一次 → 之后每次都命中缓存返回 type:'token' → 页面永远停在「已有有效登录态」
 * 想加第二个账号，必须先把槽位清掉（run.js logout），再重新取授权链接。
 *
 * body.fresh = true → 「再扫一个账号」：先 logout 清缓存，再出二维码
 * 不传 fresh       → 老行为：命中缓存就复用并落一次 MT_TOKEN（幂等）
 */
route('POST', '/api/meituan/start', async (req, res) => {
  const cfg = config.load();
  const runJs = meituan.normalizeRunJs(cfg);
  if (!runJs) {
    return httpx.fail(res, 500, '未找到美团专家包的 run.js，请先到管理后台填写路径');
  }

  const body = await httpx.readJSON(req).catch(() => ({}));
  const wantFresh = body.fresh === true || body.fresh === 1 || body.fresh === '1';

  // 官方建议先拿设备标识，失败不阻断（部分环境没有 auth.py 也能登录）
  await meituan.getDeviceToken(cfg);

  let code = await meituan.authGetCode(cfg);
  if (!code.ok && !code.type) {
    return httpx.fail(res, 502, code.message || code.error || '获取授权链接失败');
  }

  // 缓存命中：单槽位里已经躺着一个账号
  if (code.type === 'token' && code.token) {
    // 无论接下来走哪条路，都先把已有 token 落一次青龙，保证切账号时不会把这个号弄丢
    const up = await upload.uploadMeituanToken(cfg, code.token);

    if (!wantFresh) {
      const sid = newSession({ mode: 'meituan', uploaded: true });
      return httpx.ok(res, { sid, mode: 'token', cached: true, upload: up });
    }

    // 要加新账号 → 清掉单槽位缓存，才可能拿到真正的授权链接
    const lg = await meituan.logout(cfg);
    if (!lg.ok) {
      return httpx.fail(res, 502, `清除本地登录态失败（${lg.message || lg.error || '未知错误'}），无法切换到新账号`);
    }

    code = await meituan.authGetCode(cfg);
    if (code.type === 'token' && code.token) {
      return httpx.fail(res, 502, '本地登录态没清干净，仍然返回旧 token；请到管理后台点「清除本地美团登录态」后重试');
    }
    if (!code.ok && !code.type) {
      return httpx.fail(res, 502, code.message || code.error || '清除登录态后重新获取授权链接失败');
    }
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

/* 美团签名服务（供青龙里的 mt_code.py 调用，只需容器网络可达） */

route('GET', '/api/meituan/sign/health', async (req, res) => {
  httpx.ok(res, { available: sign.available() });
});

route('POST', '/api/meituan/sign', async (req, res) => {
  const ip = httpx.clientIP(req);
  if (sign.tooMany(ip)) return httpx.fail(res, 429, '签名请求过于频繁，请稍后再试');

  const body = await httpx.readJSON(req);
  const url = String(body.url || '');
  if (!/^https?:\/\//i.test(url)) return httpx.fail(res, 400, '缺少合法的 url');

  const out = sign.sign(body.method, url, String(body.bodyHash || ''));
  if (!out.ok) return httpx.fail(res, 500, out.error);
  httpx.ok(res, { url: out.url, headers: out.headers });
});

/* 应用宝账号管理（管理后台，需登录） */

route('GET', '/api/yyb/accounts', async (req, res) => {
  const cfg = config.load();
  const out = await yyb.listAccounts(cfg.yyb);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  httpx.ok(res, { accounts: out.accounts, gateway: cfg.yyb.baseUrl });
}, { admin: true });

route('POST', '/api/yyb/accounts/refresh', async (req, res) => {
  const body = await httpx.readJSON(req);
  const cfg = config.load();
  const out = await yyb.refreshAccounts(cfg.yyb, body.ref || '');
  if (!out.ok) return httpx.fail(res, 502, out.error);
  const list = await yyb.listAccounts(cfg.yyb);
  httpx.ok(res, { refreshed: out.result, accounts: list.ok ? list.accounts : [] });
}, { admin: true });

route('POST', '/api/yyb/accounts/resync', async (req, res) => {
  const body = await httpx.readJSON(req);
  const cfg = config.load();
  const out = await yyb.resyncAccounts(cfg.yyb, body.ref || '');
  if (!out.ok) return httpx.fail(res, 502, out.error);
  const list = await yyb.listAccounts(cfg.yyb);
  httpx.ok(res, { accounts: list.ok ? list.accounts : [] });
}, { admin: true });

route('DELETE', '/api/yyb/accounts', async (req, res, url) => {
  const ref = url.searchParams.get('ref') || '';
  if (!ref) return httpx.fail(res, 400, '缺少账号 ref');
  const cfg = config.load();
  const out = await yyb.deleteAccount(cfg.yyb, ref);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  httpx.ok(res, out.result);
}, { admin: true });

route('GET', '/api/yyb/avatar', async (req, res, url) => {
  const ref = url.searchParams.get('ref') || '';
  const cfg = config.load();
  const target = yyb.avatarUrl(cfg.yyb, ref);
  if (!target) return httpx.fail(res, 400, '未配置 yyb_go 网关地址');
  httpx.pipeThrough(target, res);
}, { admin: true });

/* 账号导出 / 导入 / 排序（管理后台） */

route('GET', '/api/yyb/accounts/export', async (req, res, url) => {
  const ref = url.searchParams.get('ref') || '';
  const cfg = config.load();
  const out = await yyb.exportAccounts(cfg.yyb, ref);
  if (!out.ok) return httpx.fail(res, ref ? 404 : 502, out.error);

  // 导出格式 = 纯数组，字段与其它工具的 yyb 账号文件一致，可直接互导
  const body = JSON.stringify(out.accounts, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = ref ? `yyb-account-${ref}-${stamp}.json` : `yyb-accounts-${stamp}.json`;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}, { admin: true });

route('POST', '/api/yyb/accounts/import', async (req, res) => {
  const body = await httpx.readJSON(req, 64 * 1024 * 1024);
  const payload = Array.isArray(body) ? body : body.accounts;
  if (!Array.isArray(payload) || !payload.length) {
    return httpx.fail(res, 400, '请求体应为账号数组，或 {"accounts":[...]}');
  }

  const cfg = config.load();
  const out = await yyb.importAccounts(cfg.yyb, payload);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  const result = out.result || {};
  const list = await yyb.listAccounts(cfg.yyb);
  httpx.ok(res, {
    created: result.created || 0,
    updated: result.updated || 0,
    skipped: result.skipped || [],
    accounts: list.ok ? list.accounts : [],
  });
}, { admin: true });

route('POST', '/api/yyb/accounts/order', async (req, res) => {
  const body = await httpx.readJSON(req);
  const refs = Array.isArray(body.refs) ? body.refs.map((r) => String(r)) : [];
  if (!refs.length) return httpx.fail(res, 400, '缺少 refs');

  const cfg = config.load();
  const out = await yyb.setAccountOrder(cfg.yyb, refs);
  if (!out.ok) return httpx.fail(res, 502, out.error);
  const list = await yyb.listAccounts(cfg.yyb);
  httpx.ok(res, { ordered: (out.result && out.result.ordered) || 0, accounts: list.ok ? list.accounts : [] });
}, { admin: true });

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
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(), auth.isSecureRequest(req)));
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
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(), auth.isSecureRequest(req)));
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
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.issueSession(), auth.isSecureRequest(req)));
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
  // 保存青龙配置后顺手兜底确保 yyb_server 存在（已存在则完全不动）
  let yyb_server = null;
  if (cfg.qinglong.host && cfg.qinglong.clientId && cfg.qinglong.clientSecret) {
    yyb_server = await upload.ensureYybServerEnv(cfg);
  }
  httpx.ok(res, {
    qinglong: { host: cfg.qinglong.host, clientId: cfg.qinglong.clientId, clientSecretSet: Boolean(cfg.qinglong.clientSecret) },
    yyb: cfg.yyb,
    meituan: { runJs: cfg.meituan.runJs, detectedRunJs: meituan.normalizeRunJs(cfg) },
    yyb_server,
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
  // 连接没问题就顺手兜底确保 yyb_server 存在（已存在则完全不动）
  const yybEnv = await upload.ensureYybServerEnv(cfg);
  httpx.ok(res, Object.assign({}, out, { yyb_server: yybEnv }));
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

/**
 * 查看 / 清除美团本地登录态
 *
 * run.js 的 pt-passport 缓存是单槽位文件，页面「再扫一个账号」会自动清；
 * 这里留一个手动入口，方便缓存异常（清不掉、或想强制回退到未登录状态）时自救。
 */
route('GET', '/api/admin/meituan/session', async (req, res) => {
  const cfg = config.load();
  const out = await meituan.getCachedToken(cfg);
  const token = out.ok ? String(out.token || '').trim() : '';
  httpx.ok(res, {
    hasToken: Boolean(token),
    masked: token ? (token.length > 12 ? `${token.slice(0, 8)}****${token.slice(-4)}` : '****') : '',
    error: token ? '' : (out.message || out.error || ''),
  });
}, { admin: true });

route('POST', '/api/admin/meituan/logout', async (req, res) => {
  const cfg = config.load();
  const out = await meituan.logout(cfg);
  if (!out.ok) return httpx.fail(res, 502, out.message || out.error || '清除失败');
  // 清完再探一次，确认槽位真的空了
  const probe = await meituan.getCachedToken(cfg);
  const still = probe.ok && String(probe.token || '').trim();
  httpx.ok(res, { cleared: !still, message: still ? '仍能读到缓存 token，可能 run.js 版本不支持 logout' : '已清除本地登录态' });
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
