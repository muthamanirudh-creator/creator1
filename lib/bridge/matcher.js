'use strict';
// Bridge matcher.
//
//   eligibility (deterministic engine)  ──┐  hard gate; never overridden by skills
//   skill fit (explainable, range)      ──┤
//   readiness (hours vs. time left)     ──┼─►  bridge score + a concrete next action
//   resume text affinity (TF-IDF)       ──┘
//
// Everything is pure and synchronous: callers pass in jobs, the skill profile, exam syllabus nodes and a
// clock. That keeps the engine testable, reproducible and independent of Express / Postgres / Campus.
const { evaluate } = require('../eligibility');
const { deadlineInfo, istYMD } = require('../dates');
const { deriveRequirements, skillsForNode, examFor } = require('./requirements');
const T = require('./taxonomy');

const PRIOR_UNKNOWN = 0.25;       // assumed level for a skill with no evidence at all
const UNCERTAINTY = 0.25;         // half-width of the range for a skill with zero confidence
const PREP_BUFFER = 0.85;         // only 85% of nominal study time is assumed usable
const ASSUMED_EXAM_LAG_DAYS = 60; // used only when the notification gives no exam date (and labelled)
const STRONG = 70, GOOD = 45;
const ELIG_SCORE = { MATCH: 1, PARTIAL_MATCH: 0.75, CONDITIONALLY_ELIGIBLE: 0.6, UNKNOWN: 0.5, INSUFFICIENT_EVIDENCE: 0.5, NOT_ELIGIBLE: 0 };
const WEIGHTS = { fit: 0.55, elig: 0.2, feas: 0.15, affinity: 0.1 };

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const dayMs = 864e5;
const daysBetween = (a, b) => Math.max(0, Math.ceil((b - a) / dayMs));

// Accept both spellings: the browser profile uses `exServiceman`, the eligibility engine `exServicemen`.
function normaliseProfile(p) {
  const out = { ...(p || {}) };
  if (out.exServiceman && !out.exServicemen) out.exServicemen = true;
  return out;
}

// ---- skill state ----------------------------------------------------------------------------------
function stateOf(skills, id) {
  const s = skills && skills[id];
  if (!s) return { known: false, est: PRIOR_UNKNOWN, lo: 0, hi: 1, confidence: 0, verified: false, tested: false, sources: [] };
  const spread = (1 - (s.confidence == null ? 0.5 : s.confidence)) * UNCERTAINTY;
  return { known: true, est: s.level, lo: clamp01(s.level - spread), hi: clamp01(s.level + spread), confidence: s.confidence, verified: !!s.verified, tested: !!s.tested, sources: s.sources || [] };
}

// ---- text affinity (TF-IDF cosine) ----------------------------------------------------------------
const STOP = new Set('the and for with from that this are was were will have has had not but all any can our your you its their they them who whom into than then also such per via etc one two may must shall under over upon more most other some each both his her out off who how what when where which while within without about after before between through during against above below been being does did done doing would could should might very just only own same too'.split(' '));
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 3 && !STOP.has(w));
function tfidfAffinity(resumeText, jobDocs) {
  if (!resumeText || String(resumeText).trim().length < 40) return null;
  const docs = [tokens(resumeText), ...jobDocs.map(tokens)];
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  const vec = (d) => { const tf = new Map(); d.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1)); const v = new Map(); let norm = 0; for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + N / df.get(w)); v.set(w, x); norm += x * x; } return { v, norm: Math.sqrt(norm) || 1 }; };
  const r = vec(docs[0]);
  const raw = docs.slice(1).map((d) => { const j = vec(d); let dot = 0; for (const [w, x] of r.v) { const y = j.v.get(w); if (y) dot += x * y; } return dot / (r.norm * j.norm); });
  const max = Math.max(...raw, 1e-9);
  return raw.map((x) => clamp01(x / max));   // relative: the best-matching job scores 1
}

// ---- per-job fit ----------------------------------------------------------------------------------
function computeFit(reqs, skills) {
  if (!reqs.length) return null;
  let est = 0, lo = 0, hi = 0;
  const coverage = reqs.map((r) => {
    const st = stateOf(skills, r.skill);
    const c = (x) => clamp01(x / r.target);
    est += r.weight * c(st.est); lo += r.weight * c(st.lo); hi += r.weight * c(st.hi);
    const cov = c(st.est);
    const status = !st.known ? 'UNKNOWN' : cov >= 1 ? 'MET' : cov >= 0.8 ? 'CLOSE' : 'GAP';
    return { ...r, level: st.known ? r2(st.est) : null, confidence: st.known ? st.confidence : 0, verified: st.verified, tested: st.tested, coverage: r2(cov), status, evidence: st.sources.slice(0, 3) };
  });
  const score = r1(est * 100);
  return { score, low: r1(lo * 100), high: r1(hi * 100), tier: score >= STRONG ? 'STRONG' : score >= GOOD ? 'GOOD' : score >= 25 ? 'STRETCH' : 'FAR', coverage };
}

