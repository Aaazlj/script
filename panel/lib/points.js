/**
 * 各脚本的积分快照（脚本跑完主动上报）
 *
 * 存 data/points.json：
 *   { updated_at: 1761..., accounts: { "<ref>": { ppcs: {...}, sfsy: {...} } } }
 *
 * key 优先用网关账号 ref；没有 ref 的脚本（顺丰）用网关 openid。
 * 注意别用「小程序自己的 openid」当 key —— 同一微信在朴朴和顺丰里是两串不同的值。
 *
 * 纯展示用：文件丢了最多是面板上不显示积分，不影响签到脚本。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'points.json');
// 账号删了以后这里不会自动清，留个上限防止无限长
const MAX_ACCOUNTS = 500;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data && typeof data === 'object' && data.accounts && typeof data.accounts === 'object') {
      return data;
    }
  } catch (_) { /* 不存在或损坏都当空 */ }
  return { updated_at: 0, accounts: {} };
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** 记录一批上报：script 是脚本 key（ppcs / sfsy），items 里每条要 openid + points */
function report(script, items) {
  const scriptKey = String(script || '').trim().toLowerCase();
  if (!scriptKey) return { updated: 0, total: 0 };

  const now = Math.floor(Date.now() / 1000);
  const data = load();
  const accounts = data.accounts || {};
  let updated = 0;

  for (const item of Array.isArray(items) ? items : []) {
    // ref（网关账号 id）优先：小程序自己的 openid 在朴朴/顺丰里是两套值，对不上账号卡片
    const acctKey = String((item && (item.ref || item.openid)) || '').trim();
    const raw = item && item.points;
    if (!acctKey || raw === '' || raw == null) continue;
    const points = Number(raw);
    if (!Number.isFinite(points)) continue;

    const before = Number(item.before);
    accounts[acctKey] = Object.assign({}, accounts[acctKey], {
      [scriptKey]: {
        points,
        before: Number.isFinite(before) ? before : null,
        at: now,
        ok: item.ok !== false,
        note: String(item.note || '').slice(0, 80),
      },
    });
    updated++;
  }

  const keys = Object.keys(accounts);
  if (keys.length > MAX_ACCOUNTS) {
    for (const k of keys.slice(0, keys.length - MAX_ACCOUNTS)) delete accounts[k];
  }

  data.accounts = accounts;
  if (updated) data.updated_at = now;
  save(data);
  return { updated, total: Object.keys(accounts).length };
}

function summary() {
  return load();
}

module.exports = { report, summary, FILE };
