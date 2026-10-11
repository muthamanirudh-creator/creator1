'use strict';
// Age Runway: how long each recruitment stays open to you by age, using the notification's own cutoff date
// and the relaxation it lists. Same rule as lib/eligibility.js (ineligible once completed years > upper limit).
const C = require('./common');

function addYears(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y + n, m - 1, d)).toISOString().slice(0, 10); }

function runwayFor(job, profile, now) {
  const a = job.age; if (!a || !profile.dob || !a.cutoff_date) return null;
  const rel = C.relaxationFor(job, profile);
  const max = a.max + rel.years, min = a.min;
  const age = C.ageOn(profile.dob, a.cutoff_date);
  const turnsOverOn = addYears(profile.dob, max + 1);            // first day at which completed years > max
  const lastEligibleCutoff = C.addDays(turnsOverOn, -1);          // last cutoff date that still passes
  const reachesMinOn = addYears(profile.dob, min);
  let status = 'ELIGIBLE_BY_AGE';
  if (age.years < min) status = 'TOO_YOUNG'; else if (age.years > max) status = 'OVER_AGE';
  const today = C.todayYMD(now);
  const marginDays = C.daysBetween(a.cutoff_date, lastEligibleCutoff);
  // Future yearly cutoffs (same month and day) that still fall on or before the last eligible cutoff.
  const cyclesLeft = status === 'ELIGIBLE_BY_AGE' ? Math.max(0, Math.floor(marginDays / 365.25)) : 0;
  let urgency = 'COMFORTABLE';
  if (status !== 'ELIGIBLE_BY_AGE') urgency = status;
  else if (cyclesLeft === 0) urgency = 'LAST_CHANCE_WINDOW';
  else if (cyclesLeft <= 2) urgency = 'FEW_CYCLES_LEFT';
  return {
    job_id: job.id, title: job.title, status, urgency,
    age_at_cutoff: `${age.years}y ${age.months}m`, cutoff_date: a.cutoff_date,
    official_range: `${min}-${a.max}`, your_upper_limit: max, relaxation_applied: rel.parts,
    ages_out_on: status === 'OVER_AGE' ? null : turnsOverOn,
    last_eligible_cutoff: status === 'OVER_AGE' ? null : lastEligibleCutoff,
    becomes_eligible_on: status === 'TOO_YOUNG' ? reachesMinOn : null,
    days_to_age_out: status === 'OVER_AGE' ? null : C.daysBetween(today, turnsOverOn),
    margin_days_after_cutoff: marginDays,
    cycles_left_if_same_cutoff_repeats: cyclesLeft,
    basis: C.sourceOf(job, 'age'),
    note: 'Assumes a future notification keeps the same age limits and cutoff month-day; real notifications vary. Verify in the notification.',
  };
}
function runway(jobs, profile, now) {
  const rows = jobs.map((j) => runwayFor(j, profile, now)).filter(Boolean);
  const order = { LAST_CHANCE_WINDOW: 0, FEW_CYCLES_LEFT: 1, COMFORTABLE: 2, TOO_YOUNG: 3, OVER_AGE: 4 };
  rows.sort((x, y) => (order[x.urgency] - order[y.urgency]) || ((x.days_to_age_out ?? 1e9) - (y.days_to_age_out ?? 1e9)));
  const eligible = rows.filter((r) => r.status === 'ELIGIBLE_BY_AGE');
  return {
    rows,
    summary: {
      eligible_by_age: eligible.length, over_age: rows.filter((r) => r.status === 'OVER_AGE').length, too_young: rows.filter((r) => r.status === 'TOO_YOUNG').length,
      earliest_age_out: eligible.length ? eligible.reduce((m, r) => (r.ages_out_on < m.ages_out_on ? r : m)) : null,
      last_chance: eligible.filter((r) => r.urgency === 'LAST_CHANCE_WINDOW').map((r) => r.job_id),
    },
  };
}
module.exports = { runway, runwayFor, addYears };
