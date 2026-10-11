'use strict';
// AI answer guard (v2.9.0). Sits AFTER the grounded composer (lib/answer.js) and in front of any model-written text.
//
// Rules, all enforced in code:
//   1. An answer is one of  ANSWERED_VERIFIED | ANSWERED_UNVERIFIED | CONFLICTING_OFFICIAL_SOURCES | INSUFFICIENT_EVIDENCE.
//      "Insufficient evidence" is a first-class result, not an error.
//   2. If a question depends on a critical field and the record is DETECTED/RETRACTED, or the field is absent, or two official
//      documents disagree on it, the guard refuses to name a value.
//   3. Official facts (bound to a field, with a cited page) are returned separately from derived statements (status, eligibility)
//      and from generated guidance. A reader can always tell which is which.
//   4. Model-written text may not contain a date, vacancy count, age, fee, syllabus topic or qualification that the official
//      record does not contain. guardFreeText() finds them and says exactly what was invented.
const { auditText } = require('../claims');
const { levelsFrom } = require('../rulesExtractor');

const ASKS = [
  ['dates.application_close', /\b(last date|closing date|deadline|close[sd]?|apply (?:by|before)|due)\b/i],
  ['dates.application_open', /\b(opens?|starting|start date|begin)\b/i],
  ['dates.exam_date', /\b(exam date|when is the exam|exam on|test date)\b/i],
  ['vacancies.total', /\b(vacanc|posts?|seats?|openings?|how many)\b/i],
  ['age', /\b(age|born|dob|relaxation|cut-?off)\b/i],
  ['education', /\b(qualification|education|degree|graduat|diploma|10th|12th|iti|eligible|eligibility)\b/i],
  ['syllabus', /\b(syllabus|topics?|curriculum|subjects?)\b/i],
];
const askedFields = (q) => ASKS.filter(([, rx]) => rx.test(String(q || ''))).map(([f]) => f);
const fieldMatches = (asked, field) => asked === field || field.startsWith(asked + '.') || (asked === 'age' && /^age\./.test(field));

const STATUS = Object.freeze({ VERIFIED: 'ANSWERED_VERIFIED', UNVERIFIED: 'ANSWERED_UNVERIFIED', CONFLICT: 'CONFLICTING_OFFICIAL_SOURCES', INSUFFICIENT: 'INSUFFICIENT_EVIDENCE' });
const NO_ANSWER = 'The available evidence is not enough to state this. Check the official notification directly.';

function abstain({ reason, missing = [], trust = null, base = {} }) {
  return { ...base, text: `${NO_ANSWER} ${reason}`.trim(), answer_status: STATUS.INSUFFICIENT, abstained: true, abstain_reason: reason, missing_evidence: missing, official_facts: [], derived: [], guidance: [], claims: [], where_did_this_come_from: [], trust_summary: trust ? { display_status: trust.display_status, why: trust.why } : null };
}

// result = output of answer.ask(); trust = computeTrust(job); conflicts = open flags for this recruitment.
function guardAnswer({ result, trust, flags = [], question = '' }) {
  if (!result || result.needs_clarification) return result;
  const asked = askedFields(question);
  const critical = asked.filter((f) => f !== 'syllabus');
  const conflicts = (flags || []).filter((f) => (f.status === undefined || f.status === 'OPEN') && /^CONFLICTING/.test(f.kind));
  const base = { mode: result.mode, intent: result.intent, recruitment_id: result.recruitment_id, audit: result.audit };

  // 2a. Nothing has been read, or the record was withdrawn.
  if (trust && ['DETECTED', 'RETRACTED'].includes(trust.verification) && (critical.length || !asked.length)) {
    return abstain({ base, trust, reason: trust.verification === 'DETECTED' ? 'This notice was only detected on an official portal; no dates, vacancies or qualifications have been read from it.' : 'This record was retracted.', missing: critical.length ? critical : ['all'] });
  }
  // 2b. Official documents disagree on something that was asked.
  const hit = conflicts.filter((c) => critical.some((a) => fieldMatches(a, c.field)) || (!critical.length && ['dates.application_close', 'vacancies.total'].includes(c.field)));
  if (hit.length) {
    const lines = hit.map((c) => `${c.field}: ${c.summary}`);
    return { ...base, text: `Official documents disagree, so no single value is stated. ${lines.join(' ')} Open the official documents and confirm.`, answer_status: STATUS.CONFLICT, abstained: true, conflicts: hit.map((c) => ({ field: c.field, summary: c.summary, candidates: c.candidates || [{ value: c.from }, { value: c.to }] })), official_facts: [], derived: [], guidance: [], claims: [], where_did_this_come_from: [], trust_summary: trust ? { display_status: trust.display_status, why: trust.why } : null };
  }
  // 2c. The official source is silent on exactly what was asked.
  const silent = (result.segments || []).filter((s) => s.silent);
  if (silent.length && (result.segments || []).filter((s) => s.field && !s.silent && s.field !== 'status').length === 0) {
    return abstain({ base, trust, reason: 'The official record does not state it.', missing: silent.map((s) => s.field).filter(Boolean) });
  }

  // 3. Separate official facts from derived statements and guidance.
  const claimByField = new Map((result.claims || []).map((c) => [c.field, c]));
  const official_facts = [], derived = [], guidance = [];
  for (const s of result.segments || []) {
    if (!s.text || s.identity) continue;
    if (s.silent) { official_facts.push({ text: s.text, field: s.field, official: false, note: 'The official source does not specify this.' }); continue; }
    const c = s.field && claimByField.get(s.field);
    if (c) { const src = (result.where_did_this_come_from || []).find((w) => w.field === s.field) || null; official_facts.push({ text: s.text, field: s.field, official: true, source: src ? { doc: src.doc, page: src.page, section: src.section, viewer_url: src.viewer_url } : null }); }
    else if (['status', 'eligibility', 'eligibility.row', 'education', 'selection'].includes(s.field)) derived.push({ text: s.text, field: s.field, note: s.field === 'education' || s.field === 'selection' ? 'Quoted from the official record.' : 'Computed by rule from official facts and your profile.' });
    else if (s.text) guidance.push({ text: s.text, generated: true, note: 'Generated guidance, not an official statement.' });
  }

  const unverified = trust && trust.verification !== 'VERIFIED' && trust.verification !== 'SAMPLE';
  const status = unverified ? STATUS.UNVERIFIED : STATUS.VERIFIED;
  const prefix = unverified ? `Unverified (${trust.verification_label.toLowerCase()}). ` : trust && trust.verification === 'SAMPLE' ? 'Sample data (fictional). ' : '';
  return {
    ...result, text: prefix + result.text, answer_status: status, abstained: false,
    official_facts, derived, guidance,
    trust_summary: trust ? { display_status: trust.display_status, verification: trust.verification, why: trust.why } : null,
    disclaimer: 'Official facts are quoted from the cited document. Derived statements are computed from them. Guidance is generated and is not official.',
  };
}

