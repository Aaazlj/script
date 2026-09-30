/**
 * 扫码成功后往青龙写环境变量
 *
 *   应用宝 → 不写任何东西：账号保存在网关里，脚本运行时自动发现；
 *            yyb_server 由后台「配置/测试青龙连接」时兜底确保存在（见 ensureYybServerEnv）
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
    if (LOOPBACK_HOSTS.has(u.hostname) && req) {
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

/**
 * 确保 yyb_server 存在（只在后台「配置/测试青龙连接」时调用，扫码流程不碰青龙）。
 * 已存在 → 完全不动（尊重手动配置）；缺失 → 按后台配置的网关地址补一次，
 * 保证全新环境开箱即用。yyb_server 是纯静态的网关地址，配一次就够了。
 */
async function ensureYybServerEnv(cfg) {
  const value = derivePublicBase(cfg, null);
  if (!value) {
    return { ok: false, error: '无法确定 yyb_server 地址，请在后台配置 yyb_go 对外地址' };
  }

  const found = await qinglong.findEnvs(cfg.qinglong, 'yyb_server');
  if (found.ok && found.list.length) {
    return {
      ok: true,
      variable: 'yyb_server',
      skipped: true,
      message: 'yyb_server 已存在，保持青龙里的配置不动',
    };
  }

  const res = await qinglong.setEnv(cfg.qinglong, 'yyb_server', value, '朴朴/顺丰/美团脚本 · 应用宝网关地址（由扫码面板写入）');
  if (!res.ok) return res;
  return { ok: true, variable: 'yyb_server', action: res.action, value };
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

module.exports = { derivePublicBase, ensureYybServerEnv, uploadMeituanToken, mask };