function readiness(coverage, job, now, dailyMinutes) {
  const open = new Date(job.dates.application_open), close = new Date(job.dates.application_close);
  let target, basis;
  if (job.dates.exam_date) { target = new Date(`${String(job.dates.exam_date).slice(0, 10)}T00:00:00+05:30`); basis = 'EXAM_DATE'; }
  else { target = new Date(close.getTime() + ASSUMED_EXAM_LAG_DAYS * dayMs); basis = 'ASSUMED_AFTER_CLOSE'; }
  const from = now < open ? open : now;
  const days = Math.max(0, daysBetween(now, target));
  const dailyHours = Math.max(0.25, dailyMinutes / 60);
  let hours = 0;
  const per = [];
  for (const c of (coverage || [])) {
    if (c.coverage >= 1) continue;
    const est = c.level == null ? PRIOR_UNKNOWN : c.level;
    const h = T.SKILLS[c.skill].hours * Math.max(0, (c.target - est) / c.target);
    if (h > 0) { hours += h; per.push({ skill: c.skill, label: c.label, hours: Math.round(h) }); }
  }
  const available = days * dailyHours * PREP_BUFFER;
  const feasibility = hours <= 0 ? 1 : clamp01(available / hours);
  const needDays = Math.ceil(hours / dailyHours);
  const readyBy = hours > 0 ? istYMD(new Date(now.getTime() + needDays * dayMs)) : null;
  return {
    hours_needed: Math.round(hours), per_skill_hours: per.sort((a, b) => b.hours - a.hours),
    days_available: days, window_basis: basis, window_note: basis === 'ASSUMED_AFTER_CLOSE'
      ? `The notification gives no exam date, so ${ASSUMED_EXAM_LAG_DAYS} days after applications close is assumed for planning only.` : 'Counted to the notified exam date.',
    daily_minutes: dailyMinutes, feasibility: r2(feasibility), feasible: feasibility >= 0.999,
    days_to_ready: hours > 0 ? needDays : 0, ready_by: readyBy, starts: istYMD(from),
  };
}

function decideAction({ dl, elig, fit, ready }) {
  if (dl.status === 'CLOSED') return { code: 'CLOSED', label: 'Applications closed', priority: 9, reason: 'The application window has ended.' };
  if (elig.overall === 'NOT_ELIGIBLE') return { code: 'NOT_ELIGIBLE', label: 'Not eligible', priority: 8, reason: elig.summary };
  if (elig.overall === 'INSUFFICIENT_EVIDENCE') return { code: 'CHECK_NOTIFICATION', label: 'Read the official notification', priority: 4, reason: 'The record does not state a required rule, so no eligibility decision is made. ' + elig.summary };
  if (elig.overall === 'UNKNOWN') return { code: 'COMPLETE_PROFILE', label: 'Complete your profile', priority: 4, reason: 'Eligibility cannot be checked until more profile details are added.' };
  if (dl.status === 'UPCOMING') return { code: 'PREPARE_AHEAD', label: 'Prepare before it opens', priority: 3, reason: dl.label + '. Use the time to close skill gaps.' };
  const verify = elig.overall !== 'MATCH' ? ' Some eligibility details still need verification.' : '';
  if (!fit) return { code: 'CHECK_NOTIFICATION', label: 'Read the notification', priority: 2, reason: 'No skill-based stage could be derived; eligibility decides this post.' + verify };
  if (fit.score >= STRONG) return { code: 'APPLY_NOW', label: 'Strong fit — apply', priority: 0, reason: `Skills cover about ${Math.round(fit.score)}% of what this selection process tests.` + verify };
  if (fit.score >= GOOD) return { code: 'APPLY_AND_PREPARE', label: 'Apply and keep preparing', priority: 1, reason: `You cover about ${Math.round(fit.score)}% today; the remaining gap is closable in roughly ${ready.hours_needed} study hours.` + verify };
  return ready.feasible
    ? { code: 'BUILD_SKILLS', label: 'Build skills first', priority: 5, reason: `Large gap (${ready.hours_needed} study hours) but it fits the time available at ${ready.daily_minutes} min/day.` + verify }
    : { code: 'STRETCH', label: 'Stretch target', priority: 6, reason: `The gap (${ready.hours_needed} study hours) is larger than the time available at ${ready.daily_minutes} min/day. Consider a later cycle.` + verify };
}

