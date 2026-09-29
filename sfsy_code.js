/*
------------------------------------------
@Description: 顺丰速运 全任务版（应用宝网关取 code + 日常积分 / 会员日 / 红包大派送 / 优惠券 / 中秋博饼集礼盒）
cron: 20 8,12,20 * * *
new Env('顺丰速运')
------------------------------------------
设计说明：
  · 零外部依赖：只用 Node 内置 https/http/net/tls/crypto/fs/path，
    不再依赖 axios / ../tools/env.js / ./wcs.js（那几个文件仓库里并不存在，脚本原先根本加载不起来）
  · 自带 Cookie Jar、重定向跟随、超时重试、CONNECT 隧道代理，可直接在青龙裸环境跑

环境变量：
  sf_openid        顺丰账号（微信 openid），多账号用 & 、逗号 、或换行分隔，可加 #备注
  yyb_server       应用宝网关地址（推荐），支持 @账号ref，例：http://yyb-go:8000@1
                   —— 脚本用 POST {yyb_server}/wxapp/getCode 取 code
  wx_server_url    兼容变量：网关地址（yyb_server 为空时生效，请求方式相同）
  sfsyUrl / sf     兼容变量：直接给 Cookie 串或登录 URL（不经过网关）

  代理（可选，海外服务器访问国内接口必配）：
  sf_proxy          静态代理地址，形如 http://user:pass@host:port（也可用 script_proxy，与朴朴脚本共用）
                    —— 树脂（resin）就是这种写法：http://:管理token@主机:2260（用户名注意留空！）
                    —— 只用这一个就够了，推荐
  sf_proxy_api_url  可选：代理提取 API（每次提取一个，支持 JSON / 纯文本返回）。
                    注意提取接口本身多半也在国内，海外机器需要先用 sf_proxy 引导才能访问它；
                    且不少供应商需要把调用方出口 IP 加白名单，不适合配动态出口。国内环境再考虑用。
                    —— 只在 https 请求上走代理；内网 http 网关自动直连（外部代理解析不了容器内网域名）
  sf_proxy_mode     置为 api 时优先用提取 API（此时会用 sf_proxy 当引导去访问提取接口）；
                    默认静态代理优先

  sf_autumn        中秋活动开关，默认 1（活动时间窗内才执行）
  sf_dry_run       自检模式，默认 0；设为 1 则只查询不消耗（首次验证账号用）
  sf_verbose       详细日志，默认 0

中秋活动时间：2026-09-11 10:00 ~ 2026-10-08 19:00（超出窗口自动跳过，不报错）
------------------------------------------
*/

'use strict';

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/* ==================== 运行环境（青龙 Env + 本地兜底） ==================== */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 注意：青龙靠扫描 Env 构造参数里的字符串字面量取任务名，必须写字面量
      return new Env('顺丰速运');
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

const LOG = (msg) => $.log(msg);
const VLOG = (msg) => { if (VERBOSE) $.log(msg); };

/* ==================== 常量 ==================== */

const APPID = 'wxd4185d00bf7e08ac';
const PUBLIC_ID = 'gh_f9d9fca26a50';
const PAGE_VERSION = '663';
const TOKEN = 'wwesldfs29aniversaryvdld29';
const SYS_CODE = 'MCS-MIMP-CORE';
const UCMP_BASE = 'https://ucmp.sf-express.com';
const MCS_BASE = 'https://mcs-mimp-web.sf-express.com';

const UA_MP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
  + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) XWEB/19027';
const UA_H5 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x1800452d) NetType/WIFI Language/zh_CN';

const TIMEOUT = 25000;
const MAX_RETRY = 3;

/* ---- 中秋博饼集礼盒活动（2026-09-11 10:00 ~ 2026-10-08 19:00，用绝对时刻比较，不受容器时区影响） ---- */
const AUTUMN_START = Date.parse('2026-09-11T10:00:00+08:00');
const AUTUMN_END = Date.parse('2026-10-08T19:00:00+08:00');
const AUTUMN_CODE = 'MID_AUTUMN_2026';
const AUTUMN_CITY = '551';
const AUTUMN_INVITE_USER_IDS = ['E72FE5AFC7B14F3D96C9F0C9147A66CE', '198E8A9C50704D41AE133DFC89B543D0'];
const AUTUMN_CHANNELS = [
  { name: '小程序', channel: '26zhongqiu07', channelType: 'MINI_PROGRAM', platform: 'MINI_PROGRAM' },
  { name: 'APP', channel: '26zhongqiu01', channelType: 'SFAPP', platform: 'SFAPP' },
];
// 需人工/真实寄件才能完成的任务类型，直接跳过
const AUTUMN_SKIP_TYPES = [
  'SEND_SUCCESS_RECALL', 'LOOK_BIG_PACKAGE_GET_CASH', 'OPEN_FAMILY_HOME_MUTUAL',
  'SHUNYUN_CARD', 'CHARGE_NEW_EXPRESS_CARD', 'OPEN_APP_NOTIFICATION',
];
const AUTUMN_RANK_CN = { 1: '状元', 2: '榜眼', 3: '探花', 4: '进士', 5: '举人', 6: '秀才', 0: '参与奖' };

/* ---- 红包大派送（固定常量） ---- */
const RP_AC_ID = '1D2532575D49438FA3D63842BF53F6EB';
const RP_SECEND_CHANNEL = 'MBHD_BASIC20260409160224813';
const RP_RULE_CODE = 'SFGZ20260409160224757';
const RP_MD5_SIGN = 'f196f7a1db74f90f84bf03b8d54fc006';

/* ---- 日常任务：无法自动完成 / 不需处理的任务 ---- */
const DAILY_SKIP_TITLES = [
  '用行业模板寄件下单', '用积分兑任意礼品', '参与积分活动', '每月累计寄件', '完成每月任务',
  '去使用AI寄件', '去新增一个收件偏好', '设置你的顺丰ID', '去使用AI小丰寄件', '寄一单国际件',
];
const EXECUTE_FIRST_KEYWORDS = ['浏览', '查看', '点击', '去微博', '打开', '去看看', '看小丰'];

/* ==================== 环境变量 ==================== */

const ENV = (k) => String(process.env[k] || '').trim();

