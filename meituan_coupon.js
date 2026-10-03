/*
------------------------------------------
@Author: Aaa
@Date: 2026.09.13
@Description: 美团优惠券自动领取（含当日券明细缓存回放）
cron: 0 10 * * *
------------------------------------------
环境变量：
MT_TOKEN        必填，美团登录 Token。多账号有两种写法，都支持：
                 ① 青龙里一个账号一条**同名**的 MT_TOKEN 环境变量（推荐 —— 扫码面板
                    就是这么写的，好处是每个账号能单独填备注，比如手机号）。
                    青龙会把同名变量的值用 & 拼成一个值注入给脚本，所以 &
                    等价于「一个账号一行」。
                 ② 单条变量里多账号用换行分隔（旧写法）。
                 另外，更早的「单行 # 分隔」写法也兼容。三种可以混用。
MT_TOKEN_FILE   可选，Token 文件路径
                 默认依次尝试 mt_token.txt / data/mt_token.txt / token-web/data/mt_token.txt
MT_AI_SCENE     接口 aiScene 渠道标识，默认官方渠道值 a0d4da77f918ab204d86c911fcdd0ce1
                 ⚠️ 不要留空！官方专家包固定带这个值；实测脚本用空值会被服务端判为
                 「发券失败」(code 1014)，看起来像"今天已领过"，其实是请求被拒。
MT_PUSH_URL     可选，自定义推送地址（POST {title, content}，http / https 均可）
MT_CLIGUARD     可选，cliguard（mtgsig 风控签名组件）绝对路径
                 不配则依次找 ./vendor/cliguard/js/cliguard.js、~/.cliguard/...
MT_SIGN_URL     可选，签名服务地址（面板暴露的 POST /api/meituan/sign）
                 青龙环境默认尝试 http://panel:5180/api/meituan/sign
                 签名优先级：面板签名服务 > 本地 cliguard > 裸请求
MT_DEBUG        可选，=1 时打印服务端原始响应，排查 1014 用
MT_MAX_COUPONS  可选，通知最多展示几张券，默认 8
MT_CACHE_FILE   可选，当日券缓存路径
                 默认：青龙环境 $QL_DIR/data/mt_coupons_cache.json（容器重建不丢），
                       其它环境 ./data/mt_coupons_cache.json
------------------------------------------
重要：
  每天限领一次。当天已领过时，接口只返回 code 1014，couponList 为空，
  不会带任何券数据。所以脚本在【真正领到券】的那次把明细写入本地缓存，
  之后再跑（当天）直接命中缓存回放，不再重复打领券接口，跨天自动失效。

返回码含义（都是 HTTP 200，看 body 里的 code）：
  200   发券成功
  1014  服务端「发券失败」——⚠️ 它【不等于】"今天已领过"，至少三种含义：
          ① 该账号今天确实已经领过；
          ② 本轮请求被服务端拒绝（aiScene 渠道标识为空/不对，或风控签名不被认可）；
          ③ 该渠道/活动当前对这个账号没有可发的券。
        如何区分：看【当天第一次运行】的结果。如果当天第一次就是 1014，那基本是 ②；
        脚本会在每轮打印实际用的 aiScene 与签名方式，MT_DEBUG=1 还能看原始响应。
  401   token 已失效，需要用 token-web / 面板重新扫码
  403   token 为空（青龙环境变量没配上）
  509 / 50200  请求过于频繁，稍后重试
  9999  服务端异常

结论怎么读：脚本每轮末尾会打一行「本轮结论: ...」，一眼就能看出是领到了、
还是 1014、还是 token 挂了。
------------------------------------------
获取 Token：仓库内 token-web/ 目录提供扫码登录服务
           node token-web/server.js → http://127.0.0.1:5178
------------------------------------------
*/

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_URL = 'https://media.meituan.com/fulishemini/couponActivity/sendCouponWork';
const TIMEOUT_MS = 20000;
const MAX_COUPONS = Number(process.env.MT_MAX_COUPONS || 8) || 8;
// 官方专家包 scripts/config.json 里的渠道值；实测留空与填它服务端表现一致，
// 这里给个默认值只是为了和官方保持同一渠道口径。
const DEFAULT_AI_SCENE = 'a0d4da77f918ab204d86c911fcdd0ce1';
const AI_SCENE = (process.env.MT_AI_SCENE || DEFAULT_AI_SCENE).trim();

