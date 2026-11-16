/*
------------------------------------------
@Author: Aaa
@Date: 2026.11.16
@Description: 小象超市每日签到领买菜币（只走应用宝网关登录）
cron: 5 9 * * *
------------------------------------------
功能：复用应用宝网关里的小象超市登录态，每日签到领买菜币，并领取已完成的买菜币任务奖励。

环境变量：
1. 应用宝网关（必需，与美团/朴朴/顺丰等脚本共用同一个变量）：
   yyb_server                                      网关地址，如 http://yyb-go:8000
     - 支持 @ref 写法：http://yyb-go:8000@1         （@ 后面是账号 ref，可省掉 xxcs_openid）
   wx_server_url                                   兼容变量（yyb_server 为空时生效）
   xxcs_openid                                     可选。指定网关 ref；
                                                   多个用 &、英文/中文逗号、空格或换行分隔
     - 不配置时自动从网关拉全部 alive 账号（面板里新扫码的账号下次运行自动生效）
     - 优先级：xxcs_openid > yyb_server 里的 @ref > 网关自动发现
   yyb_script_key                                  本脚本在网关账号上的标记 key，默认 xxcs。
                                                   账号的 scripts 标记里没有它就不跑这个账号
                                                   （标记为空 = 不限制，所有脚本都跑）。
                                                   在扫码面板「应用宝账号」页勾选即可，不用手填。
   yyb_tag_filter                                  默认 1（按标记过滤）。设 0 则忽略标记跑全部账号

2. 代理（⚠️ 强烈建议配置）：
   xxcs_proxy / script_proxy                       静态代理，形如 http://user:pass@host:port
     - mall.meituan.com 的 CDN 节点对海外出口不放行：海外机器**直连一定超时**，
       签到接口根本发不出去。要么配国内 http 代理，要么把脚本放到国内机器上跑。
     - open.meituan.com（登录）海外可直连；只有 mall 这一段必须走国内出口。
     - 只支持 http / https 代理（Node 内置模块做 CONNECT 隧道）
     - 品赞（resin）就是这种写法：http://:管理token@主机:2260（用户名注意留空！）
   xxcs_proxy_type                                 默认 http。⚠️ socks5 / socks5h 不支持
                                                   （Node 内置模块没有 SOCKS 实现），配了会告警并回退直连
   xxcs_proxy_validate                             默认 1，启动时先验证代理连通性；置 0 可跳过

3. 业务参数（可选）：
   xxcs_poi                                        门店 ID，默认 10002122。
                                                   买菜币活动不分城市，用默认值即可
   xxcs_task                                       默认 1。设 0 则只签到、不领任务奖励
   xxcs_continuous                                 默认 0。设 1 时只在连续签到第 3 / 7 天去领里程碑奖励
                                                   （页面气泡文案 thirdDay/seventhDay）。
                                                   其它日子调这个接口只会回「设备已经参加过活动」，
                                                   所以按天数门控，开着也不会每天发无效请求

4. 其它（可选）：
   xxcs_login_cache                                默认 1。设 0 关闭「登录态复用」，每次都去网关取 code
   xxcs_account_timeout                            单账号上限（秒），最小 60，默认 180
   XXCS_PUSH_URL                                   自定义推送地址（POST {title, content}）
   XXCS_DEBUG                                      设 1 打印接口原始响应，排查用

登录态缓存文件默认 $QL_DIR/data/xxcs_login_cache.json（其它环境 ./data/...），
⚠️ 文件内含 token，写入权限 0600，别外传/别提交。

接口要点（改代码前先看这段）：
  · 鉴权是请求头 t（不是 query、不是 cookie）；放错位置就是 {"code":5,"message":"请重新登录"}
  · token 必须用 appName=maicai + 小象 appid 换，用外卖(openid=group)那套换来的 token 不认
  · 每个请求都要带 openId / openIdCipher（登录响应里有），uuid / xuuid 也取 openId
  · riskMap 用空指纹即可：{platform:13, app:95, utm_term:'', uuid:openId, utm_medium:'wxapp', fingerprint:''}
  · UA 必须是微信小程序内置浏览器的 UA，Referer 指 servicewechat.com
*/

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============ 常量 ============ */

const APPID = 'wx92916b3adca84096';        // 小象超市小程序 appid（网关取 code 用）
const APP_NAME = 'maicai';                 // weapplogin 的 appName，必须是这个
const PAGE_VERSION = '674';                // servicewechat Referer 里的版本号，取一个真实版本即可

const OPEN_BASE = 'https://open.meituan.com';
const LOGIN_URL = `${OPEN_BASE}/user/v1/weapplogin`;
const MALL_BASE = 'https://mall.meituan.com';
const CHECKIN_API = '/api/c/mallcoin/checkIn';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 '
  + 'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
  + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) '
  + 'UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364 '
  + `miniProgram/${APPID}`;

const REQUEST_TIMEOUT = 30000;
const PROXY_RETRY_TIMES = 3;
const PROXY_VALIDATE_URL = 'https://www.baidu.com';
const KEEPALIVE_MS = 30000;

/* ============ 运行环境：青龙 Env + 本地兜底 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 青龙靠扫描 Env 参数里的【字符串字面量】取任务名，这里必须写字面量
      return new Env('小象超市签到');
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

/* ============ 环境变量 ============ */

function env(...names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
}

