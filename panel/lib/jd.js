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

/** 扫码会话最长存活时间（毫秒），超时由调用方关闭 */
const SESSION_TTL = 5 * 60 * 1000;

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

  const browser = await pptr.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox',
      '--no-zygote', '--disable-accelerated-2d-canvas', '--js-flags=--max-old-space-size=256',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 420, height: 760, deviceScaleFactor: 2, isMobile: false });

    try {
      // 用 domcontentloaded 而不是 networkidle2：登录页本身一直在轮询二维码状态，
      // networkidle 永远等不到，会白等 45s 超时（二维码有效期才 2 分钟，耗不起）。
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (_) { /* 超时也继续，下面直接找二维码 */ }

    // 等二维码元素出现（京东是 img[src*="qr.m.jd.com/show"]）
    let target = null;
    for (let i = 0; i < 20; i += 1) {
      /* eslint-disable no-await-in-loop */
      target = await page.$('img[src*="qr.m.jd.com"], #qr-img, .qrcode-img, img.qrcode');
      if (target) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    let image;
    let fallback = false;
    if (target) {
      image = await target.screenshot({ encoding: 'base64' });
    } else {
      // 找不到就整页截一张，让人自己找二维码
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
