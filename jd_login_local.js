#!/usr/bin/env node
/**
 * 京东扫码登录（本地版）
 *
 * 为什么在本地跑：面板所在的服务器在海外、内存只有 1.6G，京东登录页 75 秒都加载不完，
 * 二维码 2 分钟就换，根本来不及。本机 Chrome 打开只要 1~2 秒。
 *
 * 用法：
 *   node jd_login_local.js
 *   → 自动弹出 Chrome 打开京东登录页
 *   → 用「京东 App」扫码并在手机上确认
 *   → 拿到 pt_key/pt_pin 后自动写入青龙（需要配 QL_* 环境变量），否则只打印
 *
 * 环境变量（可选，不配就只打印 cookie）：
 *   QL_URL      青龙地址，如 https://ql.example.com
 *   QL_CID      青龙应用 Client ID
 *   QL_SECRET   青龙应用 Client Secret
 *   JD_ENV_NAME 环境变量名，默认 JD_COOKIE
 */

const path = require('path');
const https = require('https');
const http = require('http');

// 本机已缓存的 playwright（用系统 Chrome，不需要下载 chromium）
const PW_CANDIDATES = [
  process.env.PLAYWRIGHT_PATH,
  '/Users/summer/.npm/_npx/9833c18b2d85bc59/node_modules/playwright',
];

function loadPlaywright() {
  for (const p of PW_CANDIDATES) {
    if (!p) continue;
    try { return require(p); } catch (_) { /* next */ }
  }
  // 兜底：全局/本地安装
  try { return require('playwright'); } catch (_) { /* next */ }
  throw new Error('找不到 playwright。先执行：npm i -g playwright');
}

const QL_URL = (process.env.QL_URL || '').replace(/\/+$/, '');
const QL_CID = process.env.QL_CID || '';
const QL_SECRET = process.env.QL_SECRET || '';
const ENV_NAME = process.env.JD_ENV_NAME || 'JD_COOKIE';

