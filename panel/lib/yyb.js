/**
 * 应用宝扫码适配器
 *
 * 不重写 yyb_go 的 mmtls 协议，而是在服务端代理它已有的扫码接口：
 *   POST {base}/qr?as_base64=true      新建二维码会话
 *   GET  {base}/qr/{sid}/poll          轮询扫码状态
 *   POST {base}/qr/{sid}/confirm       换取登录态并入库
 *
 * yyb_go 的响应统一是 {code, msg, data} 信封，code===0 表示成功。
 */

const { requestRaw } = require('./http');
const { trimBase } = require('./config');

const TIMEOUT = 60000;
// 轮询是长连接（yyb_go 内部最多等 35s），超时要给足
const POLL_TIMEOUT = 45000;

function unwrap(res, action) {
  if (res.status === 0) return { ok: false, error: `${action}失败：${res.error}` };
  const body = res.data;
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'code')) {
    if (body.code !== 0) {
      return { ok: false, error: `${action}失败：${body.msg || `code=${body.code}`}`, code: body.code };
    }
    return { ok: true, data: body.data };
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, data: body };
  return { ok: false, error: `${action}失败：HTTP ${res.status} ${res.raw.slice(0, 200)}` };
}

function base(cfg) {
  return trimBase(cfg && cfg.baseUrl);
}

async function health(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/health`, { timeout: 8000 });
  if (res.status === 0) return { ok: false, error: `连不上 yyb_go（${b}）：${res.error}` };
  return { ok: true, url: b, status: res.status, body: res.data };
}

/** 新建二维码会话 */
async function createQR(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/qr?as_base64=true`, { method: 'POST', timeout: TIMEOUT });
  const out = unwrap(res, '获取应用宝二维码');
  if (!out.ok) return out;
  const d = out.data || {};
  return {
    ok: true,
    sessionId: d.session_id,
    status: d.status,
    imageUrl: d.image_url ? `${b}${d.image_url}` : '',
    imageBase64: d.image_base64 || '',
  };
}

/** 轮询扫码状态：pending / scanned / authorized / confirmed / expired / cancelled / unknown */
async function pollQR(cfg, sessionId) {
  const b = base(cfg);
  const res = await requestRaw(`${b}/qr/${encodeURIComponent(sessionId)}/poll`, { timeout: POLL_TIMEOUT });
  const out = unwrap(res, '轮询扫码状态');
  if (!out.ok) return out;
  return { ok: true, status: (out.data && out.data.status) || 'unknown', errcode: out.data && out.data.errcode };
}

/** 确认授权 → yyb_go 换取登录态并写入它自己的账号库 */
async function confirmQR(cfg, sessionId) {
  const b = base(cfg);
  const res = await requestRaw(`${b}/qr/${encodeURIComponent(sessionId)}/confirm`, {
    method: 'POST',
    timeout: TIMEOUT,
  });
  const out = unwrap(res, '确认授权');
  if (!out.ok) return out;
  const acc = out.data || {};
  return {
    ok: true,
    account: {
      id: acc.id,
      openid: acc.openid,
      uin: acc.uin,
      nickname: acc.nickname || acc.alias || acc.openid,
      alias: acc.alias,
      status: acc.status,
    },
  };
}

/* ---------------- 账号管理（对应 yyb_go 的 /accounts 系列） ---------------- */

function normalizeAccount(a) {
  const id = a && a.id != null ? a.id : '';
  return {
    ref: String(id || (a && a.openid) || ''),
    id: a && a.id,
    openid: (a && a.openid) || '',
    uin: a && a.uin,
    nickname: (a && (a.nickname || a.alias)) || '',
    alias: (a && a.alias) || '',
    status: (a && a.status) || '',
    // 「这个账号跑哪些脚本」的标记，逗号分隔；空 = 不限制（所有脚本都跑它）
    scripts: (a && a.scripts) || '',
    hasAvatar: !!(a && a.avatar),
    // 卡片上要展示的时间（秒）
    last_checked_at: (a && a.last_checked_at) || 0,
    created_at: (a && a.created_at) || 0,
    updated_at: (a && a.updated_at) || 0,
  };
}

/** 列出网关里已入库的微信（应用宝）账号 */
async function listAccounts(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts`, { timeout: TIMEOUT });
  const out = unwrap(res, '读取账号列表');
  if (!out.ok) return out;
  const list = Array.isArray(out.data) ? out.data : [];
  return { ok: true, accounts: list.map(normalizeAccount) };
}

/** 刷新账号登录态；ref 为空表示全部 */
async function refreshAccounts(cfg, ref) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts/refresh`, {
    method: 'POST',
    body: { ref: ref || '' },
    timeout: 180000, // 逐账号探测，多账号会比较慢
  });
  const out = unwrap(res, '刷新账号');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/** 重新拉取账号资料（昵称/头像） */
