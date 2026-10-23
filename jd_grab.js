/*
------------------------------------------
@Description: 京东外卖「超级补贴」整点抢 20 元金券（浏览器方案）
cron: 59 7 * * *
------------------------------------------
为什么要用浏览器：
  这个活动的 H5（pro.m.jd.com/mini/active/<actId>/index.html）所有接口都要求
  h5st 签名，而 h5st 是页面里 babel-jssdk 用设备指纹 + 运行时环境现算的，
  离线无法复刻。所以干脆开一个无头 chromium 把页面跑起来，让页面自己生成签名，
  我们只负责「到点点击领取」。实测页面能正常识别 cookie / 地址 / 场次。

环境变量：
  jd_cookie        必需。完整 cookie 字符串（pt_key / pt_pin / 3AB9D23F7A4B3C9B /
                   __jda / shshshfpa / loc / wq_addr 等，直接从浏览器 Network
                   里复制整个 Cookie 请求头）
  jd_grab_hour     抢哪个整点场，默认 8（即每天 08:00 那场）。多场次用逗号分隔，
                   如 8,12,16；脚本会抢「最近的一个还没过且今天还没领过」的场
  jd_grab_open_sec 提前多少秒启动浏览器，默认 75（页面加载实测约 23s，留足余量）
  jd_grab_act_id   活动 id，默认 2BuMtujoMx1EPnFvUrUpsrYucqUK（超级补贴会场）
  jd_grab_shot_dir 截图目录，默认 /ql/data/jd_grab_shots
  jd_grab_headless 默认 1；设 0 会用有头模式（调试用，需要 X）
------------------------------------------
*/

const fs = require('fs');
const path = require('path');

const IN_QINGLONG = typeof Env === 'function';
const $ = (() => {
  if (IN_QINGLONG) {
    try { return new Env('京东外卖抢券'); } catch (_) { /* 降级 */ }
  }
  return { log: (...a) => console.log(...a), msg: null, done: () => {} };
})();

function env(...names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
}

const COOKIE_RAW = env('jd_cookie', 'JD_COOKIE');
const HOURS = (env('jd_grab_hour') || '8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23')
  .split(/[,，\s]+/).map(Number).filter((n) => n >= 0 && n <= 23);
const OPEN_SEC = Math.max(20, Number(env('jd_grab_open_sec') || 75));
const ACT_ID = env('jd_grab_act_id') || '2BuMtujoMx1EPnFvUrUpsrYucqUK';
const SHOT_DIR = env('jd_grab_shot_dir') || '/ql/data/jd_grab_shots';
const HEADLESS = env('jd_grab_headless') !== '0';

const PUPPETEER = env('jd_grab_puppeteer') || '/ql/data/puppeteer/node_modules/puppeteer-core';
const CHROME = env('jd_grab_chrome') || '/usr/bin/chromium-browser';
const STATE_FILE = env('jd_grab_state_file') || '/ql/data/jd_grab_state.json';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI '
  + 'MiniProgramEnv/Mac MacWechat/WMPF MacWechat/3.8.7(0x13080712) UnifiedPCMacWechat(0xf2641f37) '
  + 'XWEB/25800 miniProgram/wxad169f0e9e78fe47';

