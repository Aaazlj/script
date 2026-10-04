/*
------------------------------------------
@Author: Aaa
@Date: 2026.10.03
@Description: 美团优惠券自动领取（合并版 · 只走应用宝网关登录）
cron: 0 10 * * *
------------------------------------------
本脚本合并了原来的两个脚本：
  · mt_code.py            —— 福利社动态 code 版（listActivityCoupon / grantActivityCoupon）
  · meituan_coupon.js     —— 一键领券版（sendCouponWork）
合并后：
  · 账号与 token **只走应用宝网关**（微信 code → open.meituan.com/weapplogin），
    不再需要美团 App 扫码、不再需要 MT_TOKEN / pt-passport 那一套；
  · 一个账号会把**两条链路**都跑一遍，能领的券一起领；
  · 零外部依赖，只用 Node 内置模块（http/https/net/tls/crypto/fs/path）。

为什么可以合并（实测依据）：
  网关换出来的 token 与扫码换出来的 token 格式不同（152 vs 174 字符），但都打同一个
  域名族 media.meituan.com/fulishemini。拿网关联路的 token 打 sendCouponWork：
  垃圾 token 得到 401「请重新登录」，而它得到 1014「发券失败」—— 档位不同，
  说明它通过了鉴权。所以一条登录路可以同时喂两条领券链路。

两条链路各自领不同的券包（互不替代）：
  A. sendCouponWork                    —— WorkBuddy 渠道券（数量多，几十张）
  B. listActivityCoupon + grantActivityCoupon —— 福利社红包墙券（外卖专享神券等）

环境变量：
1. 应用宝网关（必需，与朴朴/顺丰/撸批脚本共用同一个变量）：
   yyb_server                                      网关地址，如 http://yyb-go:8000
     - 支持 @ref 写法：http://yyb-go:8000@1         （@ 后面是账号 ref，可省掉 mt_openid）
   wx_server_url                                   兼容变量（yyb_server 为空时生效）
   mt_openid                                       可选。指定网关 ref；
                                                   多个用 &、英文/中文逗号、空格或换行分隔
     - 不配置时自动从网关拉全部 alive 账号（面板里新扫码的账号下次运行自动生效）
     - 优先级：mt_openid > yyb_server 里的 @ref > 网关自动发现
   yyb_script_key                                  本脚本在网关账号上的标记 key，默认 mt。
                                                   账号的 scripts 标记里没有它就不跑这个账号
                                                   （标记为空 = 不限制，所有脚本都跑）。
                                                   在扫码面板「应用宝账号」页勾选即可，不用手填。
   yyb_tag_filter                                  默认 1（按标记过滤）。设 0 则忽略标记跑全部账号
     - 只影响「网关自动发现」这条路径；显式写了 mt_openid / @ref 时以你写的为准

2. 签名服务（用默认值即可，无需配置）：
   mt_sign_url                                     默认 http://panel:5180/api/meituan/sign
   media.meituan.com 从 2026-09 起强制校验 mtgsig 签名，缺了直接 403。
   签名算法在美团混淆 JS（cliguard）里，本脚本借用 panel 暴露的签名接口加签；
   面板容器里挂着美团专家包，只借它的 cliguard.js 生成签名（面板本身不做美团扫码登录）。
   与网关一样只在容器网络内可达、始终直连。

3. 代理（可选，一般不需要）：
   mt_proxy / MT_PROXY / script_proxy / SCRIPT_PROXY
                                                   静态代理，形如 http://user:pass@host:port
     - 只作用于访问美团的请求；网关与签名服务始终直连
     - 只支持 http / https 代理（Node 内置模块做 CONNECT 隧道）
     - 树脂（resin）就是这种写法：http://:管理token@主机:2260（用户名注意留空！）
   mt_proxy_type                                   默认 http。⚠️ socks5 / socks5h 不支持
                                                   （Node 内置模块没有 SOCKS 实现），
                                                   配了会明确告警并回退直连
   mt_proxy_validate                               默认 1，启动时先验证代理连通性；
                                                   置 0 可跳过验证（直接用）
   - 美团域名（media.meituan.com / open.meituan.com）走腾讯国际节点，
     海外机器直连可用，一般不需要配代理

4. 领取开关（可选，默认两条都开）：
   mt_claim_work                                   设 0 则不跑链路 A（sendCouponWork）
   mt_claim_fulishe                                设 0 则不跑链路 B（福利社红包墙）

5. 其它（可选）：
   MT_AI_SCENE                                     接口 aiScene 渠道标识，默认官方渠道值
                                                   a0d4da77f918ab204d86c911fcdd0ce1
                                                   ⚠️ 不要留空！留空会被服务端判为
                                                   「发券失败」(1014)，看着像"今天已领过"
   MT_PUSH_URL                                     自定义推送地址（POST {title, content}）
   MT_MAX_COUPONS                                  通知里最多展示几张券，默认 8
   MT_CACHE_FILE                                   当日券缓存路径
                                                   默认：$QL_DIR/data/mt_coupons_cache.json
                                                   （容器重建不丢），其它环境 ./data/...
   MT_LOGIN_CACHE_FILE                             登录态（token）缓存路径
                                                   默认：$QL_DIR/data/mt_login_cache.json
                                                   ⚠️ 文件内含 token，写入权限 0600，别外传/别提交
   mt_login_cache                                  默认 1。设 0 关闭「登录态复用」，退回每次都去网关取 code
   mt_account_timeout                              单账号上限（秒），最小 30，默认 240。
                                                   某个账号卡死时到点跳过它、继续下一个
   MT_DEBUG                                        设 1 打印服务端原始响应，排查用

6. 青龙任务建议：
   名称：美团优惠券
   命令：task Aaazlj_script_master/meituan_code.js
         （前缀是订阅目录名，用 `ql repo` 拉的库就是这个形状；按你的实际目录调整）
   定时：0 10 * * *（每天 10:00；每天只能领一次，多跑几次只会回放当日缓存）

重要：
  · 每天限领一次。当天已领过时接口只返回 1014 且 couponList 为空，不带任何券数据。
    所以脚本在【真正领到券】的那次把明细写入本地缓存，之后再跑（当天）直接命中缓存回放，
    不再重复打领券接口，跨天自动失效。
  · 缓存按【网关账号 ref】索引。因为登录态本身也是按 ref 缓存的（见下），
    用 token 当 key 会导致缓存天天失效。

  · 登录态（token）会被缓存到 MT_LOGIN_CACHE_FILE，**下次运行先用上次的 token**，
    只有当服务端明确拒绝（401/403）时才回头去网关取 code 重新登录。
    好处有两个：
      ① 省掉每轮「取 code + 换 token」的往返（网关 mmtls 取 code 通常几秒）；
      ② **关键**：网关里账号授权掉了（status=expired）、取不到 code 时，
         只要本地缓存的 token 还有效，脚本照样能领券 —— 不会再因为
         「一个 alive 账号都没有」而整体不跑。
    因此账号发现阶段除了 alive 账号，还会把「非 alive 但本地有登录态缓存」的账号一并尝试。

返回码含义（都是 HTTP 200，看 body 里的 code）：
  200   发券成功
  1014  服务端「发券失败」——⚠️ 它【不等于】"今天已领过"，至少三种含义：
          ①该账号今天确实已经领过；②请求被拒（aiScene 为空/不对，或签名不被认可）；
          ③该渠道当前对这个账号没有可发的券。
        区分办法：看当天第一次运行。当天第一次就是 1014，基本是 ②。
  401   token 已失效（重新跑一次即可，本脚本每轮都会重新登录）
  403   token 为空
  509 / 50200  请求过于频繁，稍后重试
  9999  服务端异常
------------------------------------------
*/