function jobDoc(job, reqs) {
  return [job.title, job.summary, job.organization, job.domain, (job.education && job.education.label) || '', (job.selection || []).join(' '),
    reqs.map((r) => `${r.label} ${T.SKILLS[r.skill].aliases.slice(0, 4).join(' ')}`).join(' ')].join(' ');
}

// ---- main entry ------------------------------------------------------------------------------------
function matchJobs({ jobs, profile, skills, resumeText, now = new Date(), exams = [], syllabusByVersion = {}, options = {} }) {
  const o = { dailyMinutes: 120, includeClosed: false, limit: 50, ...options };
  const prof = normaliseProfile(profile);
  const prepared = (jobs || []).map((job) => {
    const ex = examFor(job, exams);
    const nodes = ex ? syllabusByVersion[ex.version_id || ex.id] : null;
    const req = deriveRequirements(job, { exams, syllabusNodes: nodes });
    return { job, req };
  });
  const aff = tfidfAffinity(resumeText, prepared.map((p) => jobDoc(p.job, p.req.requirements)));

  const rows = prepared.map(({ job, req }, i) => {
    const dl = deadlineInfo(job.dates, now);
    const elig = evaluate(job, prof);
    const fit = computeFit(req.requirements, skills || {});
    const ready = readiness(fit && fit.coverage, job, now, o.dailyMinutes);
    const action = decideAction({ dl, elig, fit, ready });
    const affinity = aff ? aff[i] : null;
    const eligScore = ELIG_SCORE[elig.overall];
    let bridge;
    if (fit) {
      const w = affinity == null ? { fit: WEIGHTS.fit + WEIGHTS.affinity, elig: WEIGHTS.elig, feas: WEIGHTS.feas, affinity: 0 } : WEIGHTS;
      bridge = 100 * (w.fit * fit.score / 100 + w.elig * eligScore + w.feas * ready.feasibility + w.affinity * (affinity || 0));
    } else bridge = 100 * (0.7 * eligScore + 0.3 * ready.feasibility);
    return {
      id: job.id, title: job.title, organization: job.organization, state: job.state, domain: job.domain, vacancies_total: job.vacancies && job.vacancies.total,
      deadline: { status: dl.status, label: dl.label, closes_exact: dl.closes_exact, opens_exact: dl.opens_exact, closes_ymd: dl.closes_ymd, ms_left: dl.ms_left },
      eligibility: { overall: elig.overall, summary: elig.summary, blockers: elig.rows.filter((r) => r.result === 'NOT_ELIGIBLE').map((r) => r.short), open: elig.rows.filter((r) => r.result === 'UNKNOWN' || r.result === 'CONDITIONAL').map((r) => r.short), asks: elig.rows.filter((r) => r.ask).map((r) => r.ask) },
      fit, readiness: ready, text_affinity: affinity == null ? null : r2(affinity),
      bridge_score: r1(Math.max(0, Math.min(100, bridge))), action,
      exam: req.exam, checkpoints: req.checkpoints, notes: req.notes, requirements_basis: req.requirements.some((r) => r.kind === 'STATED') ? 'STATED' : 'INFERRED',
      sample: !!job.sample,
    };
  });

  const open = rows.filter((r) => r.deadline.status !== 'CLOSED' && r.eligibility.overall !== 'NOT_ELIGIBLE');
  open.sort((a, b) => a.action.priority - b.action.priority || b.bridge_score - a.bridge_score || (a.deadline.ms_left || 0) - (b.deadline.ms_left || 0));
  const notEligible = rows.filter((r) => r.deadline.status !== 'CLOSED' && r.eligibility.overall === 'NOT_ELIGIBLE').sort((a, b) => b.bridge_score - a.bridge_score);
  const closed = o.includeClosed ? rows.filter((r) => r.deadline.status === 'CLOSED') : [];

  const profileAsks = [];
  const seen = new Set();
  for (const r of open) for (const a of r.eligibility.asks) if (!seen.has(a.field)) { seen.add(a.field); profileAsks.push(a); }

  const list = Object.values(skills || {});
  return {
    generated_at: now.toISOString(),
    weights: WEIGHTS,
    summary: {
      total_considered: rows.length, matches: open.length, apply_now: open.filter((r) => r.action.code === 'APPLY_NOW').length,
      apply_and_prepare: open.filter((r) => r.action.code === 'APPLY_AND_PREPARE').length, not_eligible: notEligible.length,
      closed: rows.filter((r) => r.deadline.status === 'CLOSED').length, skills_known: list.length, skills_verified: list.filter((s) => s.verified).length,
      eligibility_complete: !!(prof.education && prof.education.level && prof.dob),
    },
    matches: open.slice(0, o.limit), not_eligible: notEligible.slice(0, o.limit), closed,
    profile_asks: profileAsks,
    caveats: [
      'Eligibility is decided only by the deterministic engine, using the notification’s own rules. Skills never override it.',
      'Skill requirements marked “inferred” are derived from the selection process, not stated by the notification. Confirm sections in the official document.',
      'Skill levels come from your evidence. Self-declared and resume-derived levels are unverified claims and shown as such.',
    ],
  };
}

