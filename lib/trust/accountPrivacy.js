'use strict';
// Citizen account trust helpers (v2.9.0). Pure policy; routes do the I/O.
// Consent is PER PURPOSE and revocable; the ledger of grants/withdrawals is append-only (consent_events).
const PURPOSES = Object.freeze({
  ACCOUNT: 'Keep your account and sign you in',
  ALERTS: 'Send you deadline and match alerts',
  PERSONALISATION: 'Use your profile to rank and explain opportunities',
  DOCUMENT_REVIEW: 'Store documents you upload so you can check eligibility against them',
  CAMPUS_LINK: 'Use your linked Campus skills for Career Fit',
});
const REQUIRED = ['ACCOUNT'];

// events: consent_events rows (oldest..newest) -> current state per purpose.
function currentConsents(events) {
  const st = Object.fromEntries(Object.keys(PURPOSES).map((p) => [p, { purpose: p, description: PURPOSES[p], granted: false, since: null, version: null }]));
  for (const e of events || []) { const p = e.purpose || 'ACCOUNT'; if (!st[p]) continue; st[p] = { ...st[p], granted: e.action === 'GRANTED', since: e.at, version: e.version }; }
  return Object.values(st);
}
function canProcess(consents, purpose) { const c = (consents || []).find((x) => x.purpose === purpose); return !!(c && c.granted); }
function validateChange(purpose, action) {
  if (!PURPOSES[purpose]) throw Object.assign(new Error(`Unknown purpose. Use one of ${Object.keys(PURPOSES).join(', ')}`), { status: 400 });
  if (!['GRANTED', 'WITHDRAWN'].includes(action)) throw Object.assign(new Error('action must be GRANTED or WITHDRAWN'), { status: 400 });
  if (REQUIRED.includes(purpose) && action === 'WITHDRAWN') throw Object.assign(new Error('Withdrawing ACCOUNT consent means deleting the account: use DELETE /api/account.'), { status: 409 });
}
// Sessions: show where you are signed in; never reveal the token (only a short non-reversible label).
const sessionLabel = (tokenHash) => `…${String(tokenHash).slice(-6)}`;
function describeSessions(rows, currentHash) { return rows.map((r) => ({ id: sessionLabel(r.token_hash), current: r.token_hash === currentHash, created_at: r.created_at, expires_at: r.expires_at })); }
// What an export must contain to be complete (checked by tests so a new table cannot be forgotten).
const EXPORT_SECTIONS = ['account', 'consents', 'alert_preferences', 'watchlist', 'saved_searches', 'applications', 'documents_metadata', 'alerts_and_receipts'];
module.exports = { PURPOSES, REQUIRED, currentConsents, canProcess, validateChange, sessionLabel, describeSessions, EXPORT_SECTIONS };