const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============ 常量 ============ */

const APPID = 'wxde8ac0a21135c07d';        // 美团小程序 appid（网关取 code 用）
const MT_APP_NAME = 'group';               // weapplogin 的 appName
const OPEN_BASE = 'https://open.meituan.com';
const WECHAT_LOGIN_URL = `${OPEN_BASE}/user/v1/weapplogin`;
const USER_INFO_URL = `${OPEN_BASE}/user/v1/info`;

const MEDIA_BASE = 'https://media.meituan.com';
const WORK_PATH = '/fulishemini/couponActivity/sendCouponWork';
const LIST_PATH = '/fulishemini/couponActivity/listActivityCoupon';
const GRANT_PATH = '/fulishemini/couponActivity/grantActivityCoupon';
const WEB_QUERY = 'yodaReady=wx&csecappid=wx0b42a347aafbe0d0&csecplatform=3'
  + '&csecversionname=1.47.0&csecversion=1.3.0';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 '
  + 'MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
  + 'MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) '
  + 'UnifiedPCWindowsWechat(0xf2541c37) XWEB/25364';

const DEFAULT_AI_SCENE = 'a0d4da77f918ab204d86c911fcdd0ce1';
const REQUEST_TIMEOUT = 30000;
const PROXY_RETRY_TIMES = 3;
const PROXY_VALIDATE_URL = 'https://www.baidu.com';

// 单账号上限 / 保活 / 看门狗 —— 注意：这些定时器一律**不能 unref**，
// unref 之后它不撑事件循环，真卡死时 Node 会直接 beforeExit 静默退出，兜底等于没有。
const ACCOUNT_TIMEOUT = Math.max(30, Number(process.env.mt_account_timeout || 240)) * 1000;
const KEEPALIVE_MS = 30000;

/* ============ 运行环境：青龙 Env + 本地兜底 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 注意：青龙靠扫描 Env 构造参数里的【字符串字面量】取任务名，
      // 这里必须写字面量，不能传变量（否则任务名会变成变量名）
      return new Env('美团优惠券');
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
  let base = at > 0 ? raw.slice(0, at).replace(/\/+$/, '') : raw.replace(/\/+$/, '');
  const ref = at > 0 ? raw.slice(at + 1).trim() : '';
  if (base && !/:\/\//.test(base)) base = 'http://' + base;
  return { base, ref };
})();

const MT_OPENIDS = env('mt_openid').split(/[&,，\s]+/).map((s) => s.trim()).filter(Boolean);

// 「这个账号要不要跑本脚本」由网关账号上的标记决定（面板「应用宝账号」页勾选）。
// 标记为空 = 不限制；显式写了 mt_openid / @ref 时不做过滤（你写谁就跑谁）。
const SCRIPT_KEY = (env('yyb_script_key') || 'mt').toLowerCase();
const TAG_FILTER = (env('yyb_tag_filter') || '1').toLowerCase() !== '0';

const MT_PROXY = env('mt_proxy', 'MT_PROXY', 'script_proxy', 'SCRIPT_PROXY');
const PROXY_TYPE = (env('mt_proxy_type') || 'http').toLowerCase();
const PROXY_VALIDATE = (env('mt_proxy_validate') || '1').toLowerCase() !== '0';

const SIGN_URL = (env('mt_sign_url', 'MT_SIGN_URL')
  || (process.env.QL_DIR ? 'http://panel:5180/api/meituan/sign' : '')).replace(/\/+$/, '');

const AI_SCENE = env('MT_AI_SCENE') || DEFAULT_AI_SCENE;
const MAX_COUPONS = Number(env('MT_MAX_COUPONS') || 8) || 8;
const CLAIM_WORK = (env('mt_claim_work') || '1') !== '0';
const CLAIM_FULISHE = (env('mt_claim_fulishe') || '1') !== '0';
const DEBUG = process.env.MT_DEBUG === '1';

const CACHE_FILE = process.env.MT_CACHE_FILE
  || (process.env.QL_DIR
    ? path.join(process.env.QL_DIR, 'data', 'mt_coupons_cache.json')
    : path.join(__dirname, 'data', 'mt_coupons_cache.json'));

const LOGIN_CACHE_FILE = process.env.MT_LOGIN_CACHE_FILE
  || (process.env.QL_DIR
    ? path.join(process.env.QL_DIR, 'data', 'mt_login_cache.json')
    : path.join(__dirname, 'data', 'mt_login_cache.json'));
const LOGIN_CACHE_ON = (env('mt_login_cache') || '1').toLowerCase() !== '0';

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
  const host = rest.slice(at + 1);
  const user = cred.includes(':') ? cred.split(':')[0] : '';
  return `${scheme}${user ? user + ':***' : '***'}@${host}`;
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
  $.log('║' + padR('🚀 美团优惠券（应用宝网关登录）', 50) + '║');
  $.log('║' + padR(`🕒 启动时间: ${nowText()}`, 50) + '║');
  $.log('║' + padR(`🔢 账号数量: ${count}`, 50) + '║');
  $.log('╚' + '═'.repeat(50) + '╝');
}

function logAccountHeader(index, total, label, ref) {
  $.log('');
  $.log('┌' + '─'.repeat(50) + '┐');
  $.log('│' + padR(`🧩 账号 ${index} / ${total}`, 50) + '│');
  $.log('│' + padR(`🌍 网关 ${mask(GATEWAY.base)}`, 50) + '│');
  $.log('│' + padR(`🧾 身份 ${label}`, 50) + '│');
  if (ref && ref !== label) $.log('│' + padR(`🆔 ref ${mask(ref)}`, 50) + '│');
  $.log('└' + '─'.repeat(50) + '┘');
}

/* ============ 代理：只支持 http / https（自建 CONNECT 隧道） ============ */
/* 与 sfsy_code.js 同款实现：一个 TunnelAgent（覆写 Agent.createConnection），
   http 目标直接把隧道 socket 交给 http.Agent 用；https 目标在隧道上再 tls.connect 一层。
   Node 内置模块没有 SOCKS 实现，所以 socks 代理一律回退直连。 */