/* ============ 运行环境：青龙 Env + 本地兜底 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 注意：青龙靠扫描 Env 构造参数里的【字符串字面量】取任务名，
      // 这里必须写字面量，不能传变量（否则任务名会变成变量名）
      return new Env('美团自动领券');
    } catch (_) { /* 降级到本地实现 */ }
  }
  return {
    log: (...args) => console.log(...args),
    msg: null,
    done: () => {},
    getdata: () => '',
    setdata: () => {},
  };
})();

/* ============ Token 获取 ============ */

// token 是 base64url 风格的密文串；用来兜住「误把分隔符切进 token 里」的情况
function looksLikeToken(s) {
  return typeof s === 'string' && s.length >= 16 && /^[A-Za-z0-9_\-=+/]+$/.test(s);
}

/**
 * 多账号分隔。三种写法都认：
 *   ① 换行分隔（最稳，token 里的任意字符都不会被误切）
 *   ② & 分隔 —— 青龙对**同名环境变量**是按名字分组后 .join('&') 注入的
 *      （见 back/services/env.ts 的 groupBy(envs,'name')），
 *      所以「一个账号一条同名 MT_TOKEN」最终就是 & 拼接。
 *      & 不属于 token 的字符集，可以无条件当分隔符。
 *   ③ 单行 # 分隔 —— 更早的老写法。只在「某一段里含 #」时才细分，
 *      而且要求细分出来的每一段都长得像 token，避免把 token 自带的 # 截断。
 *      （老条目 `a#b` 和新条目 c 混在一起会变成 `a#b&c`，上面这步就能兜住。）
 */
function splitTokens(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];

  let parts;
  if (raw.includes('\n')) parts = raw.split(/\n+/);
  else if (raw.includes('&')) parts = raw.split(/&+/);
  else parts = [raw];

  const out = [];
  for (const p0 of parts.map((s) => s.trim()).filter(Boolean)) {
    if (p0.includes('#')) {
      const sub = p0.split(/#+/).map((s) => s.trim()).filter(Boolean);
      if (sub.length > 1 && sub.every(looksLikeToken)) {
        out.push(...sub);
        continue;
      }
    }
    out.push(p0);
  }
  return out;
}

function readTokenFile() {
  const candidates = [
    process.env.MT_TOKEN_FILE,
    path.join(__dirname, 'mt_token.txt'),
    path.join(__dirname, 'data', 'mt_token.txt'),
    path.join(__dirname, 'token-web', 'data', 'mt_token.txt'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
        // 兼容纯 token、MT_TOKEN=xxx、export MT_TOKEN=xxx 三种写法；
        // 只在非注释行里找赋值，避免把 "#MT_TOKEN=xxx" 这类注释当有效 token
        const matched = text
          .split('\n')
          .filter((line) => !/^\s*#/.test(line))
          .join('\n')
          .match(/(?:^|\n)\s*(?:export\s+)?MT_TOKEN\s*=\s*(.+)/);
        const value = (matched ? matched[1] : text).trim();
        if (value) return { token: value, from: file };
      }
    } catch (_) { /* 继续尝试下一个 */ }
  }
  return null;
}

function getTokens() {
  const fromEnv = (process.env.MT_TOKEN || '').trim();
  if (fromEnv) {
    return splitTokens(fromEnv);
  }
  const file = readTokenFile();
  if (file) {
    $.log(`[提示] 从文件读取 token：${file.from}`);
    return splitTokens(file.token);
  }
  return [];
}

const maskToken = (t) => (t.length > 8 ? `${t.slice(0, 8)}****` : t);
const tokenKey = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);

/* ============ 当日券缓存（跨天自动失效） ============ */

// 青龙里脚本目录在 ql repo 更新时可能被清空，缓存默认落到 $QL_DIR/data 持久化目录
const DEFAULT_CACHE_FILE = process.env.QL_DIR
  ? path.join(process.env.QL_DIR, 'data', 'mt_coupons_cache.json')
  : path.join(__dirname, 'data', 'mt_coupons_cache.json');
const CACHE_FILE = process.env.MT_CACHE_FILE || DEFAULT_CACHE_FILE;

function localDateStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadCache(token) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const all = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const entry = all[tokenKey(token)];
    if (entry && entry.date === localDateStr()) return entry.data;
  } catch (_) { /* 缓存损坏就当没有 */ }
  return null;
}

