'use strict';

/**
 * 京东扫码登录（获取 pt_key / pt_pin）
 *
 * 为什么用浏览器：京东换 pt_key 需要 __jda / eid（3AB9D23F7A4B3C9B）这两个
 * 设备指纹，它们由登录页里的 JS SDK 执行后生成，纯 HTTP 请求造不出来 ——
 * 实测「二维码 → ticket」都能拿到，但带着 ticket 去 qrCodeLogin 永远不下发
 * Set-Cookie，直到换成真实浏览器页面才行。
 *
 * 流程：开无头 chromium → 打开 passport.jd.com 登录页（默认就是扫码 tab）
 *      → 截二维码给人扫 → 页面自己完成换取 → 从浏览器 cookie 里取 pt_key。
 */

const fs = require('fs');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium-browser';
const LOGIN_URL = 'https://passport.jd.com/new/login.aspx';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/144.0.0.0 Safari/537.36';

// 服务器在海外，京东登录页资源全在国内，直连要 60s+ 才渲染出二维码，
// 而二维码只有 2 分钟有效期。走国内出口（树脂）后能压到 10s 内。
const PROXY_URL = process.env.JD_PROXY || '';
const PROXY_AUTH = process.env.JD_PROXY_AUTH || '';   // 形如 user:pass

/** 扫码会话最长存活时间（毫秒），超时由调用方关闭 */
const SESSION_TTL = 5 * 60 * 1000;
/** 页面里哪个 img 是二维码：实测是 img13.360buyimg.com/imagetools/... 且 naturalWidth≈147 */
const QR_PICK = `
  const imgs = [...document.querySelectorAll('img')];
  const isQr = (el) => {
    const s = String(el.src || '');
    return s.includes('360buyimg.com') && !/logo/i.test(s)
      && el.complete && el.naturalWidth >= 140 && el.naturalWidth <= 165;
  };
  const img = imgs.find(isQr) || null;
`;


let pptr = null;
let pptrErr = '';

function loadPuppeteer() {
  if (pptr) return pptr;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    pptr = require('puppeteer-core');
  } catch (e) {
    pptrErr = e.message;
    pptr = null;
  }
  return pptr;
}

function chromeReady() {
  return Boolean(loadPuppeteer()) && fs.existsSync(CHROME_PATH);
}

