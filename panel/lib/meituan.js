/**
 * 美团扫码适配器
 *
 * 复用官方专家包 meituan-living-assistant 的 scripts/run.js：
 *   node run.js get-device-token    取设备标识
 *   node run.js auth-get-code       拿授权链接（缓存命中时直接给 token）
 *   node run.js qrcode <url>        把授权链接转成二维码图片
 *   node run.js auth-poll-token     阻塞等待用户扫码，成功返回 token
 *
 * auth-poll-token 最长要等十几分钟，所以放到后台任务里跑，
 * 前端通过任务 id 轮询状态。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TASK_TTL_MS = 30 * 60 * 1000;
const POLL_TIMEOUT_MS = 16 * 60 * 1000;

const tasks = new Map();
let seq = 0;

/* ---------------- run.js 定位 ---------------- */

function candidates(explicit) {
  return [
    explicit,
    process.env.MT_RUN_JS,
    process.env.PANEL_MEITUAN_RUNJS,
    path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
      'meituan-living-assistant', 'scripts', 'run.js'),
    path.join(os.homedir(), '.codebuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
      'meituan-living-assistant', 'scripts', 'run.js'),
    path.join(os.homedir(), '.workbuddy', 'plugins', 'marketplaces', 'experts', 'plugins',
      'meituan-living-deals-assistant', 'scripts', 'run.js'),
  ].filter(Boolean);
}

function resolveRunJs(explicit) {
  for (const p of candidates(explicit)) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) { /* 继续探测 */ }
  }
  return '';
}

/* ---------------- CLI 调用 ---------------- */

function runCli(runJs, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!runJs) {
      return resolve({ ok: false, error: 'RUN_JS_NOT_FOUND', message: '未找到美团专家包的 run.js，请在后台填写绝对路径' });
    }
    let child;
    try {
      child = spawn(process.execPath, [runJs, ...args], {
        cwd: path.dirname(runJs),
        env: Object.assign({}, process.env, { NODE_OPTIONS: '' }),
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: 'SPAWN_FAILED', message: String(e) });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      done({ ok: false, error: 'TIMEOUT', message: `run.js ${args[0]} 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => done({ ok: false, error: 'SPAWN_ERROR', message: String(e) }));
    child.on('close', () => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      // run.js 约定：最后一行是 JSON 结果
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          return done(Object.assign({ ok: true }, JSON.parse(lines[i])));
        } catch (_) { /* 继续往前找 */ }
      }
      done({
        ok: false,
        error: 'NO_JSON',
        message: (stderr || stdout || 'run.js 没有输出 JSON').trim().slice(0, 400),
      });
    });
  });
}

/* ---------------- 具体命令 ---------------- */

function normalizeRunJs(cfg) {
  return resolveRunJs(cfg && cfg.meituan && cfg.meituan.runJs);
}

async function environmentCheck(cfg) {
  const runJs = normalizeRunJs(cfg);
  const res = await runCli(runJs, ['init'], 120000);
  return Object.assign({ runJs }, res);
}

async function getDeviceToken(cfg) {
  return runCli(normalizeRunJs(cfg), ['get-device-token'], 60000);
}

async function authGetCode(cfg) {
  const runJs = normalizeRunJs(cfg);
  const res = await runCli(runJs, ['auth-get-code'], 120000);
  return Object.assign({ runJs }, res);
}

async function fetchQRCode(cfg, authUrl) {
  return runCli(normalizeRunJs(cfg), ['qrcode', authUrl], 60000);
}

/* ---------------- 后台任务（扫码轮询） ---------------- */

function pruneTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TASK_TTL_MS) tasks.delete(id);
  }
}

/**
 * 启动一个等待扫码的后台任务。
 * @returns {string} taskId
 */
function startPollTask(cfg) {
  pruneTasks();
  const id = `mt${++seq}_${Date.now()}`;
  const task = {
    id,
    status: 'running',
    createdAt: Date.now(),
    result: null,
    error: '',
  };
  tasks.set(id, task);

  (async () => {
    const res = await runCli(normalizeRunJs(cfg), ['auth-poll-token'], POLL_TIMEOUT_MS);
    if (res.ok && res.token) {
      task.status = 'done';
      task.result = { token: res.token };
    } else {
      task.status = 'failed';
      task.error = res.message || res.error || '登录失败，请重新扫码';
    }
  })();

  return id;
}

function getTask(id) {
  pruneTasks();
  const t = tasks.get(id);
  if (!t) return null;
  return { id: t.id, status: t.status, error: t.error, token: (t.result && t.result.token) || '' };
}

module.exports = {
  resolveRunJs,
  normalizeRunJs,
  environmentCheck,
  getDeviceToken,
  authGetCode,
  fetchQRCode,
  startPollTask,
  getTask,
};
