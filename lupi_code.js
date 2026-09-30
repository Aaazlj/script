/*
------------------------------------------
@Description: 噜皮生图 每日签到（青龙版，替代 image2api 容器的常驻签到）
cron: 5 8 * * *
new Env('噜皮生图签到')
------------------------------------------
设计说明：
  · 零外部依赖，只用 Node 内置 https
  · 签到接口只认「网页会话 Cookie」，个人 API Key 会被 401/403 拒绝
  · 多账号：lupi_cookie 每行一个
  · 完整复刻 image2api/src/image2api/checkin.py 的核心流程：
      GET  /api/me          查积分 / 连签天数 / 今日是否已签
      未签则 POST /api/me/checkin   领取积分（已签会直接跳过）

环境变量：
  lupi_cookie   必填。网页会话 Cookie，形如 chatgpt2api_session=xxxxx
                —— 浏览器登录 image.mlgb7.com 后 F12 → Application →
                   Cookies 复制 chatgpt2api_session 的整个键值对；
                   过期（HTTP 401「密钥无效或已失效」）时更新它即可
                多账号用换行分隔
  lupi_base     可选，上游地址，默认 https://image.mlgb7.com
  lupi_force    可选，置 1 时即使今天已签到也强制再请求一次（默认 0，已签就跳过）
  lupi_retry    可选，网络错误重试次数，默认 3
*/

'use strict';

const https = require('https');
const { URL } = require('url');

const ENV = (k) => String(process.env[k] || '').trim();

const BASE = (ENV('lupi_base') || 'https://image.mlgb7.com').replace(/\/+$/, '');
const COOKIES = ENV('lupi_cookie')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const FORCE = /^(1|true|yes|on)$/i.test(ENV('lupi_force'));
const MAX_RETRY = Math.max(1, Number(ENV('lupi_retry')) || 3);
const TIMEOUT = 20000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const REFERER = BASE + '/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(msg);
}

function mask(s, head = 8, tail = 4) {
  const v = String(s || '');
  return v.length > head + tail + 4 ? `${v.slice(0, head)}...${v.slice(-tail)}` : v;
}

/** 发一次请求；网络层错误 resolve 成 { status: 0, error }，不抛异常 */
function request(method, path, cookie) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(BASE + path);
    } catch (e) {
      return resolve({ status: 0, error: '上游地址非法: ' + e.message });
    }

    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          Cookie: cookie,
          Accept: 'application/json',
          'User-Agent': UA,
          Referer: REFERER,
          Origin: BASE,
        },
        timeout: TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );

    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(TIMEOUT, () => {
      req.destroy();
      resolve({ status: 0, error: 'TIMEOUT' });
    });
    req.end();
  });
}

/** 带重试的请求：只有「一个字节都没收到」才重试；拿到 HTTP 状态码就算结果 */
async function call(method, path, cookie) {
  let last = null;
  for (let i = 0; i < MAX_RETRY; i++) {
    const r = await request(method, path, cookie);
    if (r.status > 0) return r;
    last = r;
    if (i < MAX_RETRY - 1) {
      log(`   ⚠️ 网络错误(${r.error})，重试第 ${i + 1} 次`);
      await sleep(1500 * (i + 1));
    }
  }
  return last || { status: 0, error: '未知错误' };
}

/** 从各种错误结构里抠出人能看懂的提示 */
function detailError(r) {
  const d = r.json && r.json.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') return d.error || d.message || JSON.stringify(d);
  if (r.json) return r.json.error || r.json.message || JSON.stringify(r.json).slice(0, 160);
  return (r.text || '').replace(/\s+/g, ' ').slice(0, 160) || `HTTP ${r.status}`;
}

/** 判断是不是会话/密钥失效（需要换 Cookie） */
function isExpired(r) {
  if (r.status === 401 || r.status === 403) return true;
  return /密钥无效|已失效|重新登录|未登录|token/i.test(detailError(r));
}

