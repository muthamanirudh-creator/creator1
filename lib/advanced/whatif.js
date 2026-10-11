'use strict';
// What-if scenarios: re-run the same eligibility engine on altered profiles and show which recruitments open or close.
const { evaluate } = require('../eligibility');
const C = require('./common');

const NEXT_LEVEL = { '8th': '10th', '10th': '12th', '12th': 'bachelor', iti: 'diploma', diploma: 'bachelor', bachelor: 'master', master: 'phd' };
const shiftDob = (dob, years) => { const [y, m, d] = dob.split('-').map(Number); return new Date(Date.UTC(y - years, m - 1, d)).toISOString().slice(0, 10); };
function defaults(p) {
  const out = [];
  const lvl = p.education && p.education.level;
  if (lvl && NEXT_LEVEL[lvl]) out.push({ label: `Complete the next level (${NEXT_LEVEL[lvl]})`, patch: { education: { ...p.education, level: NEXT_LEVEL[lvl], status: 'completed' } } });
  if (p.education && p.education.status === 'final_year') out.push({ label: 'Final-year course completed', patch: { education: { ...p.education, status: 'completed' } } });
  if (p.dob) out.push({ label: 'One year older at the same cutoff dates', patch: { dob: shiftDob(p.dob, 1) }, caveat: 'Future notifications may use different limits or cutoff dates.' });
  out.push({ label: '+2 years of experience', patch: { experienceYears: (p.experienceYears || 0) + 2 } });
  return out;
}
function run(jobs, base, scenarios) {
  const verdict = (p) => Object.fromEntries(jobs.map((j) => [j.id, evaluate(j, p).overall]));
  const ok = (v) => v === 'MATCH' || v === 'PARTIAL_MATCH' || v === 'CONDITIONALLY_ELIGIBLE';
  const b = verdict(base); const title = Object.fromEntries(jobs.map((j) => [j.id, j.title]));
  const baseOpen = Object.keys(b).filter((id) => ok(b[id]));
  return { base: { eligible_or_possible: baseOpen.length, total: jobs.length }, scenarios: (scenarios && scenarios.length ? scenarios : defaults(base)).slice(0, 8).map((s) => {
    const p = C.normProfile({ ...base, ...(s.patch || {}) }); const v = verdict(p);
    const opened = Object.keys(v).filter((id) => ok(v[id]) && !ok(b[id])), closed = Object.keys(v).filter((id) => !ok(v[id]) && ok(b[id]));
    return { label: String(s.label || 'Scenario').slice(0, 100), caveat: s.caveat || null, eligible_or_possible: Object.keys(v).filter((id) => ok(v[id])).length, net_change: opened.length - closed.length, opens: opened.map((id) => ({ job_id: id, title: title[id], now: v[id] })), closes: closed.map((id) => ({ job_id: id, title: title[id], was: b[id] })) };
  }) };
}
module.exports = { run, defaults };
