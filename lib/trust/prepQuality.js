'use strict';
// Exam preparation quality (v2.9.0): verified exam-year syllabi, question-quality checks, progress analytics, adaptive plans.
const { wilson } = require('./evaluation');

// A syllabus may be called "verified" only if it is pinned to an exam year, has a source, and every leaf names a page.
function syllabusStatus(version, nodes) {
  const problems = [];
  if (!version || !version.recruitment_year) problems.push('not pinned to an exam year');
  if (!version || !version.syllabus_version) problems.push('no syllabus version label');
  if (!version || !(version.source_ref || version.source_url)) problems.push('no official source recorded');
  const parents = new Set((nodes || []).map((n) => n.parent_id).filter((x) => x != null));
  const leaves = (nodes || []).filter((n) => !parents.has(n.id));
  if (!leaves.length) problems.push('no topics');
  const noPage = leaves.filter((n) => n.source_page == null).length;
  if (leaves.length && noPage) problems.push(`${noPage} of ${leaves.length} topics have no page reference`);
  if (version && version.status && version.status !== 'VERIFIED') problems.push(`status is ${version.status}`);
  const cur = new Date().getFullYear();
  const stale = version && version.recruitment_year && version.recruitment_year < cur - 1;
  return { verified: problems.length === 0, problems, stale_year: !!stale, label: problems.length === 0 ? `Verified syllabus ${version.recruitment_year} (${version.syllabus_version})` : `Not verified: ${problems.join('; ')}` };
}

// Structural quality of ONE multiple-choice question. Cannot prove the key is right; can prove many ways it is wrong.
function checkQuestion(q) {
  const issues = [];
  const opts = q.options || q.o;
  const text = q.text || q.q;
  const ans = q.answer !== undefined ? q.answer : q.a;
  if (!text || String(text).trim().length < 8) issues.push({ code: 'NO_STEM', severity: 'ERROR', message: 'The question text is missing or too short.' });
  if (!Array.isArray(opts) || opts.length < 3) issues.push({ code: 'FEW_OPTIONS', severity: 'ERROR', message: 'Needs at least 3 options.' });
  else {
    const norm = opts.map((o) => String(o).trim().toLowerCase());
    if (new Set(norm).size !== norm.length) issues.push({ code: 'DUPLICATE_OPTIONS', severity: 'ERROR', message: 'Two options are identical.' });
    if (norm.some((o) => !o)) issues.push({ code: 'EMPTY_OPTION', severity: 'ERROR', message: 'An option is empty.' });
    const idx = Number.isInteger(ans) ? ans : opts.findIndex((o) => String(o) === String(ans));
    if (idx < 0 || idx >= opts.length) issues.push({ code: 'KEY_NOT_AN_OPTION', severity: 'ERROR', message: 'The answer key is not one of the options.' });
    if (norm.some((o) => /^(all|none) of the above$/.test(o))) issues.push({ code: 'ALL_NONE_OF_ABOVE', severity: 'WARN', message: '"All/None of the above" options weaken the question.' });
    const longest = Math.max(...opts.map((o) => String(o).length)); if (idx >= 0 && opts.length >= 4 && String(opts[idx]).length === longest && longest > 2 * (opts.reduce((a, o) => a + String(o).length, 0) / opts.length)) issues.push({ code: 'KEY_STANDS_OUT', severity: 'WARN', message: 'The correct option is much longer than the others, a common giveaway.' });
  }
  if (q.origin === 'AI_GENERATED' && !q.reviewed_by) issues.push({ code: 'AI_UNREVIEWED', severity: 'WARN', message: 'AI-generated and not reviewed by a person: label it and do not count it toward official-style scores.' });
  if (q.origin === 'PREVIOUS_YEAR' && (!q.source_ref || !q.legal_basis)) issues.push({ code: 'PYQ_NO_SOURCE', severity: 'ERROR', message: 'Previous-year question needs source_ref and legal_basis.' });
  if (!q.explanation && !q.rationale) issues.push({ code: 'NO_EXPLANATION', severity: 'INFO', message: 'No explanation recorded.' });
  return { id: q.id, ok: !issues.some((i) => i.severity === 'ERROR'), issues };
}
function checkQuestionSet(qs) {
  const per = (qs || []).map(checkQuestion);
  const stems = new Map(); (qs || []).forEach((q) => { const k = String(q.text || q.q || '').toLowerCase().replace(/\s+/g, ' ').trim(); if (k) stems.set(k, [...(stems.get(k) || []), q.id]); });
  const dups = [...stems.values()].filter((v) => v.length > 1);
  return { total: per.length, passing: per.filter((p) => p.ok).length, failing: per.filter((p) => !p.ok).map((p) => ({ id: p.id, issues: p.issues.filter((i) => i.severity === 'ERROR') })), warnings: per.filter((p) => p.issues.some((i) => i.severity === 'WARN')).length, duplicate_stems: dups };
}

