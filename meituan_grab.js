/*
------------------------------------------
@Author: Aaa
@Date: 2026.10.21
@Description: 美团「红包天天领」整点抢券（全账号并发）
cron: 0 9 * * *
------------------------------------------
为什么单独拆一个脚本：
  整点场次的券是限量的（如周三外卖节 18 元券全国 2 万张），必须所有账号
  在同一秒并发下单才有意义。放在 meituan_code.js 里会按账号串行，实测只有
  排第一个的号能抢到，第二个号拉场次时券已经光了。

工作方式：**两个任务**，职责分开（关键：探测任务的 9 点永远不动）
  ①「美团整点抢券」cron 0 9 * * * —— `task meituan_grab.js probe`
     只用【1 个号】拉一次场次（场次是活动级的，所有号看到的一样；
     实测未登录拿不到，会 401 passport，所以必须带一个号的 token）。
     有场次 → 把【执行任务】的 cron 改到「开场前 2 分钟」；没场次 → 执行任务置休眠。
     **它自己的时间谁都不许改**：这样即使执行任务那边出任何岔子，
     第二天 9 点照样会探测，不会「断了链条」。
  ②「美团整点抢券-执行」cron 0 0 1 1 *（休眠）—— `task meituan_grab.js grab`
     被叫醒后：把全部账号拉起来 → 各自拉 grabToken → 等到开场前 LEAD_MS
     → 全账号【并发】抢（串行只有第一个号能抢到）
     → 写当日状态 → 抢完把自己置为休眠（或下一场前 2 分钟，如果还有号没抢到）。

风控注意：探测只打 1 次请求；抢券阶段每号只有「拉 token（最多几次短轮询）+ 抢 1 次」，
不做无意义的重试；白天不会常驻轮询。

环境变量：
  yyb_server            应用宝网关地址（与其它脚本共用），必需
  ql_url                青龙地址，默认 http://127.0.0.1:5700
  ql_client_id          青龙应用 client_id（要 envs/crons 权限），改 cron 必需
  ql_client_secret      青龙应用 client_secret
  mt_grab_cron_name     探测任务在青龙里的名字，默认「美团整点抢券」（脚本不改它）
  mt_grab_exec_cron_name 执行任务名，默认「美团整点抢券-执行」（脚本改它的时间）
  mt_grab_lead_ms       开场前多少毫秒开抢，默认 300
  mt_grab_exec_lead_min 执行任务提前多少分钟被叫醒，默认 2
  mt_grab_enter_sec     距开场多少秒内算「抢券模式」，默认 180（必须大于 exec_lead_min*60）
  mt_sign_url           美团签名服务，默认 http://panel:5180/api/meituan/sign
  mt_grab_state_file    当日状态文件，默认 $QL_DIR/data/mt_grab_state.json
  mt_grab_login_cache   登录态缓存，默认 $QL_DIR/data/mt_grab_login_cache.json
  mt_openid             可选，只跑指定账号（同 meituan_code.js 的写法）
  MT_DEBUG              设 1 打印原始响应
------------------------------------------
*/

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============ 常量 ============ */

const APPID = 'wxde8ac0a21135c07d';
const MT_APP_NAME = 'group';
const OPEN_BASE = 'https://open.meituan.com';
const WECHAT_LOGIN_URL = `${OPEN_BASE}/user/v1/weapplogin`;
const MEDIA_BASE = 'https://media.meituan.com';
const GRAB_INFO_PATH = '/fulishemini/couponActivity/limitTimeGrabInfo';
const GRAB_PATH = '/fulishemini/couponActivity/limitTimeGrab';
// 分销场地身份（H5 distribution-center 里 DISTRIBUTION_VENUE：identity=4、scene=13）
const IDENTITY_SCENE = { sendCouponIdentity: 4, sendCouponScene: 13 };
const MODULE_ID = 'b_waimai_jayhgcnt_mv';
const UNPL = 'v1_4AHi-LokTshbKe0CTLVFiRfpi2gcMVypu2V3bcBL-lxh8gsU0RWoDhMxZHRdAilG';

const SUBCODE_TEXT = {
  1: '抢券成功！',
  8000: '抢券失败，稍后重试',
  8001: '来晚了，券抢完了',
  8002: '抢券失败，稍后重试',
  8003: '红包互斥（去美团App-我的红包卡券看）',
  8004: '抢券失败，请刷新页面后重试',
};
const STATUS_TEXT = { 0: '进行中', 1: '未开始', 2: '已结束' };

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 '
  + 'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
  + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) '
  + 'UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364';

const REQUEST_TIMEOUT = 20000;

/* ============ 运行环境 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 青龙靠扫描 Env 构造参数里的字符串字面量取任务名，必须写字面量
      return new Env('美团整点抢券');
    } catch (_) { /* 降级到本地实现 */ }
  }
  return {
    log: (...a) => console.log(...a),
    msg: null,
    done: () => {},
    getdata: () => '',
    setdata: () => {},
  };
})();

function env(...names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
}