// 代理是否实际生效。配了 socks、或连通性验证没过，都会把这里置 false → 回退直连。
let proxyEnabled = false;

const PROXY_URL = (() => {
  if (!MT_PROXY) return '';
  let raw = MT_PROXY;
  if (!raw.includes('://')) {
    const scheme = PROXY_TYPE.startsWith('socks') ? PROXY_TYPE : 'http';
    raw = `${scheme}://${raw}`;
  }
  let u;
  try { u = new URL(raw); } catch (_) { return ''; }
  if (u.protocol === 'socks5:' || u.protocol === 'socks5h:') {
    $.log('⚠️ [代理] Node 内置模块没有 SOCKS 实现，mt_proxy 配了 socks 代理 —— 本次回退直连');
    $.log('          （要么改用 http 代理，要么把 mt_proxy 去掉）');
    return '';
  }
  return raw;
})();

const PROXY_LABEL = PROXY_URL ? maskProxy(PROXY_URL) : '';

/**
 * 把 http 代理 URL 变成一个可复用的 Agent（自建 CONNECT 隧道）。
 * secure=true（https 目标）时，隧道建好后在裸 socket 上再 tls.connect，
 * 交给 https.Agent 当作「已完成握手的连接」直接使用。
 */
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
        // 隧道已建立，撤掉握手期的 15s 超时，改由上层 request 统一控制
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
/** 取（或惰性创建）隧道 Agent。proxyUrl 非法 / 未配置则返回 undefined → 直连 */
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
  // 验证本身就得走代理，所以先把开关打开；验证不过再关回去（回退直连）
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
 * 统一的 HTTP 请求。
 * opts: { json | form | body, headers, timeout, proxy, method }
 * 返回值：{ status, headers, text, json, error }
 *
 * 硬超时是普通 setTimeout（刻意不 unref）：不依赖 socket，
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
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
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
    // 走代理：换成自建 CONNECT 隧道的 Agent；直连则留 undefined（用默认 Agent）
    if (useProxy) {
      const agent = agentFor(isHttps);
      if (agent) baseOpts.agent = agent;
    }

    const attach = (r2) => {
      req = r2;
      req.on('error', (e) => done({ status: 0, error: e.message, text: '' }));
      // socket 级超时（连上之后迟迟没有数据）
      req.setTimeout(timeout, () => {
        try { req.destroy(); } catch (_) {}
        done({ status: 0, error: 'TIMEOUT', text: '' });
      });
      if (payload) req.write(payload);
      req.end();
    };

    hard = setTimeout(() => {
      try { if (req) req.destroy(); } catch (_) {}
      done({ status: 0, error: 'TIMEOUT', text: '' });
    }, timeout + 5000);

    try {
      attach((isHttps ? https : http).request(baseOpts, finish));
    } catch (e) {
      done({ status: 0, error: e.message, text: '' });
    }
  });
}

/* ============ 签名：panel /api/meituan/sign > 裸请求 ============ */

/**
 * 调面板签名接口拿 mtgsig 头与补好公共参数的 URL。
 * bodyHash 取【签名前原始 body】前 16200 字节的 md5（与官方专家包口径一致）。
 * 返回 { url, headers, mode }；签名服务不可用时原样返回（美团会 403，靠日志提示）。
 */
async function resolveSignature(method, rawUrl, bodyBuf) {
  if (!SIGN_URL) return { url: rawUrl, headers: {}, mode: '无(未配置签名服务)' };
  const bodyHash = bodyBuf
    ? crypto.createHash('md5').update(bodyBuf.slice(0, 16200)).digest('hex')
    : '';
  const r = await request('POST', SIGN_URL, { json: { method, url: rawUrl, bodyHash }, timeout: 10000 });
  if (r.json && r.json.ok && r.json.data && r.json.data.url) {
    return { url: r.json.data.url, headers: r.json.data.headers || {}, mode: 'panel' };
  }
  const why = r.error || (r.json && (r.json.error || r.json.message)) || `HTTP ${r.status}`;
  $.log(`⚠️ [签名] 签名服务不可用（${SIGN_URL}）：${why}`);
  $.log('   未加签的 media 请求会被美团 403，请确认扫码面板（panel）容器在运行');
  return { url: rawUrl, headers: {}, mode: `无(${why})` };
}

/* ============ 网关：账号发现 / 取 code / 换 token / 昵称 ============ */

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
 *
 * 语义（三只脚本一致）：
 *   · 没标记          → 允许（默认行为：所有脚本都跑它）
 *   · 标记里有本 key  → 允许
 *   · 标记里没有本 key → 跳过
 * 关掉过滤：环境变量 yyb_tag_filter=0。
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
 * 优先级：mt_openid > yyb_server 里的 @ref > 自动拉网关全部 alive 账号。
 * 自动发现一个 alive 都没有时，先给所有账号续期再重拉一次。
 */
async function resolveAccounts() {
  if (MT_OPENIDS.length) return MT_OPENIDS.map((ref) => ({ ref, label: ref }));
  if (GATEWAY.ref) return [{ ref: GATEWAY.ref, label: GATEWAY.ref }];

  let accounts = await fetchGatewayAccounts();
  let alive = accounts.filter((a) => String(a.status || '').toLowerCase() === 'alive');
  if (!alive.length && accounts.length) {
    $.log('⚠️ [账号] 网关里没有 alive 的账号，尝试全部续期后重拉');
    for (const a of accounts) await refreshGatewayAccount(String(a.openid || a.id || ''));
    accounts = await fetchGatewayAccounts();
    alive = accounts.filter((a) => String(a.status || '').toLowerCase() === 'alive');
  }

  // 除了 alive 账号，还把「网关里不是 alive、但本地有登录态缓存」的账号一并纳入。
  // 这类账号虽然取不到新 code，但只要旧 token 还有效就照样能领券
  // （这正是「授权掉了但当天还能抢救」的场景）。
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
    $.log(`ℹ️ [账号] 按脚本标记过滤掉 ${filtered} 个账号（本脚本 key=${SCRIPT_KEY}，候选 ${alive.length + revived.length} 个）`);
    $.log('   想让它跑：面板「应用宝账号」页把美团勾上；或临时设 yyb_tag_filter=0 忽略标记');
  }
  return out;
}

