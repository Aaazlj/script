/**
 * 管理员密码与会话
 *
 * 密码用 scrypt 加盐哈希；会话令牌是 HMAC 签名的过期时间戳，
 * 放在 HttpOnly Cookie 里，服务端无状态校验。
 */

const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'panel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const SCRYPT_KEYLEN = 64;

/* ---------------- 密码 ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), SCRYPT_KEYLEN).toString('hex');
}

function setPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  config.update({ admin: { passwordHash: hash, salt } });
  return true;
}

function verifyPassword(password) {
  const { admin } = config.load();
  if (!admin.passwordHash || !admin.salt) return false;
  const candidate = Buffer.from(hashPassword(password, admin.salt), 'hex');
  const expected = Buffer.from(admin.passwordHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* ---------------- 会话 ---------------- */

function sign(payload) {
  const secret = config.load().admin.sessionSecret;
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueSession() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return '';
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return '';
}

function isValidSession(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let expected;
  try {
    expected = sign(payload);
  } catch (_) {
    return false;
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isLoggedIn(req) {
  return isValidSession(parseCookie(req.headers.cookie, COOKIE_NAME));
}

function sessionCookie(token) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return attrs.join('; ');
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ---------------- 登录限速 ---------------- */

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  rec.count += 1;
}

function clearFailures(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE_NAME,
  setPassword,
  verifyPassword,
  issueSession,
  isLoggedIn,
  sessionCookie,
  clearCookie,
  tooManyAttempts,
  recordFailure,
  clearFailures,
};