// ---- gap analysis ---------------------------------------------------------------------------------
function actionsFor(skillId, exam, syllabusByVersion) {
  const sk = T.SKILLS[skillId];
  const out = [];
  const c = sk.campus || {};
  if (c.aptitude || c.competencyCategories || c.competency || c.resultTypes) out.push({ type: 'CAMPUS_PRACTICE', label: sk.practice, href: '/campus/' });
  if (exam) {
    const nodes = (syllabusByVersion[exam.version_id] || []).filter((n) => skillsForNode(n).some(([id]) => id === skillId));
    if (nodes.length) out.push({ type: 'EXAM_LAB', label: `Study ${nodes.map((n) => n.title).join(', ')} (${exam.code})`, exam_version_id: exam.version_id, node_codes: nodes.map((n) => n.code) });
    out.push({ type: 'MOCK_TEST', label: `Take the ${exam.code} mock test`, exam_version_id: exam.version_id });
  }
  if (!out.length || !(c.aptitude || c.competencyCategories)) out.push({ type: 'SELF_STUDY', label: sk.practice });
  return out;
}

function gapAnalysis(result, skills, syllabusByVersion = {}, options = {}) {
  const pool = result.matches.filter((m) => m.fit && ['MATCH', 'PARTIAL_MATCH', 'CONDITIONALLY_ELIGIBLE', 'UNKNOWN', 'INSUFFICIENT_EVIDENCE'].includes(m.eligibility.overall));
  const jobW = (m) => (m.eligibility.overall === 'UNKNOWN' ? 0.5 : m.deadline.status === 'UPCOMING' ? 0.7 : 1);
  const per = new Map();
  for (const m of pool) {
    for (const c of m.fit.coverage) {
      const cur = per.get(c.skill) || { skill: c.skill, label: c.label, group: c.group, jobs: [], weighted_gap: 0, max_target: 0, exam: null };
      cur.jobs.push({ id: m.id, title: m.title, weight: c.weight, target: c.target, coverage: c.coverage, kind: c.kind });
      cur.weighted_gap += jobW(m) * c.weight * (1 - c.coverage);
      cur.max_target = Math.max(cur.max_target, c.target);
      if (!cur.exam && m.exam) cur.exam = m.exam;
      per.set(c.skill, cur);
    }
  }
  const out = [];
  for (const g of per.values()) {
    const st = stateOf(skills, g.skill);
    const gapNow = Math.max(0, g.max_target - st.est);
    if (gapNow <= 0.01 && st.known) continue;
    // What-if: lift just this skill to its highest required target and see which jobs move up a tier.
    let toStrong = 0, toGood = 0, gain = 0;
    for (const m of pool) {
      const hit = m.fit.coverage.find((c) => c.skill === g.skill);
      if (!hit) continue;
      const add = hit.weight * (1 - hit.coverage) * 100;
      const after = m.fit.score + add;
      gain += add;
      if (m.fit.score < STRONG && after >= STRONG) toStrong++;
      else if (m.fit.score < GOOD && after >= GOOD) toGood++;
    }
    const hours = Math.round(T.SKILLS[g.skill].hours * (g.max_target ? gapNow / g.max_target : 0));
    const priority = (toStrong * 3 + toGood * 1.5 + g.weighted_gap * 10) / (hours / 50 + 1);
    out.push({
      skill: g.skill, label: g.label, group: g.group,
      current_level: st.known ? r2(st.est) : null, target_level: r2(g.max_target), known: st.known, verified: st.verified, confidence: st.confidence,
      demand: g.jobs.length, jobs: g.jobs.slice(0, 8), hours_to_close: hours,
      unlocks: { to_strong: toStrong, to_good: toGood, total_score_gain: r1(gain) },
      impact_per_50h: r2(priority),
      actions: actionsFor(g.skill, g.exam, syllabusByVersion),
      advice: !st.known
        ? 'No evidence yet. Take a Campus diagnostic or declare your level so Bridge can stop assuming the worst.'
        : st.verified ? 'Tested evidence shows a gap; practise this next.' : 'Currently an unverified claim; a tested result will make this reliable.',
    });
  }
  out.sort((a, b) => b.impact_per_50h - a.impact_per_50h);
  return { generated_at: result.generated_at, considered_jobs: pool.length, skills: out, plan: studyBlocks(out, options.dailyMinutes || 120) };
}

