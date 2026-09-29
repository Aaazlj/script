/**
 * 青龙面板 OpenAPI 客户端
 *
 * 青龙有两代应用鉴权，代码会自动探测，两代都支持：
 *
 * ① 新版（约 2.17+，实测 2.21.0）—— 必须走 /open 前缀
 *      GET /open/auth/token?client_id=&client_secret=
 *        -> { code:200, data:{ token, token_type:"Bearer", expiration } }
 *      拿到的是**应用令牌（UUID，不是 JWT）**，后续接口也必须走 /open：
 *        /open/envs、/open/system（服务端把 /open/* 重写到 /api/*）
 *      用应用令牌打 /api/* 会直接 401「jwt malformed」。
 *      /open/* 还会校验应用 scope，缺 scope 时返回 401「暂无权限」。
 *
 * ② 老版本 —— 走 /api 前缀
 *      GET /api/auth/token?client_id=&client_secret=  -> JWT
 *      后续 /api/envs、/api/system
 *
 * 环境变量接口两代一致：
 *   GET    .../envs?searchValue=<kw>   -> data 是数组
 *   POST   .../envs  body = 裸数组      -> 新建
 *   PUT    .../envs  body = 对象（标识字段是数字 id）  -> 更新
 *   DELETE .../envs  body = id 数组     -> 删除
 * 变量名规则：^[a-zA-Z_][0-9a-zA-Z_]*$
 */

const { requestRaw } = require('./http');

const NAME_PATTERN = /^[a-zA-Z_][0-9a-zA-Z_]*$/;
const REQUEST_TIMEOUT = 15000;

// 按优先级探测：新版 /open 优先，失败再退到老版 /api
const AUTH_CANDIDATES = [
  { path: '/open/auth/token', flavor: 'open' },
  { path: '/api/auth/token', flavor: 'api' },
  { path: '/api/system/token', flavor: 'api' },
];

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

/** 上游返回的不是 JSON 时，给出能直接定位问题的提示 */
function describeBadResponse(status, raw) {
  const head = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!head) return `HTTP ${status}（空响应）`;
  if (head.startsWith('<')) {
    return `HTTP ${status}，返回的是 HTML 错误页而不是 JSON —— 多半是反向代理 / 网关（nginx、Cloudflare）报的错，不是青龙本身。原文：${head}`;
  }
  return `HTTP ${status}：${head}`;
}

function extractMessage(body, status) {
  const m = body && (body.message || body.msg);
  return m || `HTTP ${status}`;
}

/**
 * 探测应用鉴权：返回 { ok, host, token, tokenType, flavor, endpoint }
 * flavor = 'open' | 'api'，决定后续接口用哪个前缀
 */