const GATEWAY_RAW = env('yyb_server', 'wx_server_url');
const GATEWAY = (() => {
  const raw = GATEWAY_RAW;
  if (!raw) return { base: '', ref: '' };
  const at = raw.lastIndexOf('@');
  const base = at > 0 ? raw.slice(0, at).replace(/\/+$/, '') : raw.replace(/\/+$/, '');
  const ref = at > 0 ? raw.slice(at + 1).trim() : '';
  return { base: base && !/:\/\//.test(base) ? 'http://' + base : base, ref };
})();

const XXCS_REFS = env('xxcs_openid').split(/[&,，\s]+/).map((s) => s.trim()).filter(Boolean);

const SCRIPT_KEY = (env('yyb_script_key') || 'xxcs').toLowerCase();
const TAG_FILTER = (env('yyb_tag_filter') || '1').toLowerCase() !== '0';

const POI_ID = env('xxcs_poi') || '10002122';
const DO_TASK = (env('xxcs_task') || '1').toLowerCase() !== '0';
const DO_CONTINUOUS = (env('xxcs_continuous') || '0') === '1';

const XXCS_PROXY = env('xxcs_proxy', 'XXCS_PROXY', 'script_proxy', 'SCRIPT_PROXY');
const PROXY_TYPE = (env('xxcs_proxy_type') || 'http').toLowerCase();
const PROXY_VALIDATE = (env('xxcs_proxy_validate') || '1').toLowerCase() !== '0';

const DEBUG = process.env.XXCS_DEBUG === '1';
const ACCOUNT_TIMEOUT = Math.max(60, Number(env('xxcs_account_timeout') || 180)) * 1000;

const LOGIN_CACHE_FILE = process.env.XXCS_LOGIN_CACHE_FILE
  || (process.env.QL_DIR
    ? path.join(process.env.QL_DIR, 'data', 'xxcs_login_cache.json')
    : path.join(__dirname, 'data', 'xxcs_login_cache.json'));
const LOGIN_CACHE_ON = (env('xxcs_login_cache') || '1').toLowerCase() !== '0';

if (!GATEWAY.base) {
  $.log('❌ [配置] 缺少必填环境变量 yyb_server（应用宝网关地址，兼容旧变量 wx_server_url）');
  $.log('本轮结论: 未配置 yyb_server，脚本未执行');
  $.done();
  process.exit(1);
}

/* ============ 工具 ============ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mask(s, head = 6, tail = 6) {
  s = String(s || '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}****${s.slice(-tail)}`;
}

function tokenKey(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

const maskProxy = (raw) => {
  if (!raw || !raw.includes('://') || !raw.includes('@')) return raw || '';
  const i = raw.lastIndexOf('://');
  const scheme = raw.slice(0, i + 3);
  const rest = raw.slice(i + 3);
  const at = rest.lastIndexOf('@');
  const cred = rest.slice(0, at);
  const user = cred.includes(':') ? cred.split(':')[0] : '';
  return `${scheme}${user ? user + ':***' : '***'}@${rest.slice(at + 1)}`;
};

function jsonPreview(data, limit = 300) {
  try { return JSON.stringify(data).slice(0, limit); } catch (_) { return String(data).slice(0, limit); }
}

function _dispW(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d || cp === 0xfe0e) continue;
    if (cp >= 0x1100 && cp <= 0x115f) { w += 2; continue; }
    if (cp >= 0x2e80) { w += 2; continue; }
    if (cp >= 0x1f000) { w += 2; continue; }
    w += 1;
  }
  return w;
}
const padR = (s, width) => s + ' '.repeat(Math.max(0, width - _dispW(s)));

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logTitle(count) {
  $.log('');
  $.log('╔' + '═'.repeat(50) + '╗');
  $.log('║' + padR('🛒 小象超市签到（应用宝网关登录）', 50) + '║');
  $.log('║' + padR(`🕒 启动时间: ${nowText()}`, 50) + '║');
  $.log('║' + padR(`🔢 账号数量: ${count}`, 50) + '║');
  $.log('╚' + '═'.repeat(50) + '╝');
}

function logAccountHeader(index, total, label, ref) {
  $.log('');
  $.log('┌' + '─'.repeat(50) + '┐');
  $.log('│' + padR(`🧩 账号 ${index} / ${total}`, 50) + '│');
  $.log('│' + padR(`🏪 门店 poiId ${POI_ID}`, 50) + '│');
  $.log('│' + padR(`🧾 身份 ${label}`, 50) + '│');
  if (ref && ref !== label) $.log('│' + padR(`🆔 ref ${mask(ref)}`, 50) + '│');
  $.log('└' + '─'.repeat(50) + '┘');
}

/* ============ 代理：只支持 http / https（自建 CONNECT 隧道） ============ */
/* 一个 TunnelAgent（覆写 Agent.createConnection）：
   http 目标直接把隧道 socket 交给 http.Agent 用；https 目标在隧道上再 tls.connect 一层。
   Node 内置模块没有 SOCKS 实现，所以 socks 代理一律回退直连。 */

let proxyEnabled = false;

const PROXY_URL = (() => {
  if (!XXCS_PROXY) return '';
  let raw = XXCS_PROXY;
  if (!raw.includes('://')) {
    const scheme = PROXY_TYPE.startsWith('socks') ? PROXY_TYPE : 'http';
    raw = `${scheme}://${raw}`;
  }
  let u;
  try { u = new URL(raw); } catch (_) { return ''; }
  if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
    $.log('⚠️ [代理] Node 内置模块没有 SOCKS 实现，xxcs_proxy 配了 socks 代理 —— 本次回退直连');
    $.log('          （要么改用 http 代理，要么把 xxcs_proxy 去掉）');
    return '';
  }
  return raw;
})();

const PROXY_LABEL = PROXY_URL ? maskProxy(PROXY_URL) : '';