const URL_PAGE = `https://pro.m.jd.com/mini/active/${ACT_ID}/index.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const nowText = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const mask = (s, h = 4, t = 4) => {
  s = String(s || '');
  return s.length <= h + t ? '***' : `${s.slice(0, h)}****${s.slice(-t)}`;
};

/* ---------- 当日已领状态：一个号一天只能领一张，领过就不再碰 ---------- */
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && s.date === todayStr()) return s;
  } catch (_) { /* 没有状态文件 */ }
  return null;
}

function writeState(info) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE,
      JSON.stringify(Object.assign({ date: todayStr() }, info), null, 1), 'utf8');
  } catch (_) { /* 写不了不影响主流程 */ }
}

/* ---------- cookie 解析 ---------- */
function parseCookie(raw) {
  const out = {};
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/* ---------- 目标场次：最近一个还没开始的 ---------- */
function pickTarget() {
  const now = new Date();
  const cands = [];
  const hours = HOURS.length ? HOURS : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  for (const h of hours) {
    for (let d = 0; d <= 1; d += 1) {
      const t = new Date(now);
      t.setDate(t.getDate() + d);
      t.setHours(h, 0, 0, 0);
      if (t.getTime() > now.getTime() - 2000) cands.push(t);   // 还没开始（含刚过 2s）
    }
  }
  cands.sort((a, b) => a - b);
  return cands[0] || new Date(now.getTime() + 3600 * 1000);
}

/* ---------- 点击领取 ---------- */
async function findClaimable(page) {
  return page.evaluate(() => {
    const want = ['立即领取', '马上抢', '立即抢', '去领取'];
    const done = ['去使用', '已领取', '已抢完', '已抢光'];
    const nodes = [...document.querySelectorAll('div,span,button,a,p')];
    const visible = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
    const leafText = nodes.filter((e) => e.children.length === 0 && visible(e));
    const texts = leafText.map((e) => (e.textContent || '').trim()).filter(Boolean);
    for (const w of want) {
      if (texts.includes(w)) return { state: 'claimable', text: w };
    }
    for (const d of done) {
      if (texts.includes(d)) return { state: 'done', text: d };
    }
    return { state: 'unknown', text: texts.slice(0, 12).join('/') };
  });
}

async function clickClaim(page) {
  return page.evaluate(() => {
    const want = ['立即领取', '马上抢', '立即抢', '去领取'];
    const nodes = [...document.querySelectorAll('div,span,button,a,p')];
    const visible = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
    for (const w of want) {
      const el = nodes.find((e) => e.children.length === 0 && visible(e) && (e.textContent || '').trim() === w);
      if (!el) continue;
      let box = el;
      for (let i = 0; i < 4 && box; i += 1) {
        const tag = box.tagName;
        if (tag === 'BUTTON' || tag === 'A' || box.getAttribute('role') === 'button') break;
        box = box.parentElement;
      }
      const target = box || el;
      try { target.scrollIntoView({ block: 'center' }); } catch (_) {}
      try { target.click(); } catch (_) {}
      const r = el.getBoundingClientRect();
      return { clicked: true, text: w, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return { clicked: false };
  });
}

/* ---------- 读结果 ---------- */
async function readResult(page) {
  const text = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
  const hit = ['抢券成功', '领取成功', '已抢完', '已抢光', '明天再来', '已领取', '去使用', '别太贪心', '稍后再试', '网络异常']
    .filter((k) => text.includes(k));
  return { hit, snippet: text.slice(0, 240) };
}

/* ---------- 主流程 ---------- */
async function main() {
  $.log('');
  $.log('════════ 京东外卖整点抢券（浏览器方案） ════════');
  $.log(`🕒 ${nowText()} ｜ 目标场次: ${HOURS.map((h) => pad(h) + ':00').join(', ')}`);

  if (!COOKIE_RAW) {
    $.log('❌ 缺少 jd_cookie（完整 cookie 字符串），脚本退出');
    return;
  }
  const cookies = parseCookie(COOKIE_RAW);
  if (!cookies.pt_key || !cookies.pt_pin) {
    $.log('❌ jd_cookie 里没有 pt_key / pt_pin，检查一下复制是否完整');
    return;
  }
  $.log(`🔐 cookie 字段 ${Object.keys(cookies).length} 个 ｜ pin=${mask(cookies.pt_pin)}`);

  // 一个号一天只能领一次：今天已经领过就直接退出，连浏览器都不开
  const dayState = readState();
  if (dayState && dayState.claimed) {
    $.log(`✅ 今天（${dayState.date}）已经领过了${dayState.pin ? '，pin=' + mask(dayState.pin) : ''}`);
    $.log('   按「一个号一天只能领一次」，本次不再发起领取，直接退出。');
    $.log(`   如确认是误判，删掉 ${STATE_FILE} 再跑即可。`);
    return;
  }
  $.log('🆕 今天还没领过，继续');

  const target = pickTarget();
  const openAt = target.getTime() - OPEN_SEC * 1000;
  const waitOpen = openAt - Date.now();
  $.log(`🎯 目标 ${target.toLocaleString('zh-CN')}（还有 ${((target - Date.now()) / 60000).toFixed(1)} 分钟）`);

  const NO_WAIT = env('jd_grab_no_wait') === '1';
  if (NO_WAIT) {
    $.log('⚠️ 测试模式（jd_grab_no_wait=1）：跳过等待，立即执行');
  } else if (waitOpen > 0) {
    $.log(`⏳ 等 ${(waitOpen / 1000).toFixed(0)}s 后启动浏览器（提前 ${OPEN_SEC}s）`);
    await sleep(waitOpen);
  }

  let puppeteer;
  try {
    puppeteer = require(PUPPETEER);
  } catch (e) {
    $.log(`❌ 加载 puppeteer-core 失败：${e.message}`);
    return;
  }

  const t0 = Date.now();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox',
      '--disable-accelerated-2d-canvas', '--no-zygote', '--js-flags=--max-old-space-size=256'],
  });
  $.log(`🚀 浏览器已启动（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 400, height: 860, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.setCookie(...Object.entries(cookies).map(([name, value]) => ({
      name, value, domain: '.jd.com', path: '/',
    })));

    const apis = [];
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('client.action') && apis.length < 12) {
        apis.push(r.status() + ' ' + (u.split('functionId=')[1] || '').slice(0, 26));
      }
    });

    $.log('🌐 打开活动页…');
    try {
      await page.goto(URL_PAGE, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      $.log(`⚠️ 页面加载告警：${e.message.slice(0, 80)}`);
    }
    await sleep(3000);

    const title = await page.title();
    $.log(`📄 ${title}`);
    if (!/超级补贴|金券|京东/.test(title)) {
      $.log('❌ 页面标题不对，可能 cookie 失效或被重定向');
    }

    // 等按钮出现
    let st = { state: 'unknown', text: '' };
    for (let i = 0; i < 20; i += 1) {
      st = await findClaimable(page);
      if (st.state !== 'unknown') break;
      await sleep(500);
    }
    $.log(`🔎 按钮状态：${st.state} ${st.text ? '(' + st.text + ')' : ''}`);
    if (st.state === 'done') {
      $.log(`ℹ️ 今天这场的券已经领过了（${st.text}），记录状态后退出`);
      writeState({ claimed: true, pin: cookies.pt_pin, at: nowText(), by: 'page-button' });
      await page.screenshot({ path: path.join(SHOT_DIR, `done-${Date.now()}.png`), fullPage: false }).catch(() => {});
      return;
    }

    // 等到整点
    const until = target.getTime() - Date.now();
    if (until > 0 && !NO_WAIT) {
      $.log(`⏳ 等到整点（${(until / 1000).toFixed(2)}s）`);
      await sleep(until);
    }
    $.log(`🎯 ${nowText()} 点击领取`);

    let clicked = { clicked: false };
    for (let i = 0; i < 8; i += 1) {
      clicked = await clickClaim(page);
      if (clicked.clicked) break;
      await sleep(200);
    }
    if (!clicked.clicked) {
      $.log('❌ 没找到可点的「立即领取」按钮');
      st = await findClaimable(page);
      $.log(`   当前状态：${st.state} ${st.text}`);
    } else {
      $.log(`👆 已点击「${clicked.text}」`);
      if (clicked.x) {
        try { await page.mouse.click(clicked.x, clicked.y); } catch (_) {}
      }
    }

    await sleep(2500);
    const res = await readResult(page);
    $.log(`📣 结果关键词：${res.hit.join('、') || '（无）'}`);
    $.log(`   页面片段：${res.snippet.slice(0, 160)}`);

    // 领到了就落当日状态，今天不再重复领
    const successHits = res.hit.filter((k) => /抢券成功|领取成功|去使用|已领取/.test(k));
    if (successHits.length) {
      writeState({ claimed: true, pin: cookies.pt_pin, at: nowText(), by: 'click', hit: successHits.join(',') });
      $.log('💾 已记录「今天领过了」，当天不会再领');
    } else {
      $.log('ℹ️ 没看到成功关键词，不写当日状态（下次 cron / 手动跑还可以再试）');
    }

    try { fs.mkdirSync(SHOT_DIR, { recursive: true }); } catch (_) {}
    const shot = path.join(SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    $.log(`🖼️ 截图：${shot}`);

    if (apis.length) $.log(`🌐 接口：${apis.join(' | ')}`);
    $.log(`🏁 结束，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    $.log(`❌ 异常：${e && e.message ? e.message : e}`);
    if (e && e.stack) $.log(e.stack.split('\n').slice(0, 4).join('\n'));
  } finally {
    try { $.done(); } catch (_) {}
  }
})();