const GATEWAY = (() => {
  const raw = env('yyb_server', 'wx_server_url');
  const at = raw.lastIndexOf('@');
  let base = at > 0 ? raw.slice(0, at) : raw;
  base = base.replace(/\/+$/, '');
  if (base && !/:\/\//.test(base)) base = 'http://' + base;
  return base;
})();

const QL_URL = (env('ql_url') || 'http://127.0.0.1:5700').replace(/\/+$/, '');
const QL_CLIENT_ID = env('ql_client_id');
const QL_CLIENT_SECRET = env('ql_client_secret');

/*
 * 两个任务，职责分开（关键：探测任务的 9 点永远不动，改时间只改执行任务）
 *   ① 「美团整点抢券」      cron 0 9 * * *      跑 `task meituan_grab.js probe`
 *      —— 只探测场次，有场次就把【执行任务】的时间改到开场前 2 分钟。
 *         它自己的时间谁都不许改，这样即便执行任务那边出任何岔子，
 *         第二天 9 点照样会探测，不会「断了链条」。
 *   ② 「美团整点抢券-执行」 cron 0 0 1 1 *（休眠）  跑 `task meituan_grab.js grab`
 *      —— 被叫醒后抢券，抢完把自己改回休眠（或下一场前 2 分钟）。
 */
const CRON_NAME = env('mt_grab_cron_name') || '美团整点抢券';
const EXEC_CRON_NAME = env('mt_grab_exec_cron_name') || '美团整点抢券-执行';
const IDLE_CRON = '0 0 1 1 *';
const MODE = (process.argv[2] || '').toLowerCase();   // probe | grab

// 探测任务在青龙里固定 0 9 * * *，脚本永远不改它（断了链条第二天就不跑了）
const LEAD_MS = Math.max(0, Number(env('mt_grab_lead_ms') || 300));
// 执行任务提前多少分钟被叫醒（默认 2 分钟：留出登录/预热时间，别卡在最后 60 秒）
const EXEC_LEAD_MIN = Math.max(0, Number(env('mt_grab_exec_lead_min') || 2));
// 距开场多少秒内算「抢券模式」；必须大于 EXEC_LEAD_MIN*60，否则提前醒来会被当成探测而不抢
const ENTER_SEC = Math.max(10, Number(env('mt_grab_enter_sec') || 180));
const SIGN_URL = (env('mt_sign_url', 'MT_SIGN_URL')
  || (process.env.QL_DIR ? 'http://panel:5180/api/meituan/sign' : '')).replace(/\/+$/, '');
const DEBUG = process.env.MT_DEBUG === '1';
const MT_OPENIDS = env('mt_openid').split(/[&,，\s]+/).map((s) => s.trim()).filter(Boolean);
// 账号的 scripts 标记：默认和 meituan_code.js 共用 'mt'，面板勾一次两个脚本都认
const SCRIPT_KEY = (env('yyb_script_key') || 'mt').toLowerCase();
const TAG_FILTER = (env('yyb_tag_filter') || '1').toLowerCase() !== '0';

const DATA_DIR = process.env.QL_DIR ? path.join(process.env.QL_DIR, 'data') : path.join(__dirname, 'data');
const STATE_FILE = env('mt_grab_state_file') || path.join(DATA_DIR, 'mt_grab_state.json');
const LOGIN_CACHE_FILE = env('mt_grab_login_cache') || path.join(DATA_DIR, 'mt_grab_login_cache.json');
const MAIN_LOGIN_CACHE = path.join(DATA_DIR, 'mt_login_cache.json');

if (!GATEWAY) {
  $.log('❌ [配置] 缺少 yyb_server（应用宝网关地址），脚本未执行');
  $.done();
  process.exit(1);
}

/* ============ 工具 ============ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowText = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const mask = (s, h = 6, t = 6) => {
  s = String(s || '');
  return s.length <= h + t ? s : `${s.slice(0, h)}****${s.slice(-t)}`;
};
const jsonPreview = (o, n = 300) => {
  try { return JSON.stringify(o).slice(0, n); } catch (_) { return String(o).slice(0, n); }
};
const tokenKey = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

/* ============ HTTP ============ */

function request(method, url, opts = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad url', text: '' }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    const headers = Object.assign({}, opts.headers || {});
    const hasCT = () => Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    let payload = null;
    if (opts.json != null) {
      payload = Buffer.from(JSON.stringify(opts.json), 'utf8');
      if (!hasCT()) headers['Content-Type'] = 'application/json';
    } else if (opts.form != null) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), 'utf8');
      if (!hasCT()) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (opts.body != null) {
      payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
      if (!hasCT()) headers['Content-Type'] = 'application/json';
    }
    if (payload) headers['Content-Length'] = payload.length;

    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: opts.timeout || REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON（比如 403 的 HTML） */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, text: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT', text: '' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* ============ 美团签名（panel 的 cliguard） ============ */