function makeTunnelAgent(proxyUrl, secure) {
  const u = new URL(proxyUrl);
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const authHeader = (u.username || u.password)
    ? 'Proxy-Authorization: Basic '
      + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
      + '\r\n'
    : '';
  const BaseAgent = secure ? https.Agent : http.Agent;

  class TunnelAgent extends BaseAgent {
    createConnection(options, cb) {
      let settled = false;
      const done = (err, sock) => { if (!settled) { settled = true; cb(err, sock); } };
      const host = options.host || options.hostname;
      const port = options.port || (secure ? 443 : 80);
      const target = `${host}:${port}`;
      const raw = net.connect(proxyPort, proxyHost);
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        raw.removeListener('data', onData);
        const status = parseInt(String(buf).split(' ')[1], 10);
        if (status !== 200) {
          raw.destroy();
          return done(new Error(`代理 CONNECT 失败：${buf.split('\r\n')[0]}`));
        }
        // 握手包里多读出来的字节（正常没有）要还回去
        const rest = Buffer.from(buf.slice(idx + 4), 'latin1');
        if (rest.length) raw.unshift(rest);
        raw.setTimeout(0);
        if (!secure) return done(null, raw);
        const tlsSock = tls.connect({ socket: raw, servername: host });
        tlsSock.once('secureConnect', () => done(null, tlsSock));
        tlsSock.once('error', (e) => done(e));
      };
      raw.on('data', onData);
      raw.once('error', (e) => done(e));
      raw.setTimeout(15000, () => { raw.destroy(); done(new Error('代理连接超时')); });
      raw.once('connect', () => {
        raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authHeader}\r\n`);
      });
    }
  }
  return new TunnelAgent({ keepAlive: false });
}

const agentCache = new Map();
function agentFor(secure) {
  if (!PROXY_URL) return undefined;
  const key = `${secure ? 's' : 'h'}|${PROXY_URL}`;
  if (!agentCache.has(key)) {
    try { agentCache.set(key, makeTunnelAgent(PROXY_URL, secure)); }
    catch (_) { return undefined; }
  }
  return agentCache.get(key);
}

async function validateProxy() {
  if (!PROXY_URL) return false;
  proxyEnabled = true;
  if (!PROXY_VALIDATE) {
    $.log(`🌐 [代理] 已启用：${PROXY_LABEL}（跳过连通性验证）`);
    return true;
  }
  for (let i = 1; i <= PROXY_RETRY_TIMES; i++) {
    const r = await request('GET', PROXY_VALIDATE_URL, { timeout: 10000, proxy: true });
    if (r.status >= 200 && r.status < 400) {
      $.log(`🌐 [代理] 连通性验证通过：${PROXY_LABEL} → HTTP ${r.status}`);
      return true;
    }
    if (r.error) $.log(`⚠️ [代理] 第 ${i} 次验证失败：${r.error}`);
    if (i < PROXY_RETRY_TIMES) await sleep(2000);
  }
  $.log('⚠️ [代理] 验证未通过，本次回退直连');
  proxyEnabled = false;
  return false;
}

/* ============ 网络请求（零依赖，硬超时 + 可选代理） ============ */

/**
 * 统一 HTTP 请求。opts: { json | form | body, headers, timeout, proxy }
 * 返回 { status, headers, text, json, error }
 *
 * 硬超时用普通 setTimeout（刻意不 unref）：不依赖 socket，
 * 卡在 DNS / 代理 CONNECT / TLS 握手阶段也能兜住，保证 promise 一定 settle。
 */
function request(method, url, opts = {}) {
  const useProxy = !!opts.proxy && proxyEnabled;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 0, error: '非法 URL', text: '' }); }

    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.json != null) {
      payload = Buffer.from(JSON.stringify(opts.json), 'utf8');
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    } else if (opts.form != null) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), 'utf8');
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (typeof opts.body === 'string' || Buffer.isBuffer(opts.body)) {
      payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
    }
    if (payload) headers['Content-Length'] = payload.length;

    const timeout = opts.timeout || REQUEST_TIMEOUT;
    let settled = false;
    let req = null;
    let hard = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (hard) clearTimeout(hard);
      resolve(v);
    };

    const finish = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => done({ status: 0, error: e.message, text: '' }));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON */ }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    };

    const isHttps = u.protocol === 'https:';
    const baseOpts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    };
    if (useProxy) {
      const agent = agentFor(isHttps);
      if (agent) baseOpts.agent = agent;
    }

    hard = setTimeout(() => {
      try { if (req) req.destroy(); } catch (_) {}
      done({ status: 0, error: 'TIMEOUT', text: '' });
    }, timeout + 5000);

    try {
      req = (isHttps ? https : http).request(baseOpts, finish);
      req.on('error', (e) => done({ status: 0, error: e.message, text: '' }));
      req.setTimeout(timeout, () => {
        try { req.destroy(); } catch (_) {}
        done({ status: 0, error: 'TIMEOUT', text: '' });
      });
      if (payload) req.write(payload);
      req.end();
    } catch (e) {
      done({ status: 0, error: e.message, text: '' });
    }
  });
}

/** 美团域名统一走代理（海外直连 mall 一定超时）；网关始终直连 */
function mtRequest(method, url, opts = {}) {
  return request(method, url, Object.assign({}, opts, { proxy: true }));
}

/* ============ 网关：账号发现 / 取 code / 续期 ============ */

const gwHeaders = () => ({ 'User-Agent': USER_AGENT, Accept: '*/*' });

async function fetchGatewayAccounts() {
  const r = await request('GET', `${GATEWAY.base}/accounts`, { headers: gwHeaders(), timeout: 20000 });
  if (!r.json || r.json.code !== 0) {
    throw new Error(`网关返回异常：${r.error || jsonPreview(r.json || r.text, 200)}`);
  }
  return (Array.isArray(r.json.data) ? r.json.data : []).filter((a) => a && typeof a === 'object');
}

async function refreshGatewayAccount(ref) {
  try {
    const r = await request('POST', `${GATEWAY.base}/accounts/refresh`, {
      json: { ref }, headers: gwHeaders(), timeout: 120000,
    });
    $.log(`♻️ [授权] 已请求网关续期 ${mask(ref)}（HTTP ${r.status}）`);
  } catch (e) {
    $.log(`⚠️ [授权] 请求网关续期失败：${e.message}`);
  }
}

/**
 * 账号上的脚本标记（scripts，逗号分隔）是否允许跑本脚本。
 * 没标记 = 允许；标记里有本 key = 允许；标记里没有 = 跳过。关掉过滤：yyb_tag_filter=0。
 */
function tagAllows(acc) {
  if (!TAG_FILTER) return true;
  const tags = String((acc && acc.scripts) || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!tags.length) return true;
  return tags.includes(SCRIPT_KEY);
}

/**
 * 解析要跑的账号 [{ref, label}]。
 * 优先级：xxcs_openid > yyb_server 里的 @ref > 自动拉网关全部 alive 账号。
 * 自动发现一个 alive 都没有时，先给所有账号续期再重拉一次。
 * 另外把「网关里不是 alive、但本地有登录态缓存」的账号也纳入 —— 旧 token 还有效就能签到。
 */
async function resolveAccounts() {
  if (XXCS_REFS.length) return XXCS_REFS.map((ref) => ({ ref, label: ref }));
  if (GATEWAY.ref) return [{ ref: GATEWAY.ref, label: GATEWAY.ref }];

  let accounts = await fetchGatewayAccounts();
  let alive = accounts.filter((a) => String(a.status || '').toLowerCase() === 'alive');
  if (!alive.length && accounts.length) {
    $.log('⚠️ [账号] 网关里没有 alive 的账号，尝试全部续期后重拉');
    for (const a of accounts) await refreshGatewayAccount(String(a.openid || a.id || ''));
    accounts = await fetchGatewayAccounts();
    alive = accounts.filter((a) => String(a.status || '').toLowerCase() === 'alive');
  }

  const loginCache = readLoginCacheAll();
  const aliveRefs = new Set(alive.map((a) => String(a.openid || a.id || '')));
  const revived = accounts.filter((a) => {
    const ref = String(a.openid || a.id || '');
    return ref && !aliveRefs.has(ref) && !!getCachedLogin(ref, loginCache);
  });
  if (revived.length) {
    const names = revived.map((a) => {
      const l = String(a.nickname || a.alias || '').trim();
      return l && l !== '-' ? l : String(a.openid || a.id || '');
    });
    $.log(`🔐 [账号] ${revived.length} 个账号在网关里不是 alive，但本地有登录态缓存，一并尝试：${names.join('、')}`);
  }

  const out = [];
  let filtered = 0;
  for (const a of alive.concat(revived)) {
    const ref = String(a.openid || a.id || '');
    if (!ref) continue;
    const label = String(a.nickname || a.alias || '').trim();
    const name = label && label !== '-' ? label : ref;
    if (!tagAllows(a)) {
      filtered++;
      $.log(`⏭️ [账号] 跳过「${name}」：脚本标记 [${String(a.scripts || '').trim()}] 不含本脚本 [${SCRIPT_KEY}]`);
      continue;
    }
    out.push({ ref, label: name });
  }
  if (filtered) {
    $.log(`ℹ️ [账号] 按脚本标记过滤掉 ${filtered} 个账号（本脚本 key=${SCRIPT_KEY}）`);
    $.log('   想让它跑：面板「应用宝账号」页把小象超市勾上；或临时设 yyb_tag_filter=0 忽略标记');
  }
  return out;
}

/** 网关取小象超市小程序的 code（409 = 网关账号登录态失效，续期后重试） */
async function fetchCode(ref) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await request('POST', `${GATEWAY.base}/wxapp/getCode`, {
      json: { app_id: APPID, ref }, headers: gwHeaders(), timeout: 40000,
    });
    if (r.status === 409) {
      $.log('⚠️ [授权] 网关返回 409（账号登录态失效），尝试续期后重试');
      await refreshGatewayAccount(ref);
      if (attempt < 3) await sleep(3000);
      continue;
    }
    if (r.json && r.json.code === 0) {
      const inner = r.json.data || {};
      const code = ((inner.result || {}).code) || inner.code;
      if (code && code !== 'null') {
        $.log(`🔑 [授权] code 获取成功: ${mask(code, 4, 4)}`);
        return String(code);
      }
    }
    $.log(`⚠️ [授权] 第 ${attempt} 次未拿到 code：${r.error || jsonPreview(r.json || r.text, 200)}`);
    if (attempt < 3) await sleep(2000);
  }
  return '';
}

/** code 换登录态，返回 { ok, token, openId, openIdCipher, userId } */
async function loginByCode(code) {
  const r = await mtRequest('POST', LOGIN_URL, {
    form: { code, appName: APP_NAME },
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      xweb_xhr: '1',
      Referer: `https://servicewechat.com/${APPID}/${PAGE_VERSION}/page-frame.html`,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: REQUEST_TIMEOUT,
  });
  const data = r.json;
  if (!data) return { ok: false, error: `登录响应非 JSON（HTTP ${r.status}）：${(r.text || r.error || '').slice(0, 200)}` };

  const inner = (data.data && typeof data.data === 'object') ? data.data : {};
  const token = data.token || inner.token || '';
  if (!token || token === 'null') return { ok: false, error: `未识别到 token：${jsonPreview(data, 300)}` };

  const openId = data.openId || inner.openId || '';
  const openIdCipher = data.openIdCipher || inner.openIdCipher || '';
  const userId = inner.userId || inner.userid || '';
  // openId / openIdCipher 是 mall 接口的必填身份参数，缺了后面每一步都会报「请重新登录」
  if (!openId || !openIdCipher || !userId) {
    return { ok: false, error: `登录响应缺少 openId / openIdCipher / userId：${jsonPreview(data, 300)}` };
  }
  return { ok: true, token: String(token), openId: String(openId), openIdCipher: String(openIdCipher), userId: String(userId) };
}