function cookieLabel(cookie) {
  const m = /chatgpt2api_session=([^;]+)/.exec(cookie);
  return m ? mask(m[1]) : mask(cookie);
}

async function runAccount(cookie, index, total) {
  const tag = `[${index}/${total}]`;
  log(`${tag} 开始处理（Cookie ${cookieLabel(cookie)}）`);

  // 1) 先查账户状态，避免重复签到
  const me = await call('GET', '/api/me', cookie);
  if (me.status === 0) {
    log(`${tag} ❌ 查询账户失败：${me.error}`);
    return false;
  }
  if (me.status !== 200) {
    if (isExpired(me)) {
      log(`${tag} ❌ Cookie 已失效，请重新到浏览器复制并更新 lupi_cookie：${detailError(me)}`);
    } else {
      log(`${tag} ❌ 查询账户失败：HTTP ${me.status} ${detailError(me)}`);
    }
    return false;
  }

  const acc = me.json || {};
  const pointsBefore = acc.points != null ? acc.points : null;
  const days = acc.checkin_days != null ? acc.checkin_days : null;
  log(
    `${tag} 👤 当前积分：${pointsBefore != null ? pointsBefore : '-'}` +
      (days != null ? ` · 连签 ${days} 天` : '')
  );

  if (acc.checked_in_today && !FORCE) {
    log(`${tag} ✅ 今日已签到，跳过（积分 ${pointsBefore != null ? pointsBefore : '-'}）`);
    return true;
  }

  // 2) 签到
  const ck = await call('POST', '/api/me/checkin', cookie);
  if (ck.status === 0) {
    log(`${tag} ❌ 签到请求失败：${ck.error}`);
    return false;
  }
  if (ck.status !== 200) {
    if (isExpired(ck)) {
      log(`${tag} ❌ Cookie 已失效，请更新 lupi_cookie：${detailError(ck)}`);
    } else {
      log(`${tag} ❌ 签到失败：HTTP ${ck.status} ${detailError(ck)}`);
    }
    return false;
  }

  const r = ck.json || {};
  const reward = Number(r.reward || 0);
  const pointsAfter = r.points != null ? r.points : pointsBefore;
  const awarded = r.awarded === undefined ? reward > 0 : !!r.awarded;

  if (awarded && reward > 0) {
    log(`${tag} 🎁 签到成功，获得 ${reward} 积分（当前积分 ${pointsAfter != null ? pointsAfter : '-'}）`);
  } else {
    log(`${tag} ✅ 签到完成（今日已签，当前积分 ${pointsAfter != null ? pointsAfter : '-'}）`);
  }
  return true;
}

async function main() {
  log('==============================');
  log('☀️  噜皮生图 每日签到');
  log(`🔗 上游：${BASE}`);
  log(`📱 账号：${COOKIES.length} 个${FORCE ? '（强制模式）' : ''}`);
  log('==============================');

  if (!COOKIES.length) {
    log('❌ 未配置 lupi_cookie：到浏览器登录 image.mlgb7.com，F12 → Application → Cookies');
    log('   复制 chatgpt2api_session 的整个键值对，填进青龙环境变量 lupi_cookie');
    return 1;
  }

  let ok = 0;
  for (let i = 0; i < COOKIES.length; i++) {
    try {
      if (await runAccount(COOKIES[i], i + 1, COOKIES.length)) ok++;
    } catch (e) {
      log(`[${i + 1}/${COOKIES.length}] ❌ 执行异常：${(e && e.message) || e}`);
    }
    if (i < COOKIES.length - 1) await sleep(2000);
  }

  log('==============================');
  log(`🏁 完成：成功 ${ok} / 共 ${COOKIES.length}`);
  log('==============================');
  return ok === COOKIES.length ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('❌ 脚本异常：', (e && e.stack) || e);
    process.exitCode = 1;
  })
  .finally(() => {
    // 青龙里跑完必须显式退出，否则被句柄吊住不结束
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