async function resolveSignature(method, rawUrl, bodyBuf) {
  if (!SIGN_URL) return { url: rawUrl, headers: {} };
  const bodyHash = bodyBuf
    ? crypto.createHash('md5').update(bodyBuf.slice(0, 16200)).digest('hex') : '';
  const data = JSON.stringify({ method, url: rawUrl, bodyHash });
  const r = await request('POST', SIGN_URL, {
    body: Buffer.from(data, 'utf8'),
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  if (r.json && r.json.ok && r.json.data && r.json.data.url) {
    return { url: r.json.data.url, headers: r.json.data.headers || {} };
  }
  $.log(`⚠️ [签名] 签名服务不可用（${SIGN_URL}）：${r.error || jsonPreview(r.json || r.text, 120)}`);
  return { url: rawUrl, headers: {} };
}

/* ============ 网关：账号 / 取 code / 换 token ============ */

const gwHeaders = () => ({ 'User-Agent': USER_AGENT, Accept: '*/*' });

/** scripts 标记：空=允许；含本 key=允许；否则跳过（yyb_tag_filter=0 可关掉过滤） */
function tagAllows(acc) {
  if (!TAG_FILTER) return true;
  const tags = String((acc && acc.scripts) || '')
    .split(/[,，;；\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!tags.length) return true;
  return tags.includes(SCRIPT_KEY);
}

async function fetchGatewayAccounts() {
  const r = await request('GET', `${GATEWAY}/accounts`, { headers: gwHeaders(), timeout: 20000 });
  if (!r.json || r.json.code !== 0) {
    throw new Error(`网关返回异常：${r.error || jsonPreview(r.json || r.text, 200)}`);
  }
  return (Array.isArray(r.json.data) ? r.json.data : []).filter((a) => a && typeof a === 'object');
}

async function refreshGatewayAccount(ref) {
  try {
    const r = await request('POST', `${GATEWAY}/accounts/refresh`, {
      json: { ref }, headers: gwHeaders(), timeout: 120000,
    });
    $.log(`♻️ [授权] 已请求网关续期 ${mask(ref)}（HTTP ${r.status}）`);
  } catch (e) {
    $.log(`⚠️ [授权] 请求网关续期失败：${e.message}`);
  }
}

/** 网关取微信 code（409 = 登录态失效，续期后重试） */
async function fetchCode(ref) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = await request('POST', `${GATEWAY}/wxapp/getCode`, {
      json: { app_id: APPID, ref }, headers: gwHeaders(), timeout: 40000,
    });
    if (r.status === 409) {
      $.log('⚠️ [授权] 网关返回 409（登录态失效），续期后重试');
      await refreshGatewayAccount(ref);
      if (attempt < 3) await sleep(3000);
      continue;
    }
    if (r.json && r.json.code === 0) {
      const inner = r.json.data || {};
      const code = ((inner.result || {}).code) || inner.code;
      if (code && code !== 'null') return String(code);
    }
    if (attempt < 3) await sleep(2000);
  }
  return '';
}

function pickToken(data) {
  if (!data || typeof data !== 'object') return '';
  const inner = (data.data && typeof data.data === 'object') ? data.data : {};
  const user = (inner.user && typeof inner.user === 'object') ? inner.user : {};
  const cands = [
    data.token, data.wm_logintoken, data.accessToken, data.access_token, data.jwt,
    inner.token, inner.wm_logintoken, inner.accessToken, inner.access_token, inner.jwt,
    user.token, user.wm_logintoken, user.accessToken, user.access_token, user.jwt,
  ];
  for (const c of cands) if (c && c !== 'null') return String(c);
  return '';
}

/** 用微信 code 换美团登录态（注意是 form 表单，不是 JSON） */
async function loginByCode(code) {
  const r = await request('POST', WECHAT_LOGIN_URL, {
    form: { code, appName: MT_APP_NAME },
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      xweb_xhr: '1',
      Referer: `https://servicewechat.com/${APPID}/270/page-frame.html`,
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeout: 30000,
  });
  const data = r.json;
  if (!data) return { ok: false, error: `登录响应非 JSON（HTTP ${r.status}）` };
  const token = pickToken(data);
  if (!token) return { ok: false, error: `未识别到 token：${jsonPreview(data, 200)}` };
  const inner = (data.data && typeof data.data === 'object') ? data.data : {};
  return {
    ok: true,
    token,
    openId: data.openId || inner.openId || inner.open_id || '',
    openIdCipher: data.openIdCipher || inner.openIdCipher || '',
    userId: inner.userId || inner.userid || '',
  };
}

/* ============ 登录态缓存 ============ */

function readLoginCache() {
  try {
    const mine = JSON.parse(fs.readFileSync(LOGIN_CACHE_FILE, 'utf8')).accounts || {};
    if (Object.keys(mine).length) return mine;
  } catch (_) { /* 自己还没写过 */ }
  // 首次运行：继承主脚本的登录态。否则要现场给每个号取 code（一个号就好几秒，
  // 开场前 1 分钟根本来不及），而且网关经常先回 409 再续期，更慢。
  try {
    const main = JSON.parse(fs.readFileSync(MAIN_LOGIN_CACHE, 'utf8')).accounts || {};
    if (Object.keys(main).length) {
      $.log(`🔐 [登录] 继承 meituan_code.js 的 ${Object.keys(main).length} 个登录态`);
      return Object.assign({}, main);
    }
  } catch (_) { /* 主脚本缓存也没有 */ }
  return {};
}
function writeLoginCache(accounts) {
  try {
    fs.mkdirSync(path.dirname(LOGIN_CACHE_FILE), { recursive: true });
    fs.writeFileSync(LOGIN_CACHE_FILE,
      JSON.stringify({ note: '美团整点抢券登录态缓存（含 token，别外传）', accounts }, null, 1), 'utf8');
  } catch (_) { /* 写不了不影响主流程 */ }
}

/* ============ 当日状态（抢到过就不再抢） ============ */

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.date === today()) return s;
  } catch (_) { /* 不存在或跨天 */ }
  return { date: today(), accounts: {} };
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), 'utf8');
  } catch (_) { /* 忽略 */ }
}

/* ============ 青龙 API（改自己的定时任务时间） ============ */

let qlToken = '';

async function qlAuth() {
  if (qlToken) return true;
  if (!QL_CLIENT_ID || !QL_CLIENT_SECRET) return false;
  const url = `${QL_URL}/open/auth/token?client_id=${encodeURIComponent(QL_CLIENT_ID)}`
    + `&client_secret=${encodeURIComponent(QL_CLIENT_SECRET)}`;
  const r = await request('GET', url, { timeout: 15000 });
  if (r.json && r.json.code === 200 && r.json.data && r.json.data.token) {
    qlToken = r.json.data.token;
    return true;
  }
  $.log(`⚠️ [调度] 青龙鉴权失败：${jsonPreview(r.json || r.text, 150)}`);
  return false;
}

