/**
 * 扫码成功后往青龙写环境变量
 *
 *   应用宝 → yyb_server（网关地址）
 *   美团   → MT_TOKEN（多账号按行追加，已存在则跳过）
 */

const qinglong = require('./qinglong');
const { trimBase } = require('./config');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::1', '[::1]']);

/**
 * 算出写进青龙的 yyb_server 地址。
 * 后台没显式配置 publicBaseUrl 时，取 yyb_go 地址；
 * 若它指向本机回环，则把主机名换成面板请求里的 Host（青龙和网关通常同机部署）。
 */
function derivePublicBase(cfg, req) {
  const explicit = trimBase(cfg.yyb && cfg.yyb.publicBaseUrl);
  if (explicit) return explicit;

  const raw = trimBase(cfg.yyb && cfg.yyb.baseUrl);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (LOOPBACK_HOSTS.has(u.hostname)) {
      const reqHost = String((req && req.headers && req.headers.host) || '').split(':')[0];
      if (reqHost && !LOOPBACK_HOSTS.has(reqHost)) {
        u.hostname = reqHost;
      }
    }
    return u.toString().replace(/\/+$/, '');
  } catch (_) {
    return raw;
  }
}

/** 应用宝：把网关地址写进 yyb_server */
async function uploadYybServer(cfg, req) {
  const value = derivePublicBase(cfg, req);
  if (!value) {
    return { ok: false, error: '无法确定 yyb_server 地址，请在后台配置 yyb_go 对外地址' };
  }
  const res = await qinglong.setEnv(cfg.qinglong, 'yyb_server', value, '朴朴超市签到 · 应用宝网关（由扫码面板写入）');
  if (!res.ok) return res;
  return Object.assign({ variable: 'yyb_server' }, res);
}

/** 美团：token 追加进 MT_TOKEN（多账号一行一个） */
async function uploadMeituanToken(cfg, token) {
  if (!token) return { ok: false, error: 'token 为空，跳过上传' };
  const res = await qinglong.appendEnvLine(cfg.qinglong, 'MT_TOKEN', token, '美团优惠券自动领取 token（由扫码面板写入）');
  if (!res.ok) return res;
  // 只回传脱敏信息，绝不把完整 token 送回前端
  return {
    ok: true,
    action: res.action,
    variable: 'MT_TOKEN',
    masked: mask(token),
    host: res.host,
    existingLines: res.existingLines,
    duplicates: res.duplicates,
  };
}

function mask(token) {
  const s = String(token || '');
  return s.length > 12 ? `${s.slice(0, 8)}****${s.slice(-4)}` : '****';
}

module.exports = { derivePublicBase, uploadYybServer, uploadMeituanToken, mask };
