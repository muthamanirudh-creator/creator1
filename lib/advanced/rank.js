'use strict';
// Opportunity Decision Matrix: transparent weighted scoring. Not a probability of selection. Each criterion shows
// its raw value, a 0-100 score and its weight; criteria with unknown inputs are excluded and weights renormalised.
const C = require('./common');
const { evaluate } = require('../eligibility');
const { runwayFor } = require('./age');
const { lifecycle } = require('./planner');

const DEFAULT_WEIGHTS = { eligibility: 30, time_to_apply: 15, prep_time: 15, seats: 20, cost: 5, age_comfort: 15 };
const ELIG_SCORE = { MATCH: 100, PARTIAL_MATCH: 70, CONDITIONALLY_ELIGIBLE: 55, UNKNOWN: 40, INSUFFICIENT_EVIDENCE: 40, NOT_ELIGIBLE: 0 };

function seatsFor(job, p) {
  const v = job.vacancies || {}, b = v.breakdown || {};
  let seats = b.UR || 0; const parts = [];
  if (b.UR) parts.push(`UR ${b.UR}`);
  if (p.category && p.category !== 'General' && b[p.category]) { seats += b[p.category]; parts.push(`${p.category} ${b[p.category]}`); }
  if (p.category === 'EWS' && b.EWS && !parts.some((x) => x.startsWith('EWS'))) { seats += b.EWS; parts.push(`EWS ${b.EWS}`); }
  if (p.pwbd && v.pwbd) { seats += v.pwbd; parts.push(`PwBD ${v.pwbd}`); }
  if ((p.exServicemen || p.exServiceman) && v.ex_servicemen) { seats += v.ex_servicemen; parts.push(`Ex-servicemen ${v.ex_servicemen}`); }
  if (!b.UR && v.total) return { seats: v.total, label: `${v.total} total (breakdown not published)` };
  return { seats, label: parts.join(' + ') || null };
}
function criteria(job, p, now) {
  const today = C.todayYMD(now), close = C.closeDate(job), exam = C.examDate(job);
  const ev = evaluate(job, p);
  const out = {};
  out.eligibility = { raw: ev.overall, score: ELIG_SCORE[ev.overall], note: ev.summary };
  if (close) { const d = C.daysBetween(today, close); out.time_to_apply = { raw: d, score: d < 0 ? 0 : C.clamp((d / 30) * 100, 5, 100), note: d < 0 ? 'Applications are closed.' : `${d} day(s) left to apply.` }; }
  else out.time_to_apply = null;
  if (exam) { const d = C.daysBetween(today, exam); out.prep_time = { raw: d, score: d < 0 ? 0 : C.clamp((d / 90) * 100, 0, 100), note: d < 0 ? 'Exam date has passed.' : `${d} day(s) until the exam.` }; }
  else out.prep_time = null;
  const s = seatsFor(job, p);
  out.seats = s.seats > 0 ? { raw: s.seats, score: C.clamp((Math.log10(s.seats) / Math.log10(30000)) * 100, 0, 100), note: `Seats open to your profile: ${s.label}.` } : null;
  const fee = C.feeFor(job, p);
  out.cost = fee.amount == null ? null : { raw: fee.amount, score: C.clamp(100 - (fee.amount / 1000) * 100, 0, 100), note: `Fee ${fee.label} (${fee.column} column).` };
  const rw = runwayFor(job, p, now);
  out.age_comfort = rw && rw.status === 'ELIGIBLE_BY_AGE' ? { raw: rw.margin_days_after_cutoff, score: C.clamp((rw.margin_days_after_cutoff / (365 * 5)) * 100, 10, 100), note: `Age limit leaves about ${Math.round(rw.margin_days_after_cutoff / 365 * 10) / 10} year(s) after the cutoff date.` } : (rw && rw.status !== 'ELIGIBLE_BY_AGE' ? { raw: 0, score: 0, note: 'Age rule not met.' } : null);
  return { out, ev };
}
function score(out, weights) {
  let wsum = 0, total = 0; const used = {}, skipped = [];
  for (const k of Object.keys(weights)) {
    const w = Math.max(0, Number(weights[k]) || 0);
    if (!out[k]) { skipped.push(k); continue; }
    wsum += w; total += w * out[k].score; used[k] = w;
  }
  return { score: wsum ? C.round1(total / wsum) : 0, used, skipped, wsum };
}
function rankJobs(jobs, profile, opts = {}) {
  const now = opts.now || new Date(), today = C.todayYMD(now);
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const rows = [];
  for (const j of jobs) {
    const lc = lifecycle(j, today);
    const { out, ev } = criteria(j, profile, now);
    const sc = score(out, weights);
    const blocked = ev.overall === 'NOT_ELIGIBLE' || lc === 'CLOSED';
    rows.push({ job_id: j.id, title: j.title, organization: j.organization, lifecycle: lc, eligibility: ev.overall, blocked, score: blocked ? 0 : sc.score, raw_score: sc.score, criteria: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v ? { ...v, weight: sc.used[k] ?? 0, weight_share: sc.wsum ? C.round1(((sc.used[k] || 0) / sc.wsum) * 100) : 0 } : { excluded: true, reason: 'No verified value for this criterion; its weight was redistributed.' }])), excluded_criteria: sc.skipped, basis: { eligibility: ev.rows.map((r) => ({ key: r.key, result: r.result, source: r.source })) } });
  }
  rows.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  rows.forEach((r, i) => { r.rank = r.blocked ? null : i + 1; r.tier = r.blocked ? 'BLOCKED' : r.score >= 75 ? 'A' : r.score >= 55 ? 'B' : 'C'; });
  // Sensitivity: does the job stay in the top 3 when each weight is halved or raised by half?
  const live = rows.filter((r) => !r.blocked);
  if (live.length > 1 && !opts.skipSensitivity) {
    const counts = Object.fromEntries(live.map((r) => [r.job_id, 0])); let runs = 0;
    for (const k of Object.keys(weights)) for (const m of [0.5, 1.5]) {
      const w = { ...weights, [k]: weights[k] * m }; runs++;
      const ranked = live.map((r) => ({ id: r.job_id, s: score(Object.fromEntries(Object.entries(r.criteria).map(([ck, cv]) => [ck, cv.excluded ? null : { score: cv.score }])), w).score })).sort((a, b) => b.s - a.s).slice(0, 3);
      ranked.forEach((x) => { counts[x.id]++; });
    }
    live.forEach((r) => { r.top3_stability = C.round1((counts[r.job_id] / runs) * 100); });
  }
  return { weights, default_weights: DEFAULT_WEIGHTS, rows, note: 'A planning aid. The score ranks fit and practicality using verified fields; it does not predict selection chances.' };
}
module.exports = { rankJobs, DEFAULT_WEIGHTS, seatsFor };
