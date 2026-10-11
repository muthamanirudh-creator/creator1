'use strict';
// GovCareer -> Campus server-to-server client.
//
// The browser talks to GovCareer only. For linked students GovCareer forwards the student's own Campus access
// token (read from the same-origin HttpOnly `cp_access` cookie) to the internal Campus service together with an
// HMAC signature (see serviceAuth.js). Campus therefore checks BOTH who the student is and that the call really
// came from the GovCareer server acting for the named GovCareer account.
const http = require('http');
const serviceAuth = require('./serviceAuth');

const cfg = () => ({
  host: process.env.CAMPUS_HOST || '127.0.0.1',
  port: Number(process.env.CAMPUS_PORT || 3101),
  secret: String(process.env.BRIDGE_SERVICE_SECRET || ''),
  timeout: Number(process.env.BRIDGE_CAMPUS_TIMEOUT_MS || 8000),
  disabled: process.env.DISABLE_CAMPUS_PORTAL === '1' && !process.env.CAMPUS_HOST,
});

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); } }
  }
  return null;
}
// Unverified decode: Campus verifies the signature; we only need `sub` to bind the HMAC to that user.
function subjectOf(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).sub || null; } catch { return null; }
}

function request({ method, path, token, accountId, body }) {
  const c = cfg();
  if (c.disabled) return Promise.resolve({ status: 503, body: { error: 'Campus portal is not running in this deployment.', code: 'CAMPUS_UNAVAILABLE' } });
  if (!token) return Promise.resolve({ status: 401, body: { error: 'Sign in to the Campus portal first.', code: 'CAMPUS_SESSION_REQUIRED' } });
  const userId = subjectOf(token);
  if (!userId) return Promise.resolve({ status: 401, body: { error: 'Campus session is not valid.', code: 'CAMPUS_SESSION_REQUIRED' } });
  const raw = body ? JSON.stringify(body) : '';
  const headers = {
    authorization: `Bearer ${token}`, accept: 'application/json',
    ...serviceAuth.headersFor(c.secret, { method, path: path.split('?')[0], accountId, userId, body: raw }),
    ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
  };
  return new Promise((resolve) => {
    const req = http.request({ hostname: c.host, port: c.port, method, path, headers, timeout: c.timeout }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => { let parsed = {}; try { parsed = data ? JSON.parse(data) : {}; } catch { /* non-JSON */ } resolve({ status: res.statusCode || 502, body: parsed }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 503, body: { error: 'Campus portal is starting or unavailable.', code: 'CAMPUS_UNAVAILABLE' } }));
    if (raw) req.write(raw);
    req.end();
  });
}

// Maps a Campus failure onto the codes the Bridge UI understands.
function classify(res) {
  if (res.status === 401) return { code: 'CAMPUS_SESSION_REQUIRED', message: 'Your Campus session has expired. Open the Campus portal (it refreshes automatically) and try again.' };
  if (res.status === 403) return { code: (res.body && res.body.code) || 'BRIDGE_FORBIDDEN', message: (res.body && res.body.error) || 'Campus refused the request.' };
  if (res.status === 409) return { code: (res.body && res.body.code) || 'CAMPUS_CONFLICT', message: (res.body && res.body.error) || 'Campus reported a conflict.' };
  if (res.status >= 500 || res.status === 503) return { code: 'CAMPUS_UNAVAILABLE', message: 'The Campus portal is unavailable right now.' };
  return { code: 'CAMPUS_ERROR', message: (res.body && res.body.error) || 'Campus request failed.' };
}

const link = ({ token, accountId, consentVersion }) => request({ method: 'POST', path: '/api/bridge-source/link', token, accountId, body: { consent_version: consentVersion } });
const unlink = ({ token }) => request({ method: 'DELETE', path: '/api/bridge-source/link', token, accountId: '' });
const linkStatus = ({ token }) => request({ method: 'GET', path: '/api/bridge-source/link', token, accountId: '' });
const profile = ({ token, accountId }) => request({ method: 'GET', path: '/api/bridge-source/profile', token, accountId });

module.exports = { cookieValue, subjectOf, request, classify, link, unlink, linkStatus, profile };