async function qlApi(method, apiPath, body) {
  if (!(await qlAuth())) return null;
  const data = body ? JSON.stringify(body) : '';
  const r = await request(method, QL_URL + apiPath, {
    body: data ? Buffer.from(data, 'utf8') : null,
    headers: Object.assign({ 'Content-Type': 'application/json' },
      { Authorization: `Bearer ${qlToken}` }),
    timeout: 20000,
  });
  return r.json || null;
}

/** 把指定任务的 cron 改成 schedule；成功返回 true */
async function setCronSchedule(name, schedule) {
  if (!QL_CLIENT_ID || !QL_CLIENT_SECRET) {
    $.log('⚠️ [调度] 未配置 ql_client_id / ql_client_secret，无法自动改任务时间');
    return false;
  }
  const list = await qlApi('GET', `/open/crons?searchValue=${encodeURIComponent(name)}`);
  // 青龙 /open/crons 返回的是分页对象 {data:[...], total:n}，不是裸数组
  const arr = Array.isArray(list && list.data) ? list.data
    : ((list && list.data && Array.isArray(list.data.data)) ? list.data.data : []);
  const task = arr.find((t) => t && t.name === name);
  if (!task) {
    $.log(`⚠️ [调度] 青龙里没找到名为「${name}」的任务`);
    return false;
  }
  if (task.schedule === schedule) {
    $.log(`  ℹ️ [调度] 「${name}」的时间已经是 ${schedule}，不用改`);
    return true;
  }
  const detail = await qlApi('GET', `/open/crons/${task.id}`);
  const d = (detail && detail.data) || task;
  const body = {
    id: d.id,
    name: d.name,
    command: d.command,
    schedule,
    task_before: d.task_before || '',
    task_after: d.task_after || '',
    labels: Array.isArray(d.labels) ? d.labels : [],
    log_name: d.log_name || '',
    work_dir: d.work_dir || '',
    allow_multiple_instances: d.allow_multiple_instances || 0,
  };
  const r = await qlApi('PUT', '/open/crons', body);
  if (r && r.code === 200) {
    $.log(`  ✅ [调度] 「${name}」时间已改为 ${schedule}`);
    return true;
  }
  $.log(`  ✖ [调度] 改任务时间失败：${jsonPreview(r, 200)}`);
  return false;
}

/** 场次时间 → cron 表达式（开场前 EXEC_LEAD_MIN 分钟） */
function cronForSession(startMs) {
  let at = startMs - EXEC_LEAD_MIN * 60 * 1000;
  // 提前量已经过去（例如上一场刚跑完就排下一场），就卡在开场那一分钟，别排到过去的时间
  if (at <= Date.now() + 20000) at = startMs;
  const d = new Date(at);
  const mm = d.getMinutes();
  const hh = d.getHours();
  return `${mm} ${hh} * * *`;
}

/* ============ 抢券接口 ============ */

function baseBody(ctx) {
  return {
    wm_did: '', wm_mac: '', waimai_sign: '/', wm_ctype: 'fulishe_wxapp', wm_dtype: 'microsoft',
    wm_dversion: '4.1.12.55', wm_dplatform: 'windows', wm_uuid: '1457266102798364772',
    wm_visitid: '90357da0-9471-4a38-af91-bb7338fb81b7', wm_appversion: '1.47.0',
    wm_logintoken: ctx.token, req_time: Date.now(),
    userid: ctx.userId, user_id: ctx.userId, lch: 1260,
    wm_uuid_source: 'server', hostAppVersion: '',
    open_id: ctx.openId, unionid: 'oNQu9t2M2aGnZbGGda83ER7Oxweo',
    finger_applets: '', fp_platform: 13, appId: APPID, expoId: ctx.openIdCipher,
    cPosition: 1005, pBizLine: 9000, distributorChannel: 0,
    wm_latitude: 23083309, wm_longitude: 113317200,
    wm_actual_latitude: 23083309, wm_actual_longitude: 113317200,
    actual_city_id_level2: '440100', actual_city_id_level3: '440105',
    city_id_level2: '440100', city_id_level3: '440105',
  };
}

function headersFor(ctx, bodyLen) {
  return {
    geographyInfo: '%7B%7D',
    openIdCipher: ctx.openIdCipher,
    xweb_xhr: '1',
    csecuuid: '1457266102798364772',
    swimlane: '',
    'x-env': 'online',
    csecuserid: String(ctx.userId || ''),
    openId: ctx.openId,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    token: ctx.token,
    Accept: '*/*',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: `https://servicewechat.com/${APPID}/270/page-frame.html`,
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Length': bodyLen,
  };
}

/**
 * 调 fulishemini 接口。
 * ⚠️ 关键坑：limitTimeGrabInfo / limitTimeGrab 这两个接口【不能带】那串通用 query
 * （yodaReady=wx&csecappid=...），带了会被 media.meituan.com 的 openresty 直接 403。
 * 且该 path 的 WAF 是概率性放行（同请求有时 200 有时 403），所以必须退避重试。
 */