function saveCache(token, data) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (_) {}
    all[tokenKey(token)] = { date: localDateStr(), data };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    $.log(`[提示] 券缓存写入失败（不影响领券）：${e.message}`);
  }
}

/* ============ 签名：面板签名服务 > 本地 cliguard > 裸请求 ============ */

// 青龙里脚本自己搞不到 cliguard（美团混淆 JS），但扫码面板（panel）已经把
// 专家包自带的 vendor/cliguard 包成了 POST /api/meituan/sign。
// 走容器网络直连面板即可拿到 mtgsig 与公共参数（?csecplatform=..&csecversion=..）。
const DEFAULT_SIGN_URL = process.env.QL_DIR ? 'http://panel:5180/api/meituan/sign' : '';
const SIGN_URL = (process.env.MT_SIGN_URL || DEFAULT_SIGN_URL || '').trim();

let _cliguard;

function loadCliguard() {
  if (_cliguard !== undefined) return _cliguard;
  _cliguard = null;
  try {
    const os = require('os');
    const candidates = [
      // 手动指定优先级最高：青龙上可指向挂载的专家包
      // 例如 MT_CLIGUARD=/opt/meituan-expert/scripts/vendor/cliguard/js/cliguard.js
      process.env.MT_CLIGUARD,
      path.join(__dirname, 'vendor', 'cliguard', 'js', 'cliguard.js'),
      path.join(os.homedir(), '.cliguard', 'cliguard-updates', 'core', 'cliguard.js'),
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) { _cliguard = require(p); break; }
    }
    if (_cliguard && typeof _cliguard.addCommonParams !== 'function' && typeof _cliguard.signRequest !== 'function') {
      _cliguard = null;
    }
  } catch (e) {
    $.log(`[提示] cliguard 加载失败，本次使用裸请求：${e.message}`);
    _cliguard = null;
  }
  return _cliguard;
}

function addCommonParams(urlStr) {
  try {
    const cg = loadCliguard();
    if (!cg || typeof cg.addCommonParams !== 'function') return urlStr;
    const result = cg.addCommonParams(urlStr);
    return (result && result.url) ? result.url : urlStr;
  } catch (e) {
    $.log(`[提示] cliguard 加签参数失败，已忽略：${e.message}`);
    return urlStr;
  }
}

function makeSignHeaders(method, urlStr, bodyHash) {
  try {
    const cg = loadCliguard();
    if (!cg || typeof cg.signRequest !== 'function') return {};
    return cg.signRequest(method.toUpperCase(), urlStr, bodyHash || '') || {};
  } catch (e) {
    $.log(`[提示] cliguard 签名失败，已忽略：${e.message}`);
    return {};
  }
}

/* ============ 网络请求 ============ */

// 调面板的 /api/meituan/sign 拿签名（返回 {url, headers}），失败返回 null
function signViaPanel(method, urlStr, bodyHash) {
  return new Promise((resolve) => {
    if (!SIGN_URL) return resolve(null);
    let u;
    try {
      u = new URL(SIGN_URL);
    } catch (_) {
      return resolve(null);
    }
    const isHttp = u.protocol === 'http:';
    const lib = isHttp ? require('http') : https;
    const payload = Buffer.from(JSON.stringify({ method, url: urlStr, bodyHash }), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const inner = (j && j.data) || {};
            if (j && j.ok && inner.url) resolve({ url: inner.url, headers: inner.headers || {} });
            else {
              $.log(`[提示] 面板签名服务返回异常：${(j && (j.error || 'no url')) || '空响应'}，改用其它方式`);
              resolve(null);
            }
          } catch (e) {
            $.log(`[提示] 面板签名响应无法解析：${e.message}`);
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      $.log(`[提示] 面板签名服务不可用（${SIGN_URL}）：${e.message}`);
      resolve(null);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      $.log('[提示] 面板签名服务超时，改用其它方式');
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

// 统一签名入口 —— 返回 { url, headers, mode }
async function resolveSignature(method, rawUrl, bodyHash) {
  const viaPanel = await signViaPanel(method, rawUrl, bodyHash);
  if (viaPanel) return { url: viaPanel.url, headers: viaPanel.headers, mode: 'panel' };
  const cg = loadCliguard();
  if (cg) {
    const signedUrl = addCommonParams(rawUrl);
    return { url: signedUrl, headers: makeSignHeaders(method, signedUrl, bodyHash), mode: 'cliguard' };
  }
  return { url: rawUrl, headers: {}, mode: '无(裸请求)' };
}

async function sendCoupon(token) {
  const body = Buffer.from(JSON.stringify({ token, aiScene: AI_SCENE, version: 2 }), 'utf8');
  // 与官方一致：签名前先补公共参数，bodyHash 取前 16200 字节的 md5
  const bodyHash = crypto.createHash('md5').update(body.slice(0, 16200)).digest('hex');
  const sig = await resolveSignature('POST', API_URL, bodyHash);
  const parsed = new URL(sig.url);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Requested-With': 'XMLHttpRequest',
        }, sig.headers),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) { /* 非 JSON，保留 raw 供排查 */ }
          resolve({ http: res.statusCode, data, raw: raw.slice(0, 500), signMode: sig.mode, signedUrl: sig.url });
        });
      }
    );
    req.on('error', (e) => resolve({ http: 0, data: null, error: e.message, signMode: sig.mode }));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ http: 0, data: null, error: 'TIMEOUT', signMode: sig.mode });
    });
    req.write(body);
    req.end();
  });
}