/* ============ mall 接口 ============ */

function baseHeaders(token) {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    xweb_xhr: '1',
    ytType: '10',                  // 少这个部分接口会空响应
    Referer: `https://servicewechat.com/${APPID}/${PAGE_VERSION}/page-frame.html`,
    t: token,                      // 鉴权就是这个头，别塞到 query / cookie
  };
}

/** 公共 query。openId / uuid 这几个是身份参数，一个都不能省 */
function mallParams(ctx, { checkStatus = false } = {}) {
  const p = {
    activityScene: '',
    app_tag: 'union',
    appnm: 'xiaoxiangmaicai_wxapp',
    bizId: '2',
    ci: '224',
    client_page_source: 'h5',
    isSSREnv: 'false',
    mc_source: '0akaamabjacw',
    openId: ctx.openId,
    openIdCipher: ctx.openIdCipher,
    page_type: 'h5',
    poi: POI_ID,
    poiId: POI_ID,
    sceneEffectiveSkus: '',
    tenantId: '1',
    uci: '224',
    userid: ctx.userId,
    utm_medium: 'wxapp',
    utm_term: '7.26.0',
    uuid: ctx.openId,
    xuuid: ctx.openId,
    ytType: '10',
    yodaReady: 'h5',
    csecplatform: '4',
    csecversion: '4.3.0',
  };
  if (checkStatus) {
    p.channel = '99';
    p.time = String(Date.now());
  }
  return p;
}