async function grabPost(ctx, apiPath, bodyObj, tag) {
  const rawBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const url = `${MEDIA_BASE}${apiPath}`;
  const headers = headersFor(ctx, rawBody.length);
  const sig = await resolveSignature('POST', url, rawBody);
  Object.assign(headers, sig.headers || {});

  const r = await request('POST', sig.url || url, { body: rawBody, headers, timeout: REQUEST_TIMEOUT });
  if (DEBUG) {
    $.log(`  [debug] ${tag}: ${r.json ? jsonPreview(r.json, 400) : (r.text || r.error || '-').slice(0, 200)}`);
  }
  if (!r.json) {
    const text = String(r.text || '') + String(r.error || '');
    const blocked = /403 Forbidden|openresty/i.test(text);
    return {
      ok: false, blocked,
      error: blocked ? `${tag} 被 openresty 拦截（403 WAF）` : (r.error || (r.text || '').slice(0, 150)),
    };
  }
  if (![0, 200, '0', '200'].includes(r.json.code)) {
    return { ok: false, error: `${tag} code=${r.json.code} ${r.json.message || r.json.msg || ''}` };
  }
  return { ok: true, data: r.json.data || {}, raw: r.json };
}

/** 拉场次（不传 target 拿全部；传 activityId+sessionCode 切到指定场次） */
async function grabInfoOnce(ctx, target) {
  const body = Object.assign(baseBody(ctx), { identityScene: IDENTITY_SCENE, osType: 'Windows' });
  if (target && target.activityId && target.sessionCode) {
    body.activityId = target.activityId;
    body.sessionCode = target.sessionCode;
  }
  return grabPost(ctx, GRAB_INFO_PATH, body, 'limitTimeGrabInfo');
}

async function grabInfo(ctx, target, tries = 4) {
  let last = { ok: false, error: '未执行' };
  for (let i = 0; i < tries; i += 1) {
    if (i) await sleep(800 * i);
    const r = await grabInfoOnce(ctx, target);
    if (r.ok) return r;
    last = r;
    if (!r.blocked) break;   // 不是 WAF 拦截就没必要重试
  }
  return last;
}

async function grabCoupon(ctx, p) {
  const body = Object.assign(baseBody(ctx), {
    identityScene: IDENTITY_SCENE,
    activityId: p.activityId,
    sessionCode: p.sessionCode,
    grabToken: p.grabToken,
    rightCode: p.rightCode,
    pageId: '',
    moduleId: MODULE_ID,
    sessionId: p.sessionId || '',
    unpl: UNPL,
    osType: 'Windows',
  });
  const r = await grabPost(ctx, GRAB_PATH, body, 'limitTimeGrab');
  if (!r.ok) return r;
  const d = r.data;
  return {
    ok: true,
    subCode: d.subCode,
    couponInfo: d.couponInfo || null,
    text: SUBCODE_TEXT[d.subCode] || `未知结果 subCode=${d.subCode}`,
  };
}

/* ============ 场次解析 ============ */

/** 兼容 毫秒/秒 时间戳 与 "10:00:00" 这种当天时刻 */
function toMs(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n;
  if (Number.isFinite(n) && n > 1e9) return n * 1000;
  const m = typeof v === 'string' ? v.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/) : null;
  if (m) {
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }
  return 0;
}

const startMsOf = (s) => toMs(s.startTimestamp) || toMs(s.startTime)
  || toMs(s.beginTimestamp) || toMs(s.beginTime);
const endMsOf = (s) => toMs(s.endTimestamp) || toMs(s.endTime) || toMs(s.finishTimestamp);

function statusOf(s, nowMs) {
  const raw = s.status != null ? s.status : s.sessionStatus;
  if (raw != null && Number.isFinite(Number(raw))) return Number(raw);
  const st = startMsOf(s);
  const et = endMsOf(s);
  if (!st && !et) return 2;
  if (st && nowMs < st) return 1;
  if (et && nowMs > et) return 2;
  return 0;
}

/**
 * 摊平场次。真实结构（2026-10-14 抓包）：
 *   sessionList[] : { sessionCode, startTime:"10:00:00", endTime:"10:59:59" }（没有 status）
 *   currentSession: { sessionCode, startTimestamp, endTimestamp, grabToken, rightList[] }
 * 注意 grabToken 挂在【场次】上，不是每张券上。
 */
function flatten(activityList, nowMs) {
  const out = [];
  for (const act of activityList) {
    if (!act) continue;
    const byCode = new Map();
    for (const s of (Array.isArray(act.sessionList) ? act.sessionList : [])) {
      if (s && s.sessionCode != null) byCode.set(s.sessionCode, Object.assign({}, s));
    }
    const cur = act.currentSession;
    if (cur && cur.sessionCode != null) {
      byCode.set(cur.sessionCode, Object.assign({}, byCode.get(cur.sessionCode) || {}, cur));
    }
    for (const s of byCode.values()) {
      out.push({
        activityId: act.activityId,
        sessionCode: s.sessionCode,
        status: statusOf(s, nowMs),
        startMs: startMsOf(s),
        endMs: endMsOf(s),
        grabToken: s.grabToken || '',
        rights: Array.isArray(s.rightList) ? s.rightList : [],
      });
    }
  }
  return out;
}

/** 券列表：带 rightCode 的都能抢，按面额从大到小
 *  注意 status 语义没公开，实测「可抢」是 1（不是 2）；早期只认 2 导致永远报「本场次没有可抢的券」。
 *  所以这里不按 status 过滤，交给服务端裁决（抢完会回 8001）。
 */
const grabbable = (rights) => (rights || [])
  .filter((r) => r && r.rightCode)
  .sort((a, b) => Number(b.couponValue || 0) - Number(a.couponValue || 0));

/* ============ 账号准备 ============ */