/** 网关取微信 code（409 = 登录态失效，续期后重试） */
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

/** 用微信 code 换美团登录态，返回 {token, openId, openIdCipher, userId, raw} */
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
    timeout: REQUEST_TIMEOUT,
  });
  const data = r.json;
  if (!data) return { ok: false, error: `登录响应非 JSON（HTTP ${r.status}）：${(r.text || r.error || '').slice(0, 200)}` };

  const token = pickToken(data);
  if (!token) return { ok: false, error: `未识别到 token：${jsonPreview(data)}` };

  const inner = (data.data && typeof data.data === 'object') ? data.data : {};
  const openId = data.openId || inner.openId || inner.open_id || '';
  const openIdCipher = data.openIdCipher || inner.openIdCipher || '';
  const userId = inner.userId || inner.userid || '';
  return { ok: true, token, openId, openIdCipher, userId, raw: data };
}

async function queryNickname(ctx) {
  try {
    const q = new URLSearchParams({
      token: ctx.token,
      fields: 'id,nickname',
      sdkType: 'wxmp',
      appName: MT_APP_NAME,
      yodaReady: 'wx',
      csecappid: APPID,
      csecplatform: '3',
      csecversionname: '1.47.0',
      csecversion: '1.3.0',
    }).toString();
    const r = await request('GET', `${USER_INFO_URL}?${q}`, {
      headers: {
        'User-Agent': USER_AGENT,
        token: ctx.token,
        openId: ctx.openId,
        openIdCipher: ctx.openIdCipher,
        csecuserid: String(ctx.userId || ''),
        csecuuid: '1457266102798364772',
        Referer: `https://servicewechat.com/${APPID}/270/page-frame.html`,
        Accept: '*/*',
      },
      timeout: 15000,
    });
    const user = (r.json && r.json.user) || {};
    return user.nickname || '';
  } catch (_) {
    return '';
  }
}

/* ============ 链路 A：sendCouponWork（WorkBuddy 渠道券） ============ */

async function claimWorkCoupons(token) {
  const rawBody = Buffer.from(JSON.stringify({ token, aiScene: AI_SCENE, version: 2 }), 'utf8');
  const sig = await resolveSignature('POST', `${MEDIA_BASE}${WORK_PATH}`, rawBody);
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'Content-Length': rawBody.length,
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': USER_AGENT,
  }, sig.headers || {});

  const r = await request('POST', sig.url, {
    body: rawBody, headers, timeout: REQUEST_TIMEOUT, proxy: true,
  });
  if (DEBUG) {
    $.log(`  [debug] A/签名=${sig.mode} URL: ${sig.url}`);
    $.log(`  [debug] A/原始响应: ${r.json ? jsonPreview(r.json, 500) : (r.text || r.error || '-').slice(0, 500)}`);
  }
  if (!r.json) {
    return { ok: false, kind: 'net', error: r.error || (r.text || '').slice(0, 200) || '未知网络错误', signMode: sig.mode };
  }
  return Object.assign({ ok: true, code: r.json.code, msg: r.json.msg || '', data: r.json.data || {}, signMode: sig.mode });
}

/* ============ 链路 B：福利社红包墙（list + grant） ============ */

function wallHeaders(ctx) {
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
  };
}

// 两个接口共用的基础字段（与 mt_code.py 里的口径逐字保持一致）
function fulisheBase(ctx) {
  return {
    wm_did: '',
    wm_mac: '',
    waimai_sign: '/',
    wm_ctype: 'fulishe_wxapp',
    wm_dtype: 'microsoft',
    wm_dversion: '4.1.12.55',
    wm_dplatform: 'windows',
    wm_uuid: '1457266102798364772',
    wm_visitid: '90357da0-9471-4a38-af91-bb7338fb81b7',
    wm_appversion: '1.47.0',
    wm_logintoken: ctx.token,
    req_time: Date.now(),
    userid: ctx.userId,
    user_id: ctx.userId,
    lch: 1260,
    wm_uuid_source: 'server',
    hostAppVersion: '',
    open_id: ctx.openId,
    unionid: 'oNQu9t2M2aGnZbGGda83ER7Oxweo',
    finger_applets: '',
    fp_platform: 13,
    appId: APPID,
    expoId: ctx.openIdCipher,
    cPosition: 1005,
    pBizLine: 9000,
    distributorChannel: 0,
    wm_latitude: 23083309,
    wm_longitude: 113317200,
    wm_actual_latitude: 23083309,
    wm_actual_longitude: 113317200,
    actual_city_id_level2: '440100',
    actual_city_id_level3: '440105',
    city_id_level2: '440100',
    city_id_level3: '440105',
  };
}

async function fulishePost(ctx, apiPath, bodyObj) {
  const rawBody = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const url = `${MEDIA_BASE}${apiPath}?${WEB_QUERY}`;
  const headers = wallHeaders(ctx);
  headers['Content-Length'] = rawBody.length;
  const sig = await resolveSignature('POST', url, rawBody);
  if (sig.headers) Object.assign(headers, sig.headers);

  const r = await request('POST', sig.url || url, {
    body: rawBody, headers, timeout: REQUEST_TIMEOUT, proxy: true,
  });
  if (DEBUG) {
    $.log(`  [debug] B${apiPath.split('/').pop()}/原始响应: `
      + `${r.json ? jsonPreview(r.json, 500) : (r.text || r.error || '-').slice(0, 500)}`);
  }
  if (!r.json) return { ok: false, error: r.error || (r.text || '').slice(0, 200) || '响应非 JSON' };
  return { ok: true, json: r.json, signMode: sig.mode };
}