function withQuery(apiPath, params) {
  const qs = new URLSearchParams(params).toString();
  return `${MALL_BASE}${apiPath}?${qs}`;
}

/** riskMap：小程序 webview 里指纹本来就是空串，照抄即可 */
function riskMap(ctx) {
  return {
    platform: 13,
    app: 95,
    utm_term: '',
    uuid: ctx.openId,
    utm_medium: 'wxapp',
    fingerprint: '',
  };
}

async function mallGet(ctx, apiPath, params) {
  const r = await mtRequest('GET', withQuery(apiPath, params), {
    headers: baseHeaders(ctx.token), timeout: REQUEST_TIMEOUT,
  });
  if (DEBUG) $.log(`  [debug] GET ${apiPath} → ${r.status} ${jsonPreview(r.json || r.text, 400)}`);
  if (!r.json) return { code: -1, msg: r.error || `HTTP ${r.status}`, raw: r.text };
  return r.json;
}

async function mallPost(ctx, apiPath, params, body) {
  const r = await mtRequest('POST', withQuery(apiPath, params), {
    headers: baseHeaders(ctx.token), json: body, timeout: REQUEST_TIMEOUT,
  });
  if (DEBUG) $.log(`  [debug] POST ${apiPath} → ${r.status} ${jsonPreview(r.json || r.text, 400)}`);
  if (!r.json) return { code: -1, msg: r.error || `HTTP ${r.status}`, raw: r.text };
  return r.json;
}

const respMsg = (r) => (r && (r.msg || r.message
  || (r.error && (r.error.msg || r.error.message)) || r.data)) || '未知错误';

/** 请求是否属于「网络层面根本没到美团」（海外直连 mall 的典型症状） */
function looksLikeNetworkFail(r) {
  return r && r.code === -1 && typeof r.msg === 'string'
    && /TIMEOUT|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|ETIMEDOUT/i.test(r.msg);
}

/* ============ 签到链路 ============ */

async function getStatus(ctx) {
  const r = await mallGet(ctx, `${CHECKIN_API}/getCheckInMainView`, mallParams(ctx, { checkStatus: true }));
  if (r.code !== 0) return { ok: false, error: respMsg(r), raw: r };
  const d = r.data || {};
  const info = d.userInfo || {};
  return {
    ok: true,
    signed: d.checkInButtonStatus === 'CHECKIN',
    status: d.checkInButtonStatus || 'UNKNOWN',
    balance: info.balance != null ? String(info.balance) : '-',
    downgrade: !!d.downgradeCheckIn,
    notice: d.noticeDetail || '',
  };
}

async function doSignIn(ctx) {
  const r = await mallPost(ctx, `${CHECKIN_API}/userCheckInNew`, mallParams(ctx), {
    userId: ctx.userId,
    riskMap: riskMap(ctx),
  });
  if (r.code !== 0) return { ok: false, error: respMsg(r), raw: r };
  const d = r.data || {};
  return {
    ok: true,
    result: d.result !== false,
    reward: d.rewardValue != null ? String(d.rewardValue) : '',
  };
}

/** 本周进度：顺手拿到今天这一笔的奖励数额 */
async function getWeekProgress(ctx) {
  const r = await mallGet(ctx, `${CHECKIN_API}/getWeekCheckInProgressBar`, mallParams(ctx));
  if (r.code !== 0) return null;
  const d = r.data || {};
  return { count: d.checkInCount != null ? String(d.checkInCount) : '-', downgrade: !!d.downgrade };
}

/** 连续签到奖励（getWeekContinuousRewardNew 的 rewardDate 是 int，形如 20261116） */
async function claimContinuous(ctx) {
  const rewardDate = Number(new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ''));
  const r = await mallPost(ctx, `${CHECKIN_API}/getWeekContinuousRewardNew`, mallParams(ctx), {
    userId: ctx.userId,
    rewardDate,
    riskMap: riskMap(ctx),
  });
  if (r.code !== 0) return { ok: false, error: respMsg(r) };
  return { ok: true, data: r.data };
}

/**
 * 任务：拉列表 → 待领奖的直接领，没领过的先领任务。
 * takeTask      参数 activityId + taskId(=id) + userId + poiId + channel
 * takeTaskReward 参数 activityId + taskId + userId + rewardId + userTaskId + taskType + channel
 * 任务随机下发，列表经常是空的，属正常。
 */