async function resolveAccounts(loginCache) {
  if (MT_OPENIDS.length) return MT_OPENIDS.map((ref) => ({ ref, label: mask(ref, 4, 4) }));

  const accounts = await fetchGatewayAccounts();
  const alive = accounts.filter((a) => String(a.status || '').toLowerCase() === 'alive');
  // 非 alive 但本地有登录态缓存的也试一把：token 还有效就照样能抢
  const aliveRefs = new Set(alive.map((a) => String(a.openid || a.id || '')));
  const revived = accounts.filter((a) => {
    const ref = String(a.openid || a.id || '');
    return ref && !aliveRefs.has(ref) && !!loginCache[tokenKey(ref)];
  });
  if (revived.length) {
    $.log(`🔐 [账号] ${revived.length} 个非 alive 但本地有登录态，一并尝试`);
  }

  const out = [];
  let skipped = 0;
  for (const a of alive.concat(revived)) {
    const ref = String(a.openid || a.id || '');
    if (!ref) continue;
    const nickname = String(a.nickname || a.alias || '').trim();
    const label = nickname && nickname !== '-' ? nickname : ref;
    if (!tagAllows(a)) {
      skipped += 1;
      $.log(`⏭️ [账号] 跳过「${label}」：标记 [${String(a.scripts || '').trim()}] 不含 [${SCRIPT_KEY}]`);
      continue;
    }
    out.push({ ref, label });
  }
  if (skipped) $.log(`ℹ️ [账号] 按标记过滤掉 ${skipped} 个（yyb_tag_filter=0 可关闭）`);
  return out;
}

/** 拿 ctx：优先登录态缓存；缓存被拒再去网关取 code */
async function prepareAccount(acc, loginCache) {
  const key = tokenKey(acc.ref);
  const cached = loginCache[key];
  if (cached && cached.token) {
    return { ok: true, ctx: cached, fromCache: true };
  }
  const code = await fetchCode(acc.ref);
  if (!code) return { ok: false, error: '网关取 code 失败' };
  const login = await loginByCode(code);
  if (!login.ok) return { ok: false, error: login.error };
  const ctx = {
    token: login.token, openId: login.openId,
    openIdCipher: login.openIdCipher, userId: login.userId,
  };
  loginCache[key] = ctx;
  return { ok: true, ctx, fromCache: false };
}

/* ============ 主流程 ============ */

