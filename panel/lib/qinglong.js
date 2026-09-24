/**
 * 青龙面板 OpenAPI 客户端
 *
 * 认证：系统设置 → 应用设置 里新建应用拿到的 Client ID / Client Secret。
 *   GET {host}/api/auth/token?client_id=&client_secret=  →  {code:200, data:{token, expiration}}
 *   （老版本青龙挂在 /api/system/token，这里会自动回退）
 *
 * 环境变量：
 *   GET  {host}/api/envs?searchValue=<kw>  →  {code:200, data:[{id,name,value,remarks,...}]}
 *   POST {host}/api/envs   body = 裸数组   →  新建
 *   PUT  {host}/api/envs   body = 对象，用 id 字段  →  更新
 *
 * 注意：青龙对变量名有格式校验 ^[a-zA-Z_][0-9a-zA-Z_]*$
 */

const { requestRaw } = require('./http');

const NAME_PATTERN = /^[a-zA-Z_][0-9a-zA-Z_]*$/;
const REQUEST_TIMEOUT = 15000;

/** host 允许写成 1.2.3.4:5700 或 http://1.2.3.4:5700 */
function normalizeHost(host) {
  const raw = String(host || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function pickID(env) {
  const id = env && (env.id !== undefined ? env.id : env._id);
  return id === undefined || id === null ? null : id;
}

async function fetchToken(cfg) {
  const host = normalizeHost(cfg && cfg.host);
  const clientId = String((cfg && cfg.clientId) || '').trim();
  const clientSecret = String((cfg && cfg.clientSecret) || '').trim();
  if (!host) return { ok: false, error: '未配置青龙面板地址 host' };
  if (!clientId || !clientSecret) return { ok: false, error: '未配置 Client ID / Client Secret' };

  const qs = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const paths = ['/api/auth/token', '/api/system/token'];
  const errors = [];

  for (const p of paths) {
    const res = await requestRaw(`${host}${p}?${qs}`, { timeout: REQUEST_TIMEOUT });
    if (res.status === 0) {
      errors.push(`${p}: ${res.error}`);
      continue;
    }
    const token = res.data && res.data.data && res.data.data.token;
    if (res.status === 200 && token) {
      return {
        ok: true,
        host,
        token,
        expiration: (res.data.data && res.data.data.expiration) || 0,
        endpoint: p,
      };
    }
    const msg = (res.data && (res.data.message || res.data.msg)) || `HTTP ${res.status}`;
    errors.push(`${p}: ${msg}`);
    // 404 说明该路径不存在，换下一个；其他错误直接返回，避免掩盖真实原因
    if (res.status !== 404) {
      return { ok: false, error: `青龙鉴权失败（${p}）：${msg}` };
    }
  }
  return { ok: false, error: `青龙鉴权失败：${errors.join(' | ')}` };
}

async function callAPI(cfg, path, options = {}) {
  const auth = await fetchToken(cfg);
  if (!auth.ok) return { ok: false, error: auth.error };

  const url = `${auth.host}${path}`;
  const res = await requestRaw(url, Object.assign({}, options, {
    timeout: options.timeout || REQUEST_TIMEOUT,
    headers: Object.assign({ Authorization: `Bearer ${auth.token}` }, options.headers || {}),
  }));

  if (res.status === 0) return { ok: false, error: res.error };
  const code = res.data && res.data.code;
  if (res.status !== 200 || (code !== undefined && code !== 200)) {
    const msg = (res.data && (res.data.message || res.data.msg)) || res.raw.slice(0, 200) || `HTTP ${res.status}`;
    return { ok: false, error: `青龙接口 ${path} 返回异常：${msg}`, status: res.status, code };
  }
  return { ok: true, data: res.data ? res.data.data : null, host: auth.host };
}

/** 按名字查询环境变量，返回全部同名条目 */
async function findEnvs(cfg, name) {
  const res = await callAPI(cfg, `/api/envs?searchValue=${encodeURIComponent(name)}`);
  if (!res.ok) return res;
  const list = Array.isArray(res.data) ? res.data : [];
  return { ok: true, host: res.host, list: list.filter((e) => e && e.name === name) };
}

async function createEnv(cfg, entries) {
  return callAPI(cfg, '/api/envs', { method: 'POST', body: entries });
}

async function updateEnv(cfg, entry) {
  return callAPI(cfg, '/api/envs', { method: 'PUT', body: entry });
}

/**
 * 覆盖式写环境变量：同名条目存在就改成 value，不存在就新建。
 * 有多个同名条目时只更新第一条，并在结果里说明。
 */
async function setEnv(cfg, name, value, remarks) {
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: `变量名 ${name} 不符合青龙命名规则（只允许字母、数字、下划线，且不能以数字开头）` };
  }
  const found = await findEnvs(cfg, name);
  if (!found.ok) return found;

  if (found.list.length === 0) {
    const created = await createEnv(cfg, [{ name, value, remarks: remarks || '' }]);
    if (!created.ok) return created;
    return { ok: true, action: 'created', name, value, host: created.host };
  }

  const target = found.list[0];
  const id = pickID(target);
  if (id === null) return { ok: false, error: `环境变量 ${name} 缺少 id 字段，无法更新` };
  if (String(target.value) === String(value)) {
    return { ok: true, action: 'unchanged', name, value, host: found.host, duplicates: found.list.length - 1 };
  }
  const updated = await updateEnv(cfg, {
    id,
    name,
    value,
    remarks: remarks || target.remarks || '',
  });
  if (!updated.ok) return updated;
  return {
    ok: true,
    action: 'updated',
    name,
    value,
    host: found.host,
    previous: String(target.value),
    duplicates: found.list.length - 1,
  };
}