async function handleTasks(ctx) {
  const r = await mallGet(ctx, `${CHECKIN_API}/queryTaskListInfoV2`, mallParams(ctx));
  if (r.code !== 0) return { ok: false, error: respMsg(r), lines: [] };

  const tasks = (r.data && Array.isArray(r.data.checkInTaskInfos)) ? r.data.checkInTaskInfos : [];
  if (!tasks.length) return { ok: true, tasks: 0, lines: ['🎯 任务：当前没有下发任务（随机，正常）'] };

  const lines = [`🎯 任务：共 ${tasks.length} 个`];
  let taken = 0;
  let rewarded = 0;

  for (const t of tasks) {
    if (!t || !t.activityId || !t.id) continue;
    const name = t.taskName || t.name || t.title || `任务${t.id}`;

    // 有 rewardId + userTaskId = 已经完成，等着领奖
    if (t.rewardId && t.userTaskId) {
      const res = await mallPost(ctx, `${CHECKIN_API}/takeTaskReward`, mallParams(ctx), {
        activityId: t.activityId,
        taskId: t.id,
        userId: ctx.userId,
        rewardId: t.rewardId,
        userTaskId: t.userTaskId,
        taskType: t.taskType,
        channel: 7,
        riskMap: riskMap(ctx),
      });
      if (res.code === 0) {
        rewarded++;
        const v = res.data && res.data.rewardValue != null ? ` +${res.data.rewardValue}` : '';
        lines.push(`  ✅ ${name}：领奖成功${v}`);
      } else {
        lines.push(`  ⚠️ ${name}：领奖失败（${respMsg(res)}）`);
      }
      continue;
    }

    // 其余一律当「还没领任务」处理，重复领服务端会明确报错，无副作用
    const res = await mallPost(ctx, `${CHECKIN_API}/takeTask`, mallParams(ctx), {
      activityId: t.activityId,
      taskId: t.id,
      userId: ctx.userId,
      poiId: POI_ID,
      channel: 7,
      riskMap: riskMap(ctx),
    });
    if (res.code === 0) {
      taken++;
      lines.push(`  ✅ ${name}：领取任务成功`);
    } else {
      lines.push(`  ⚠️ ${name}：领取任务失败（${respMsg(res)}）`);
    }
  }

  await sleep(800);
  return { ok: true, tasks: tasks.length, taken, rewarded, lines };
}

/**
 * 跑一个账号。只依赖 ctx（登录态），方便「缓存 token 被拒 → 重新登录重跑」。
 */
async function runChains(ctx) {
  const lines = [];
  let authFail = false;
  let ok = false;
  let reward = '';
  let justSigned = false;

  /* 1) 签到前的状态 */
  const before = await getStatus(ctx);
  if (before.code === 5 || (!before.ok && looksLikeNetworkFail(before.raw))) {
    return { ok: false, authFail: false, balance: '-', lines, netFail: !before.ok && looksLikeNetworkFail(before.raw) };
  }
  if (!before.ok) {
    authFail = /登录|token/i.test(before.error || '');
    return { ok: false, authFail, balance: '-', lines: [`✖ 查询签到状态失败：${before.error}`] };
  }

  $.log(`💰 [余额] ${before.balance} 买菜币 ｜ 签到状态: ${before.status}`);
  lines.push(`💰 签到前：${before.balance} 买菜币（${before.status}）`);

  if (before.downgrade) {
    lines.push('⚠️ 账号被降级（downgradeCheckIn=true），本次跳过签到');
    return { ok: true, balance: before.balance, lines };
  }

  /* 2) 签到 */
  if (before.signed) {
    $.log('✅ [签到] 今日已签到，跳过');
    lines.push('✅ 签到：今日已签到');
  } else {
    const sign = await doSignIn(ctx);
    if (!sign.ok) {
      authFail = /登录|token/i.test(sign.error || '');
      $.log(`⚠️ [签到] ${sign.error}`);
      lines.push(`⚠️ 签到失败：${sign.error}`);
    } else if (!sign.result) {
      $.log('⚠️ [签到] 服务端返回 result=false（大概率今天已经签过了）');
      lines.push('⚠️ 签到：服务端返回 result=false');
    } else {
      reward = sign.reward;
      justSigned = true;
      $.log(`✅ [签到] 签到成功 +${reward || '?'} 买菜币`);
      lines.push(`✅ 签到：成功 +${reward || '?'} 买菜币`);
    }
  }

  /* 3) 周进度 */
  const week = await getWeekProgress(ctx);
  if (week) {
    $.log(`📅 [进度] 本周已签到 ${week.count} 天`);
    lines.push(`📅 本周签到进度：${week.count} 天`);
  }

  /* 4) 连续奖励：只有第 3 / 7 天是里程碑（页面气泡文案 thirdDay/seventhDay），
        其它日子调这个接口只会回「您的设备已经参加过活动」，纯噪音，所以按天数门控。 */
  if (DO_CONTINUOUS) {
    const day = week ? Number(week.count) || 0 : 0;
    if (!justSigned) {
      // 今天不是本次签的，里程碑奖励一般随签到一起发，不再重复调
      $.log('🎁 [连续] 今日非本次签到，跳过连续奖励领取');
    } else if (day !== 3 && day !== 7) {
      $.log(`🎁 [连续] 本周第 ${day} 天，未到 3/7 天里程碑，跳过`);
      lines.push(`🎁 连续奖励：本周第 ${day} 天，未到里程碑`);
    } else {
      const cont = await claimContinuous(ctx);
      if (cont.ok) {
        const v = cont.data && cont.data.rewardValue != null ? ` +${cont.data.rewardValue}` : '';
        $.log(`🎁 [连续] 第 ${day} 天里程碑奖励${v || '已处理'}`);
        lines.push(`🎁 连续奖励（第 ${day} 天）：${v ? '领到' + v : '已处理'}`);
      } else if (/已经参加|重复|已领/i.test(cont.error || '')) {
        $.log(`🎁 [连续] 第 ${day} 天里程碑奖励已领过：${cont.error}`);
        lines.push(`🎁 连续奖励（第 ${day} 天）：已领过`);
      } else {
        $.log(`⚠️ [连续] ${cont.error}`);
        lines.push(`⚠️ 连续签到奖励：${cont.error}`);
      }
    }
  }

  /* 5) 任务 */
  if (DO_TASK) {
    const task = await handleTasks(ctx);
    if (!task.ok) {
      $.log(`⚠️ [任务] ${task.error}`);
      lines.push(`⚠️ 任务：${task.error}`);
    } else {
      task.lines.forEach((l) => $.log(l.startsWith('  ') ? l : l));
      lines.push(...task.lines);
    }
  }

  /* 6) 签到后的余额 */
  const after = await getStatus(ctx);
  const balance = after.ok ? after.balance : before.balance;
  if (after.ok) {
    $.log(`💰 [余额] 现在 ${balance} 买菜币`);
    lines.push(`💰 签到后：${balance} 买菜币`);
  }

  ok = before.signed || !!reward || !!(after.ok && after.signed);
  return { ok, balance, reward, authFail, lines };
}

