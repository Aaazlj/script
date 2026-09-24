/**
 * 配置读写
 *
 * 全部落在 data/config.json（0600），包含管理员密码哈希、会话签名密钥、
 * 青龙面板凭据。首次启动时自动生成会话密钥。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.PANEL_DATA_DIR
  ? path.resolve(process.env.PANEL_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  admin: {
    passwordHash: '',
    salt: '',
    sessionSecret: '',
  },
  qinglong: {
    // 容器里默认走 compose 内网的服务名；面板后台可随时改
    host: process.env.PANEL_QINGLONG_HOST || '',
    clientId: '',
    clientSecret: '',
  },
  yyb: {
    // yyb_go 网关地址，面板服务端调它拿二维码
    baseUrl: process.env.PANEL_YYB_BASE_URL || 'http://127.0.0.1:8000',
    // 扫码成功后写进青龙 yyb_server 的地址；留空则用 baseUrl（并把 0.0.0.0/127.0.0.1 换成面板访问地址的 host）
    publicBaseUrl: process.env.PANEL_YYB_PUBLIC_BASE_URL || '',
  },
  meituan: {
    // 官方专家包 run.js 的绝对路径；留空则自动探测
    runJs: process.env.MT_RUN_JS || '',
    aiScene: process.env.MT_AI_SCENE || '',
  },
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function merge(base, patch) {
  const out = clone(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(out[key] && typeof out[key] === 'object' ? out[key] : {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (_) { /* 文件不存在或损坏，用默认值 */ }

  const cfg = merge(DEFAULTS, parsed);
  let dirty = false;
  if (!cfg.admin.sessionSecret) {
    cfg.admin.sessionSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (!path.isAbsolute(cfg.yyb.baseUrl) && !/^https?:\/\//i.test(cfg.yyb.baseUrl)) {
    cfg.yyb.baseUrl = DEFAULTS.yyb.baseUrl;
    dirty = true;
  }
  if (dirty) save(cfg);
  return cfg;
}

function save(cfg) {
  ensureDataDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  return cfg;
}

/** 深合并写入（用于后台保存配置） */
function update(patch) {
  return save(merge(load(), patch));
}

function isAdminConfigured() {
  return Boolean(load().admin.passwordHash);
}

/** 去掉 yyb_go 地址末尾的斜杠，避免拼出 //qr */
function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  DEFAULTS,
  load,
  save,
  update,
  isAdminConfigured,
  trimBase,
};
