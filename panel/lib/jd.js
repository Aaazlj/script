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
    await page.setViewport({ width: 420, height: 760, deviceScaleFactor: 2, isMobile: false });

    // 服务器在海外，京东登录页有几十个第三方资源（统计/字体/图标），全加载要 60s+。
    // 只放行「登录页本身 + 京东 CDN 的图」，其余直接 abort，能压到 10s 内。
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      const keep = /^https?:\/\/passport\.jd\.com\//.test(u)
        || /^https?:\/\/(img\d*|misc|storage\d*)\.360buyimg\.com\//.test(u)
        || /^https?:\/\/storage\.jd\.com\//.test(u)
        || /^https?:\/\/qr\.m\.jd\.com\//.test(u)
        || req.resourceType() === 'document';
      if (keep) req.continue().catch(() => {});
      else req.abort().catch(() => {});
    });

    try {
      // commit：导航一开始就返回，不等资源加载（这页几十个 JS，等完要 40s+）
      await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 20000 });
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
      }, { timeout: 35000, polling: 500 });
    } catch (_) {
      const shot = await page.screenshot({ encoding: 'base64' }).catch(() => '');
      return { ok: false, error: '等了 35 秒二维码还没渲染出来（页面可能被拦截或加载失败）', debugImage: shot };
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

    let image = '';
    let fallback = false;

    // 优先：直接读 img.src，用页面内 fetch 取图。
    // 为什么不用截图：京东登录页每 60s 自动换一张码，截图耗时 + 传输延迟下来，
    // 用户拿到手时页面早换过一轮了（扫了提示「二维码无效」，poll 却还是 201）。
    // 走 img.src 拿到的是「页面此刻正在显示的那张」，和页面严格一致。
    if (target) {
      // 先看 img.src 是什么形态
      const srcInfo = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')];
        const img = imgs.find((el) => {
          const s = String(el.src || '');
          return s.includes('360buyimg.com') && !/logo/i.test(s)
            && el.complete && el.naturalWidth >= 140 && el.naturalWidth <= 165;
        });
        return img ? { src: String(img.src || '').slice(0, 100), len: String(img.src || '').length } : null;
      }).catch(() => null);
      console.log('[jd] qr img src:', JSON.stringify(srcInfo));

      try {
        image = await page.evaluate(async () => {
          const imgs = [...document.querySelectorAll('img')];
          const img = imgs.find((el) => {
            const s = String(el.src || '');
            return s.includes('360buyimg.com') && !/logo/i.test(s)
              && el.complete && el.naturalWidth >= 140 && el.naturalWidth <= 165;
          });
          if (!img) return '';
          const src = String(img.src || '');
          // data: URL 直接切出 base64
          if (src.startsWith('data:image')) {
            const i = src.indexOf(',');
            return i > 0 ? src.slice(i + 1) : '';
          }
          // 普通 URL：页面内 fetch（带 cookie），保证和页面当前显示的一致
          const r = await fetch(src, { credentials: 'include' });
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
          return btoa(bin);
        });
      } catch (e) {
        console.log('[jd] img.src 取图失败:', e.message);
        image = '';
      }

      // fetch 拿不到就退回元素截图（比整页截图准）
      if (!image) {
        try { image = await target.asElement().screenshot({ encoding: 'base64' }); } catch (_) { image = ''; }
      }
    }

    if (!image) {
      // 兜底：整页截图，让人自己找二维码
      image = await page.screenshot({ encoding: 'base64' });
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
