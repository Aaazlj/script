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

module.exports = { health, createQR, pollQR, confirmQR };
