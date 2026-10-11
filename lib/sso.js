// Single sign-on: the Campus login is the ONLY login screen. GovCareer trusts the Campus session
// (HttpOnly cp_access cookie) by asking the Campus service who it belongs to, then maps that person
// to a GovCareer citizen account. No password is ever shared or duplicated.
const crypto = require('crypto');
const http = require('http');
const db = require('./db');
const { hashPassword } = require('./auth');
const { audit } = require('./audit');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const CAMPUS_PORT = () => Number(process.env.CAMPUS_PORT || 3101);
const cache = new Map(); // cookie-hash -> {user, exp}

function campusEnabled() { return process.env.DISABLE_CAMPUS_PORTAL !== '1'; }
function cookieOf(header, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(String(header || ''));
  return m ? m[1] : '';
}
// Resolve the Campus session behind a Cookie/Authorization header. Returns {id,email,name,role} or null.
function campusUser(cookieHeader, authHeader) {
  const access = cookieOf(cookieHeader, 'cp_access');
  const bearer = /^Bearer (.+)$/.exec(authHeader || '');
  if (!access && !bearer) return Promise.resolve(null); // no Campus credentials at all
  const key = sha(access || bearer[1]);
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.user);
  return new Promise(resolve => {
    const headers = access ? { cookie: 'cp_access=' + access } : { authorization: 'Bearer ' + bearer[1] };
    const req = http.request({ hostname: '127.0.0.1', port: CAMPUS_PORT(), path: '/api/auth/me', method: 'GET', headers, timeout: 4000 }, r => {
      let body = ''; r.setEncoding('utf8'); r.on('data', c => { if (body.length < 65536) body += c; });
      r.on('end', () => {
        let user = null;
        try { const u = JSON.parse(body).user; if (r.statusCode === 200 && u && u.email) user = { id: String(u.id), email: String(u.email).toLowerCase(), name: u.name || u.email, role: String(u.role || 'student').toLowerCase() }; } catch (_) {}
        if (cache.size > 500) cache.clear();
        cache.set(key, { user, exp: Date.now() + (user ? 20000 : 3000) });
        resolve(user);
      });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(undefined)); req.end(); // undefined = Campus unreachable (unknown), null = definitely signed out
  });
}
// Exchange a verified Campus identity for a GovCareer bearer token. First use needs one explicit consent.
async function exchange(user, { consent = false } = {}) {
  const consentVersion = process.env.PRIVACY_POLICY_VERSION || '2026-10';
  let acct = (await db.query('SELECT id,email,name,consent_version,active FROM citizen_accounts WHERE email=$1', [user.email])).rows[0];
  if (acct && !acct.active) throw Object.assign(new Error('This GovCareer account was closed (consent withdrawn).'), { status: 403 });
  if (!acct) {
    if (consent !== true) return { needsConsent: true, user: { email: user.email, name: user.name }, policy_version: consentVersion };
    const pw = await hashPassword(crypto.randomBytes(32).toString('hex')); // unusable: login only via Campus
    acct = (await db.query('INSERT INTO citizen_accounts(email,name,password_hash,consent_version,consented_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(email) DO UPDATE SET updated_at=now() RETURNING id,email,name,consent_version', [user.email, String(user.name).slice(0, 120), pw, consentVersion])).rows[0];
    await db.query("INSERT INTO consent_events(account_id,version,action) VALUES($1,$2,'GRANTED')", [acct.id, consentVersion]);
    await audit('citizen:' + user.email, 'CITIZEN_ACCOUNT_CREATED_VIA_CAMPUS_SSO', 'citizen_account', acct.id, { consentVersion });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await db.query("INSERT INTO citizen_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [sha(token), acct.id]);
  return { token, user: { id: acct.id, email: acct.email, name: acct.name, consent_version: acct.consent_version, role: user.role, sso: 'campus' } };
}
module.exports = { campusUser, exchange, cookieOf, campusEnabled };
