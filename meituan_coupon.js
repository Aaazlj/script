/*
------------------------------------------
@Author: Aaa
@Date: 2026.09.13
@Description: 美团优惠券自动领取（含当日券明细缓存回放）
cron: 0 10 * * *
------------------------------------------
环境变量：
MT_TOKEN        必填，美团登录 Token，多账号使用 # 或换行分隔
MT_TOKEN_FILE   可选，Token 文件路径
                 默认依次尝试 mt_token.txt / data/mt_token.txt / token-web/data/mt_token.txt
MT_PUSH_URL     可选，自定义推送地址（POST {title, content}）
MT_MAX_COUPONS  可选，通知最多展示几张券，默认 8
MT_CACHE_FILE   可选，当日券缓存路径，默认 data/mt_coupons_cache.json
------------------------------------------
重要：
  每天限领一次。当天已领过时，接口只返回 code 1014，couponList 为空，
  不会带任何券数据。所以脚本在【真正领到券】的那次把明细写入本地缓存，
  之后再跑（1014）就从缓存回放，跨天自动失效。
------------------------------------------
获取 Token：仓库内 token-web/ 目录提供扫码登录服务
           node token-web/server.js → http://127.0.0.1:5178
------------------------------------------
*/

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_URL = 'https://media.meituan.com/fulishemini/couponActivity/sendCouponWork';
const TIMEOUT_MS = 20000;
const MAX_COUPONS = Number(process.env.MT_MAX_COUPONS || 8) || 8;

/* ============ 运行环境：青龙 Env + 本地兜底 ============ */

const IN_QINGLONG = typeof Env === 'function';

const $ = (() => {
  if (IN_QINGLONG) {
    try {
      // 注意：青龙靠扫描 Env 构造参数里的【字符串字面量】取任务名，
      // 这里必须写字面量，不能传变量（否则任务名会变成变量名）
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

const maskToken = (t) => (t.length > 8 ? `${t.slice(0, 8)}****` : t);
const tokenKey = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);

/* ============ 当日券缓存（跨天自动失效） ============ */

const CACHE_FILE = process.env.MT_CACHE_FILE || path.join(__dirname, 'data', 'mt_coupons_cache.json');

function localDateStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadCache(token) {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const all = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const entry = all[tokenKey(token)];
    if (entry && entry.date === localDateStr()) return entry.data;
  } catch (_) { /* 缓存损坏就当没有 */ }
  return null;
}

function saveCache(token, data) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (_) {}
    all[tokenKey(token)] = { date: localDateStr(), data };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    $.log(`[提示] 券缓存写入失败（不影响领券）：${e.message}`);
  }
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
const SLOT_PLAN_BASE = [['外卖', 2], ['美食团购', 1], ['美团闪购', 1],
                        ['休闲娱乐', 1], ['生活服务', 1], ['丽人医疗', 1]];

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
  const limit = Number(c.priceLimit || 0);
  const value = Number(c.couponValue || 0);
  const discount = limit > 0 ? `满${fenToYuan(limit)}元减${fenToYuan(value)}元` : '无门槛';
  const period = c.couponStartTime && c.couponEndTime
    ? `${fmtDate(c.couponStartTime)} 至 ${fmtDate(c.couponEndTime)}`
    : '-';
  return { name: c.couponName || '', discount, period, tab: c.tabName || '', value, limit };
}

function buildCountStr(list) {
  const counter = {};
  list.forEach((c) => (counter[c.tab] = (counter[c.tab] || 0) + 1));
  const unknown = Object.keys(counter).filter((t) => !TAB_ORDER.includes(t));
  const order = TAB_ORDER.slice(0, 6).concat(unknown, TAB_ORDER.slice(6));
  return order
    .filter((t) => counter[t])
    .map((t) => `${TAB_DISPLAY[t] || t}优惠券${counter[t]}张`)
    .join('、');
}

// 分类配额挑选，保证每个品类都有代表，避免全被外卖券占满
function pickDisplay(list) {
  const ratio = (c) => (c.limit > 0 ? [1, -(c.value / c.limit)] : [0, 0]);
  const cmp = (a, b) => {
    const ka = ratio(a);
    const kb = ratio(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  };

  const groups = {};
  list.forEach((c) => (groups[c.tab] = groups[c.tab] || []).push(c));
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
    const token = tokens[i];
    const title = `账号 ${i + 1} 领券结果`;
    $.log(`\n账号 ${i + 1}/${tokens.length} (${maskToken(token)}) 开始领券…`);

    const resp = await sendCoupon(token);

    if (resp.http === 0 || !resp.data) {
      const reason = resp.error || resp.raw || '未知网络错误';
      sections.push(`${title}\n  请求失败：${reason}`);
      $.log(`  ✖ 请求失败：${reason}`);
    } else {
      const { code, msg, data } = resp.data;

      if (code === 200) {
        const list = ((data && data.couponList) || []).map(formatCoupon);
        anySuccess = true;
        const summary = buildCountStr(list);
        saveCache(token, { count: list.length, count_str: summary, coupons: list });

        $.log(`  ✅ 领取成功，本次共领取 ${list.length} 张美团优惠券，包括${summary}！`);
        $.log(renderList(list));
        sections.push(`✅ 领取成功，共 ${list.length} 张\n  包括${summary}\n\n${renderList(list)}`);
      } else if (code === 1014) {
        // 接口在已领状态下不返回券数据，优先用本地当日缓存回放
        const cached = loadCache(token);
        if (cached) {
          $.log(`  ℹ️ 今天已领取过，以下是今日已领券明细（本地缓存）：`);
          $.log(renderList(cached.coupons || []));
          sections.push(`ℹ️ 今天已领取过（每天限领一次），今日已领 ${cached.count} 张\n  包括${cached.count_str}\n\n${renderList(cached.coupons || [])}`);
        } else {
          const tip = '今天已领取过，但本地没有今天的券明细（可能是在美团 App 或其它工具领的）。'
            + '下次真正领到券时脚本会自动记录，之后即可回放。';
          $.log(`  ℹ️ ${tip}`);
          sections.push(`${title}\n  ${tip}`);
        }
      } else if (code === 401) {
        $.log('  🔑 token 已失效，请用 token-web 重新扫码登录');
        sections.push(`${title}\n  🔑 token 已失效，请用 token-web 重新扫码登录`);
      } else if (code === 509 || code === 50200) {
        $.log(`  ⏳ 请求过于频繁（code ${code}），请稍后重试`);
        sections.push(`${title}\n  ⏳ 请求过于频繁（code ${code}）`);
      } else {
        const reason = code === 9999 ? '系统异常，请稍后重试' : `未知错误 code=${code} msg=${msg || '-'}`;
        $.log(`  ✖ ${reason}`);
        sections.push(`${title}\n  ✖ ${reason}`);
      }
    }

    if (i < tokens.length - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  await push(anySuccess ? '🎉 美团优惠券领取完成' : '美团优惠券领取结果', sections.join('\n\n'));
  $.done();
})();