/**
 * 追加式写环境变量：value 按行拆分，token 已存在就跳过，否则追加一行。
 * 用于 MT_TOKEN 这种「一个变量放多账号」的场景。
 */
async function appendEnvLine(cfg, name, line, remarks) {
  const found = await findEnvs(cfg, name);
  if (!found.ok) return found;

  if (found.list.length === 0) {
    return setEnv(cfg, name, line, remarks);
  }

  const target = found.list[0];
  const id = pickID(target);
  if (id === null) return { ok: false, error: `环境变量 ${name} 缺少 id 字段，无法更新` };

  const lines = String(target.value == null ? '' : target.value)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.includes(line)) {
    return { ok: true, action: 'unchanged', name, value: target.value, host: found.host, existingLines: lines.length };
  }

  const next = lines.concat([line]).join('\n');
  const updated = await updateEnv(cfg, {
    id,
    name,
    value: next,
    remarks: remarks || target.remarks || '',
  });
  if (!updated.ok) return updated;
  return {
    ok: true,
    action: 'appended',
    name,
    value: next,
    host: found.host,
    existingLines: lines.length + 1,
    duplicates: found.list.length - 1,
  };
}

/** 连接测试：鉴权 + 读一下面板版本和变量条数 */
async function testConnection(cfg) {
  const auth = await fetchToken(cfg);
  if (!auth.ok) return auth;

  const sys = await callAPI(cfg, '/api/system');
  const envs = await callAPI(cfg, '/api/envs');
  return {
    ok: true,
    host: auth.host,
    endpoint: auth.endpoint,
    version: (sys.ok && sys.data && sys.data.version) || '',
    branch: (sys.ok && sys.data && sys.data.branch) || '',
    envCount: Array.isArray(envs.data) ? envs.data.length : -1,
    envError: envs.ok ? '' : envs.error,
  };
}

module.exports = {
  normalizeHost,
  NAME_PATTERN,
  fetchToken,
  findEnvs,
  setEnv,
  appendEnvLine,
  testConnection,
};