/* ============ 结果格式化 ============ */

const TAB_ORDER = ['外卖', '美食团购', '美团闪购', '休闲娱乐', '生活服务', '丽人医疗', '更多福利'];
const TAB_DISPLAY = { '更多福利': '其他' };
const SLOT_PLAN_BASE = [['外卖', 2], ['美食团购', 1], ['美团闪购', 1],
                        ['休闲娱乐', 1], ['生活服务', 1], ['丽人医疗', 1]];

const fenToYuan = (fen) => {
  const yuan = Number(fen || 0) / 100;
  return yuan === Math.floor(yuan) ? String(Math.floor(yuan)) : yuan.toFixed(1);
};

const fmtDate = (ms) => {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function formatCoupon(c) {
  const limit = Number(c.priceLimit || 0);
  const value = Number(c.couponValue || 0);
  const discount = limit > 0 ? `满${fenToYuan(limit)}元减${fenToYuan(value)}元` : '无门槛';
  const period = c.couponStartTime && c.couponEndTime
    ? `${fmtDate(c.couponStartTime)} 至 ${fmtDate(c.couponEndTime)}`
    : '-';
  return { name: c.couponName || '', discount, period, tab: c.tabName || '', value, limit };
}

function buildCountStr(list) {
  const counter = {};
  list.forEach((c) => (counter[c.tab] = (counter[c.tab] || 0) + 1));
  const unknown = Object.keys(counter).filter((t) => !TAB_ORDER.includes(t));
  const order = TAB_ORDER.slice(0, 6).concat(unknown, TAB_ORDER.slice(6));
  return order
    .filter((t) => counter[t])
    .map((t) => `${TAB_DISPLAY[t] || t}优惠券${counter[t]}张`)
    .join('、');
}

// 分类配额挑选，保证每个品类都有代表，避免全被外卖券占满
function pickDisplay(list) {
  const ratio = (c) => (c.limit > 0 ? [1, -(c.value / c.limit)] : [0, 0]);
  const cmp = (a, b) => {
    const ka = ratio(a);
    const kb = ratio(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  };

  const groups = {};
  list.forEach((c) => (groups[c.tab] = groups[c.tab] || []).push(c));
  Object.keys(groups).forEach((t) => groups[t].sort(cmp));

  const unknown = Object.keys(groups).filter((t) => !TAB_ORDER.includes(t));
  const plan = SLOT_PLAN_BASE.concat(unknown.map((t) => [t, 1]), [['更多福利', 1]]);

  const used = {};
  const slots = [];
  plan.forEach(([tab, quota]) => {
    if (slots.length >= MAX_COUPONS) return;
    const grp = groups[tab] || [];
    let taken = 0;
    for (const c of grp) {
      if (taken >= quota || slots.length >= MAX_COUPONS) break;
      slots.push(c);
      used[tab] = (used[tab] || 0) + 1;
      taken++;
    }
  });

  const fallback = ['外卖', '美食团购', '美团闪购', '休闲娱乐', '生活服务', '丽人医疗']
    .concat(unknown, ['更多福利']);
  while (slots.length < MAX_COUPONS) {
    let filled = false;
    for (const tab of fallback) {
      const rest = (groups[tab] || []).slice(used[tab] || 0);
      if (rest.length) {
        slots.push(rest[0]);
        used[tab] = (used[tab] || 0) + 1;
        filled = true;
        break;
      }
    }
    if (!filled) break;
  }
  return slots;
}

function renderList(list) {
  const lines = [`  共 ${list.length} 张：${buildCountStr(list)}`];
  pickDisplay(list).forEach((c, i) => {
    lines.push(`  ${i + 1}. [${c.tab}] ${c.name} | ${c.discount} | ${c.period}`);
  });
  return lines.join('\n');
}

/* ============ 通知 ============ */

async function pushByWebhook(title, content) {
  const url = process.env.MT_PUSH_URL;
  if (!url) return false;
  const body = Buffer.from(JSON.stringify({ title, content }), 'utf8');
  try {
    await new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(url);
      } catch (_) {
        return reject(new Error(`MT_PUSH_URL 不是合法 URL：${url}`));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error(`MT_PUSH_URL 仅支持 http/https，当前是 ${u.protocol}`));
      }
      const isHttp = u.protocol === 'http:';
      const lib = isHttp ? require('http') : https;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttp ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => { res.resume(); resolve(res.statusCode); }
      );
      req.on('error', reject);
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('TIMEOUT')));
      req.write(body);
      req.end();
    });
    return true;
  } catch (e) {
    $.log(`[推送] 自定义推送失败：${e.message}`);
    return false;
  }
}

