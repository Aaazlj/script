/*
------------------------------------------
@Author: Aaa
@Date: 2026.09.12
@Description: 美团优惠券自动领取
cron: 0 10 * * *
------------------------------------------
环境变量：
MT_TOKEN        必填，美团登录 Token，多账号使用 # 或换行分隔
MT_TOKEN_FILE   可选，Token 文件路径
MT_PUSH_URL     可选，自定义推送地址（POST {title, content}）
MT_MAX_COUPONS  可选，通知最多展示几张券，默认 8
------------------------------------------
获取 Token：仓库内 token-web/ 目录提供扫码登录服务
           node token-web/server.js → http://127.0.0.1:5178
------------------------------------------
*/

const https = require('https');
const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = '美团自动领券';
const API_URL = 'https://media.meituan.com/fulishemini/couponActivity/sendCouponWork';
const TIMEOUT_MS = 20000;
const MAX_COUPONS = Number(process.env.MT_MAX_COUPONS || 8) || 8;

/* ============ 运行环境：青龙 Env + 本地兜底 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 注意：青龙靠扫描 Env 构造参数里的【字符串字面量】取任务名，
      // 这里必须写字面量，不能传 SCRIPT_NAME 变量（否则任务名会变成 "SCRIPT_NAME"）
      return new Env('美团自动领券');
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

/* ============ Token 获取 ============ */

function readTokenFile() {
  const candidates = [
    process.env.MT_TOKEN_FILE,
    path.join(__dirname, 'mt_token.txt'),
    path.join(__dirname, 'data', 'mt_token.txt'),
    path.join(__dirname, 'token-web', 'data', 'mt_token.txt'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
        // 兼容纯 token、MT_TOKEN=xxx、export MT_TOKEN=xxx 三种写法
        const matched = text.match(/(?:^|\n)(?:export\s+)?MT_TOKEN\s*=\s*(.+)/);
        const value = (matched ? matched[1] : text).trim();
        if (value) return { token: value, from: file };
      }
    } catch (_) { /* 继续尝试下一个 */ }
  }
  return null;
}

function getTokens() {
  const fromEnv = (process.env.MT_TOKEN || '').trim();
  if (fromEnv) {
    return fromEnv.split(/[\n#]+/).map((s) => s.trim()).filter(Boolean);
  }
  const file = readTokenFile();
  if (file) {
    $.log(`[提示] 从文件读取 token：${file.from}`);
    return file.token.split(/[\n#]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/* ============ 网络请求 ============ */

function sendCoupon(token) {
  const body = Buffer.from(JSON.stringify({ token, aiScene: '', version: 2 }), 'utf8');
  const parsed = new URL(API_URL);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ http: res.statusCode, data: JSON.parse(raw) });
          } catch (_) {
            resolve({ http: res.statusCode, data: null, raw: raw.slice(0, 200) });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ http: 0, data: null, error: e.message }));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ http: 0, data: null, error: 'TIMEOUT' });
    });
    req.write(body);
    req.end();
  });
}

/* ============ 结果格式化 ============ */

const TAB_ORDER = ['外卖', '美食团购', '美团闪购', '休闲娱乐', '生活服务', '丽人医疗', '更多福利'];
const TAB_DISPLAY = { '更多福利': '其他' };

const fenToYuan = (fen) => {
  const yuan = Number(fen || 0) / 100;
  return yuan === Math.floor(yuan) ? String(Math.floor(yuan)) : yuan.toFixed(1);
};