// ---- free text from a model ----------------------------------------------------------------------------------------
const LEVEL_WORDS = { '10th': /\b(10th|matriculation|class x)\b/i, '12th': /\b(12th|intermediate|class xii|higher secondary)\b/i, iti: /\biti\b/i, diploma: /\bdiploma\b/i, bachelor: /\b(b\.?\s?tech|b\.?\s?e\b|bachelor|graduate|graduation|degree)\b/i, master: /\b(m\.?\s?tech|master|post[- ]?graduate)\b/i, phd: /\b(ph\.?\s?d|doctorate)\b/i };

// Returns { ok, violations: [{ kind, token, reason }], sanitized }.
function guardFreeText({ text, job, syllabusNodes = null, now = new Date() }) {
  const violations = [];
  const t = String(text || '');
  if (job) {
    // Figures and dates: every one must equal a value in the record. (Reuses the strict field-bound auditor.)
    const a = auditText(job, t, now);
    for (const c of a.checks) if (!c.supported) violations.push({ kind: /\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(c.token) ? 'INVENTED_DATE' : 'INVENTED_FIGURE', token: c.token, reason: c.reason || 'Not in the verified record.' });
    // Qualifications: a level named as required must be one the notice accepts.
    const e = job.education;
    if (e && Array.isArray(e.accepted)) {
      const ok = new Set(e.accepted); const sentences = t.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (!/(require|eligib|qualif|must (?:have|hold)|need|minimum|should (?:have|hold)|open to)/i.test(s)) continue;
        for (const [lv, rx] of Object.entries(LEVEL_WORDS)) if (rx.test(s) && !ok.has(lv) && !(e.or_higher && lv === 'bachelor' && ok.has('12th')) && !/\bnot\b/i.test(s)) violations.push({ kind: 'INVENTED_QUALIFICATION', token: lv, reason: `The notice accepts ${e.label || [...ok].join(', ')}; "${lv}" is not stated.` });
      }
    } else if (/(require|eligib|qualif)/i.test(t) && Object.values(LEVEL_WORDS).some((rx) => rx.test(t))) violations.push({ kind: 'INVENTED_QUALIFICATION', token: 'education', reason: 'The record does not state the qualification.' });
  }
  if (syllabusNodes) {
    const titles = syllabusNodes.flatMap((n) => [n.title, n.description, n.code]).filter(Boolean).map((x) => String(x).toLowerCase());
    const rx = /syllabus[^.:]{0,40}(?:includes?|covers?|contains?|comprises?)[:\s]+([^.]+)/gi; let m;
    while ((m = rx.exec(t))) for (const topic of m[1].split(/,|;| and /).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 2)) if (!titles.some((x) => x.includes(topic) || topic.includes(x))) violations.push({ kind: 'INVENTED_SYLLABUS_TOPIC', token: topic, reason: 'This topic is not in the verified syllabus version.' });
  }
  return { ok: violations.length === 0, violations, sanitized: violations.length ? NO_ANSWER : t };
}

module.exports = { STATUS, NO_ANSWER, askedFields, abstain, guardAnswer, guardFreeText };
