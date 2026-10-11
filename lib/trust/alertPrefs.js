'use strict';
// Alert preferences, trust-aware planning and delivery receipts (v2.9.0). Pure: decisions only, no I/O.
// Retries, back-off, de-duplication per (account, dedupe_key), SKIPPED-on-consent-withdrawal and provider-confirmed SENT already
// live in alertPlanner.js / alertDelivery.js / alerts.js and are unchanged. This adds what they lacked:
//   - per-person choices (channels, which event types, only-verified), honoured BEFORE anything is queued
//   - deadline-change / conflict alerts raised from trust flags, with the evidence in the payload
//   - receipts a person can read: what was sent, where, when, with which provider id, or why it was not
const CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'];
const EVENT_TYPES = ['DEADLINE_CHANGED', 'NEW_MATCH', 'TRUST_FLAG'];
const DEFAULTS = Object.freeze({ channels: ['IN_APP', 'EMAIL', 'PUSH'], deadline_changes: true, new_match: true, trust_flags: true, min_trust: 'ANY' });

function normalisePrefs(input = {}) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const out = { ...DEFAULTS };
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels) || input.channels.some((c) => !CHANNELS.includes(c))) throw bad(`channels must be a list of ${CHANNELS.join(', ')}`);
    out.channels = [...new Set(input.channels)];
  }
  for (const k of ['deadline_changes', 'new_match', 'trust_flags']) if (input[k] !== undefined) { if (typeof input[k] !== 'boolean') throw bad(`${k} must be true or false`); out[k] = input[k]; }
  if (input.min_trust !== undefined) { if (!['ANY', 'VERIFIED'].includes(input.min_trust)) throw bad('min_trust must be ANY or VERIFIED'); out.min_trust = input.min_trust; }
  return out;
}

const KEY = { DEADLINE_CHANGED: 'deadline_changes', NEW_MATCH: 'new_match', TRUST_FLAG: 'trust_flags' };
// A deadline change or a conflict is safety information: it is never hidden by min_trust (hiding it would hide the very warning).
function allow(prefs, eventType, verification) {
  const p = prefs || DEFAULTS;
  if (KEY[eventType] && p[KEY[eventType]] === false) return { ok: false, reason: `turned off: ${KEY[eventType]}` };
  if (!p.channels || !p.channels.length) return { ok: false, reason: 'no channel selected' };
  if (eventType === 'NEW_MATCH' && p.min_trust === 'VERIFIED' && verification && verification !== 'VERIFIED') return { ok: false, reason: `only verified notices wanted; this one is ${verification}` };
  return { ok: true };
}

// plans: [{accountId, recruitmentId, eventType, dedupeKey, payload}] -> { plans (each with .channels), suppressed }
function applyPreferences(plans, prefsByAccount = {}, verificationByRecruitment = {}) {
  const keep = [], suppressed = [];
  for (const p of plans) {
    const prefs = prefsByAccount[p.accountId] || DEFAULTS;
    const a = allow(prefs, p.eventType, verificationByRecruitment[p.recruitmentId]);
    if (a.ok) keep.push({ ...p, channels: prefs.channels.filter((c) => CHANNELS.includes(c)) }); else suppressed.push({ accountId: p.accountId, recruitmentId: p.recruitmentId, eventType: p.eventType, reason: a.reason });
  }
  return { plans: keep, suppressed };
}

// flags: open trust flags; watchers: [{account_id, recruitment_id, watch_created_at, account_active}]
const ALERT_KINDS = new Set(['DEADLINE_CHANGED', 'CONFLICTING_AMENDMENT', 'CONFLICTING_SOURCES', 'SOURCE_DATE_MISMATCH', 'NOTICE_EXPIRED', 'REVERSED_AMENDMENT']);
function planTrustAlerts(flags, watchers, { now = new Date(), lookbackDays = 30 } = {}) {
  const out = [], seen = new Set();
  for (const f of flags) {
    if (!ALERT_KINDS.has(f.kind) || (f.status && f.status !== 'OPEN')) continue;
    const raised = Date.parse(f.raised_at); if (Number.isNaN(raised) || raised < now.getTime() - lookbackDays * 864e5) continue;
    for (const w of watchers.filter((x) => x.recruitment_id === f.recruitment_id)) {
      if (w.account_active === false) continue;
      if (Date.parse(w.watch_created_at) > raised) continue; // happened before this person started watching
      const dedupeKey = `TRUST_FLAG:${f.dedupe_key}`; const k = `${w.account_id}|${dedupeKey}`; if (seen.has(k)) continue; seen.add(k);
      out.push({ accountId: w.account_id, recruitmentId: f.recruitment_id, eventType: 'TRUST_FLAG', dedupeKey,
        payload: { version: String(f.to_version || '1'), title: w.title, field: f.field, from: f.from, to: f.to, kind: f.kind, severity: f.severity, summary: f.summary, evidence: f.evidence || null, verify_on_official_source: true } });
    }
  }
  return out;
}

// rows: notification_deliveries joined with alert_events. "Delivered" is claimed only when a provider confirmed it.
function receipts(rows) {
  const by = new Map();
  for (const r of rows) {
    const a = by.get(r.alert_id) || by.set(r.alert_id, { alert_id: r.alert_id, event_type: r.event_type, recruitment_id: r.recruitment_id, title: r.payload && r.payload.title, summary: r.payload && (r.payload.summary || `${r.payload.field}: ${r.payload.from} -> ${r.payload.to}`), created_at: r.alert_created_at, deliveries: [] }).get(r.alert_id);
    const sent = r.status === 'SENT';
    a.deliveries.push({ channel: r.channel, status: r.status, delivered_confirmed: sent && !!r.provider_message_id, provider_message_id: r.provider_message_id || null, attempts: r.attempts, sent_at: r.sent_at || null, note: r.status === 'SKIPPED' ? r.last_error : r.status === 'FAILED' ? `gave up: ${r.last_error}` : r.status === 'QUEUED' && r.attempts ? `retrying: ${r.last_error}` : null });
  }
  return [...by.values()];
}

module.exports = { CHANNELS, EVENT_TYPES, DEFAULTS, normalisePrefs, allow, applyPreferences, planTrustAlerts, receipts };