// Analytics from attempts: [{ topic, correct (bool), at, seconds }]. Gives intervals, never bare percentages on tiny samples.
function progressAnalytics(attempts, { now = new Date() } = {}) {
  const topics = new Map();
  for (const a of attempts || []) { const t = topics.get(a.topic) || topics.set(a.topic, { topic: a.topic, attempted: 0, correct: 0, last: null, recent: [] }).get(a.topic); t.attempted++; if (a.correct) t.correct++; if (!t.last || a.at > t.last) t.last = a.at; t.recent.push(a); }
  const rows = [...topics.values()].map((t) => { const w = wilson(t.correct, t.attempted); const rec = t.recent.sort((x, y) => String(x.at).localeCompare(String(y.at))).slice(-10); const half = Math.floor(rec.length / 2); const acc = (xs) => (xs.length ? xs.filter((x) => x.correct).length / xs.length : null); const early = acc(rec.slice(0, half)), late = acc(rec.slice(half));
    return { topic: t.topic, attempted: t.attempted, correct: t.correct, accuracy_pct: Math.round((t.correct / t.attempted) * 1000) / 10, ci95_pct: [Math.round(w.lower * 1000) / 10, Math.round(w.upper * 1000) / 10], reliable: t.attempted >= 10, trend: early == null || late == null || rec.length < 6 ? 'UNKNOWN' : late - early > 0.1 ? 'IMPROVING' : early - late > 0.1 ? 'DECLINING' : 'FLAT', days_since_practice: t.last ? Math.floor((now - new Date(t.last)) / 864e5) : null }; });
  return { topics: rows.sort((a, b) => a.ci95_pct[1] - b.ci95_pct[1]), note: 'Accuracy is shown with a 95% interval. Topics with fewer than 10 attempts are marked unreliable.' };
}

// Adaptive plan: more days for topics where the UPPER bound of accuracy is low, spaced revision for stale ones; unknown topics get a diagnostic first.
function adaptivePlan({ topics, analytics, days, minutesPerDay }) {
  const bt = new Map((analytics && analytics.topics || []).map((t) => [t.topic, t]));
  const weight = (name) => { const a = bt.get(name); if (!a || !a.reliable) return { w: 1.2, why: 'no reliable data yet: start with a diagnostic set' }; const need = 1 - a.ci95_pct[1] / 100; return { w: 0.5 + 2 * need + (a.days_since_practice > 14 ? 0.5 : 0) + (a.trend === 'DECLINING' ? 0.5 : 0), why: `accuracy ${a.accuracy_pct}% (95% interval ${a.ci95_pct.join('–')}%)${a.days_since_practice > 14 ? ', not practised for ' + a.days_since_practice + ' days' : ''}` }; };
  const ws = topics.map((t) => ({ topic: t, ...weight(t) })); const tot = ws.reduce((x, y) => x + y.w, 0) || 1;
  const nd = Math.max(1, Math.min(366, days));
  return { days: nd, minutes_per_day: minutesPerDay, allocation: ws.map((x) => ({ topic: x.topic, days: Math.max(1, Math.round((x.w / tot) * nd)), why: x.why })), note: 'Allocation follows measured weakness. It is a plan, not a prediction of your score.' };
}
module.exports = { syllabusStatus, checkQuestion, checkQuestionSet, progressAnalytics, adaptivePlan };