const SF_OPENID = ENV('sf_openid');
const YYB_SERVER = (ENV('yyb_server') || ENV('wx_server_url')).replace(/\/+$/, '');
const RAW_COOKIE_ENV = ENV('sfsyUrl') || ENV('sf');
const STATIC_PROXY = ENV('sf_proxy') || ENV('script_proxy');
const PROXY_API_URL = ENV('sf_proxy_api_url') || ENV('script_proxy_api_url');
// sf_proxy_mode=api：优先用提取 API（可用静态代理引导）；默认静态代理优先
const PROXY_MODE_API = ENV('sf_proxy_mode') === 'api';
const DRY_RUN = ENV('sf_dry_run') === '1';
const VERBOSE = ENV('sf_verbose') === '1';
const AUTUMN_ENABLED = ENV('sf_autumn') !== '0';

/* ==================== 小工具 ==================== */

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (s) => {
  const v = String(s || '');
  return v.length >= 7 ? `${v.slice(0, 3)}****${v.slice(-4)}` : v;
};
const crop = (v, n = 200) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return !t ? '' : (t.length > n ? t.slice(0, n) + '...' : t);
};
const splitAccounts = (raw) => String(raw || '')
  .replace(/，/g, ',').replace(/,/g, '&').replace(/\r?\n/g, '&')
  .split('&').map((s) => s.trim()).filter(Boolean);

/** 顺丰业务签名：signature = md5(token&timestamp&sysCode) */
function signHeaders() {
  const timestamp = String(Date.now());
  return {
    syscode: SYS_CODE,
    timestamp,
    signature: md5(`token=${TOKEN}&timestamp=${timestamp}&sysCode=${SYS_CODE}`),
  };
}

/* ==================== 代理（树脂静态代理 / 品赞提取 API，均零依赖） ==================== */

/**
 * 把 http 代理 URL 变成一个可复用的 Agent（自建 CONNECT 隧道）
 * 树脂的写法是「token 填在密码位、用户名留空」：http://:token@host:port
 */
