'use strict';
// Trust policy (v2.9.0). Pure functions, no I/O, no clock except the `now` that callers pass in.
//
// The goal is one honest answer to: "why is this vacancy shown the way it is?"
//
// A record carries THREE independent facts, never merged into one flattering label:
//   verification  how far a person has confirmed the critical fields
//                 DETECTED -> UNVERIFIED -> PARTIALLY_VERIFIED -> VERIFIED   (or CONFLICTED / RETRACTED / SAMPLE)
//   amended       an official corrigendum / amendment changed the record after first publication
//   phase         where the recruitment is in time: UPCOMING / ONGOING / CLOSING_SOON / CLOSED / EXPIRED
//
// A confidence score is NOT evidence of correctness. A machine-read record stays UNVERIFIED however high its
// extraction confidence is; only a named person confirming each critical field against the official document,
// on the CURRENT value, makes it VERIFIED.
const { canon } = require('../util');
const crypto = require('crypto');

// Fields whose error would make a person miss a deadline, apply when ineligible, or skip a valid vacancy.
// Each maps to a list of record paths that must be confirmed together.
const CRITICAL_FIELDS = Object.freeze([
  'dates.application_close',
  'dates.application_open',
  'vacancies.total',
  'age.min',
  'age.max',
  'age.cutoff_date',
  'education',
]);

const VERIFICATION_LABEL = Object.freeze({
  SAMPLE: 'Sample data (fictional demo, not a real recruitment)',
  DETECTED: 'Detected on an official portal, not read or verified',
  UNVERIFIED: 'Machine-read, not yet confirmed by a person',
  PARTIALLY_VERIFIED: 'Some critical fields confirmed by a person, others not',
  VERIFIED: 'Critical fields confirmed by a named reviewer against the official document',
  CONFLICTED: 'Official documents disagree. Do not rely on a single value',
  RETRACTED: 'Withdrawn: this record was taken down',
});

const PHASE_LABEL = Object.freeze({
  UPCOMING: 'Applications not open yet',
  ONGOING: 'Applications open',
  CLOSING_SOON: 'Applications close within 7 days',
  CLOSED: 'Applications closed',
  EXPIRED: 'Expired: closed long ago or the official page is gone',
  UNKNOWN: 'Dates not recorded',
});

const EXPIRY_GRACE_DAYS = Number(process.env.TRUST_EXPIRY_GRACE_DAYS || 30);
const DAY = 864e5;

const get = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const hashValue = (v) => crypto.createHash('sha256').update(canon(v === undefined ? null : v)).digest('hex');

// Which critical fields does this record actually carry? (A field the notice never stated cannot be "verified"; it is
// reported as missing instead, and the eligibility engine answers INSUFFICIENT_EVIDENCE for anything that needs it.)
function presentCriticalFields(job) {
  return CRITICAL_FIELDS.filter((f) => {
    const v = get(job, f);
    if (f === 'education') return v && Array.isArray(v.accepted) && v.accepted.length > 0;
    return v !== undefined && v !== null && v !== '';
  });
}
const missingCriticalFields = (job) => CRITICAL_FIELDS.filter((f) => !presentCriticalFields(job).includes(f));

// A verification row counts only if ALL of these hold (otherwise it is stale, forged or incomplete):
//   - names a human reviewer (an e-mail or id, never "system"/"policy")
//   - was made against the CURRENT value (value_hash equal): an amendment invalidates older confirmations
//   - points to evidence: a document, a page and a quote
function verificationCounts(row, job) {
  const reasons = [];
  if (!row || !row.verified_by || /^(system|policy|agent|auto|ai)\b/i.test(String(row.verified_by))) reasons.push('not confirmed by a named person');
  if (!row || row.value_hash !== hashValue(get(job, row.field))) reasons.push('value changed since it was confirmed');
  const ev = row && row.evidence;
  if (!ev || ev.page == null || !ev.quote || (ev.document_id == null && !ev.document_sha256)) reasons.push('no page and quote evidence');
  return { counts: reasons.length === 0, reasons };
}

