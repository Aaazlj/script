/**
 * 扫码成功后往青龙写环境变量
 *
 *   应用宝 → 不写任何东西：账号保存在网关里，脚本运行时自动发现；
 *            yyb_server 由后台「配置/测试青龙连接」时兜底确保存在（见 ensureYybServerEnv）
 *   美团   → MT_TOKEN：**一个账号一条同名环境变量**，每条自带备注（手机号 / 昵称）。
 *            青龙会把同名变量的值用 & 拼成一个值注入脚本，
 *            meituan_coupon.js 已支持 & 分隔，所以下游不用改。
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

/**
 * 把一条环境变量的值拆成若干 token，用于「这个账号是不是已经录过了」的去重判断。
 * 兼容三种写法：换行分隔、青龙的 & 拼接、更早的单行 # 分隔。
 */
function splitEnvValue(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r/g, '')
    .split(/[\n&#]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 美团：一个账号 → 一条独立的 MT_TOKEN 环境变量（同名多条）。
 *
 * 为什么不「换行拼进同一条变量」：
 *   · 青龙对同名环境变量是按名字分组后 .join('&') 注入的，两种写法脚本都读得到；
 *   · 但一条一条写能在青龙界面上给每个账号单独填备注（手机号 / 昵称），
 *     而且删某个账号时只删它那一行，不会误伤别的号。
 *
 * @param {string} token    扫码拿到的 token
 * @param {string} remarks  可选备注；留空则自动用「美团账号 N」
 */
async function uploadMeituanToken(cfg, token, remarks) {
  if (!token) return { ok: false, error: 'token 为空，跳过上传' };
  const value = String(token).trim();
  const note = String(remarks || '').trim().slice(0, 64);

  const found = await qinglong.findEnvs(cfg.qinglong, 'MT_TOKEN');
  if (!found.ok) return found;

  const hit = found.list.find((e) => {
    const v = String(e.value == null ? '' : e.value).replace(/\r/g, '').trim();
    return v === value || splitEnvValue(v).includes(value);
  });

  if (hit) {
    // 这个账号已经录过了：不重复建，但如果原本没备注、这次给了就顺手补上
    let patched = '';
    const old = String(hit.remarks || '').trim();
    if (note && !old) {
      const up = await qinglong.setEnvRemarks(cfg.qinglong, hit, note);
      if (up.ok) patched = note;
    }
    return {
      ok: true,
      action: 'unchanged',
      variable: 'MT_TOKEN',
      masked: mask(value),
      host: found.host,
      accountCount: found.list.length,
      remarks: patched || old,
      remarksPatched: Boolean(patched),
    };
  }

  const text = note || `美团账号 ${found.list.length + 1}`;
  const created = await qinglong.addEnvEntry(cfg.qinglong, 'MT_TOKEN', value, text);
  if (!created.ok) return created;

  return {
    ok: true,
    action: 'created',
    variable: 'MT_TOKEN',
    masked: mask(value),
    host: created.host,
    remarks: text,
    accountCount: found.list.length + 1,
  };
}

function mask(token) {
  const s = String(token || '');
  return s.length > 12 ? `${s.slice(0, 8)}****${s.slice(-4)}` : '****';
}

module.exports = { derivePublicBase, ensureYybServerEnv, uploadMeituanToken, mask };