async function fetchToken(cfg) {
  const host = normalizeHost(cfg && cfg.host);
  const clientId = String((cfg && cfg.clientId) || '').trim();
  const clientSecret = String((cfg && cfg.clientSecret) || '').trim();
  if (!host) return { ok: false, error: '未配置青龙面板地址 host' };
  if (!clientId || !clientSecret) return { ok: false, error: '未配置 Client ID / Client Secret' };

  const qs = `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const attempts = [];

  for (const c of AUTH_CANDIDATES) {
    const res = await requestRaw(`${host}${c.path}?${qs}`, { timeout: REQUEST_TIMEOUT });

    if (res.status === 0) {
      // 网络层不通，换路径也没用，直接返回
      return { ok: false, error: `连不上青龙面板 ${host}：${res.error}` };
    }
    if (!res.data) {
      attempts.push(`${c.path}: ${describeBadResponse(res.status, res.raw)}`);
      continue;
    }

    const token = res.data.data && res.data.data.token;
    if (res.status === 200 && res.data.code === 200 && token) {
      return {
        ok: true,
        host,
        token,
        tokenType: (res.data.data && res.data.data.token_type) || 'Bearer',
        expiration: (res.data.data && res.data.data.expiration) || 0,
        flavor: c.flavor,
        endpoint: c.path,
      };
    }
    attempts.push(`${c.path}: ${extractMessage(res.data, res.status)}`);
  }

  const hint = attempts.length ? `已尝试：${attempts.join(' | ')}` : '没有可用的鉴权路径';
  return {
    ok: false,
    error: `青龙鉴权失败。${hint}\n请确认：① host 是否正确；② 应用设置里的 Client ID / Client Secret 是否对得上；③ 该应用是否勾选了 envs 等 scope。`,
  };
}

/** 带鉴权请求；apiPath 是不含前缀的路径，例如 /envs、/system */
async function callAPI(cfg, apiPath, options = {}) {
  const auth = await fetchToken(cfg);
  if (!auth.ok) return { ok: false, error: auth.error };

  const prefix = auth.flavor === 'open' ? '/open' : '/api';
  const res = await requestRaw(`${auth.host}${prefix}${apiPath}`, Object.assign({}, options, {
    timeout: options.timeout || REQUEST_TIMEOUT,
    headers: Object.assign({ Authorization: `${auth.tokenType} ${auth.token}` }, options.headers || {}),
  }));

  if (res.status === 0) return { ok: false, error: res.error };
  if (!res.data) {
    return {
      ok: false,
      error: `青龙接口 ${prefix}${apiPath} ${describeBadResponse(res.status, res.raw)}`,
      status: res.status,
    };
  }

  const code = res.data.code;
  if (res.status !== 200 || (code !== undefined && code !== 200)) {
    const msg = extractMessage(res.data, res.status);
    const extra = /暂无权限/.test(msg)
      ? '（该应用缺少对应 scope，请到青龙「系统设置 → 应用设置」给这个应用勾上 envs）'
      : '';
    return { ok: false, error: `青龙接口 ${prefix}${apiPath} 返回异常：${msg}${extra}`, status: res.status, code };
  }
  return { ok: true, data: res.data.data, host: auth.host, endpoint: `${prefix}${apiPath}` };
}

/** 按名字查询环境变量，返回全部同名条目 */
async function findEnvs(cfg, name) {
  const res = await callAPI(cfg, `/envs?searchValue=${encodeURIComponent(name)}`);
  if (!res.ok) return res;
  const list = Array.isArray(res.data) ? res.data : [];
  return { ok: true, host: res.host, list: list.filter((e) => e && e.name === name) };
}

async function createEnv(cfg, entries) {
  return callAPI(cfg, '/envs', { method: 'POST', body: entries });
}

async function updateEnv(cfg, entry) {
  return callAPI(cfg, '/envs', { method: 'PUT', body: entry });
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
    return { ok: true, action: 'created', name, value, host: created.host, endpoint: created.endpoint };
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
    host: updated.host,
    endpoint: updated.endpoint,
    previous: String(target.value),
    duplicates: found.list.length - 1,
  };
}

/**
 * 追加式写环境变量：value 按行拆分，已存在就跳过，否则追加一行。
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
    host: updated.host,
    endpoint: updated.endpoint,
    existingLines: lines.length + 1,
    duplicates: found.list.length - 1,
  };
}

/** 连接测试：鉴权 + 读一下面板版本和变量条数 */
async function testConnection(cfg) {
  const auth = await fetchToken(cfg);
  if (!auth.ok) return auth;

  const sys = await callAPI(cfg, '/system');
  const envs = await callAPI(cfg, '/envs');

  return {
    ok: true,
    host: auth.host,
    endpoint: auth.endpoint,
    flavor: auth.flavor,
    tokenType: auth.tokenType,
    version: (sys.ok && sys.data && sys.data.version) || '',
    branch: (sys.ok && sys.data && sys.data.branch) || '',
    envCount: Array.isArray(envs.data) ? envs.data.length : -1,
    envError: envs.ok ? '' : envs.error,
  };
}

module.exports = {
  normalizeHost,
  NAME_PATTERN,
  AUTH_CANDIDATES,
  fetchToken,
  findEnvs,
  setEnv,
  appendEnvLine,
  testConnection,
};
