'use strict';
// Server-to-server authentication for the Bridge.
//
// Why this exists: a Campus access token proves WHO the student is, but it is also held by the student's
// browser (HttpOnly cookie, same origin). If the Campus-side Bridge endpoints trusted the token alone, any
// script running in that origin could create a link to an attacker-controlled GovCareer account or pull the
// student's profile. Every Bridge call between the two servers is therefore ALSO signed with a secret that
// only the servers know and that never reaches a browser.
//
//   signature = HMAC-SHA256(secret, `${method}\n${path}\n${accountId}\n${userId}\n${timestamp}\n${bodyHash}`)
//
// In unified mode the parent (GovCareer) generates a per-boot secret when none is configured and passes it to
// the Campus child. Separate deployments must set BRIDGE_SERVICE_SECRET (>= 32 chars) on both sides.
const crypto = require('crypto');

const MAX_SKEW_MS = 2 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function canonical({ method, path, accountId, userId, timestamp, body }) {
  return [String(method).toUpperCase(), path, accountId || '', userId || '', String(timestamp), sha256(body || '')].join('\n');
}
function sign(secret, parts) {
  return crypto.createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}
function headersFor(secret, parts) {
  const timestamp = Date.now();
  return {
    'x-bridge-timestamp': String(timestamp),
    'x-bridge-account': parts.accountId ? String(parts.accountId) : '',
    'x-bridge-signature': sign(secret, { ...parts, timestamp }),
  };
}
// Returns { ok:true } or { ok:false, code, message }.
function verify(secret, parts, headers, now = Date.now()) {
  if (!secret || String(secret).length < 32) return { ok: false, code: 'BRIDGE_NOT_CONFIGURED', message: 'Bridge service secret is not configured.' };
  const ts = Number(headers['x-bridge-timestamp']);
  const sig = String(headers['x-bridge-signature'] || '');
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, code: 'BRIDGE_STALE', message: 'Bridge request timestamp is missing or too old.' };
  const expected = sign(secret, { ...parts, timestamp: ts });
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 'BRIDGE_BAD_SIGNATURE', message: 'Bridge request signature is invalid.' };
  return { ok: true };
}
function newSecret() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { sign, headersFor, verify, newSecret, canonical, MAX_SKEW_MS };