async function pushBySendNotify(title, content) {
  for (const mod of ['./sendNotify', '/ql/scripts/sendNotify']) {
    try {
      const m = require(mod);
      if (typeof m === 'function') { await m(title, content); return true; }
      if (m && typeof m.sendNotify === 'function') { await m.sendNotify(title, content); return true; }
      if (m && typeof m.default === 'function') { await m.default(title, content); return true; }
    } catch (_) { /* 青龙环境无此模块则跳过 */ }
  }
  return false;
}

async function push(title, content) {
  let sent = false;
  if (!sent) sent = await pushByWebhook(title, content);      // 自定义 webhook 优先
  if (!sent && typeof $.msg === 'function') {                 // 其次用青龙面板的通知配置
    try { await $.msg(title, content); sent = true; }
    catch (e) { $.log(`[推送] $.msg 调用失败：${e.message}`); }
  }
  if (!sent) sent = await pushBySendNotify(title, content);   // 最后用 sendNotify
  if (!sent) $.log('[推送] 未配置推送，结果仅输出日志');
}

/* ============ 主流程 ============ */

!(async () => {
  const tokens = getTokens();
  if (!tokens.length) {
    $.log('未找到 MT_TOKEN，请先配置 token（可用仓库内 token-web 扫码获取）');
    $.log('本轮结论: 未配置 MT_TOKEN，脚本未执行');
    $.done();
    return;
  }

  const sections = [];
  let anyOk = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const title = `账号 ${i + 1} 领券结果`;
    let conclusion = '';
    $.log(`\n账号 ${i + 1}/${tokens.length} (${maskToken(token)}) 开始领券…`);

    // 先看当日缓存：命中就不再打领券接口。
    // 每天只能领一次，重复请求只会拿到 code 1014，白挨一次风控。
    const cached = loadCache(token);
    if (cached) {
      anyOk = true;
      const parts = [title];
      parts.push(`  ℹ️ 今天已领取过（每天限领一次），今日已领 ${cached.count} 张`);
      if (cached.count_str) parts.push(`  包括${cached.count_str}`);
      if (cached.activity_link) parts.push(`  活动链接：${cached.activity_link}`);
      parts.push('', renderList(cached.coupons || []));
      $.log('  ℹ️ 今天已领取过，直接回放本地缓存（未重复请求接口）：');
      $.log(renderList(cached.coupons || []));
      $.log(`  本轮结论: 今天已领过 ${cached.count} 张（回放本地缓存）`);
      sections.push(parts.join('\n'));
      if (i < tokens.length - 1) await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const resp = await sendCoupon(token);
    $.log(`  请求参数: aiScene=${AI_SCENE || '(空!)'} | 签名=${resp.signMode || '-'} | token=${maskToken(token)}`);
    if (process.env.MT_DEBUG === '1') {
      $.log(`  [debug] URL: ${resp.signedUrl || '-'}`);
      $.log(`  [debug] 原始响应: ${resp.data ? JSON.stringify(resp.data).slice(0, 500) : (resp.raw || resp.error || '-')}`);
    }

    if (resp.http === 0 || !resp.data) {
      const reason = resp.error || resp.raw || '未知网络错误';
      sections.push(`${title}\n  请求失败：${reason}`);
      $.log(`  ✖ 请求失败：${reason}`);
      conclusion = `请求失败（${reason}）`;
    } else {
      const { code, msg, data } = resp.data;

      if (code === 200) {
        const list = ((data && data.couponList) || []).map(formatCoupon);
        if (list.length > 0) {
          anyOk = true;
          const summary = buildCountStr(list);
          saveCache(token, {
            count: list.length,
            count_str: summary,
            coupons: list,
            activity_name: (data && data.activityName) || '',
            activity_link: (data && data.activityLink) || '',
          });

          $.log(`  ✅ 领取成功，本次共领取 ${list.length} 张美团优惠券，包括${summary}！`);
          $.log(renderList(list));
          sections.push(`${title}\n  ✅ 领取成功，共 ${list.length} 张\n  包括${summary}\n\n${renderList(list)}`);
          conclusion = `本次领取成功 ${list.length} 张，已写入今日缓存`;
        } else {
          // 接口返回成功但没券：既不算领取成功，也不写缓存，
          // 否则会把"共 0 张"当成今日已领明细回放出来
          const tip = '接口没有返回任何优惠券，今天可能没有可领的券。';
          $.log(`  ℹ️ ${tip}`);
          sections.push(`${title}\n  ℹ️ ${tip}`);
          conclusion = '接口返回 0 张券（今日无可领券）';
        }
      } else if (code === 1014) {
        // ⚠️ 1014 只是服务端「发券失败」，【不等于】"今天已领过"。
        // 实测过：账号当天根本没领过、脚本却拿到 1014（官方专家包同一账号同一时刻能领到）。
        // 三种可能：①确实已领过；②请求被拒（aiScene 为空/不对，或签名不被认可）；③该渠道无券。
        const tip = '服务端返回 1014（发券失败）。它有三种含义，不要一律当成"今天已领过"：'
          + '①该账号今天确实领过；'
          + '②本轮请求被服务端拒绝（aiScene 渠道标识为空/不对，或风控签名不被认可）'
          + `——本轮实际用的是 aiScene=${AI_SCENE || '(空!)'}、签名=${resp.signMode}；`
          + '③该渠道当前对这个账号没有可发的券。'
          + '判断方法：看【当天第一次运行】。如果当天第一次就是 1014，基本是 ②，'
          + '请检查 MT_AI_SCENE / MT_SIGN_URL，并用 MT_DEBUG=1 复跑一次看服务端原始返回。';
        $.log(`  ℹ️ ${tip}`);
        sections.push(`${title}\n  ℹ️ ${tip}`);
        conclusion = '服务端 1014 发券失败（未必是"已领过"，看当天首次运行与请求参数）';
      } else if (code === 401) {
        const tip = '🔑 token 已失效：请用 token-web 重新扫码，并把新的 MT_TOKEN 更新到环境变量或 mt_token.txt';
        $.log(`  ${tip}`);
        sections.push(`${title}\n  ${tip}`);
        conclusion = 'token 失效（401），需重新扫码';
      } else if (code === 403) {
        const tip = '🔑 token 为空：检查青龙环境变量 MT_TOKEN 是否配好（或 mt_token.txt 路径）';
        $.log(`  ${tip}`);
        sections.push(`${title}\n  ${tip}`);
        conclusion = 'token 未配置（403）';
      } else if (code === 509 || code === 50200) {
        $.log(`  ⏳ 请求过于频繁（code ${code}），请稍后重试`);
        sections.push(`${title}\n  ⏳ 请求过于频繁（code ${code}）`);
        conclusion = `请求过于频繁（${code}），可稍后重跑`;
      } else {
        const reason = code === 9999 ? '系统异常，请稍后重试' : `未知错误 code=${code} msg=${msg || '-'}`;
        $.log(`  ✖ ${reason}`);
        sections.push(`${title}\n  ✖ ${reason}`);
        conclusion = reason;
      }
    }

    if (conclusion) $.log(`  本轮结论: ${conclusion}`);

    if (i < tokens.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  await push(anyOk ? '🎉 美团优惠券领取完成' : '美团优惠券领取结果', sections.join('\n\n'));
  $.log(`\n========== 本轮汇总 ==========\n共 ${tokens.length} 个账号；${anyOk ? '至少一个账号今日已领到券' : '本次没有账号领到券'}`);
  $.done();
})();
