'use strict';
// Next-best-action engine (Advanced Strategy Suite). Deterministic and explainable: every action cites the data it
// came from, and nothing is invented. Missing inputs lower the confidence and are listed, never silently defaulted.
// Inputs (all optional, all supplied by the caller): profile, open jobs, attempts, sm2 revision states, applications.
const C = require('./common');
const { evaluate } = require('../eligibility');
const planner = require('./planner');
const analytics = require('./analytics');

const PROFILE_FIELDS = [
  ['dob', 'date of birth', 'age limits'],
  ['education', 'highest qualification', 'education rules'],
  ['category', 'category (General/OBC/SC/ST/EWS)', 'age relaxation and fees'],
  ['domicileState', 'domicile state', 'state-restricted vacancies'],
];
const DONE = new Set(['APPLIED', 'SUBMITTED', 'COMPLETED', 'ADMIT_CARD', 'EXAM_DONE', 'WITHDRAWN']);
const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

const has = (v) => v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && !Object.keys(v).length);
const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function missingProfile(profile) {
  const out = [];
  for (const [key, label, why] of PROFILE_FIELDS) {
    const v = key === 'education' ? profile.education && profile.education.level : profile[key];
    if (!has(v)) out.push({ field: key, label, needed_for: why });
  }
  return out;
}

function deadlineActions(jobs, profile, apps, today, missing) {
  const acts = [];
  const appByJob = new Map((apps || []).filter((a) => a && a.job_id != null).map((a) => [String(a.job_id), a]));
  for (const j of jobs) {
    const close = C.closeDate(j); if (!close) continue;
    const life = planner.lifecycle(j, today); if (life === 'CLOSED') continue;
    const left = C.daysBetween(today, close); if (left < 0 || left > 14) continue;
    const app = appByJob.get(String(j.id)); if (app && DONE.has(String(app.status).toUpperCase())) continue;
    const ev = evaluate(j, profile);
    if (ev.overall === 'NOT_ELIGIBLE') continue;                       // never nag about vacancies the user cannot apply to
    const certain = ev.overall === 'MATCH';
    const sample = j.sample === true;                                    // demo/sample records are never presented as real vacancies
    const verified = !sample && !!(j.verification && j.verification.status === 'VERIFIED');
    acts.push({
      id: `deadline:${j.id}`, type: 'DEADLINE', view: 'opportunities', ref: { job_id: j.id },
      title: `${certain ? 'Apply' : 'Verify eligibility and apply'}: ${j.title || j.id}`,
      why: `Applications close in ${left} day${left === 1 ? '' : 's'} (${close}). ${ev.summary}`,
      evidence: [`Closing date ${close} from ${sample ? 'a SAMPLE (demo) record' : verified ? 'a verified record' : 'an UNVERIFIED record'}`, `Eligibility result: ${ev.overall}`, app ? `Tracker status: ${app.status}` : 'Not in your tracker yet'],
      urgency: left <= 2 ? 'CRITICAL' : left <= 5 ? 'HIGH' : 'MEDIUM',
      score: 1000 - left * 20 + (certain ? 60 : 0) - (verified ? 0 : 150),
      confidence: certain && verified && missing.length === 0 ? 'HIGH' : verified ? 'MEDIUM' : 'LOW',
      caveats: sample ? ['This is a sample record used to demonstrate the platform. It is not a real vacancy.'] : verified ? [] : ['This record is not verified. Confirm the date on the official notification before acting.'],
    });
  }
  return acts;
}

function resolveEligibilityActions(jobs, profile, today, missing) {
  // Opportunities that would become checkable if the user supplied the missing details.
  if (!missing.length) return [];
  const open = jobs.filter((j) => planner.lifecycle(j, today) !== 'CLOSED');
  const unknown = open.filter((j) => { const o = evaluate(j, profile).overall; return o === 'UNKNOWN' || o === 'PARTIAL_MATCH' || o === 'CONDITIONALLY_ELIGIBLE'; });
  if (!unknown.length) return [];
  return [{
    id: 'profile:complete', type: 'PROFILE', view: 'opportunities',
    title: `Add ${missing.map((m) => m.label).join(', ')} to your profile`,
    why: `${unknown.length} open recruitment${unknown.length === 1 ? '' : 's'} cannot be fully checked until this is provided. Missing details stay "unable to determine"; they are never assumed.`,
    evidence: missing.map((m) => `Missing ${m.label} (used for ${m.needed_for})`),
    urgency: 'MEDIUM', score: 700 + Math.min(unknown.length, 20), confidence: 'HIGH', caveats: [],
  }];
}