async function resyncAccounts(cfg, ref) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts/resync`, {
    method: 'POST',
    body: { ref: ref || '' },
    timeout: TIMEOUT,
  });
  const out = unwrap(res, '同步账号资料');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/** 删除账号 */
async function deleteAccount(cfg, ref) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts?ref=${encodeURIComponent(ref)}`, {
    method: 'DELETE',
    timeout: TIMEOUT,
  });
  const out = unwrap(res, '删除账号');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/** 头像的原始 URL（供面板透传） */
function avatarUrl(cfg, ref) {
  const b = base(cfg);
  if (!b) return '';
  return `${b}/accounts/avatar?ref=${encodeURIComponent(ref)}`;
}

/* ---------------- 导出 / 导入 / 排序 ---------------- */

/**
 * 导出完整账号（含 login_buffer / credentials / user_info），
 * 返回网关给的纯数组，字段与其它工具的 yyb 账号文件一致。
 */
async function exportAccounts(cfg, ref) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const res = await requestRaw(`${b}/accounts/export${suffix}`, { timeout: TIMEOUT });
  if (res.status === 404) return { ok: false, error: '未找到该账号：' + ref };
  const out = unwrap(res, '导出账号');
  if (!out.ok) return out;
  return { ok: true, accounts: Array.isArray(out.data) ? out.data : [] };
}

/** 导入账号（数组或 {accounts:[...]}），返回网关的统计与最新列表 */
async function importAccounts(cfg, payload) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts/import`, {
    method: 'POST',
    body: payload,
    timeout: 120000,
  });
  const out = unwrap(res, '导入账号');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/** 按 refs 顺序重排账号（写入网关的 sort_order） */
async function setAccountOrder(cfg, refs) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts/order`, {
    method: 'POST',
    body: { refs },
    timeout: 30000,
  });
  const out = unwrap(res, '保存账号顺序');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/** 设置账号的「跑哪些脚本」标记。items = [{ref, scripts}]，scripts 空串表示不限制 */
async function setAccountScripts(cfg, items) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/accounts/scripts`, {
    method: 'POST',
    body: { items },
    timeout: TIMEOUT,
  });
  const out = unwrap(res, '保存脚本标记');
  if (!out.ok) return out;
  return { ok: true, result: out.data };
}

/* ---------------- 动态出口（品赞链路）开关 ---------------- */

/** 读代理状态 + 开关 */
async function proxySummary(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/proxy/settings`, { timeout: TIMEOUT });
  const out = unwrap(res, '读取代理状态');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

/** 改开关：patch 形如 {scan_via_proxy: true} / {code_via_proxy: false} */
async function updateProxySettings(cfg, patch) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/proxy/settings`, { method: 'POST', body: patch, timeout: TIMEOUT });
  const out = unwrap(res, '保存代理开关');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

/** 强制换一个出口 */
async function refreshProxy(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/proxy/refresh`, { method: 'POST', timeout: 45000 });
  const out = unwrap(res, '换出口');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

/** 保活状态 */
async function keepAliveStatus(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/keepalive`, { timeout: TIMEOUT });
  const out = unwrap(res, '读取保活状态');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

/** 立即跑一轮保活 */
async function runKeepAlive(cfg) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const res = await requestRaw(`${b}/keepalive`, { method: 'POST', timeout: 20000 });
  const out = unwrap(res, '触发保活');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

/** 用当前出口真连一次目标（默认微信 HTTPDNS IP） */
async function probeProxy(cfg, host, port) {
  const b = base(cfg);
  if (!b) return { ok: false, error: '未配置 yyb_go 网关地址' };
  const qs = host ? `?host=${encodeURIComponent(host)}${port ? '&port=' + port : ''}` : '';
  const res = await requestRaw(`${b}/proxy/probe${qs}`, { method: 'POST', timeout: 45000 });
  const out = unwrap(res, '测试链路');
  if (!out.ok) return out;
  return { ok: true, data: out.data };
}

module.exports = {
  health,
  createQR,
  pollQR,
  confirmQR,
  listAccounts,
  refreshAccounts,
  resyncAccounts,
  deleteAccount,
  avatarUrl,
  exportAccounts,
  importAccounts,
  setAccountOrder,
  setAccountScripts,
  proxySummary,
  updateProxySettings,
  refreshProxy,
  probeProxy,
  keepAliveStatus,
  runKeepAlive,
};