/** 拉取券包配置，返回 { ok, tabs, activityName, activityCode, sessionId, recallToken } */
async function fulisheList(ctx) {
  const body = Object.assign(fulisheBase(ctx), {
    pSubCode: 30300,
    requestType: 0,
    requestSource: 1,
    couponActivityScene: 1,
    osType: 'Windows',
  });
  const r = await fulishePost(ctx, LIST_PATH, body);
  if (!r.ok) return { ok: false, error: r.error };

  const code = r.json.code;
  if (![0, 200, '0', '200'].includes(code)) {
    return {
      ok: false,
      error: `美团优惠券配置获取失败 code=${code} ${r.json.message || r.json.msg || jsonPreview(r.json)}`,
    };
  }

  const data = r.json.data || {};
  const config = data.config || {};
  const planMap = {};
  for (const pg of (data.preGrantList || [])) {
    if (!pg || typeof pg !== 'object') continue;
    const pd = pg.data || {};
    const plan = pd.planCode;
    const right = pd.rightCode;
    if (!plan || !right) continue;
    planMap[plan] = planMap[plan] || [];
    if (!planMap[plan].includes(right)) planMap[plan].push(right);
  }
  let tabs = Object.keys(planMap).map((plan) => ({ planCode: plan, rightCodes: planMap[plan] }));
  if (!tabs.length) {
    for (const t of (config.tabList || [])) {
      if (t && t.planCode) tabs.push({ planCode: t.planCode, rightCodes: t.rightCodes || [] });
    }
  }

  return {
    ok: true,
    tabs,
    activityName: config.activityName || data.activityName || '美团优惠券活动配置',
    activityCode: config.activityCode || data.activityCode,
    sessionId: data.sessionId || '1a01aa999d0-8f3b-8811-6d',
    recallToken: data.recallToken || '',
    signMode: r.signMode,
  };
}

/** 一键领取福利社券包 */
async function fulisheGrant(ctx, cfg) {
  const body = Object.assign(fulisheBase(ctx), {
    activityName: cfg.activityName,
    activityCode: cfg.activityCode,
    sessionId: cfg.sessionId,
    unpl: 'v1_4AHi-LokTshbKe0CTLVFiRfpi2gcMVypu2V3bcBL-lxh8gsU0RWoDhMxZHRdAilG',
    tabs: cfg.tabs,
    pSubCode: 30301,
    recallToken: cfg.recallToken,
    preGrantSource: 2,
    activityScene: 1,
    osType: 'Windows',
    pageId: 'c_waimai_7hs96y41',
    moduleId: 'b_waimai_gci8oda9_mc',
  });
  const r = await fulishePost(ctx, GRANT_PATH, body);
  if (!r.ok) return { ok: false, error: r.error };

  const code = r.json.code;
  if (![0, 200, '0', '200'].includes(code)) {
    return {
      ok: false,
      error: `领取失败 code=${code} ${r.json.message || r.json.msg || jsonPreview(r.json)}`,
    };
  }
  const data = r.json.data || {};
  const coupons = [];
  for (const tab of (data.tabs || [])) {
    for (const c of (tab.couponList || [])) coupons.push(c);
  }
  return {
    ok: true,
    coupons,
    activityName: cfg.activityName,
    totalValue: data.totalCouponValue,
    signMode: r.signMode,
  };
}

/* ============ 券展示 ============ */

const TAB_ORDER = ['外卖', '美食团购', '美团闪购', '休闲娱乐', '生活服务', '丽人医疗', '更多福利'];
const TAB_DISPLAY = { '更多福利': '其他' };
const SLOT_PLAN_BASE = [['外卖', 2], ['美食团购', 1], ['美团闪购', 1],
                        ['休闲娱乐', 1], ['生活服务', 1], ['丽人医疗', 1]];

const fenToYuan = (fen) => {
  const yuan = Number(fen || 0) / 100;
  return yuan === Math.floor(yuan) ? String(Math.floor(yuan)) : yuan.toFixed(1);
};

const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function formatCoupon(c) {
  const limit = Number(c.priceLimit || 0);
  const value = Number(c.couponValue || 0);
  const discount = limit > 0 ? `满${fenToYuan(limit)}元减${fenToYuan(value)}元` : '无门槛';
  const period = c.couponStartTime && c.couponEndTime
    ? `${fmtDate(c.couponStartTime)} 至 ${fmtDate(c.couponEndTime)}`
    : '';
  return {
    name: c.couponName || '',
    discount,
    period,
    tab: c.tabName || '',
    value,
    limit,
  };
}

function buildCountStr(list) {
  const counter = {};
  list.forEach((c) => { const t = c.tab || '其他'; counter[t] = (counter[t] || 0) + 1; });
  const unknown = Object.keys(counter).filter((t) => !TAB_ORDER.includes(t));
  const order = TAB_ORDER.slice(0, 6).concat(unknown, TAB_ORDER.slice(6));
  return order
    .filter((t) => counter[t])
    .map((t) => `${TAB_DISPLAY[t] || t}优惠券${counter[t]}张`)
    .join('、');
}

/** 分类配额挑选，保证每个品类都有代表，避免全被外卖券占满 */
function pickDisplay(list) {
  const ratio = (c) => (c.limit > 0 ? [1, -(c.value / c.limit)] : [0, 0]);
  const cmp = (a, b) => {
    const ka = ratio(a); const kb = ratio(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  };

  const groups = {};
  list.forEach((c) => { const t = c.tab || '其他'; (groups[t] = groups[t] || []).push(c); });
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
    lines.push(`  ${i + 1}. ${c.tab ? `[${c.tab}] ` : ''}${c.name} | ${c.discount}`
      + (c.period ? ` | ${c.period}` : ''));
  });
  return lines.join('\n');
}

/* ============ 当日券缓存（跨天自动失效，按账号 ref 索引） ============ */

function localDateStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readCacheAll() {
  try {
    const all = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (all && all.date === localDateStr() && all.accounts && typeof all.accounts === 'object') {
      return all.accounts;
    }
  } catch (_) { /* 缓存损坏/跨天 → 当没有 */ }
  return {};
}

function writeCacheAll(accounts) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      date: localDateStr(),
      note: '美团优惠券当日领取明细缓存（按网关账号 ref 索引，跨天自动失效）',
      accounts,
    }, null, 2), 'utf8');
  } catch (e) {
    $.log(`[提示] 券缓存写入失败（不影响领券）：${e.message}`);
  }
}

