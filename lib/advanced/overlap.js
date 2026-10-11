'use strict';
// Syllabus Overlap & Target Portfolio.
// Topics are matched by an explicit, editable concept lexicon on the verified syllabus titles (falling back to
// title-token overlap). Matching topic names does NOT prove equal depth; the output says so.
const C = require('./common');

const CONCEPTS = {
  english: ['english', 'language', 'comprehension', 'grammar', 'vocabulary', 'verbal ability'],
  quantitative: ['quantitative', 'aptitude', 'arithmetic', 'numerical', 'mathematics', 'maths', 'data interpretation'],
  reasoning: ['reasoning', 'intelligence', 'logical', 'analytical', 'puzzles'],
  awareness: ['awareness', 'current affairs', 'general knowledge', 'static gk'],
  computer: ['computer', 'it knowledge', 'digital'],
  economy_banking: ['economy', 'banking', 'finance'],
  statistics: ['statistics', 'probability'],
};
const STOP = new Set(['and', 'the', 'of', 'in', 'to', 'for', 'a', 'an', 'general', 'basic', 'section', 'paper', 'test', 'skills', 'skill', 'ability']);
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
function conceptOf(title) {
  const t = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
  const hit = [];
  for (const [c, words] of Object.entries(CONCEPTS)) if (words.some((w) => t.includes(' ' + w + ' ') || t.includes(' ' + w))) hit.push(c);
  return hit;
}
function overlapCoeff(a, b) { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let n = 0; A.forEach((x) => { if (B.has(x)) n++; }); return n / Math.min(A.size, B.size); }
function match(a, b) {
  const ca = conceptOf(a.title), cb = conceptOf(b.title);
  const shared = ca.filter((c) => cb.includes(c));
  if (shared.length) return { how: `concept: ${shared[0]}`, confidence: 'HIGH' };
  const oc = overlapCoeff(toks(a.title), toks(b.title));
  if (oc >= 0.6) return { how: `title words (${Math.round(oc * 100)}%)`, confidence: 'MEDIUM' };
  return null;
}
function compare(exams) { // exams: [{id, code, name, nodes:[{id,code,title}]}]
  const pairs = [], shared = new Map();
  for (let i = 0; i < exams.length; i++) for (let k = i + 1; k < exams.length; k++) {
    const A = exams[i], B = exams[k]; const matches = []; const usedB = new Set();
    for (const na of A.nodes) for (const nb of B.nodes) { if (usedB.has(nb.id)) continue; const m = match(na, nb); if (m) { matches.push({ a: na.title, b: nb.title, ...m }); usedB.add(nb.id); break; } }
    pairs.push({ a: A.code, b: B.code, matched_topics: matches.length, a_covered_pct: A.nodes.length ? Math.round((matches.length / A.nodes.length) * 100) : 0, b_covered_pct: B.nodes.length ? Math.round((matches.length / B.nodes.length) * 100) : 0, matches });
    matches.forEach((m) => { const key = (conceptOf(m.a)[0] || toks(m.a).join(' ')); if (!shared.has(key)) shared.set(key, new Set()); shared.get(key).add(A.code); shared.get(key).add(B.code); });
  }
  const sharedTopics = [...shared.entries()].map(([topic, set]) => ({ topic, exams: [...set].sort() })).sort((x, y) => y.exams.length - x.exams.length);
  const startWith = exams.map((e) => ({ code: e.code, other_topics_covered: pairs.filter((p) => p.a === e.code || p.b === e.code).reduce((s, p) => s + p.matched_topics, 0) })).sort((x, y) => y.other_topics_covered - x.other_topics_covered);
  return { exams: exams.map((e) => ({ code: e.code, name: e.name, topics: e.nodes.length })), pairs, shared_topics: sharedTopics, best_foundation: startWith[0] || null, caveat: 'Topic names match; depth and difficulty can differ between exams. Check each syllabus before reusing preparation.' };
}