function req(method, urlStr, { headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { return resolve({ status: 0, error: 'bad url' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const r = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        headers,
      ),
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.setTimeout(timeout, () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (payload) r.write(payload);
    r.end();
  });
}

async function qlToken() {
  const r = await req('GET', `${QL_URL}/open/auth/token?client_id=${encodeURIComponent(QL_CID)}&client_secret=${encodeURIComponent(QL_SECRET)}`);
  if (!r.json || !r.json.data || !r.json.data.token) throw new Error(`青龙鉴权失败: ${r.text.slice(0, 120)}`);
  return r.json.data.token;
}

async function qlWriteCookie(cookie, pin) {
  const token = await qlToken();
  const auth = { Authorization: `Bearer ${token}` };

  // 查现有 JD_COOKIE
  const list = await req('GET', `${QL_URL}/open/envs?searchValue=${encodeURIComponent(ENV_NAME)}`, { headers: auth });
  const items = (list.json && (list.json.data || list.json)) || [];
  const exist = Array.isArray(items) ? items.find((it) => it.name === ENV_NAME) : null;

  if (!exist) {
    const created = await req('POST', `${QL_URL}/open/envs`, {
      headers: auth,
      body: [{ name: ENV_NAME, value: cookie, remarks: `京东扫码 ${pin}` }],
    });
    if (created.status >= 300) throw new Error(`新增失败: ${created.text.slice(0, 120)}`);
    return '已新增环境变量';
  }

  const old = String(exist.value || '');
  // 已有同一个 pin 就替换，否则追加一行
  const lines = old.split(/\n+/).filter(Boolean);
  const idx = lines.findIndex((l) => l.includes(`pt_pin=${pin}`) || l.includes(`pt_pin=${encodeURIComponent(pin)}`));
  let value;
  if (idx >= 0) {
    lines[idx] = cookie;
    value = lines.join('\n');
  } else {
    value = old ? `${old}\n${cookie}` : cookie;
  }

  const updated = await req('PUT', `${QL_URL}/open/envs`, {
    headers: auth,
    body: { id: exist.id, name: ENV_NAME, value, remarks: exist.remarks || `京东扫码 ${pin}` },
  });
  if (updated.status >= 300) throw new Error(`更新失败: ${updated.text.slice(0, 120)}`);
  return idx >= 0 ? '已更新同 pin 的 cookie' : '已追加新 cookie';
}

(async () => {
  const { chromium } = loadPlaywright();

  console.log('');
  console.log('════════ 京东扫码登录（本地） ════════');
  console.log('即将打开浏览器，请用【京东 App】扫码并确认');
  console.log('');

  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 860 },
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  try {
    await page.goto('https://passport.jd.com/new/login.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log('页面加载告警（继续等待）：', e.message.slice(0, 80));
  }

  console.log('✅ 浏览器已打开，请扫码…（最多等 5 分钟）');

  let cookie = '';
  let pin = '';
  let lastNames = '';
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    /* eslint-disable no-await-in-loop */
    let cookies = [];
    try { cookies = await ctx.cookies(); } catch (_) { /* ignore */ }

    // 诊断：cookie 名单或 URL 变了就打印一行，方便看扫码后发生了什么
    const names = cookies.map((c) => c.name).sort().join(',');
    let curUrl = '';
    try { curUrl = page.url(); } catch (_) { /* ignore */ }
    if (names !== lastNames) {
      console.log(`[${new Date().toLocaleTimeString()}] cookie=${names || '(空)'}`);
      console.log(`    url=${curUrl.slice(0, 80)}`);
      lastNames = names;
    }

    // 新版京东 PC 登录不再下发 pt_key，改发 pin + thor（+ _pst/_tp/...）；
    // 老账号/老入口仍可能有 pt_key。两种都认。
    const k = cookies.find((c) => c.name === 'pt_key' && c.value);
    const p = cookies.find((c) => c.name === 'pt_pin' && c.value);
    const pinCk = cookies.find((c) => c.name === 'pin' && c.value);
    const thorCk = cookies.find((c) => c.name === 'thor' && c.value);

    if ((k && p) || (pinCk && thorCk)) {
      // 完整 cookie（同名去重，保留第一个）
      const seen = new Set();
      const parts = [];
      for (const c of cookies) {
        if (!c.value || seen.has(c.name)) continue;
        seen.add(c.name);
        parts.push(`${c.name}=${c.value}`);
      }
      cookie = parts.join('; ');
      pin = decodeURIComponent((p || pinCk).value);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!cookie) {
    console.log('❌ 5 分钟内没检测到登录成功，请重跑一次');
    await browser.close();
    process.exit(1);
  }

  console.log('');
  console.log('✅ 登录成功，pin =', pin);
  console.log('cookie 长度', cookie.length, '｜字段数', cookie.split(';').length);
  console.log('前 80 字符：', cookie.slice(0, 80) + '...');
  console.log('');

  if (QL_URL && QL_CID && QL_SECRET) {
    try {
      const msg = await qlWriteCookie(cookie, pin);
      console.log(`✅ 青龙：${msg}（${QL_URL}）`);
    } catch (e) {
      console.log(`⚠️ 写青龙失败：${e.message}`);
      console.log('   cookie 已打印在下面，可以手动粘贴');
    }
  } else {
    console.log('（没配 QL_URL / QL_CID / QL_SECRET，只打印 cookie，请手动加到青龙）');
  }

  console.log('');
  console.log('完整 cookie：');
  console.log(cookie);
  console.log('');

  try {
    // 尽量复制到剪贴板（macOS）
    const { execSync } = require('child_process');
    execSync(`printf '%s' '${cookie}' | pbcopy`);
    console.log('📋 已复制到剪贴板');
  } catch (_) { /* ignore */ }

  await new Promise((r) => setTimeout(r, 1500));
  await browser.close();
  console.log('完成，浏览器已关闭。');
})();