async function main() {
  const t0 = Date.now();
  $.log('');
  $.log('════════ 美团整点抢券（全账号并发） ════════');
  $.log(`🕒 ${nowText()}`);

  // 1) 账号候选
  const loginCache = readLoginCache();
  const accounts = await resolveAccounts(loginCache).catch((e) => {
    $.log(`❌ [账号] 获取失败：${e.message}`);
    return [];
  });
  if (!accounts.length) {
    $.log('❌ [账号] 没有可用账号');
    return;
  }
  $.log(`👥 候选账号：${accounts.length}`);

  // 2) 探测：只用一个号拉场次
  //    风控考虑：场次是【活动级】的，所有号看到的完全一样，没必要每个号都去打一次。
  //    实测未登录拿不到（media 直接 401 passport），所以必须带【一个】号的 token。
  const probe = accounts[0];
  $.log(`🔍 探测：只用 1 个号（${probe.label}）`);
  const probeLogin = await prepareAccount(probe, loginCache)
    .catch((e) => ({ ok: false, error: e.message }));
  if (!probeLogin.ok) {
    $.log(`❌ [探测] ${probe.label} 登录失败：${probeLogin.error}`);
    return;
  }
  writeLoginCache(loginCache);

  const probeInfo = await grabInfo(probeLogin.ctx);
  if (!probeInfo.ok) {
    $.log(`❌ [探测] 拉场次失败：${probeInfo.error}`);
    return;
  }

  const nowMs = Date.now();

  // debug 模式：原样打印场次与券列表（含 status），用来判断「没有可抢的券」到底是真没券还是状态判断错
  if (MODE === 'debug') {
    const act = Array.isArray(probeInfo.data.activityList) ? probeInfo.data.activityList : [];
    for (const a of act) {
      $.log(`📋 活动 ${a.activityId || ''} 场次数 ${(a.sessionList || []).length}`);
      for (const s of a.sessionList || []) {
        const st = statusOf(s, nowMs);
        $.log(`  ・场次 ${s.sessionCode} status=${s.status} 推导=${STATUS_TEXT[st] || st}`
          + ` start=${s.startTime || ''} ${s.startTimestamp || ''} 券数=${(s.rightList || []).length}`
          + ` grabToken=${s.grabToken ? '有' : '无'}`);
        for (const r of s.rightList || []) {
          $.log(`      - rightCode=${r.rightCode} status=${r.status} 面额=${r.amount || r.discount || ''}`
            + ` 描述=${(r.rightName || r.name || r.title || '').slice(0, 20)} 剩余=${r.stock != null ? r.stock : '?'}`);
        }
      }
    }
    if (probeInfo.data && probeInfo.data.currentSession) {
      const cs = probeInfo.data.currentSession;
      $.log(`⭐ 顶层 currentSession ${cs.sessionCode} grabToken=${cs.grabToken ? '有' : '无'}`);
    }
    for (const a of act) {
      const cs = a.currentSession;
      if (!cs) { $.log('   （该活动无 currentSession）'); continue; }
      $.log(`⭐ ${a.activityId} currentSession=${cs.sessionCode}`
        + ` start=${cs.startTimestamp || ''} end=${cs.endTimestamp || ''}`
        + ` grabToken=${cs.grabToken ? cs.grabToken.slice(0, 12) + '…' : '无'}`
        + ` 券数=${(cs.rightList || []).length}`);
      for (const r of cs.rightList || []) {
        $.log(`      - ${JSON.stringify(r)}`);
      }
      $.log(`      ▶ 经 grabbable 过滤后可抢 ${grabbable(cs.rightList).length} 张`);
    }
    $.log('（debug 模式，不抢）');
    return;
  }

  // trygrab 模式：对「当前进行中」的场次真打一枪（1 个号），用来看服务端真实返回码
  if (MODE === 'trygrab') {
    const list = flatten(Array.isArray(probeInfo.data.activityList) ? probeInfo.data.activityList : [], nowMs);
    const sess = list.find((s) => s.grabToken && grabbable(s.rights).length);
    if (!sess) { $.log('❌ 当前没有带 grabToken 的可抢场次'); return; }
    const right = grabbable(sess.rights)[0];
    $.log(`🎯 trygrab：场次 ${sess.sessionCode} 券 ${right.rightCode}`
      + `（${(Number(right.couponValue || 0) / 100).toFixed(0)}元/满${(Number(right.priceLimit || 0) / 100).toFixed(0)}）`);
    const r = await grabCoupon(probeLogin.ctx, {
      activityId: sess.activityId,
      sessionCode: sess.sessionCode,
      grabToken: sess.grabToken,
      rightCode: right.rightCode,
    });
    $.log(`📨 返回：${JSON.stringify(r).slice(0, 400)}`);
    return;
  }
  const sessions = flatten(Array.isArray(probeInfo.data.activityList) ? probeInfo.data.activityList : [], nowMs);
  if (!sessions.length) {
    $.log('ℹ️ 今天没有整点场次，把执行任务置为休眠');
    await setCronSchedule(EXEC_CRON_NAME, IDLE_CRON);
    return;
  }
  $.log('🕐 场次：' + sessions.map((s) =>
    `${s.sessionCode}[${STATUS_TEXT[s.status] || s.status}`
    + `${s.startMs ? ' ' + new Date(s.startMs).toTimeString().slice(0, 5) : ''}]`).join('、'));

  // 4) 选目标：优先「马上要开场」的场次
  //    （上一场还在进行中时，它的券早就光了；选它会导致抢不到、还把下次时间排错）
  const alive = sessions.filter((s) => s.status !== 2 && s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (!alive.length) {
    $.log('ℹ️ 今天的场次都结束了，把执行任务置为休眠');
    await setCronSchedule(EXEC_CRON_NAME, IDLE_CRON);
    return;
  }
  // 只把「刚开场 60 秒内」的场次算作可抢；再早就已经光了，选它只会白跑并排错下次时间
  const RECENT_MS = 60 * 1000;
  const target = alive.find((s) => s.startMs >= nowMs - RECENT_MS) || alive[alive.length - 1];
  const untilStart = target.startMs - nowMs;

  // 5) 探测任务（probe）永远不抢，只负责调执行任务的时间；
  //    grab 模式如果发现离得还远（误触发），也按探测处理
  if (MODE !== 'grab' || untilStart > ENTER_SEC * 1000) {
    const cron = cronForSession(target.startMs);
    const mins = Math.round(untilStart / 60000);
    $.log(`🧭 只探测（mode=${MODE || '未指定'}）：最近场次 `
      + `${new Date(target.startMs).toTimeString().slice(0, 5)}（约 ${mins} 分钟后）`
      + `，把执行任务「${EXEC_CRON_NAME}」改到 ${cron}`);
    await setCronSchedule(EXEC_CRON_NAME, cron);
    return;
  }

  // 6) 抢券模式：这时候才把所有账号拉起来（探测阶段只用了 1 个号）
  $.log(`🚀 抢券模式：准备全部账号（目标场次 ${target.sessionCode}）`);
  const prepared = await Promise.all(accounts.map(async (acc) => {
    const r = await prepareAccount(acc, loginCache).catch((e) => ({ ok: false, error: e.message }));
    return Object.assign({ acc }, r);
  }));
  writeLoginCache(loginCache);
  const ready = prepared.filter((p) => p.ok);
  for (const p of prepared) if (!p.ok) $.log(`  ✖ ${p.acc.label} 登录失败：${p.error}`);
  if (!ready.length) {
    $.log('❌ [登录] 没有账号登录成功');
    return;
  }
  $.log(`🔐 登录就绪 ${ready.length}/${accounts.length}`
    + `（缓存命中 ${ready.filter((p) => p.fromCache).length}）`);

  // 当天抢到过的不再抢
  const state = readState();
  const pending = ready.filter((p) => !state.accounts[tokenKey(p.acc.ref)]);
  $.log(`🎯 待抢 ${pending.length} 个号（今日已抢到跳过 ${ready.length - pending.length} 个）`);
  if (!pending.length) {
    $.log('ℹ️ 今天所有账号都已抢到过，不再抢');
    await planNext(state, sessions, Date.now(), ready.length);
    return;
  }

  // 7) 等到开场前 LEAD_MS
  const wait = target.startMs - LEAD_MS - Date.now();
  if (wait > 0) {
    $.log(`⏳ 等待开场 ${new Date(target.startMs).toTimeString().slice(0, 8)}`
      + `（${(wait / 1000).toFixed(2)}s 后开抢）`);
    await sleep(wait);
  }

  // 8) 开场瞬间拉 grabToken（开场后才下发）；没拿到就短轮询，总共最多 1.2 秒
  const tokenDeadline = Date.now() + 1200;
  const tokens = await Promise.all(pending.map(async (p) => {
    let lastErr = '未拿到 grabToken';
    while (Date.now() < tokenDeadline) {
      const r = await grabInfoOnce(p.ctx, target);
      if (!r.ok) {
        lastErr = r.error;
        if (!r.blocked) break;          // 非 WAF 错误（如 token 失效）就别重试了
      } else {
        const list = flatten(Array.isArray(r.data.activityList) ? r.data.activityList : [], Date.now());
        const sess = list.find((s) => s.sessionCode === target.sessionCode);
        if (sess && sess.grabToken) return { p, sess };
        lastErr = sess ? '该场次还没下发 grabToken' : '找不到该场次';
      }
      await sleep(250);
    }
    return { p, error: lastErr };
  }));

  const shooters = tokens.filter((t) => t.sess && t.sess.grabToken);
  if (!shooters.length) {
    $.log('❌ [抢券] 没有任何账号拿到 grabToken');
    for (const t of tokens) $.log(`   ✖ ${t.p.acc.label}：${t.error}`);
    await planNext(state, sessions, Date.now(), ready.length);
    return;
  }

  // 9) 全账号【并发】抢（这是拆脚本的核心：串行会只有第一个号能抢到）
  $.log(`🎯 ${nowText()} 并发开抢（${shooters.length} 个号同时发）`);
  const results = await Promise.all(shooters.map(async (t) => {
    const { p, sess } = t;
    const rights0 = grabbable(sess.rights);
    if (!rights0.length) return { p, ok: false, text: '本场次没有可抢的券' };
    // 8004 = 抢券失败请刷新页面重试（grabToken 过期/已消费），所以失败要刷新 token 再打
    let sessNow = sess;
    let last = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rights = grabbable(sessNow.rights);
      if (!rights.length) break;
      let done = false;
      for (const right of rights.slice(0, 3)) {
        const r = await grabCoupon(p.ctx, {
          activityId: target.activityId,
          sessionCode: sessNow.sessionCode,
          grabToken: sessNow.grabToken,
          rightCode: right.rightCode,
        });
        if (r.ok && r.subCode === 1) {
          const ci = r.couponInfo || {};
          const name = ci.couponName || ci.name || right.rightCode;
          const val = ci.couponValue != null ? `（${(Number(ci.couponValue) / 100).toFixed(0)}元）` : '';
          return { p, ok: true, text: `${name}${val} 抢到了（第 ${attempt + 1} 轮）` };
        }
        last = r;
        // 8001=已抢完，换下一张券；其它错误直接进刷新重试
        if (!(r.ok && r.subCode === 8001)) { done = true; break; }
      }
      if (!done) break;                                  // 所有券都 8001，没得试了
      if (last && last.ok && ![8000, 8002, 8004].includes(last.subCode)) break;  // 不可重试的错误
      await sleep(450);
      const info = await grabInfoOnce(p.ctx, target);
      if (!info.ok) break;
      const s2 = flatten(Array.isArray(info.data.activityList) ? info.data.activityList : [], Date.now())
        .find((s) => s.sessionCode === target.sessionCode && s.grabToken);
      if (!s2) break;
      sessNow = s2;
    }
    return { p, ok: false, text: last && last.ok ? `${last.text}（已重试）` : (last ? last.error : '未知') };
  }));

  let got = 0;
  for (const r of results) {
    if (r.ok) {
      got += 1;
      state.accounts[tokenKey(r.p.acc.ref)] = {
        rightCode: 'ok', sessionCode: target.sessionCode, at: Date.now(),
      };
      $.log(`  ✅ ${r.p.acc.label}：${r.text}`);
    } else {
      $.log(`  ✖ ${r.p.acc.label}：${r.text}`);
    }
  }
  writeState(state);
  $.log(`🏁 本轮：${got}/${results.length} 个号抢到`
    + `（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // 10) 收尾：还有没抢到的 + 后面还有场次 → 定到下一场；否则回 9:00
  await planNext(state, sessions, Date.now(), ready.length);
}

/** 决定执行任务下一次什么时候被唤醒 */
async function planNext(state, sessions, nowMs, totalAccounts) {
  const doneCount = Object.keys(state.accounts).length;
  if (doneCount >= totalAccounts) {
    $.log(`🔁 今天 ${doneCount} 个号都已抢到，执行任务置为休眠（探测任务照常 9 点跑）`);
    await setCronSchedule(EXEC_CRON_NAME, IDLE_CRON);
    return;
  }
  const next = sessions.filter((s) => s.status !== 2 && s.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (next) {
    const cron = cronForSession(next.startMs);
    $.log(`🔁 还有 ${totalAccounts - doneCount} 个号没抢到，下一场 `
      + `${new Date(next.startMs).toTimeString().slice(0, 5)}，执行任务改到 ${cron}`);
    await setCronSchedule(EXEC_CRON_NAME, cron);
    return;
  }
  $.log('🔁 今天没有后续场次了，执行任务置为休眠');
  await setCronSchedule(EXEC_CRON_NAME, IDLE_CRON);
}

// 兜底：整体 10 分钟还没跑完就收尾，别把青龙任务挂住
const watchdog = setTimeout(() => {
  $.log('⛔ 看门狗：运行超过 10 分钟，强制退出');
  try { $.done(); } catch (_) {}
  process.exit(0);
}, 10 * 60 * 1000);

(async () => {
  try {
    await main();
  } catch (e) {
    $.log(`❌ [主流程] 异常：${e && e.message ? e.message : e}`);
    $.log(e && e.stack ? e.stack : '');
  } finally {
    clearTimeout(watchdog);
    try { $.done(); } catch (_) {}
  }
})();