const JOB_EXAM = { 'ssc-combined-graduate': 'SSC-CGL', 'bank-po': 'BANK-PO' };
const linkedCode = (job) => job.exam_code || JOB_EXAM[job.id] || null;

// Overlap-aware, deadline-feasible target portfolio (earliest-deadline-first feasibility, greedy by value per marginal hour).
function portfolio({ ranked, jobsById, examsByCode, weeklyHours, hoursPerTopic = 12, now }) {
  const today = C.todayYMD(now || new Date());
  const cands = [];
  for (const r of ranked) {
    if (r.blocked) continue;
    const job = jobsById.get(r.job_id), code = job && linkedCode(job); const ex = code && examsByCode.get(code); const exam = job && C.examDate(job);
    if (!ex) { cands.push({ r, unlinked: true }); continue; }
    if (!exam || exam < today) continue;
    cands.push({ r, job, ex, exam, nodes: ex.nodes });
  }
  const linked = cands.filter((c) => !c.unlinked), unlinked = cands.filter((c) => c.unlinked).map((c) => ({ job_id: c.r.job_id, title: c.r.title, reason: 'No verified syllabus linked yet, so preparation hours cannot be estimated.' }));
  const chosen = [], rejected = [];
  const key = (n) => conceptOf(n.title)[0] || n.title.toLowerCase();
  // Hours are charged in exam-date order: the earliest exam must cover all of its own topics, later exams only add what is new.
  const schedule = (set) => { const covered = new Set(); return [...set].sort((a, b) => a.exam.localeCompare(b.exam)).map((c) => { const fresh = c.nodes.filter((n) => !covered.has(key(n))); c.nodes.forEach((n) => covered.add(key(n))); return { c, newTopics: fresh.length, hours: fresh.length * hoursPerTopic }; }); };
  const feasible = (set) => { let cum = 0; for (const x of schedule(set)) { cum += x.hours; if (cum > (weeklyHours / 7) * C.daysBetween(today, x.c.exam) + 1e-9) return false; } return true; };
  const pool = [...linked];
  while (pool.length) {
    const base = schedule(chosen).reduce((s2, x) => s2 + x.hours, 0);
    pool.forEach((c) => { c.gain = schedule(chosen.concat([c])).reduce((s2, x) => s2 + x.hours, 0) - base; c.ratio = c.r.score / Math.max(c.gain, 1); });
    pool.sort((a, b) => b.ratio - a.ratio); const c = pool.shift();
    if (feasible(chosen.concat([c]))) chosen.push(c);
    else { let cum = 0, need = 0, have = 0; for (const x of schedule(chosen.concat([c]))) { cum += x.hours; if (cum > (weeklyHours / 7) * C.daysBetween(today, x.c.exam) + 1e-9) { need = cum; have = Math.floor((weeklyHours / 7) * C.daysBetween(today, x.c.exam)); break; } } rejected.push({ job_id: c.r.job_id, title: c.r.title, reason: `Adding it would need about ${need} prep hours before ${schedule(chosen.concat([c])).find((x) => x.c === c).c.exam} but only about ${have} fit at ${weeklyHours} h/week alongside your other targets.` }); }
  }
  const sched = schedule(chosen);
  return {
    weekly_hours: weeklyHours, hours_per_topic_assumption: hoursPerTopic,
    targets: sched.map((x) => ({ job_id: x.c.r.job_id, title: x.c.r.title, exam_date: x.c.exam, score: x.c.r.score, marginal_prep_hours: x.hours, new_topics: x.newTopics, shared_topics_saved: x.c.nodes.length - x.newTopics })),
    total_prep_hours: sched.reduce((s2, x) => s2 + x.hours, 0), not_feasible: rejected, no_syllabus_link: unlinked,
    note: 'Hours are planning assumptions (topics x hours per topic, with topics already covered for an earlier exam counted once), not predictions.',
  };
}
module.exports = { compare, portfolio, conceptOf, linkedCode, CONCEPTS };