function makeTunnelAgent(proxyUrl, secure) {
  const u = new URL(proxyUrl);
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const authHeader = (u.username || u.password)
    ? 'Proxy-Authorization: Basic '
      + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
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
        const rest = Buffer.from(buf.slice(idx + 4), 'latin1');
        if (rest.length) raw.unshift(rest);
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
function agentFor(proxyUrl, secure) {
  const key = `${secure ? 's' : 'h'}|${proxyUrl}`;
  if (!agentCache.has(key)) agentCache.set(key, makeTunnelAgent(proxyUrl, secure));
  return agentCache.get(key);
}

/** 极简 HTTP 请求（返回文本），用于访问代理提取 API；agent 可选 */
function plainGet(url, timeout = 10000, agent) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, error: '非法 URL' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(
      { hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, timeout, agent },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ ok: true, status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

/** 代理池：默认静态代理优先；sf_proxy_mode=api 则用提取 API（可用静态代理引导） */
class ProxyPool {
  constructor() {
    this.useApi = PROXY_MODE_API || !STATIC_PROXY;
    this.current = this.useApi ? '' : STATIC_PROXY;
  }

  async refresh(reason) {
    if (!this.useApi) return this.current;
    if (!PROXY_API_URL) return '';
    // 提取 API 本身多半也在国内（品赞 service.ipzan.com 就是），海外机器直连不通，
    // 所以直连失败后再经静态代理试一次 —— 用树脂引导品赞。
    const attempts = [
      { label: '直连', agent: undefined },
      { label: '经静态代理', agent: STATIC_PROXY ? agentFor(STATIC_PROXY, true) : undefined },
    ];
    for (const a of attempts) {
      if (!a.agent && a.label !== '直连') continue;
      let r;
      try {
        r = await plainGet(PROXY_API_URL, 12000, a.agent);
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r.ok) { VLOG(`   提取代理(${a.label})失败：${r.error}`); continue; }

      const picked = ProxyPool.parseExtract(r.text);
      if (picked) {
        if (picked !== this.current) LOG(`🔄 切换代理${reason ? `（${reason}）` : ''}：${ProxyPool.display(picked)}`);
        this.current = picked;
        return picked;
      }
      // 拿不到 IP：把服务端的 message 透出来（余额不足 / 白名单 / 频率过快 等）
      let hint = crop(r.text, 160);
      try {
        const j = JSON.parse(r.text);
        if (j && j.message) hint = j.message;
      } catch (_) { /* 非 JSON */ }
      LOG(`⚠️ 提取代理(${a.label})未拿到可用 IP：${hint}`);
      break;
    }
    return this.current;
  }

  /** 品赞 JSON（{code:0,data:{list:[{ip,port,account,password}]}}）或纯文本 IP:PORT / IP:PORT user pass */
  static parseExtract(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    try {
      const j = JSON.parse(raw);
      const list = (j && j.data && j.data.list) || (j && j.list) || [];
      if (Array.isArray(list) && list.length) {
        const it = list[0];
        if (it.ip && it.port) {
          const auth = it.account && it.password
            ? `${encodeURIComponent(it.account)}:${encodeURIComponent(it.password)}@`
            : '';
          return `http://${auth}${it.ip}:${it.port}`;
        }
      }
      // 提取失败：把服务端的提示透出来（套餐余量不足 / secret密匙错误 等）
      if (j && j.code !== 0) return '';
      return '';
    } catch (_) { /* 非 JSON，按纯文本处理 */ }

    const parts = raw.split(/\s+/);
    if (parts.length === 3 && /^[\d.]+:\d+$/.test(parts[0])) {
      return `http://${parts[1]}:${parts[2]}@${parts[0]}`;
    }
    if (/^[\d.]+:\d+$/.test(parts[0])) return `http://${parts[0]}`;
    if (/^https?:\/\//.test(parts[0])) return parts[0];
    return '';
  }

  static display(proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      return `${u.host}`;
    } catch (_) { return proxyUrl; }
  }
}

/** 只有 https 走代理：内网网关是 http，必须直连（外部代理解析不了容器内网域名） */
function proxyFor(proxyUrl, urlStr) {
  if (!proxyUrl) return undefined;
  if (!String(urlStr).startsWith('https:')) return undefined;
  try { return agentFor(proxyUrl, true); } catch (_) { return undefined; }
}

/* ==================== Cookie Jar ==================== */

class CookieJar {
  constructor() { this.map = {}; }

  absorb(setCookie) {
    if (!setCookie) return;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const line of arr) {
      const first = String(line).split(';')[0];
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const k = first.slice(0, idx).trim();
      const v = first.slice(idx + 1).trim();
      if (k && v && v !== 'deleted') this.map[k] = v;
    }
  }

  header() {
    return Object.entries(this.map).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(k) { return this.map[k] || ''; }
  merge(obj) { Object.assign(this.map, obj || {}); }
}

/** 把 "sessionId=x;_login_mobile_=y;..." 解析成 jar */
function jarFromCookieString(str) {
  const jar = new CookieJar();
  const obj = {};
  for (const item of String(str).split(';')) {
    const s = item.trim();
    const i = s.indexOf('=');
    if (i > 0) obj[s.slice(0, i)] = s.slice(i + 1);
  }
  jar.merge(obj);
  return jar;
}

/* ==================== HTTP 客户端 ==================== */

function rawRequest(opts) {
  const {
    url, method = 'GET', headers = {}, body = null,
    agent, timeout = TIMEOUT, follow = 0, jar = null,
  } = opts;

  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 0, error: '非法 URL', text: '' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const finalHeaders = Object.assign({}, headers);
    if (payload) {
      if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
      finalHeaders['Content-Length'] = payload.length;
    }
    if (jar) {
      const ck = jar.header();
      if (ck) finalHeaders.Cookie = ck;
    }

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: finalHeaders,
        agent,
      },
      (res) => {
        if (jar) jar.absorb(res.headers['set-cookie']);
        if (follow > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(rawRequest(Object.assign({}, opts, { url: next, follow: follow - 1, method: 'GET', body: null })));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );

    req.on('error', (e) => resolve({ status: 0, error: e.message, text: '' }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT', text: '' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ==================== 网关取 code ==================== */

/**
 * 应用宝网关取微信 code：POST {gateway}/wxapp/getCode
 * 返回 { code:0, data:{ openid, result:{ code, errMsg } } }
 * gateway 支持 "@ref" 写法（与 ppcs 脚本一致），不带 @ 时用传入的 ref
 */
function parseGateway(raw) {
  const i = raw.lastIndexOf('@');
  if (i > 0) return { url: raw.slice(0, i).replace(/\/+$/, ''), ref: raw.slice(i + 1) };
  return { url: raw.replace(/\/+$/, ''), ref: '' };
}

async function fetchWxCode(account, proxyPool) {
  const gw = parseGateway(YYB_SERVER);
  const ref = gw.ref || account.openid;
  if (!gw.url) return { ok: false, error: '未配置 yyb_server / wx_server_url' };
  if (!ref) return { ok: false, error: '未配置 sf_openid' };

  for (let i = 0; i < MAX_RETRY; i++) {
    const r = await rawRequest({
      url: `${gw.url}/wxapp/getCode`,
      method: 'POST',
      headers: { 'User-Agent': UA_MP },
      body: { app_id: APPID, ref },
      timeout: 40000,
      agent: proxyFor(proxyPool.current, gw.url), // http 网关 → 直连
    });
    const j = r.json;
    if (j && j.code === 0) {
      const data = j.data || {};
      const code = (data.result && data.result.code) || data.code || '';
      if (code) return { ok: true, code: String(code) };
    }
    if (r.status === 409) {
      // 网关里账号登录态过期，尝试刷新一次
      VLOG('   网关返回 409，尝试刷新账号登录态');
      await rawRequest({ url: `${gw.url}/accounts/refresh`, method: 'POST', body: { ref }, timeout: 120000 });
      continue;
    }
    if (i < MAX_RETRY - 1) await sleep(1500 * (i + 1));
    else return { ok: false, error: `getCode 失败：${r.status === 0 ? r.error : crop(j || r.text, 160)}` };
  }
  return { ok: false, error: 'getCode 重试耗尽' };
}

/* ==================== 顺丰登录：code → UCMP → 业务 Cookie ==================== */

/** 通用的「失败就重试」包装：代理池类出口偶发连不通，必须靠重试兜住 */
async function withRetry(label, fn, tries, proxyPool) {
  const max = tries || 4;
  let last = '未知错误';
  for (let i = 0; i < max; i++) {
    const r = await fn();
    if (r && r.ok) return r;
    last = (r && r.error) || '未知错误';
    if (i < max - 1) {
      VLOG(`   ${label} 第${i + 1}次失败：${last}`);
      if (/TIMEOUT|ECONN|socket|TLS|EPROTO|ETIMEDOUT|reset|disconnected|代理/i.test(last)) {
        if (proxyPool) await proxyPool.refresh('连接失败');
      }
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: last };
}

async function sfLogin(account, proxyPool) {
  // 已直接给了 cookie 串：不需要网关
  if (/sessionId=|_login_mobile_=/.test(account.raw)) {
    return { ok: true, jar: jarFromCookieString(account.raw), via: 'cookie' };
  }

  return withRetry('登录', async () => {
    const jar = new CookieJar();

    const codeRes = await fetchWxCode(account, proxyPool);
    if (!codeRes.ok) return { ok: false, error: codeRes.error };

    const agent = proxyFor(proxyPool.current, UCMP_BASE);
    const onLogin = await rawRequest({
      url: `${UCMP_BASE}/wxaccess/weixin/appOnLogin?code=${encodeURIComponent(codeRes.code)}&publicId=${encodeURIComponent(PUBLIC_ID)}`,
      headers: {
        'User-Agent': UA_MP,
        Accept: 'application/json, text/plain, */*',
        Referer: `https://servicewechat.com/${APPID}/${PAGE_VERSION}/page-frame.html`,
      },
      timeout: 30000,
      agent,
      jar,
    });
    const j = onLogin.json || {};
    const sessionId = j.sessionId || j.sessionID || (j.obj && j.obj.sessionId) || jar.get('sessionId');
    if (!sessionId) {
      return {
        ok: false,
        error: `appOnLogin 未返回 sessionId（HTTP ${onLogin.status}${onLogin.error ? ` ${onLogin.error}` : ''}）`
          + ` raw=${crop(onLogin.text, 200)}`,
      };
    }
    jar.merge({ sessionId, suuid: sessionId });

    // 换绑补全 _login_mobile_ / _login_user_id_
    const bizCode = JSON.stringify({
      path: '/up-member/newPoints', linkCode: 'SFAC20230803190840424',
      supportShare: 'YES', subCategoryCode: '1', from: 'mypoint', categoryCode: '1',
    });
    const sfnewUrl = `${UCMP_BASE}/wechat-act/weixin/activity/sfnewactivity?bizCode=${encodeURIComponent(bizCode)}`
      + `&regSource=mypoint&citycode=025&cityname=${encodeURIComponent('广州')}`
      + `&wxapp-version=V17.49&suuid=${sessionId}`;
    await rawRequest({ url: sfnewUrl, headers: { 'User-Agent': UA_H5, Accept: 'text/html,*/*' }, timeout: 30000, agent, jar, follow: 10 });
    if (!jar.get('_login_mobile_')) {
      await rawRequest({ url: `${MCS_BASE}/mcs-mimp/app/index.html`, headers: { 'User-Agent': UA_H5 }, timeout: 20000, agent, jar, follow: 5 });
    }
    if (!jar.get('_login_mobile_')) {
      return { ok: false, error: '未拿到绑定手机号（该微信号可能未注册/未绑定顺丰会员）' };
    }
    return { ok: true, jar, via: 'gateway' };
  }, 4, proxyPool);
}

/* ==================== 顺丰业务请求 ==================== */

function sfClient(task, proxyPool) {
  return async function sfPost(apiPath, body, extraHeaders) {
    const url = `${MCS_BASE}${apiPath}`;
    const headers = Object.assign({
      Host: 'mcs-mimp-web.sf-express.com',
      'User-Agent': UA_MP,
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      channel: 'xcxpart',
      platform: 'MINI_PROGRAM',
      'accept-language': 'zh-CN,zh;q=0.9',
      Referer: `https://servicewechat.com/${APPID}/${PAGE_VERSION}/page-frame.html`,
    }, signHeaders(), extraHeaders || {});

    let lastErr = '';
    for (let i = 0; i < MAX_RETRY; i++) {
      const r = await rawRequest({
        url, method: 'POST', headers, body: body || {}, timeout: TIMEOUT,
        agent: proxyFor(proxyPool.current, url), jar: task.jar,
      });
      if (r.json) return r.json;
      lastErr = r.status === 0 ? r.error : `HTTP ${r.status} ${crop(r.text, 100)}`;
      // 代理类故障换一个再试
      if (/TIMEOUT|ECONN|socket|代理|ESOCKET|EPROTO|ETIMEDOUT/i.test(lastErr) && PROXY_API_URL) {
        await proxyPool.refresh('请求失败');
      }
      if (i < MAX_RETRY - 1) await sleep(1500 * (i + 1));
    }
    VLOG(`   ${apiPath} 请求失败：${lastErr}`);
    return null;
  };
}

/* ==================== 日常积分任务 ==================== */

class DailyTask {
  constructor(task, sfPost) {
    this.task = task;
    this.sfPost = sfPost;
    this.deviceId = this.newDeviceId();
    this.stat = { done: 0, rewarded: 0, welfare: 0 };
  }

  static newDeviceId() {
    return 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => 'abcdef0123456789'[Math.floor(Math.random() * 16)]);
  }
  newDeviceId() { return DailyTask.newDeviceId(); }

  /** 小程序签到 */
  async signIn() {
    const r = await this.sfPost('/mcs-mimp/commonPost/~memberNonactivity~integralTaskSignPlusService~automaticSignFetchPackage',
      { comeFrom: 'vioin', channelFrom: 'WEIXIN' });
    if (r && r.success) {
      const o = r.obj || {};
      const pk = (o.integralTaskSignPackageVOList || [])[0];
      const day = o.countDay != null ? o.countDay : (o.countDays != null ? o.countDays : '-');
      if (o.hasFinishSign === 1) return this.task.log(`📅 小程序签到：今日已签，本周累计【${day}】天`);
      if (pk) return this.task.log(`📅 小程序签到：获得【${pk.packetName}】，本周累计【${day}】天`);
      return this.task.log(`📅 小程序签到：完成，本周累计【${day}】天`);
    }
    this.task.log(`📅 小程序签到失败：${(r && (r.errorMessage || r.msg)) || '无响应'}`);
  }

  /** 签到日历 */
  async signCalendar() {
    const r = await this.sfPost('/mcs-mimp/commonPost/~memberNonactivity~integralSignV2Service~sign', {});
    if (r && r.success) {
      const o = r.obj || {};
      const awardName = (o.award && o.award.giftBagName) || '';
      if (o.signed && awardName) return this.task.log(`📅 签到日历：连续第${o.dayCount}天，获得【${awardName}】`);
      if (o.signed) return this.task.log(`📅 签到日历：今日已签，连续第${o.dayCount}天`);
      return this.task.log('📅 签到日历：完成');
    }
    VLOG(`   签到日历失败：${(r && (r.errorMessage || r.msg)) || '无响应'}`);
  }

  /** 拉取任务列表（多 channelType 去重） */
  async taskList() {
    const url = '/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~queryPointTaskAndSignFromES';
    const seen = new Set();
    const out = [];
    for (const ct of ['1', '2', '3', '4', '01', '02', '03', '04']) {
      const r = await this.sfPost(url, { channelType: ct, deviceId: this.deviceId });
      if (!r || !r.success || !r.obj) continue;
      if ((ct === '1' || ct === '01') || !this.points) this.points = Number(r.obj.totalPoint || this.points || 0);
      const items = r.obj.taskTitleLevels || r.obj.ESobj || [];
      if (!Array.isArray(items)) continue;
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const t = Object.assign({}, raw);
        t.taskCode = this.resolveTaskCode(t);
        const key = t.taskCode || `${t.taskId || ''}|${t.title || ''}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  /** taskCode 为空时，从跳转参数里取 */
  resolveTaskCode(t) {
    const direct = String(t.taskCode || '').trim();
    if (direct) return direct;
    for (const k of ['buttonRedirect', 'taskJumpAddress', 'redirectUrl']) {
      const u = t[k];
      if (!u) continue;
      try {
        const parsed = new URL(String(u));
        const ug = parsed.searchParams.get('_ug_view_param');
        if (ug) {
          const obj = JSON.parse(decodeURIComponent(ug));
          const v = obj.taskId || obj.taskCode || obj.task_id;
          if (v) return String(v);
        }
      } catch (_) { /* 继续 */ }
      const m = String(u).match(/"taskId"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return '';
  }

  async refreshPoints() {
    const r = await this.sfPost('/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~queryPointTaskAndSignFromES',
      { channelType: '1', deviceId: this.deviceId });
    if (r && r.success && r.obj) this.points = Number(r.obj.totalPoint || this.points || 0);
  }

  finishTask(code) {
    return this.sfPost('/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask', { taskCode: code });
  }

  fetchIntegral(t) {
    return this.sfPost('/mcs-mimp/commonPost/~memberNonactivity~integralTaskStrategyService~fetchIntegral', {
      strategyId: Number(t.strategyId || 0),
      taskId: String(t.taskId || ''),
      taskCode: t.taskCode,
      deviceId: this.deviceId,
    });
  }

  /** 领任意生活特权福利 */
  async welfare() {
    const list = await this.sfPost('/mcs-mimp/commonPost/~memberGoods~mallGoodsLifeService~list',
      { memGrade: 3, categoryCode: 'SHTQ', showCode: 'SHTQWNTJ' });
    if (!list || !list.success) return false;
    const goods = [];
    for (const mod of list.obj || []) {
      for (const g of (mod.goodsList || [])) if (g.exchangeStatus === 1) goods.push(g);
    }
    if (!goods.length) return false;
    for (const g of goods) {
      const r = await this.sfPost('/mcs-mimp/commonPost/~memberGoods~pointMallService~createOrder', {
        from: 'Point_Mall', orderSource: 'POINT_MALL_EXCHANGE',
        goodsNo: g.goodsNo, quantity: 1, taskCode: this.currentTaskCode || '',
      });
      if (r && r.success) {
        const name = g.showName ? `${g.showName} - ${g.goodsName}` : g.goodsName;
        this.task.log(`🎁 生活特权：领取成功 ${name}`);
        this.stat.welfare++;
        return true;
      }
      await sleep(800);
    }
    return false;
  }

  /** 执行日常任务全流程 */
  async run() {
    this.task.log('🎯 开始执行日常积分任务');
    await this.refreshPoints();
    this.task.log(`💰 当前积分：【${this.points || 0}】`);

    await this.signIn();
    await sleep(800);
    await this.signCalendar();
    await sleep(800);

    const before = this.points || 0;
    const tasks = await this.taskList();
    if (!tasks.length) {
      this.task.log('⚠️ 任务列表为空');
      await this.refreshPoints();
      this.task.log(`💰 执行后积分：【${this.points || 0}】（${(this.points || 0) - before >= 0 ? '+' : ''}${(this.points || 0) - before}）`);
      return;
    }

    for (const t of tasks) {
      const title = String(t.title || '未知任务');
      let status = Number(t.status);
      if (status === 3) { VLOG(`   ${title} - 已完成`); continue; }
      if (DAILY_SKIP_TITLES.includes(title)) { VLOG(`   ${title} - 已跳过`); continue; }

      t.taskCode = this.resolveTaskCode(t);
      this.currentTaskCode = t.taskCode;
      if (!t.taskCode) { VLOG(`   ${title} - 无 taskCode，跳过`); continue; }

      // 生活特权任务
      if (title.includes('领任意生活特权福利')) {
        if (DRY_RUN) { this.task.log(`   [自检] ${title} 可自动完成`); continue; }
        if (await this.welfare()) {
          await sleep(1500);
          if ((await this.finishTask(t.taskCode)) && (await this.fetchIntegral(t))) { this.stat.done++; this.stat.rewarded++; }
        }
        await sleep(1200);
        continue;
      }

      // 进度未满的连签类任务跳过
      if (title.includes('连签') && String(t.process || '').includes('/')) {
        const [cur, total] = String(t.process).split('/').map(Number);
        if (cur < total) { VLOG(`   ${title} 进度 ${t.process}，暂不可领`); continue; }
      }

      if (status === 1) {
        if (DRY_RUN) { this.task.log(`   [自检] ${title} 可自动完成`); continue; }
        const done = await this.finishTask(t.taskCode);
        if (done && done.success) { this.stat.done++; status = 2; await sleep(1200); }
        else { VLOG(`   ${title} 提交失败：${(done && (done.errorMessage || done.msg)) || '无响应'}`); continue; }
      }

      if (status === 2) {
        if (DRY_RUN) continue;
        const needFirst = EXECUTE_FIRST_KEYWORDS.some((k) => title.includes(k));
        if (needFirst) {
          await this.finishTask(t.taskCode);
          await sleep(1200);
        }
        let got = await this.fetchIntegral(t);
        if (!(got && got.success)) {
          await this.finishTask(t.taskCode);
          await sleep(1200);
          got = await this.fetchIntegral(t);
        }
        if (got && got.success) { this.stat.rewarded++; VLOG(`   ${title} 奖励领取成功`); }
        await sleep(900);
      }
    }

    await this.refreshPoints();
    const after = this.points || 0;
    this.task.log(`🎯 日常任务：提交 ${this.stat.done} / 领奖 ${this.stat.rewarded} / 生活特权 ${this.stat.welfare}`);
    this.task.log(`💰 执行后积分：【${after}】（${after - before >= 0 ? '+' : ''}${after - before}）`);
  }
}

/* ==================== 会员日（26-28 号） ==================== */

async function memberDay(task, sfPost) {
  const day = new Date(Date.now() + 8 * 3600 * 1000).getUTCDate();
  if (day < 26 || day > 28) return;
  task.log('🎯 会员日活动');
  const idx = await sfPost('/mcs-mimp/commonPost/~memberNonactivity~memberDayIndexService~index', { inviteUserId: '' });
  if (!idx || !idx.success) return;
  const num = Number((idx.obj || {}).lotteryNum || 0);
  if (!num) { task.log('   会员日：无抽奖次数'); return; }
  for (let i = 0; i < num; i++) {
    const r = await sfPost('/mcs-mimp/commonPost/~memberNonactivity~memberDayLotteryService~lottery', {});
    if (r && r.success) task.log(`   会员日抽奖：${(r.obj || {}).productName || '未抽中'}`);
    await sleep(1000);
  }
}

/* ==================== 顺丰红包大派送（每日免费抽奖一次） ==================== */

async function redPacket(task, sfPost) {
  task.log('🎯 顺丰红包大派送');
  const actHeaders = { channel: RP_SECEND_CHANNEL, syscode: SYS_CODE, platform: 'MINI_PROGRAM' };

  const rule = await sfPost('/mcs-mimp/commonNoLoginPost/~actMiddlePlat~midActivity~getUserAcRuleInfo',
    { acId: RP_AC_ID, empNum: '', shareUserId: '', shareRuleCode: '', shareTaskId: '' }, actHeaders);

  let surplus = null;
  if (rule && rule.success) {
    const o = rule.obj || {};
    if (o.surplusLotteryNum != null) surplus = Number(o.surplusLotteryNum);
    task.log(`   活动：${o.acName || o.name || '顺丰红包大派送'}，剩余免费次数 ${surplus == null ? '未知' : surplus}`);
  }
  if (surplus === 0) { task.log('   今日免费抽奖次数已用完，跳过'); return; }

  const sid = task.jar.get('sessionId');
  const uid = task.jar.get('_login_user_id_');
  const phone = task.jar.get('_login_mobile_');
  const referer = 'https://mcs-mimp-web.sf-express.com/origin/g/mid-platform/main-active/nineBlockDraw'
    + '?redirectUri=/origin/g/mid-platform/main-active/activityCenterEntry'
    + `&mobile=${mask(phone)}&userId=${uid}&scene=676&memberType=0&token=${sid}`
    + `&acId=${RP_AC_ID}&from=${RP_SECEND_CHANNEL}&activityType=MID_JGGCJ&source=CX&isFinishActivity=true`;

  const r = await sfPost('/mcs-mimp/commonPost/~actMiddlePlat~midActivity~lotteryPrize', {
    acId: RP_AC_ID, ruleCode: RP_RULE_CODE, secendChannel: RP_SECEND_CHANNEL, md5Sign: RP_MD5_SIGN,
  }, Object.assign({}, actHeaders, { referer, origin: 'https://mcs-mimp-web.sf-express.com' }));

  if (r && r.success) {
    const o = r.obj || {};
    const recs = o.userWinPrizeList || o.midAcAwardRecords || [];
    if (Array.isArray(recs) && recs.length) {
      for (const rec of recs) {
        const name = rec.prizeName || rec.packetName || rec.couponName || rec.commodityName || rec.productName || '奖品';
        task.log(`   🧧 抽中：${name}`);
      }
    } else {
      task.log('   抽奖受理成功，本次未中奖');
    }
  } else {
    const msg = (r && (r.errorMsg || r.errorMessage || r.msg)) || '无响应';
    task.log(`   抽奖失败：${code_or_msg(r)} ${msg}`);
  }
}

function code_or_msg(r) {
  const c = r && (r.errorCode || r.code);
  return c == null ? '' : `[${c}]`;
}

/* ==================== 我的优惠券 ==================== */

async function coupons(task, sfPost) {
  const r = await sfPost('/mcs-mimp/coupon/available/list',
    { type: '1', pageSize: 50, pageNum: 1, couponType: '', labelCode: '0', channel: 'SFAPP' },
    {
      channel: 'HOME_COUPON', syscode: SYS_CODE, platform: 'SFAPP',
      referer: 'https://mcs-mimp-web.sf-express.com/home?redirectUri=/couponCollection&from=HOME_COUPON',
    });
  if (!r || !r.success) { VLOG(`   优惠券查询失败：${(r && (r.msg || r.message)) || '无响应'}`); return; }
  const list = Array.isArray(r.obj) ? r.obj : [];
  task.log(`🎟️ 我的优惠券：${list.length} 张`);
  for (const c of list.slice(0, 20)) {
    const amt = c.pledgeAmt != null ? `¥${c.pledgeAmt}` : '';
    task.log(`   · ${c.couponName || '未命名券'}${amt} [${c.effectTm || ''}~${c.invalidTm || ''}]`);
  }
}

/* ==================== 中秋博饼集礼盒（2026-09-11 10:00 ~ 2026-10-08 19:00） ==================== */

function autumnInWindow() {
  const now = Date.now();
  return now >= AUTUMN_START && now <= AUTUMN_END;
}

class AutumnTask {
  constructor(task, sfPost, inviterId) {
    this.task = task;
    this.sfPost = sfPost;
    this.inviterId = inviterId || '';
    this.ch = AUTUMN_CHANNELS[0];
    this.stat = { tasks: 0, bobing: 0, collect: 0, box: 0 };
  }

  use(cfg) { this.ch = cfg; }

  post(path, body, extra) {
    return this.sfPost(path, body, Object.assign({
      channel: this.ch.channel,
      platform: this.ch.platform,
    }, extra || {}));
  }

  // ---- 进入活动页（带邀请人，注册"被邀请访问"） ----
  async index() {
    const inviter = this.inviterId || AUTUMN_INVITE_USER_IDS.find((x) => x !== this.task.jar.get('_login_user_id_')) || '';
    const data = inviter ? { inviteType: 1, inviteUserId: inviter } : {};
    let r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026IndexService~index', data);
    if (!(r && r.success)) r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026IndexService~index', {});
    const o = r && r.success ? r.obj : null;
    if (o) this.task.log(`   活动：${o.acStartTime || '?'} ~ ${o.acEndTime || '?'}`);
    return o;
  }

  // ---- 每日礼包 ----
  async dailyGift() {
    const st = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026DailyService~getDailyGiftStatus',
      { cityCode: AUTUMN_CITY, channel: this.ch.channel });
    const o = st && st.success ? st.obj : null;
    if (!o) return;
    if (o.received) { VLOG('   每日礼包：今日已领'); return; }
    if (!o.canReceive) { VLOG('   每日礼包：暂不可领'); return; }
    if (DRY_RUN) { this.task.log('   每日礼包：[自检] 可领取'); return; }
    const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026DailyService~receiveDailyGift',
      { cityCode: AUTUMN_CITY, channel: this.ch.channel });
    if (r && r.success) {
      const n = ((r.obj || {}).dailyGiftProductList || []).length;
      this.task.log(`   🎁 每日礼包：领取成功 ${n} 张券`);
    } else {
      this.task.log(`   每日礼包领取失败：${(r && (r.errorMessage || r.msg)) || '无响应'}`);
    }
  }

  // ---- 任务 ----
  async doTasks() {
    const list = await this.post('/mcs-mimp/commonPost/~memberNonactivity~activityTaskService~taskList',
      { activityCode: AUTUMN_CODE, channelType: this.ch.channelType });
    if (!list || !list.success) return;
    const tasks = list.obj || [];
    const done = [];
    for (const t of tasks) {
      const name = t.taskName || '未知';
      const type = t.taskType || '';
      const code = t.taskCode || '';
      const status = t.status;
      const rest = Number(t.restFinishTime || 0);

      if (status === 3 || (status === 1 && rest <= 0)) continue;
      if (type === 'INVITEFRIENDS_PARTAKE_ACTIVITY') { VLOG(`   邀请任务 ${name}：${t.process || '-'}`); continue; }
      if (AUTUMN_SKIP_TYPES.includes(type)) { VLOG(`   ${name} 跳过（需实际操作）`); continue; }
      if (type === 'PLAY_ACTIVITY_GAME') { VLOG(`   ${name} 由博饼完成`); continue; }
      if (DRY_RUN) { this.task.log(`   [自检] ${name} 可自动完成`); continue; }

      if (type === 'INTEGRAL_EXCHANGE') {
        const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026TaskService~integralExchange',
          { exchangeNum: 1, activityCode: AUTUMN_CODE });
        if (r && r.success) { done.push(name); this.stat.tasks++; }
        continue;
      }
      if (type === 'RECEIVE_VIP_BENEFIT') {
        const r = await this.sfPost('/mcs-mimp/commonPost/~memberManage~memberEquity~commonEquityReceive', { key: 'surprise_benefit' });
        if (r && r.success) { done.push(name); this.stat.tasks++; }
        continue;
      }
      if (!code) { VLOG(`   ${name} 无 taskCode，跳过`); continue; }
      let r = await this.sfPost('/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask', { taskCode: code });
      if (!(r && r.success)) {
        await this.sfPost('/mcs-mimp/commonRoutePost/memberEs/taskRecord/checkTask', { taskCode: code });
        r = await this.sfPost('/mcs-mimp/commonRoutePost/memberEs/taskRecord/finishTask', { taskCode: code });
      }
      if (r && r.success) { done.push(name); this.stat.tasks++; } else VLOG(`   ${name} 完成失败：${(r && (r.errorMessage || r.msg)) || '无响应'}`);
      await sleep(800);
    }
    if (done.length) this.task.log(`   任务[${this.ch.name}]：完成 ${done.length} 个（${done.join('/')}）`);

    // 领任务奖励（给集礼盒次数）
    await sleep(1000);
    const rw = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026TaskService~fetchTaskReward',
      { channelType: this.ch.channelType, activityCode: AUTUMN_CODE });
    if (rw && rw.success) {
      const got = ((rw.obj || {}).receivedAccountList || []);
      if (got.length) this.task.log(`   任务奖励[${this.ch.name}]：${got.map((x) => `${x.currency}x${x.amount}`).join(', ')}`);
    }
  }

  // ---- 博饼 ----
  async bobing() {
    const sum = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026BobingService~summary', {});
    const o = sum && sum.success ? sum.obj : null;
    const rest = o ? Number(o.restCount || 0) : 0;
    if (rest <= 0) { this.task.log('   🎲 博饼：今日免费次数已用完'); return; }
    if (DRY_RUN) { this.task.log(`   🎲 博饼：[自检] 剩余 ${rest} 次`); return; }

    const ranks = [];
    for (let i = 0; i < rest; i++) {
      const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026BobingService~draw', {});
      if (!(r && r.success)) { this.task.log(`   🎲 博饼第${i + 1}次失败：${(r && (r.errorMessage || r.msg)) || '无响应'}`); break; }
      const d = r.obj || {};
      const rank = d.keju || d.subAward || AUTUMN_RANK_CN[d.level] || d.rank || '参与奖';
      ranks.push(rank);
      this.stat.bobing++;
      await sleep(900);
      if (Number(d.restCount || 0) <= 0) break;
    }
    if (ranks.length) this.task.log(`   🎲 博饼 ${ranks.length} 次：${ranks.join('，')}`);

    // 博饼后补领两个渠道的"玩博饼"任务奖励
    for (const cfg of AUTUMN_CHANNELS) {
      this.use(cfg);
      const rw = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026TaskService~fetchTaskReward',
        { channelType: cfg.channelType, activityCode: AUTUMN_CODE });
      if (rw && rw.success) {
        const got = ((rw.obj || {}).receivedAccountList || []);
        if (got.length) this.task.log(`   博饼奖励[${cfg.name}]：${got.map((x) => `${x.currency}x${x.amount}`).join(', ')}`);
      }
    }
    this.use(AUTUMN_CHANNELS[0]);
  }

  // ---- 集礼盒 ----
  async collect() {
    const st = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026CollectService~queryStatus', {});
    const o = st && st.success ? st.obj : null;
    if (!o) return;
    const balance = AutumnTask.balanceOf(o, 'COLLECT');
    if (balance <= 0) { this.task.log('   📦 集礼盒：无次数'); return; }
    if (DRY_RUN) { this.task.log(`   📦 集礼盒：[自检] 可用次数 ${balance}`); return; }

    const gained = {};
    let times = 0;
    for (let i = 0; i < 60; i++) {
      const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026CollectService~collect', {});
      if (!(r && r.success && r.obj)) break;
      times++;
      this.stat.collect++;
      for (const a of (r.obj.receivedAccountList || [])) gained[a.currency] = (gained[a.currency] || 0) + Number(a.amount || 0);
      if (AutumnTask.balanceOf(r.obj, 'COLLECT') <= 0 || r.obj.collectFinished) break;
      await sleep(800);
    }
    const gs = Object.entries(gained).map(([k, v]) => `${k}x${v}`).join('，') || '无';
    this.task.log(`   📦 集礼盒 ${times} 次：${gs}`);
  }

  static balanceOf(obj, currency) {
    for (const a of (obj.currentAccountList || [])) if (a.currency === currency) return Number(a.balance || 0);
    return 0;
  }

  // ---- 抽奖 ----
  async lottery() {
    const pool = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026LotteryService~prizePool', {});
    const o = pool && pool.success ? pool.obj : null;
    if (!o) return;
    const box = o.boxPool || {};
    const remain = Number(box.remainingDrawTimes || 0);
    if (remain > 0 && !DRY_RUN) {
      const hits = [];
      for (let i = 0; i < remain; i++) {
        const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026LotteryService~prizeDraw', { lotteryType: 'BOX' });
        if (!(r && r.success && r.obj)) break;
        const d = r.obj;
        const pd = (d.productDTOList || [])[0] || {};
        hits.push(pd.productName || pd.couponName || d.giftBagName || '奖励');
        this.stat.box++;
        await sleep(900);
      }
      if (hits.length) this.task.log(`   🏅 开礼盒抽奖 ${hits.length} 次：${hits.join('，')}`);
    } else if (remain > 0 && DRY_RUN) {
      this.task.log(`   🏅 开礼盒：[自检] 可抽 ${remain} 次`);
    }

    const wk = o.weeklyPool || {};
    if (wk.isThursday && !wk.drawn && !DRY_RUN) {
      const r = await this.post('/mcs-mimp/commonPost/~memberNonactivity~midAutumn2026LotteryService~prizeDraw', { lotteryType: 'WEEKLY' });
      if (r && r.success && r.obj) {
        const pd = (r.obj.productDTOList || [])[0] || {};
        this.task.log(`   🏅 周四抽奖：${pd.productName || pd.couponName || r.obj.giftBagName || '奖励'}`);
      } else {
        this.task.log('   🏅 周四抽奖失败');
      }
    }
  }

  // ---- 进入页面触发的查询（拿状态、不影响收益） ----
  async touch() {
    const paths = [
      '~memberNonactivity~midAutumn2026DilateService~getDilateChange',
      '~memberNonactivity~midAutumn2026DilateService~getWidgetStatus',
      '~memberNonactivity~midAutumn2026DilateService~getDilateStatus',
      '~memberNonactivity~midAutumn2026CollectService~queryExtraRewardCards',
      '~memberNonactivity~midAutumn2026TaskService~taskInviteList',
    ];
    for (const p of paths) {
      try { await this.post(`/mcs-mimp/commonPost/${p}`, {}); } catch (_) { /* 忽略 */ }
    }
  }

  async run() {
    const idx = await this.index();
    if (!idx) { this.task.log('⚠️ 中秋活动：首页获取失败，跳过'); return; }
    await this.touch();
    await this.dailyGift();

    // 双渠道任务
    for (const cfg of AUTUMN_CHANNELS) {
      this.use(cfg);
      await this.doTasks();
    }
    this.use(AUTUMN_CHANNELS[0]);

    await this.bobing();
    await this.collect();
    await this.lottery();

    this.task.log(`🎯 中秋活动汇总：任务 ${this.stat.tasks} / 博饼 ${this.stat.bobing} / 集礼盒 ${this.stat.collect} / 抽奖 ${this.stat.box}`);
  }
}

/* ==================== 单账号执行 ==================== */

async function runAccount(account, index, total, proxyPool, inviterId) {
  const prefix = `[${index + 1}/${total}]${account.remark ? `[${account.remark}]` : ''}`;
  const task = {
    jar: new CookieJar(),
    log: (m) => LOG(`${prefix} ${m}`),
  };

  LOG(`\n${prefix} 开始处理（${mask(account.openid || account.raw)}）`);
  const login = await sfLogin(account, proxyPool);
  if (!login.ok) {
    LOG(`${prefix} ❌ 登录失败：${login.error}`);
    return false;
  }
  task.jar = login.jar;
  // 记下本账号的 _login_user_id_，供下一个账号做"邀请访问"互刷
  account._uid = task.jar.get('_login_user_id_') || '';
  LOG(`${prefix} ✅ 登录成功（${login.via === 'gateway' ? '应用宝网关' : '直接 Cookie'}）➔ ${mask(task.jar.get('_login_mobile_'))}`);

  const sfPost = sfClient(task, proxyPool);

  try {
    await new DailyTask(task, sfPost).run();
  } catch (e) {
    LOG(`${prefix} ❌ 日常任务异常：${e.message}`);
  }
  try {
    await memberDay(task, sfPost);
  } catch (e) { VLOG(`   会员日异常：${e.message}`); }
  try {
    await redPacket(task, sfPost);
  } catch (e) { LOG(`${prefix} ❌ 红包大派送异常：${e.message}`); }
  try {
    await coupons(task, sfPost);
  } catch (e) { VLOG(`   优惠券异常：${e.message}`); }

  if (AUTUMN_ENABLED) {
    if (autumnInWindow()) {
      task.log('🎯 中秋博饼集礼盒活动（进行中）');
      try {
        await new AutumnTask(task, sfPost, inviterId).run();
      } catch (e) {
        LOG(`${prefix} ❌ 中秋活动异常：${e.message}`);
      }
    } else {
      const now = Date.now();
      task.log(`⏭️ 中秋活动不在时间窗内（2026-09-11 10:00 ~ 2026-10-08 19:00，${now < AUTUMN_START ? '未开始' : '已结束'}），跳过`);
    }
  }
  return true;
}

/* ==================== 账号解析 ==================== */

function loadAccounts() {
  const out = [];

  // 1) sf_openid（配合 yyb_server 网关）
  for (const raw of splitAccounts(SF_OPENID)) {
    const [id, remark] = raw.split('#');
    const openid = (id || '').trim();
    if (!openid) continue;
    out.push({ openid, remark: (remark || '').trim(), raw: openid });
  }
  if (out.length && !YYB_SERVER) {
    LOG('⚠️ 配置了 sf_openid 但缺少 yyb_server / wx_server_url，无法取 code');
  }

  // 2) sfsyUrl / sf：直接 cookie 或登录 URL（每行一个）
  if (!out.length && RAW_COOKIE_ENV) {
    for (const line of RAW_COOKIE_ENV.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const [body, remark] = line.split('#');
      out.push({ openid: '', remark: (remark || '').trim(), raw: (body || '').trim() });
    }
  }

  // 3) yyb_server 里带了 @ref（只配了网关没配 sf_openid）
  if (!out.length && YYB_SERVER.includes('@')) {
    const gw = parseGateway(YYB_SERVER);
    if (gw.ref) out.push({ openid: gw.ref, remark: '', raw: gw.ref });
  }

  return out;
}

/* ==================== 主流程 ==================== */

async function main() {
  const accounts = loadAccounts();
  if (!accounts.length) {
    LOG('未找到顺丰账号：请配置 sf_openid（推荐，配合 yyb_server）或 sfsyUrl / sf');
    $.done();
    return;
  }

  const proxyPool = new ProxyPool();
  if (STATIC_PROXY || PROXY_API_URL) {
    LOG(`🔌 代理：${STATIC_PROXY ? `静态 ${ProxyPool.display(STATIC_PROXY)}` : '提取 API'}`);
    if (!STATIC_PROXY) await proxyPool.refresh('首次');
    if (!proxyPool.current) LOG('⚠️ 暂未取到可用代理，将直连（海外服务器可能超时）');
  } else {
    LOG('🔌 代理：未配置（海外服务器访问国内接口会超时，建议配 sf_proxy 或 sf_proxy_api_url）');
  }

  if (DRY_RUN) LOG('🧪 自检模式：中秋活动只查询不消耗（签到/红包等日常动作仍会执行）');
  LOG(`🎉 顺丰速运任务启动，共 ${accounts.length} 个账号`);

  let ok = 0;
  for (let i = 0; i < accounts.length; i++) {
    // 多账号互刷邀请：用「上一个已登录账号」的 _login_user_id_ 当邀请人
    let inviterId = '';
    if (accounts.length >= 2) {
      const prev = accounts[(i + accounts.length - 1) % accounts.length];
      if (prev !== accounts[i]) inviterId = prev._uid || '';
    }
    try {
      if (await runAccount(accounts[i], i, accounts.length, proxyPool, inviterId)) ok++;
    } catch (e) {
      LOG(`[${i + 1}/${accounts.length}] ❌ 异常：${e.message}`);
    }
    if (i < accounts.length - 1) await sleep(1500);
  }

  LOG(`\n======🎉 完成 ${ok} / 共 ${accounts.length} 账号======`);
  $.done();
}

module.exports = {
  rawRequest,
  makeTunnelAgent,
  CookieJar,
  ProxyPool,
  sfLogin,
  loadAccounts,
  signHeaders,
  withRetry,
  AUTUMN_START,
  AUTUMN_END,
  autumnInWindow,
};

if (require.main === module) {
  main()
    .catch((e) => LOG(`脚本异常：${e && e.message ? e.message : e}`))
    // 显式退出：代理 Agent/长连接句柄会吊住事件循环，否则青龙里任务永远不结束
    .finally(() => setTimeout(() => process.exit(0), 300));
}