const fmtDate = (ms) => {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function formatCoupon(c) {
  const discount = Number(c.priceLimit) > 0
    ? `满${fenToYuan(c.priceLimit)}元减${fenToYuan(c.couponValue)}元`
    : '无门槛';
  const period = c.couponStartTime && c.couponEndTime
    ? `${fmtDate(c.couponStartTime)} 至 ${fmtDate(c.couponEndTime)}`
    : '-';
  return {
    name: c.couponName || '',
    discount,
    period,
    tab: c.tabName || '',
    value: Number(c.couponValue || 0),
    limit: Number(c.priceLimit || 0),
  };
}

function countStr(list) {
  const counter = {};
  list.forEach((c) => (counter[c.tab] = (counter[c.tab] || 0) + 1));
  const tabs = TAB_ORDER.concat(Object.keys(counter).filter((t) => !TAB_ORDER.includes(t)));
  return tabs
    .filter((t) => counter[t])
    .map((t) => `${TAB_DISPLAY[t] || t}优惠券${counter[t]}张`)
    .join('、');
}

function pickDisplay(list) {
  const ratio = (c) => (c.limit > 0 ? c.value / c.limit : 1);
  return [...list].sort((a, b) => ratio(b) - ratio(a) || b.value - a.value).slice(0, MAX_COUPONS);
}

function renderSection(title, list) {
  const lines = [title];
  if (!list.length) {
    lines.push('  本次没有拿到券');
    return lines.join('\n');
  }
  lines.push(`  共 ${list.length} 张：${countStr(list)}`);
  pickDisplay(list).forEach((c, i) => {
    lines.push(`  ${i + 1}. [${c.tab}] ${c.name} | ${c.discount} | ${c.period}`);
  });
  return lines.join('\n');
}

/* ============ 通知 ============ */

async function pushByWebhook(title, content) {
  const url = process.env.MT_PUSH_URL;
  if (!url) return false;
  const body = Buffer.from(JSON.stringify({ title, content }), 'utf8');
  try {
    await new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => { res.resume(); resolve(res.statusCode); }
      );
      req.on('error', reject);
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('TIMEOUT')));
      req.write(body);
      req.end();
    });
    return true;
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
  if (!sent) sent = await pushByWebhook(title, content);      // 自定义 webhook 优先
  if (!sent && typeof $.msg === 'function') {                 // 其次用青龙面板的通知配置
    try { await $.msg(title, content); sent = true; }
    catch (e) { $.log(`[推送] $.msg 调用失败：${e.message}`); }
  }
  if (!sent) sent = await pushBySendNotify(title, content);   // 最后用 sendNotify
  if (!sent) $.log('[推送] 未配置推送，结果仅输出日志');
}

/* ============ 主流程 ============ */

!(async () => {
  const tokens = getTokens();
  if (!tokens.length) {
    $.log('未找到 MT_TOKEN，请先配置 token（可用仓库内 token-web 扫码获取）');
    $.done();
    return;
  }

  const sections = [];
  let anySuccess = false;

  for (let i = 0; i < tokens.length; i++) {
    const masked = tokens[i].length > 8 ? `${tokens[i].slice(0, 8)}****` : tokens[i];
    $.log(`\n账号 ${i + 1}/${tokens.length} (${masked}) 开始领券…`);

    const resp = await sendCoupon(tokens[i]);
    const title = `账号 ${i + 1} 领券结果`;

    if (resp.http === 0 || !resp.data) {
      const reason = resp.error || resp.raw || '未知网络错误';
      sections.push(`${title}\n  请求失败：${reason}`);
      $.log(`  请求失败：${reason}`);
      continue;
    }

    const { code, msg, data } = resp.data;

    if (code === 200) {
      const list = (data.couponList || []).map(formatCoupon);
      anySuccess = true;
      const section = renderSection(title, list);
      $.log(section);
      sections.push(section);
    } else if (code === 1014) {
      sections.push(`${title}\n  今天已领取过（code 1014：${msg || '已领取'}）`);
      $.log(`  今天已领取过（${msg || '已领取'}）`);
    } else if (code === 401) {
      sections.push(`${title}\n  token 已失效，请用 token-web 重新扫码登录`);
      $.log('  token 已失效，请重新扫码获取');
    } else if (code === 509 || code === 50200) {
      sections.push(`${title}\n  请求过于频繁（code ${code}）`);
      $.log('  请求过于频繁');
    } else {
      sections.push(`${title}\n  未知错误 code=${code} msg=${msg || '-'}`);
      $.log(`  未知错误 code=${code} msg=${msg || '-'}`);
    }

    if (i < tokens.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  await push(anySuccess ? '🎉 美团优惠券领取完成' : '美团优惠券领取结果', sections.join('\n\n'));
  $.done();
})();