function studyActions(input, today) {
  const acts = [];
  const attempts = Array.isArray(input.attempts) ? input.attempts.slice(0, 5000) : [];
  if (attempts.length) {
    const a = analytics.analyse({ attempts, marks_correct: input.marks_correct, marks_wrong: input.marks_wrong });
    const weak = a.topics.filter((t) => t.attempted >= 5 && t.advice === 'AVOID_GUESSING_AND_REVISE').slice(0, 3);
    weak.forEach((t, i) => acts.push({
      id: `weak:${t.topic}`, type: 'REVISE_TOPIC', view: 'exams',
      title: `Revise ${t.topic} before more mock tests`,
      why: `${t.correct} of ${t.attempted} attempted questions correct (${t.accuracy_pct}%, 95% interval ${t.accuracy_95ci_pct.join('–')}%). That is below the break-even accuracy of ${a.overall.break_even_accuracy_pct}% for the marking scheme used.`,
      evidence: [`${t.attempted} attempted, ${t.skipped} skipped`, 'Wilson 95% confidence interval on your own answers'],
      urgency: 'MEDIUM', score: 600 - i * 10 + (100 - (t.accuracy_pct || 0)) / 10, confidence: t.attempted >= 15 ? 'HIGH' : 'MEDIUM',
      caveats: t.attempted < 15 ? ['Small sample: results can change quickly with more practice.'] : [],
    }));
    const thin = a.topics.filter((t) => t.attempted > 0 && t.attempted < 5).slice(0, 2);
    thin.forEach((t) => acts.push({
      id: `data:${t.topic}`, type: 'GATHER_EVIDENCE', view: 'exams',
      title: `Answer at least 5 questions on ${t.topic}`,
      why: `Only ${t.attempted} answered so far, which is too few to judge mastery. No weakness or strength is claimed yet.`,
      evidence: [`${t.attempted} attempted`], urgency: 'LOW', score: 300, confidence: 'HIGH', caveats: [],
    }));
    if (a.trend && a.trend.direction === 'DECLINING') acts.push({
      id: 'trend:declining', type: 'REVIEW_APPROACH', view: 'exams', title: 'Your recent mock scores are trending down. Review mistakes before the next test',
      why: `Slope ${a.trend.slope_per_test} marks per test across ${a.trend.points} tests (a straight-line fit, not a prediction).`,
      evidence: [`${a.trend.points} test scores supplied`], urgency: 'MEDIUM', score: 550, confidence: a.trend.points >= 4 ? 'MEDIUM' : 'LOW',
      caveats: ['Few data points: treat the trend as a signal to look at, not a conclusion.'],
    });
  }
  const states = input.revision_states && typeof input.revision_states === 'object' ? Object.entries(input.revision_states).slice(0, 500) : [];
  const due = states.filter(([, s]) => s && isYMD(s.due) && s.due <= today).map(([topic, s]) => ({ topic, overdue: C.daysBetween(s.due, today) }))
    .sort((x, y) => y.overdue - x.overdue);
  if (due.length) acts.push({
    id: 'revision:due', type: 'SPACED_REVISION', view: 'exams', title: `Revise ${due.length} topic${due.length === 1 ? '' : 's'} due today or overdue`,
    why: `Spaced-repetition schedule: ${due.slice(0, 3).map((d) => `${d.topic} (${d.overdue}d overdue)`).join(', ')}${due.length > 3 ? ` and ${due.length - 3} more` : ''}.`,
    evidence: ['Intervals come from the SM-2 states you saved'], urgency: due[0].overdue > 7 ? 'HIGH' : 'MEDIUM', score: 650 + Math.min(due.length, 10), confidence: 'HIGH', caveats: [],
  });
  return acts;
}

function nextActions(input, { jobs, today }) {
  const profile = C.normProfile(input.profile || {});
  const missing = missingProfile(profile);
  const apps = Array.isArray(input.applications) ? input.applications.slice(0, 500) : [];
  const acts = [
    ...deadlineActions(jobs, profile, apps, today, missing),
    ...resolveEligibilityActions(jobs, profile, today, missing),
    ...studyActions(input, today),
  ];
  acts.sort((a, b) => b.score - a.score || (CONF_RANK[b.confidence] - CONF_RANK[a.confidence]) || String(a.id).localeCompare(String(b.id)));
  const have = {
    profile: PROFILE_FIELDS.length - missing.length, profile_total: PROFILE_FIELDS.length,
    practice_attempts: Array.isArray(input.attempts) ? input.attempts.length : 0,
    revision_states: input.revision_states && typeof input.revision_states === 'object' ? Object.keys(input.revision_states).length : 0,
    tracked_applications: apps.length,
  };
  const completeness = C.round1(((have.profile / have.profile_total) + (have.practice_attempts ? 1 : 0) + (have.tracked_applications ? 1 : 0)) / 3 * 100);
  const notes = [];
  if (!have.practice_attempts) notes.push('No practice results supplied, so no study recommendations are made.');
  if (!have.tracked_applications) notes.push('No tracker data supplied, so applications you already submitted may still be suggested.');
  if (!acts.length) notes.push('Nothing urgent found from the data supplied. This is not a guarantee that nothing needs attention.');
  return {
    today, actions: acts.slice(0, Math.min(Math.max(Number(input.limit) || 8, 1), 20)).map(({ score, ...a }) => a),
    total_candidates: acts.length, data_completeness_pct: completeness, data_used: have, missing_profile_fields: missing, notes,
    disclaimer: 'Suggestions are rule-based on the data you supplied and on verified records. They are not predictions and do not guarantee eligibility, selection or employment.',
  };
}

module.exports = { nextActions, missingProfile };