/* ============ 登录态缓存（跨天复用；被服务端拒绝时自动回退网关取 code） ============ */
/* 形状：{ accounts: { <sha256(ref)[0:12]>: {ref,token,openId,openIdCipher,userId,nickname,obtained_at} } }
   只要服务端还认这个 token 就一直用；文件含 token，按 0600 写。 */

function readLoginCacheAll() {
  if (!LOGIN_CACHE_ON) return {};
  try {
    const all = JSON.parse(fs.readFileSync(LOGIN_CACHE_FILE, 'utf8'));
    if (all && all.accounts && typeof all.accounts === 'object') return all.accounts;
  } catch (_) { /* 不存在/损坏 → 当没有 */ }
  return {};
}

function writeLoginCacheAll(accounts) {
  if (!LOGIN_CACHE_ON) return;
  try {
    fs.mkdirSync(path.dirname(LOGIN_CACHE_FILE), { recursive: true });
    fs.writeFileSync(LOGIN_CACHE_FILE, JSON.stringify({
      note: '小象超市登录态缓存（按网关 ref 索引；含 token，敏感文件，权限 0600）。'
        + '失效后由脚本自动回退「网关取 code 重新登录」并覆盖本文件。',
      accounts,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(LOGIN_CACHE_FILE, 0o600); } catch (_) {}
  } catch (e) {
    $.log(`[提示] 登录态缓存写入失败（不影响签到）：${e.message}`);
  }
}

function getCachedLogin(ref, all) {
  if (!LOGIN_CACHE_ON) return null;
  const rec = (all || {})[tokenKey(ref)];
  if (!rec || !rec.token || !rec.openId || !rec.openIdCipher) return null;
  return {
    token: String(rec.token),
    openId: rec.openId,
    openIdCipher: rec.openIdCipher,
    userId: rec.userId || '',
    nickname: rec.nickname || '',
    obtained_at: Number(rec.obtained_at || 0) || 0,
  };
}

function putCachedLogin(all, ref, ctx, nickname) {
  if (!LOGIN_CACHE_ON) return;
  all[tokenKey(ref)] = {
    ref: String(ref),
    token: ctx.token,
    openId: ctx.openId,
    openIdCipher: ctx.openIdCipher,
    userId: ctx.userId,
    nickname: nickname || ctx.nickname || '',
    obtained_at: Math.floor(Date.now() / 1000),
  };
}

function fmtTs(sec) {
  if (!sec) return '未知时间';
  try {
    return new Date(sec * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch (_) { return '未知时间'; }
}

/* ============ 推送 ============ */

async function pushByWebhook(title, content) {
  const url = env('XXCS_PUSH_URL', 'MT_PUSH_URL');
  if (!url) return false;
  try {
    const r = await request('POST', url, { json: { title, content }, timeout: REQUEST_TIMEOUT });
    if (r.status >= 200 && r.status < 300) return true;
    $.log(`[推送] 自定义推送失败：HTTP ${r.status || r.error}`);
    return false;
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
  let sent = await pushByWebhook(title, content);
  if (!sent && typeof $.msg === 'function') {
    try { await $.msg(title, content); sent = true; } catch (e) { $.log(`[推送] $.msg 调用失败：${e.message}`); }
  }
  if (!sent) sent = await pushBySendNotify(title, content);
  if (!sent) $.log('[推送] 未配置推送，结果仅输出日志');
}

/* ============ 单账号 ============ */

async function runAccount(index, total, account, loginCache) {
  const ref = account.ref;
  logAccountHeader(index, total, account.label, ref);

  const delay = 2 + Math.floor(Math.random() * 4);
  $.log(`⏳ [延迟] 启动延迟 ${delay}s`);
  await sleep(delay * 1000);

  let ctx = getCachedLogin(ref, loginCache);
  let fromCache = !!ctx;
  if (ctx) {
    $.log(`🔐 [登录] 命中本地登录态缓存（${fmtTs(ctx.obtained_at)} 获取），先复用，不去网关取 code`);
  }

  const freshLogin = async (reason) => {
    if (reason) $.log(`♻️ [登录] ${reason}，改用网关取 code 重新登录`);
    const code = await fetchCode(ref);
    if (!code) return { ok: false, error: '网关取 code 失败（账号登录态可能已失效，可去面板重扫）' };
    const login = await loginByCode(code);
    if (!login.ok) return { ok: false, error: `登录失败：${login.error}` };
    $.log(`✅ [登录] 网关登录成功: ${mask(login.token)}（${login.token.length} 字符）`);
    return { ok: true, ctx: login };
  };

  if (!ctx) {
    const fresh = await freshLogin('');
    if (!fresh.ok) return { ok: false, error: fresh.error, lines: [] };
    ctx = fresh.ctx;
    fromCache = false;
  }

  let run = await runChains(ctx);

  // 缓存的登录态被服务端拒绝 → 换新 token 重跑一次
  if (fromCache && run.authFail) {
    const fresh = await freshLogin('本地登录态被服务端拒绝');
    if (!fresh.ok) {
      $.log(`  ✖ 回退登录也失败：${fresh.error}`);
      return { ok: false, error: fresh.error, lines: run.lines };
    }
    ctx = fresh.ctx;
    fromCache = false;
    run = await runChains(ctx);
  }

  // 直连 mall 超时且没配代理 → 给出明确提示，别让人以为是风控
  if (run.netFail && !proxyEnabled) {
    run.lines.unshift('❌ 连不上 mall.meituan.com（请求超时）—— 海外机器直连一定失败，'
      + '请配置 xxcs_proxy 走国内出口，或把脚本放到国内机器跑');
    run.ok = false;
  }

  if (!fromCache && LOGIN_CACHE_ON && run.ok !== false) {
    putCachedLogin(loginCache, ref, ctx, account.label);
    $.log('💾 [登录] 已缓存本次登录态，下次运行可直接复用');
  }

  return { ok: run.ok, balance: run.balance, reward: run.reward, lines: run.lines };
}

/* ============ 主流程 ============ */

function watchdog(ms, onFire) {
  // 普通 setTimeout（刻意不 unref）：极端情况下强制收尾，不让青龙任务挂死
  return setTimeout(onFire, ms);
}

!(async () => {
  // 保活：撑住事件循环，别 unref
  const keepAlive = setInterval(() => { /* 仅用于撑住事件循环 */ }, KEEPALIVE_MS);

  let exitCode = 0;
  const globalWatchdog = watchdog(30 * 60 * 1000, () => {
    $.log('\n⛔ 看门狗触发：整体运行超过 30 分钟，强制收尾（避免青龙任务挂死）');
    try { $.done(); } catch (_) {}
    process.exit(0);
  });

  try {
    if (PROXY_URL) {
      $.log(`🌐 [代理] 使用静态代理 ${PROXY_LABEL}`);
      const ok = await validateProxy();
      if (ok) $.log('✅ [代理] 验证通过');
      else $.log('🔁 [兜底] 代理不可用，本次改用直连（mall 大概率超时）');
    } else {
      $.log('🔌 [代理] 未配置 xxcs_proxy / script_proxy，使用直连');
      $.log('   ⚠️ mall.meituan.com 对海外出口不放行，海外机器请务必配国内代理');
    }

    let accounts = [];
    try {
      accounts = await resolveAccounts();
    } catch (e) {
      $.log(`❌ [账号] 从网关获取账号失败：${e.message}`);
      accounts = [];
    }
    if (!accounts.length) {
      $.log('❌ [账号] 没有可用账号：请到扫码面板扫码登录，或配置 xxcs_openid / 在 yyb_server 里用 @ref 指定');
      $.log('本轮结论: 没有可用账号，脚本未执行');
      $.done();
      return;
    }
    if (!XXCS_REFS.length && !GATEWAY.ref) {
      $.log(`🌐 [账号] 已自动从网关发现 ${accounts.length} 个账号`);
    }

    logTitle(accounts.length);
    $.log(`📋 范围：签到=开 ｜ 任务=${DO_TASK ? '开' : '关'} ｜ 连续奖励=${DO_CONTINUOUS ? '开' : '关'}`);

    const loginCache = readLoginCacheAll();
    if (LOGIN_CACHE_ON) {
      const n = Object.keys(loginCache).length;
      $.log(`🔐 [登录] 本地登录态缓存：${n ? `已存 ${n} 个账号（优先复用）` : '暂无（本次登录后会自动写入）'}`);
    } else {
      $.log('🔐 [登录] 已通过 xxcs_login_cache=0 关闭登录态复用，每次都去网关取 code');
    }

    const results = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      let timer = null;
      const timeout = new Promise((r) => {
        // 不 unref！unref 之后它不撑事件循环，卡死时根本来不及 fire
        timer = setTimeout(() => r('__timeout__'), ACCOUNT_TIMEOUT);
      });

      let result;
      try {
        result = await Promise.race([runAccount(i + 1, accounts.length, account, loginCache), timeout]);
      } catch (e) {
        result = { ok: false, error: `异常：${e.message}`, lines: [] };
      }
      if (timer) clearTimeout(timer);

      if (result === '__timeout__') {
        $.log(`[${i + 1}/${accounts.length}] ⏱️ 处理超时（>${Math.round(ACCOUNT_TIMEOUT / 1000)}s），跳过该账号`);
        result = { ok: false, error: `处理超时（>${Math.round(ACCOUNT_TIMEOUT / 1000)}s）`, lines: [] };
      }

      results.push(Object.assign({ label: account.label, ref: account.ref }, result));

      if (i < accounts.length - 1) {
        $.log('');
        $.log('⏳ [间隔] 等待 3s 后处理下一个账号');
        await sleep(3000);
      }
    }

    try { writeLoginCacheAll(loginCache); } catch (_) { /* 已在函数里打过日志 */ }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    $.log('');
    $.log('╔' + '═'.repeat(50) + '╗');
    $.log('║' + padR('🏁 小象超市签到任务执行完成', 50) + '║');
    $.log('║' + padR(`✅ 正常账号: ${okCount}`, 50) + '║');
    $.log('║' + padR(`❌ 失败账号: ${failCount}`, 50) + '║');
    $.log('║' + padR(`🕒 结束时间: ${nowText()}`, 50) + '║');
    $.log('╚' + '═'.repeat(50) + '╝');

    const lines = [];
    results.forEach((r, i) => {
      lines.push(`【账号 ${i + 1}】${r.label}（${mask(r.ref)}）`
        + (r.ok ? `：${r.balance} 买菜币` : `：${r.error || '未完成'}`));
      (r.lines || []).forEach((l) => lines.push('  ' + l));
      lines.push('');
    });
    await push(okCount ? '🛒 小象超市签到完成' : '小象超市签到结果', lines.join('\n').trim());
  } catch (e) {
    exitCode = 1;
    $.log(`❌ [主程序] 执行异常：${e && e.message ? e.message : e}`);
    $.log(e && e.stack ? e.stack : '');
  } finally {
    clearInterval(keepAlive);
    clearTimeout(globalWatchdog);
    try { $.done(); } catch (_) {}
    if (exitCode) process.exit(exitCode);
  }
})();