/* ============ 登录态缓存（跨天复用；被服务端拒绝时自动回退网关取 code） ============
 * 形状：{ accounts: { <sha256(ref)[0:12]>: {ref,token,openId,openIdCipher,userId,nickname,obtained_at} } }
 * 与当日券缓存最大的不同：**不跨天失效** —— 只要服务端还认这个 token 就一直用。
 * token 属敏感信息，文件按 0600 写。
 */

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
      note: '美团登录态缓存（按网关 ref 索引；含 token，敏感文件，权限 0600）。'
        + '失效后由脚本自动回退「网关取 code 重新登录」并覆盖本文件。',
      accounts,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(LOGIN_CACHE_FILE, 0o600); } catch (_) {}
  } catch (e) {
    $.log(`[提示] 登录态缓存写入失败（不影响领券）：${e.message}`);
  }
}

/** 取某个 ref 的缓存登录态，返回 ctx 形状（无则 null） */
function getCachedLogin(ref, all) {
  if (!LOGIN_CACHE_ON) return null;
  const rec = (all || {})[tokenKey(ref)];
  if (!rec || !rec.token) return null;
  return {
    token: String(rec.token),
    openId: rec.openId || '',
    openIdCipher: rec.openIdCipher || '',
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
    openId: ctx.openId || '',
    openIdCipher: ctx.openIdCipher || '',
    userId: ctx.userId || '',
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
  const url = env('MT_PUSH_URL');
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
  let sent = false;
  sent = await pushByWebhook(title, content);
  if (!sent && typeof $.msg === 'function') {
    try { await $.msg(title, content); sent = true; } catch (e) { $.log(`[推送] $.msg 调用失败：${e.message}`); }
  }
  if (!sent) sent = await pushBySendNotify(title, content);
  if (!sent) $.log('[推送] 未配置推送，结果仅输出日志');
}

/* ============ 单账号处理 ============ */

/** 错误文本是否像「鉴权失效」而非业务失败 */
function looksLikeAuthError(text) {
  const s = String(text || '');
  return /\bcode=(401|403)\b/.test(s)
    || /请重新登录|未登录|token\s*(已)?(失效|过期|为空|被拒)/i.test(s);
}

/**
 * 跑一个账号的两条链路（A=渠道券、B=福利社），只依赖 ctx（登录态）。
 * 单独抽出来是为了支持「先用缓存 token → 被拒 → 换新 token 重跑」。
 * 返回 { sections, result, authFail }；authFail=true 表示某条链路明确报了鉴权失效。
 */
async function runChains(ctx, cache, step) {
  const sections = [];
  const result = { ok: false, coupons: 0 };
  let authFail = false;

  /* ---- 链路 A：sendCouponWork ---- */
  if (CLAIM_WORK) {
    $.log('━ [A] WorkBuddy 渠道券（sendCouponWork）');
    const cachedA = cache.work;
    if (cachedA) {
      result.coupons += cachedA.count || 0;
      result.ok = result.ok || (cachedA.count > 0);
      $.log(`  ℹ️ 今天已领过，直接回放缓存：共 ${cachedA.count} 张`);
      $.log(renderList(cachedA.coupons || []));
      sections.push(`[A] WorkBuddy 渠道券：今日已领 ${cachedA.count} 张（回放当日缓存）`
        + `\n  包括${cachedA.count_str || ''}\n\n${renderList(cachedA.coupons || [])}`);
    } else {
      const resp = await claimWorkCoupons(ctx.token);
      if (!resp.ok && resp.kind === 'net') {
        $.log(`  ✖ 请求失败：${resp.error}`);
        sections.push(`[A] WorkBuddy 渠道券：请求失败（${resp.error}）`);
        step.A = `请求失败（${resp.error}）`;
      } else if (resp.code === 200) {
        const list = ((resp.data && resp.data.couponList) || []).map(formatCoupon);
        if (list.length) {
          const summary = buildCountStr(list);
          cache.work = {
            count: list.length,
            count_str: summary,
            coupons: list,
            activity_name: resp.data.activityName || '',
            activity_link: resp.data.activityLink || '',
          };
          result.coupons += list.length;
          result.ok = true;
          $.log(`  ✅ 领取成功，共 ${list.length} 张，包括${summary}！`);
          $.log(renderList(list));
          sections.push(`[A] WorkBuddy 渠道券：✅ 领取成功 ${list.length} 张\n  包括${summary}\n\n${renderList(list)}`);
          step.A = `成功 ${list.length} 张`;
        } else {
          $.log('  ℹ️ 接口返回成功但没有券（今天可能没有可领的券）');
          sections.push('[A] WorkBuddy 渠道券：接口返回 0 张券');
          step.A = '0 张券';
        }
      } else if (resp.code === 1014) {
        const tip = `服务端 1014 发券失败（aiScene=${AI_SCENE}、签名=${resp.signMode}）。`
          + '三种含义：①今天确实领过；②请求被拒（aiScene/签名不被认可）；③该渠道当前无券。'
          + '判断方法：看当天第一次运行；当天第一次就是 1014 基本是 ②。';
        $.log(`  ℹ️ ${tip}`);
        sections.push(`[A] WorkBuddy 渠道券：ℹ️ ${tip}`);
        step.A = '1014';
      } else if (resp.code === 401) {
        authFail = true;
        $.log('  ✖ token 被拒（401）—— 若这是缓存的旧 token，会自动去网关重登后重试');
        sections.push('[A] WorkBuddy 渠道券：✖ token 被服务端拒绝（401）');
        step.A = '401';
      } else if (resp.code === 403) {
        authFail = true;
        $.log('  ✖ token 为空（403）');
        sections.push('[A] WorkBuddy 渠道券：✖ token 为空（403）');
        step.A = '403';
      } else if (resp.code === 509 || resp.code === 50200) {
        $.log(`  ⏳ 请求过于频繁（code ${resp.code}），可稍后重跑`);
        sections.push(`[A] WorkBuddy 渠道券：⏳ 请求过于频繁（${resp.code}）`);
        step.A = `限流 ${resp.code}`;
      } else {
        const reason = resp.code === 9999 ? '系统异常' : `未知错误 code=${resp.code} msg=${resp.msg || '-'}`;
        $.log(`  ✖ ${reason}`);
        sections.push(`[A] WorkBuddy 渠道券：✖ ${reason}`);
        step.A = reason;
      }
    }
  }

  /* ---- 链路 B：福利社红包墙 ---- */
  if (CLAIM_FULISHE) {
    $.log('━ [B] 福利社红包墙（list + grantActivityCoupon）');
    const cachedB = cache.fulishe;
    if (cachedB) {
      result.coupons += cachedB.count || 0;
      result.ok = result.ok || (cachedB.count > 0);
      $.log(`  ℹ️ 今天已领过，直接回放缓存：共 ${cachedB.count} 张`);
      $.log(renderList(cachedB.coupons || []));
      sections.push(`[B] 福利社红包墙：今日已领 ${cachedB.count} 张（回放当日缓存）`
        + `\n  包括${cachedB.count_str || ''}\n\n${renderList(cachedB.coupons || [])}`);
    } else {
      const list = await fulisheList(ctx);
      if (!list.ok) {
        if (looksLikeAuthError(list.error)) authFail = true;
        $.log(`  ✖ ${list.error}`);
        sections.push(`[B] 福利社红包墙：✖ ${list.error}`);
        step.B = list.error;
      } else if (!list.tabs.length) {
        $.log('  ℹ️ 本次没有可以领取的券包');
        sections.push('[B] 福利社红包墙：ℹ️ 暂无可以领取的券包');
        step.B = '暂无券包';
      } else {
        $.log(`  🎟️ 本次查询共有 ${list.tabs.length} 组券包可以领取（${list.activityName}）`);
        const grant = await fulisheGrant(ctx, list);
        if (!grant.ok) {
          if (looksLikeAuthError(grant.error)) authFail = true;
          $.log(`  ✖ ${grant.error}`);
          sections.push(`[B] 福利社红包墙：✖ ${grant.error}`);
          step.B = grant.error;
        } else {
          const coupons = grant.coupons.map(formatCoupon);
          const total = grant.totalValue;
          if (coupons.length) {
            const summary = buildCountStr(coupons);
            cache.fulishe = {
              count: coupons.length,
              count_str: summary,
              coupons,
              activity_name: grant.activityName,
              totalValue: total,
            };
            result.coupons += coupons.length;
            result.ok = true;
            $.log(`  ✅ 领取成功，共 ${coupons.length} 张`
              + (total != null ? `，总面额 ${(Number(total) / 100).toFixed(2)} 元` : ''));
            coupons.forEach((c) => $.log(`     - ${c.name} | ${c.discount}`));
            sections.push(`[B] 福利社红包墙：✅ 领取成功 ${coupons.length} 张`
              + (total != null ? `（总面额 ${(Number(total) / 100).toFixed(2)} 元）` : '')
              + `\n  包括${summary}\n\n${renderList(coupons)}`);
            step.B = `成功 ${coupons.length} 张`;
          } else {
            $.log('  ℹ️ 领取成功但没有返回券明细');
            sections.push('[B] 福利社红包墙：ℹ️ 领取成功但无券明细');
            step.B = '成功但无明细';
          }
        }
      }
    }
  }

  return { sections, result, authFail };
}

/**
 * 处理一个账号。任何一步失败都只影响这个账号，返回结果对象，绝不抛出去打断整只脚本。
 * cache      ：当日券缓存里这个账号的记录（可读写）
 * loginCache ：登录态缓存全表（可读写）
 *
 * 登录策略：优先复用本地缓存的登录态；只有当服务端明确拒绝（401/403 等）时，
 * 才回头去网关「取 code → 换 token」重新登录一次，成功后回写缓存。
 */
async function runAccount(index, total, account, cache, loginCache) {
  const ref = account.ref;
  logAccountHeader(index, total, account.label, ref);

  const delay = 2 + Math.floor(Math.random() * 5);
  $.log(`⏳ [延迟] 启动延迟 ${delay}s`);
  await sleep(delay * 1000);

  const step = {};
  const needA = CLAIM_WORK && !cache.work;
  const needB = CLAIM_FULISHE && !cache.fulishe;
  const needLogin = needA || needB;

  let ctx = null;
  let fromCache = false;
  let nickname = '';

  if (!needLogin) {
    // 两条链路今天都领过了 → 纯回放，连登录都不用做
    $.log('ℹ️ [登录] 两条链路今天都已领过，无需登录，直接回放当日缓存');
  } else {
    const cached = getCachedLogin(ref, loginCache);
    if (cached) {
      ctx = cached;
      fromCache = true;
      nickname = cached.nickname || '';
      $.log(`🔐 [登录] 命中本地登录态缓存（${fmtTs(cached.obtained_at)} 获取），先复用它，不去网关取 code`);
    }
  }

  /** 去网关取 code → 换 token（仅在需要时调用） */
  const freshLogin = async (reason) => {
    if (reason) $.log(`♻️ [登录] ${reason}，改用网关取 code 重新登录`);
    const code = await fetchCode(ref);
    if (!code) return { ok: false, error: '网关取 code 失败（账号登录态可能已失效，可去面板重扫）' };
    const login = await loginByCode(code);
    if (!login.ok) return { ok: false, error: `登录失败：${login.error}` };
    if (!login.userId || !login.openId) return { ok: false, error: '登录响应未返回 openId / openIdCipher / userId' };
    $.log(`✅ [登录] 网关登录成功: ${mask(login.token, 6, 6)}（${login.token.length} 字符）`);
    return {
      ok: true,
      ctx: { token: login.token, openId: login.openId, openIdCipher: login.openIdCipher, userId: login.userId },
    };
  };

  if (needLogin && !ctx) {
    const fresh = await freshLogin('');
    if (!fresh.ok) return { ok: false, error: fresh.error, step };
    ctx = fresh.ctx;
    fromCache = false;
  }
  if (ctx && !nickname) {
    nickname = await queryNickname(ctx);
    if (nickname) $.log(`👤 [用户] userId=${ctx.userId} 昵称=${nickname}`);
  }

  // 回退重跑前先给当日缓存拍个快照：重跑时复原，免得半途写进去的记录残留
  const cacheSnapshot = JSON.stringify(cache);

  let run = await runChains(ctx, cache, step);

  // 缓存的登录态被服务端拒绝 → 换新 token 重跑一次
  if (needLogin && fromCache && run.authFail) {
    for (const k of Object.keys(cache)) delete cache[k];
    Object.assign(cache, JSON.parse(cacheSnapshot));
    delete step.A;
    delete step.B;
    const fresh = await freshLogin('本地登录态被服务端拒绝');
    if (!fresh.ok) {
      $.log(`  ✖ 回退登录也失败：${fresh.error}`);
      return { ok: false, error: fresh.error, step };
    }
    ctx = fresh.ctx;
    fromCache = false;
    if (!nickname) nickname = await queryNickname(ctx);
    if (nickname) $.log(`👤 [用户] userId=${ctx.userId} 昵称=${nickname}`);
    run = await runChains(ctx, cache, step);
  }

  // 本次是走网关新登的 → 回写登录态缓存，下次直接复用
  if (!fromCache && ctx && LOGIN_CACHE_ON) {
    putCachedLogin(loginCache, ref, ctx, nickname);
    $.log('💾 [登录] 已缓存本次登录态，下次运行可直接复用');
  }

  return Object.assign(run.result, { nickname, step, sections: run.sections, ctx });
}

/* ============ 主流程 ============ */

function watchdog(ms, onFire) {
  // 普通 setTimeout（刻意不 unref）：极端情况下强制收尾，不让青龙任务挂死
  return setTimeout(onFire, ms);
}

!(async () => {
  // 保活：运行期间不让事件循环被抽空导致的静默退出
  // （历史上踩过坑：兜底定时器 unref 之后，卡死时 Node 直接 beforeExit，日志戛然而止）
  const keepAlive = setInterval(() => { /* 仅用于撑住事件循环 */ }, KEEPALIVE_MS);

  let exitCode = 0;
  const globalWatchdog = watchdog(30 * 60 * 1000, () => {
    $.log('\n⛔ 看门狗触发：整体运行超过 30 分钟，强制收尾（避免青龙任务挂死）');
    try { $.done(); } catch (_) {}
    process.exit(0);
  });

  try {
    // 代理
    if (PROXY_URL) {
      $.log(`🌐 [代理] 使用静态代理 ${PROXY_LABEL}`);
      const ok = await validateProxy();
      if (ok) $.log('✅ [代理] 验证通过');
      else $.log('🔁 [兜底] 代理不可用，本次改用直连');
    } else {
      $.log('🔌 [代理] 未配置 mt_proxy / script_proxy，使用直连');
    }

    // 账号
    let accounts = [];
    try {
      accounts = await resolveAccounts();
    } catch (e) {
      $.log(`❌ [账号] 从网关获取账号失败：${e.message}`);
      accounts = [];
    }
    if (!accounts.length) {
      $.log('❌ [账号] 没有可用账号：请到扫码面板扫码登录，或配置 mt_openid / 在 yyb_server 里用 @ref 指定');
      $.log('本轮结论: 没有可用账号，脚本未执行');
      $.done();
      return;
    }
    if (!MT_OPENIDS.length && !GATEWAY.ref) {
      $.log(`🌐 [账号] 已自动从网关发现 ${accounts.length} 个 alive 账号`);
    }

    logTitle(accounts.length);
    $.log(`📋 领取范围：${CLAIM_WORK ? 'A=WorkBuddy 渠道券' : 'A=关闭'}`
      + ` ｜ ${CLAIM_FULISHE ? 'B=福利社红包墙' : 'B=关闭'}`);

    const cacheAll = readCacheAll();
    const loginCache = readLoginCacheAll();
    if (LOGIN_CACHE_ON) {
      const n = Object.keys(loginCache).length;
      $.log(`🔐 [登录] 本地登录态缓存：${n ? `已存 ${n} 个账号（优先复用）` : '暂无（本次登录后会自动写入）'}`);
    } else {
      $.log('🔐 [登录] 已通过 mt_login_cache=0 关闭登录态复用，每次都去网关取 code');
    }
    const results = [];

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const ref = account.ref;
      const cache = cacheAll[tokenKey(ref)] || {};

      let timer = null;
      const timeout = new Promise((r) => {
        // 不 unref！unref 之后它不撑事件循环，卡死时它根本来不及 fire
        timer = setTimeout(() => r('__timeout__'), ACCOUNT_TIMEOUT);
      });

      let result;
      try {
        result = await Promise.race([runAccount(i + 1, accounts.length, account, cache, loginCache), timeout]);
      } catch (e) {
        result = { ok: false, error: `异常：${e.message}`, coupons: 0, sections: [], step: {} };
      }
      if (timer) clearTimeout(timer);

      if (result === '__timeout__') {
        $.log(`[${i + 1}/${accounts.length}] ⏱️ 处理超时（>${Math.round(ACCOUNT_TIMEOUT / 1000)}s），跳过该账号，继续下一个`);
        result = { ok: false, error: `处理超时（>${Math.round(ACCOUNT_TIMEOUT / 1000)}s）`, coupons: 0, sections: [] };
      }

      cacheAll[tokenKey(ref)] = cache;
      // 不要把 ctx（含 token）留在结果里，避免后续被误打进日志/通知
      const { sections: secs, ctx: _ctx, ...rest } = result;
      void _ctx;
      results.push(Object.assign({ label: account.label, ref, sections: secs || [] }, rest));

      if (i < accounts.length - 1) {
        $.log('');
        $.log('⏳ [间隔] 等待 3s 后处理下一个账号');
        await sleep(3000);
      }
    }

    try { writeCacheAll(cacheAll); } catch (_) { /* 已在函数里打过日志 */ }
    try { writeLoginCacheAll(loginCache); } catch (_) { /* 已在函数里打过日志 */ }

    // 汇总
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    const totalCoupons = results.reduce((n, r) => n + (r.coupons || 0), 0);

    $.log('');
    $.log('╔' + '═'.repeat(50) + '╗');
    $.log('║' + padR('🏁 美团优惠券任务执行完成', 50) + '║');
    $.log('║' + padR(`✅ 领到券的账号: ${okCount}`, 50) + '║');
    $.log('║' + padR(`❌ 失败/未领到的账号: ${failCount}`, 50) + '║');
    $.log('║' + padR(`🎟️ 本次共领到: ${totalCoupons} 张`, 50) + '║');
    $.log('║' + padR(`🕒 结束时间: ${nowText()}`, 50) + '║');
    $.log('╚' + '═'.repeat(50) + '╝');

    // 通知
    const lines = [];
    results.forEach((r, i) => {
      lines.push(`【账号 ${i + 1}】${r.label}（${mask(r.ref)}）`
        + (r.ok ? `：领到 ${r.coupons} 张` : `：${r.error || '未领到券'}`));
      if (r.sections && r.sections.length) {
        r.sections.forEach((s) => lines.push(s.split('\n').map((l) => '  ' + l).join('\n')));
      }
      lines.push('');
    });
    await push(totalCoupons > 0 ? '🎉 美团优惠券领取完成' : '美团优惠券领取结果',
      lines.join('\n').trim());
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
