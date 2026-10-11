// Admin accounts: scrypt password hashes, opaque bearer sessions (stored hashed), roles, login throttling.
const crypto = require('crypto');
const db = require('./db');
const { audit } = require('./audit');

const ROLES = { ADMIN: 3, REVIEWER: 2, VIEWER: 1 };
const SESSION_HOURS = 8;

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function checkPassword(pw, stored) {
  const [, salt, h] = stored.split('$');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createUser(email, name, password, role) {
  if (!ROLES[role]) throw new Error('Unknown role');
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters');
  const r = await db.query('INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,email,name,role',
    [email.toLowerCase(), name, hashPassword(password), role]);
  await audit('system:auth', 'USER_CREATED', 'user', r.rows[0].id, { email, role });
  return r.rows[0];
}

const attempts = new Map(); // key -> [timestamps]
function throttled(key, now = Date.now()) {
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 5;
}
function noteFailure(key, now = Date.now()) { attempts.set(key, [...(attempts.get(key) || []), now]); }

async function login(email, password, ip = 'unknown') {
  const key = `${ip}|${String(email).toLowerCase()}`;
  if (throttled(key)) { const e = new Error('Too many attempts. Try again in 15 minutes.'); e.status = 429; throw e; }
  const u = (await db.query('SELECT * FROM users WHERE email=$1 AND active', [String(email).toLowerCase()])).rows[0];
  if (!u || !checkPassword(String(password), u.password_hash)) {
    noteFailure(key); await audit('anonymous', 'LOGIN_FAILED', 'user', null, { email, ip });
    const e = new Error('Email or password is incorrect.'); e.status = 401; throw e;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now() + ($3 || \' hours\')::interval)', [sha(token), u.id, String(SESSION_HOURS)]);
  await audit(`human:${u.email}`, 'LOGIN', 'user', u.id, { ip });
  return { token, user: { id: u.id, email: u.email, name: u.name, role: u.role } };
}

async function userFromToken(token) {
  if (!token) return null;
  const r = await db.query('SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active', [sha(token)]);
  return r.rows[0] || null;
}
async function logout(token) { await db.query('DELETE FROM sessions WHERE token_hash=$1', [sha(token)]); }

// Express middleware factory
function requireRole(min) {
  return async (req, res, next) => {
    try {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
      const user = await userFromToken(m && m[1]);
      if (!user) return res.status(401).json({ error: 'Sign in required.' });
      if (ROLES[user.role] < ROLES[min]) return res.status(403).json({ error: 'Your role cannot do this.' });
      req.user = user; req.token = m[1]; next();
    } catch (e) { next(e); }
  };
}

module.exports = { ROLES, createUser, login, logout, userFromToken, requireRole, hashPassword, checkPassword };
