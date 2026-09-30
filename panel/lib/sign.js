/**
 * 美团 CLIGuard 签名服务包装。
 *
 * 背景：media.meituan.com 的福利社接口（listActivityCoupon / grantActivityCoupon）
 * 从 2026-09 起在 openresty 层强制校验 mtgsig 签名头，没有签名一律 403 Forbidden。
 * 签名算法在美团自家的混淆 JS（cliguard）里，无法用 Python 复刻。
 *
 * 做法：面板容器本来就挂载了美团专家包（/opt/meituan-expert），其中自带
 * vendor/cliguard/js/cliguard.js —— 这里把它加载进来，暴露成
 * POST /api/meituan/sign，给青龙里跑的 mt_code.py 借用。
 * （meituan_coupon.js 则是同目录 opportunistic 加载，两不耽误。）
 *
 * 只用 Node 内置模块，零第三方依赖。
 */

const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  process.env.MEITUAN_CLIGUARD_JS,
  '/opt/meituan-expert/scripts/vendor/cliguard/js/cliguard.js',
  path.join(process.env.HOME || '/root', '.cliguard', 'cliguard-updates', 'core', 'cliguard.js'),
].filter(Boolean);

let _cliguard;

function loadCliguard() {
  if (_cliguard !== undefined) return _cliguard;
  _cliguard = null;
  for (const p of CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const mod = require(p);
      if (mod && typeof mod.signRequest === 'function') {
        _cliguard = mod;
        break;
      }
    } catch (_) { /* 换下一个候选路径 */ }
  }
  return _cliguard;
}

function available() {
  return Boolean(loadCliguard());
}

/**
 * 生成签名。
 * @param {string} method HTTP 方法
 * @param {string} url    完整 URL（含 query）
 * @param {string} bodyHash 请求体 md5（body 前 16200 字节），GET 传空串
 * @returns {{ok:true, url:string, headers:object} | {ok:false, error:string}}
 */
function sign(method, url, bodyHash) {
  const cg = loadCliguard();
  if (!cg) {
    return { ok: false, error: 'cliguard 未加载：未找到 vendor/cliguard/js/cliguard.js' };
  }
  try {
    let signedUrl = url;
    if (typeof cg.addCommonParams === 'function') {
      const r = cg.addCommonParams(url);
      if (r && r.url) signedUrl = r.url;
    }
    const headers =
      cg.signRequest(String(method || 'GET').toUpperCase(), signedUrl, bodyHash || '') || {};
    return { ok: true, url: signedUrl, headers };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 简单限流：每 IP 每分钟 120 次 ---------------- */

const hits = new Map();
const WINDOW_MS = 60 * 1000;
const LIMIT = 120;

function tooMany(ip) {
  const cutoff = Date.now() - WINDOW_MS;
  const list = (hits.get(ip) || []).filter((t) => t > cutoff);
  list.push(Date.now());
  hits.set(ip, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => t > cutoff)) hits.delete(k);
    }
  }
  return list.length > LIMIT;
}

module.exports = { available, sign, tooMany, loadCliguard };