/** 1) 开浏览器 + 打开登录页 + 截二维码 */
async function createSession() {
  if (!loadPuppeteer()) return { ok: false, error: `puppeteer-core 未安装：${pptrErr}` };
  if (!fs.existsSync(CHROME_PATH)) return { ok: false, error: `找不到 chromium：${CHROME_PATH}` };

  const args = [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox',
    '--no-zygote', '--disable-accelerated-2d-canvas', '--js-flags=--max-old-space-size=256',
  ];
  if (PROXY_URL) args.push(`--proxy-server=${PROXY_URL}`);

  const browser = await pptr.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args,
  });

  try {
    const page = await browser.newPage();
    if (PROXY_URL && PROXY_AUTH) {
      const [username, ...rest] = PROXY_AUTH.split(':');
      await page.authenticate({ username, password: rest.join(':') }).catch(() => {});
    }
    await page.setUserAgent(UA);

    // 捕获页面加载到的真二维码（qr.m.jd.com/show 返回的 PNG）
    let qrFromResponse = '';
    page.on('response', async (r) => {
      try {
        const u = r.url();
        if (!u.includes('qr.m.jd.com/show')) return;
        if (r.status() !== 200) return;
        const buf = await r.buffer();
        if (buf && buf.length > 500) qrFromResponse = buf.toString('base64');
      } catch (_) { /* ignore */ }
    });
    await page.setViewport({ width: 420, height: 760, deviceScaleFactor: 2, isMobile: false });

    try {
      // 这页几十个 JS，domcontentloaded 通常 40~60s；commit 又太早（白屏）。
      // 实证：直连京东 1.1s 就有响应，慢在页面资源，只能等它渲染完。
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 75000 });
    } catch (_) { /* 超时也继续 */ }

    // 关键：页面是 JS 渲染的，commit 时还是白屏。必须等二维码 img 真正渲染出来
    // （src 含 qr.m.jd.com 且 complete && naturalWidth>50），否则会截到白图。
    try {
      await page.waitForFunction(() => {
        const imgs = [...document.querySelectorAll('img')];
        return imgs.some((el) => {
          const s = String(el.src || '');
          return s.includes('360buyimg.com') && !/logo/i.test(s)
            && el.complete && el.naturalWidth >= 140 && el.naturalWidth <= 165;
        });
      }, { timeout: 45000, polling: 500 });
    } catch (_) {
      const shot = await page.screenshot({ encoding: 'base64' }).catch(() => '');
      return { ok: false, error: '等了 45 秒二维码还没渲染出来（页面可能被拦截或加载失败）', debugImage: shot };
    }

    const target = await page.evaluateHandle(() => {
      const imgs = [...document.querySelectorAll('img')];
      return imgs.find((el) => {
        const s = String(el.src || '');
        return s.includes('360buyimg.com') && !/logo/i.test(s)
          && el.complete && el.naturalWidth >= 140 && el.naturalWidth <= 165;
      }) || null;
    });

    // 关键：等图片真正加载完。domcontentloaded 时 img 往往还是占位/空图，
    // 这时候截出来的码扫了会提示「二维码无效」——页面其实早换成新码了。
    if (target) {
      try {
        await page.waitForFunction(() => {
          const img = document.querySelector('img[src*="qr.m.jd.com"], #qr-img, .qrcode-img, img.qrcode');
          return Boolean(img && img.complete && img.naturalWidth > 50);
        }, { timeout: 12000 });
      } catch (_) {
        // 等不到就用当前状态截，至少不是空白页
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 关键：真二维码是页面 JS 动态请求 qr.m.jd.com/show 拿到的（每次带新 t 参数），
    // 页面上那张 img13.360buyimg.com/147px 的图只是「扫码登录」静态占位图 ——
    // 之前一直截它，用户扫了当然一直是 201（未扫描）。
    // 改为监听页面对 qr.m.jd.com/show 的响应，直接拿页面真正在用的那张码。
    let image = qrFromResponse;
    let fallback = false;

    if (!image) {
      for (let i = 0; i < 60 && !image; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        image = qrFromResponse;
      }
    }

    if (!image) {
      image = await page.screenshot({ encoding: 'base64' }).catch(() => '');
      fallback = true;
    }

    return { ok: true, browser, page, image, fallback, createdAt: Date.now() };
  } catch (e) {
    try { await browser.close(); } catch (_) { /* ignore */ }
    return { ok: false, error: `打开登录页失败：${e.message}` };
  }
}

/** 2) 查状态：从浏览器 cookie 判断有没有拿到 pt_key */
async function poll(session) {
  if (!session || !session.page) return { code: -1, msg: '会话无效' };

  let cookies = [];
  try { cookies = await session.page.cookies(); } catch (_) { /* ignore */ }

  const key = cookies.find((c) => c.name === 'pt_key' && c.value);
  const pin = cookies.find((c) => c.name === 'pt_pin' && c.value);
  if (key && pin) {
    const ptPin = decodeURIComponent(pin.value);
    return {
      code: 200,
      pt_key: key.value,
      pt_pin: ptPin,
      cookie: `pt_key=${key.value};pt_pin=${pin.value};`,
    };
  }

  // 没拿到就根据页面文案判断阶段
  let text = '';
  try {
    text = await session.page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ''));
  } catch (_) { /* ignore */ }

  if (/二维码已失效|二维码已过期|请点击刷新|重新获取/.test(text)) return { code: 203, msg: '二维码已过期，请重新生成' };
  if (/扫描成功|请在手机|已扫描/.test(text)) return { code: 202, msg: '已扫码，等待手机确认' };
  return { code: 201, msg: '二维码未扫描' };
}

/** 3) 关浏览器 */
async function close(session) {
  if (!session || !session.browser) return;
  try { await session.browser.close(); } catch (_) { /* ignore */ }
}

module.exports = { createSession, poll, close, chromeReady, SESSION_TTL, CHROME_PATH };