function phaseOf(job, now, ctx = {}) {
  const d = job.dates || {};
  const open = d.application_open && Date.parse(d.application_open), close = d.application_close && Date.parse(d.application_close);
  if (!close || Number.isNaN(close)) return { phase: 'UNKNOWN', reasons: ['The closing date is not recorded.'] };
  const t = now.getTime();
  if (ctx.source && ctx.source.gone) return { phase: 'EXPIRED', reasons: ['The official page or document is no longer reachable.'] };
  if (t > close + EXPIRY_GRACE_DAYS * DAY) return { phase: 'EXPIRED', reasons: [`Closed more than ${EXPIRY_GRACE_DAYS} days ago.`] };
  if (t > close) return { phase: 'CLOSED', reasons: ['The recorded closing date has passed.'] };
  if (open && !Number.isNaN(open) && t < open) return { phase: 'UPCOMING', reasons: ['The recorded opening date is in the future.'] };
  if (close - t <= 7 * DAY) return { phase: 'CLOSING_SOON', reasons: ['The recorded closing date is within 7 days.'] };
  return { phase: 'ONGOING', reasons: ['Between the recorded opening and closing dates.'] };
}

// ctx: { verifications: [row], flags: [openFlag], source: { gone, last_checked_at }, detected_only: bool, now }
function computeTrust(job, ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const why = [];
  const flags = (ctx.flags || []).filter((f) => f.status === undefined || f.status === 'OPEN');
  const openConflicts = flags.filter((f) => f.kind === 'CONFLICTING_AMENDMENT' || f.kind === 'CONFLICTING_SOURCES');
  const present = presentCriticalFields(job), missing = missingCriticalFields(job);

  const fieldStatus = {};
  const rows = new Map();
  for (const r of (ctx.verifications || [])) { const prev = rows.get(r.field); if (!prev || Date.parse(r.verified_at) > Date.parse(prev.verified_at)) rows.set(r.field, r); }
  for (const f of present) {
    const row = rows.get(f); const chk = row ? verificationCounts(row, job) : { counts: false, reasons: ['no person has confirmed this field'] };
    fieldStatus[f] = chk.counts
      ? { status: 'CONFIRMED', verified_by: row.verified_by, verified_at: row.verified_at, evidence: row.evidence }
      : { status: row ? 'STALE' : 'UNCONFIRMED', reasons: chk.reasons };
  }
  const confirmed = present.filter((f) => fieldStatus[f].status === 'CONFIRMED');

  let verification;
  if (job.sample) { verification = 'SAMPLE'; why.push('This is a fictional demonstration record used to exercise the platform. It does not describe a real recruitment.'); }
  else if (ctx.retracted || job.lifecycle === 'RETRACTED') { verification = 'RETRACTED'; why.push('The record was retracted after publication.'); }
  else if (openConflicts.length) { verification = 'CONFLICTED'; for (const c of openConflicts) why.push(`Conflict on ${c.field}: ${c.summary || 'official documents disagree'}.`); }
  else if (ctx.detected_only) { verification = 'DETECTED'; why.push('A link was found on an official portal. Nothing has been read, so no vacancy, date or qualification is stated.'); }
  else if (!present.length) { verification = 'UNVERIFIED'; why.push('No critical field (deadline, vacancies, age, qualification) is recorded.'); }
  else if (confirmed.length === present.length && missing.length === 0) { verification = 'VERIFIED'; why.push(`All ${present.length} critical fields were confirmed by a named reviewer against the official document, on their current values.`); }
  else if (confirmed.length === present.length) { verification = 'PARTIALLY_VERIFIED'; why.push(`Every recorded critical field is confirmed, but the notice does not state: ${missing.join(', ')}. Anything depending on them is answered "insufficient evidence".`); }
  else if (confirmed.length > 0) { verification = 'PARTIALLY_VERIFIED'; why.push(`${confirmed.length} of ${present.length} critical fields are confirmed. Pending: ${present.filter((f) => !confirmed.includes(f)).join(', ')}.`); }
  else { verification = 'UNVERIFIED'; why.push(job.auto_extracted || (job.verification && job.verification.level === 'AUTO_EXTRACTED')
    ? 'Read automatically from the official document. Extraction confidence is not proof of accuracy; a person has not confirmed the critical fields yet.'
    : 'No critical field has been confirmed by a named reviewer yet.'); }

  // Stale confirmations deserve an explicit line: the value moved after somebody signed off.
  for (const f of present) if (fieldStatus[f].status === 'STALE' && verification !== 'SAMPLE') why.push(`${f}: earlier confirmation no longer applies (${fieldStatus[f].reasons.join('; ')}).`);

  const amendments = (job.history || []).filter((h) => h && h.field);
  const amended = amendments.length > 0 || !!job.pending_update;
  if (amended) why.push(job.pending_update ? 'An official update was detected and is waiting for review; the values shown may change.' : `Amended ${amendments.length} time${amendments.length === 1 ? '' : 's'} by official updates; latest: ${amendments[amendments.length - 1].field} (${amendments[amendments.length - 1].from} -> ${amendments[amendments.length - 1].to}).`);

  const ph = phaseOf(job, now, ctx);
  why.push(...ph.reasons);

  const sev = flags.filter((f) => f.severity === 'HIGH' || f.severity === 'CRITICAL');
  if (sev.length && verification !== 'CONFLICTED') for (const f of sev) why.push(`Open flag: ${f.summary || f.kind}.`);

  // One display status, chosen so the least reassuring true fact wins.
  let display;
  if (['SAMPLE', 'RETRACTED', 'CONFLICTED', 'DETECTED'].includes(verification)) display = verification;
  else if (ph.phase === 'EXPIRED') display = 'EXPIRED';
  else if (verification === 'UNVERIFIED' || verification === 'PARTIALLY_VERIFIED') display = verification;
  else if (amended) display = 'AMENDED';
  else display = ph.phase === 'CLOSED' ? 'CLOSED' : ph.phase === 'UPCOMING' ? 'UPCOMING' : 'VERIFIED';

  return {
    display_status: display,
    verification, verification_label: VERIFICATION_LABEL[verification],
    amended, needs_reverification: amended && verification !== 'VERIFIED' && verification !== 'SAMPLE',
    phase: ph.phase, phase_label: PHASE_LABEL[ph.phase],
    can_rely_on_for_decisions: verification === 'VERIFIED' && ph.phase !== 'EXPIRED' && !openConflicts.length,
    critical_fields: { required: CRITICAL_FIELDS, present, missing, confirmed, status: fieldStatus },
    open_flags: flags.map((f) => ({ kind: f.kind, severity: f.severity, field: f.field, summary: f.summary })),
    why,
    checked_at: now.toISOString(),
  };
}

// Auto-verification may only be considered once accuracy has been MEASURED on adjudicated real notices.
// Until then the answer is always "a person must confirm critical fields".
function humanVerificationRequired(report, thresholds = {}) {
  const t = { min_real_documents: 200, min_critical_wilson_lower_bound: 0.98, ...thresholds };
  if (!report || !report.real_documents || report.real_documents < t.min_real_documents) return { required: true, reason: `Only ${report ? report.real_documents || 0 : 0} adjudicated real notices measured; at least ${t.min_real_documents} are needed before relaxing review.` };
  const weak = (report.critical || []).filter((c) => c.precision_lower_bound < t.min_critical_wilson_lower_bound);
  if (weak.length) return { required: true, reason: `Precision lower bound below ${t.min_critical_wilson_lower_bound} for: ${weak.map((w) => w.field).join(', ')}.` };
  return { required: false, reason: 'Measured precision on real notices supports a lighter review policy. A person should still sample-audit.' };
}

module.exports = { CRITICAL_FIELDS, VERIFICATION_LABEL, PHASE_LABEL, EXPIRY_GRACE_DAYS, hashValue, presentCriticalFields, missingCriticalFields, verificationCounts, phaseOf, computeTrust, humanVerificationRequired };