function studyBlocks(gaps, dailyMinutes) {
  const top = gaps.filter((g) => g.hours_to_close > 0).slice(0, 3);
  if (!top.length) return { daily_minutes: dailyMinutes, blocks: [], note: 'No open skill gaps among the opportunities you are eligible for.' };
  const totalPriority = top.reduce((s, g) => s + Math.max(g.impact_per_50h, 0.1), 0);
  const blocks = top.map((g) => {
    const share = Math.max(g.impact_per_50h, 0.1) / totalPriority;
    const minutes = Math.max(15, Math.round((dailyMinutes * share) / 5) * 5);
    const weeks = Math.ceil(g.hours_to_close / ((minutes / 60) * 6));
    return { skill: g.skill, label: g.label, minutes_per_day: minutes, weeks_to_target: weeks, hours_total: g.hours_to_close };
  });
  return { daily_minutes: dailyMinutes, blocks, note: 'Six study days a week are assumed. Re-run Bridge after new Campus tests to refresh this.' };
}

// ---- single job explanation -----------------------------------------------------------------------
function explainJob(match, ctx) {
  const { resumeText, syllabusByVersion = {}, skills = {} } = ctx || {};
  const cov = (match.fit && match.fit.coverage) || [];
  const lower = String(resumeText || '').toLowerCase();
  const gaps = cov.filter((c) => c.status === 'GAP' || c.status === 'UNKNOWN').map((c) => ({
    skill: c.skill, label: c.label, status: c.status, level: c.level, target: c.target, weight: c.weight,
    actions: actionsFor(c.skill, match.exam, syllabusByVersion),
  }));
  const strengths = cov.filter((c) => c.status === 'MET' || c.status === 'CLOSE').map((c) => ({ skill: c.skill, label: c.label, level: c.level, status: c.status, evidence: c.evidence }));
  const resumeRelevant = /shortlist|interview|presentation|board/i.test((match.checkpoints || []).map((c) => c.label).join(' ') + ' ' + (match.notes || []).join(' ')) || ['research', 'defence'].includes(match.domain);
  const keywordGaps = cov.filter((c) => c.status !== 'MET').map((c) => ({ skill: c.skill, label: c.label, suggest: T.SKILLS[c.skill].aliases.filter((a) => !lower.includes(a)).slice(0, 3) })).filter((k) => k.suggest.length);
  return {
    ...match, gaps, strengths,
    resume: {
      relevant: resumeRelevant,
      note: resumeRelevant ? 'This selection stage uses your profile or an interview, so a tailored resume helps.' : 'Applications for this post are made on the official form; a resume is rarely used. Evidence of skills matters through the exam, not the CV.',
      keywords_to_evidence: resumeRelevant ? keywordGaps : [],
    },
    skill_levels: Object.fromEntries(cov.map((c) => [c.skill, c.level])),
    unscored_skills: Object.keys(skills).filter((id) => !cov.some((c) => c.skill === id)).length,
  };
}

// Compare two match runs (what-if / progress). Returns movements that matter to a person.
function diffMatches(before, after) {
  const bm = new Map(before.matches.map((m) => [m.id, m]));
  const moved = [];
  for (const a of after.matches) {
    const b = bm.get(a.id);
    if (!b) { moved.push({ id: a.id, title: a.title, change: 'NEW', after: a.action.code, score_after: a.bridge_score }); continue; }
    if (b.action.code !== a.action.code || Math.abs(b.bridge_score - a.bridge_score) >= 1) {
      moved.push({ id: a.id, title: a.title, change: b.action.code !== a.action.code ? 'ACTION' : 'SCORE', before: b.action.code, after: a.action.code, score_before: b.bridge_score, score_after: a.bridge_score, delta: r1(a.bridge_score - b.bridge_score) });
    }
  }
  return moved.sort((x, y) => (y.delta || 0) - (x.delta || 0));
}

module.exports = { matchJobs, gapAnalysis, explainJob, diffMatches, computeFit, readiness, tfidfAffinity, normaliseProfile, stateOf, WEIGHTS, STRONG, GOOD };
