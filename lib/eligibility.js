// Deterministic eligibility engine. Compares a user profile against structured, verified job rules.
// It never assumes qualification equivalency, never infers category, and never uses "today" for age
// when the notification specifies a cutoff date.
const { ageOn, ageText, formatYMD } = require('./dates');

const ACADEMIC = { '8th': 8, '10th': 10, '12th': 12, bachelor: 15, master: 17, phd: 20 };
const LEVEL_LABEL = { '8th': '8th pass', '10th': '10th pass', '12th': '12th pass', iti: 'ITI', diploma: 'Diploma', bachelor: "Bachelor's degree", master: "Master's degree", phd: 'PhD' };
const FIELD_LABEL = { engineering: 'Engineering / Technology', science: 'Science', commerce: 'Commerce / Business', arts: 'Arts / Humanities', medical: 'Medical / Pharmacy', law: 'Law', education: 'Education (B.Ed)', computer_applications: 'Computer Applications', other: 'Other' };
const rank = (l) => (l in ACADEMIC ? ACADEMIC[l] : null);
const has = (v) => v !== undefined && v !== null && v !== '';

function row(key, label, official, yours, result, note, extra = {}) {
  return { key, label, official, yours, result, note, ...extra };
}

function evalEducation(job, p) {
  const e = job.education, u = p.education || {};
  if (!e || !Array.isArray(e.accepted) || !e.accepted.length) return row('education', 'Education', 'Not recorded', u.level ? LEVEL_LABEL[u.level] || String(u.level) : 'Not provided', 'INSUFFICIENT_EVIDENCE', 'The record does not state the required qualification, so no decision is made. Check the official notification.', { short: 'Qualification not recorded in the notice' });
  const official = e.label;
  if (!u.level) return row('education', 'Education', official, 'Not provided', 'UNKNOWN', 'Add your highest qualification.', { short: 'Qualification not provided' });
  const yours = LEVEL_LABEL[u.level] + (u.status === 'final_year' ? ' (final year)' : '');
  const canBePursuing = !['8th', '10th', '12th'].includes(u.level);
  const pursuing = u.status === 'final_year' && canBePursuing;

  if (e.accepted.includes(u.level)) {
    if (pursuing) {
      return e.allow_final_year
        ? row('education', 'Education', official, yours, 'CONDITIONAL', 'Final-year candidates may apply only if the notification’s completion condition is met by the stated date.', { short: 'Final-year condition applies' })
        : row('education', 'Education', official, yours, 'NOT_ELIGIBLE', 'The notification requires the qualification to be completed. Final-year candidates are not listed as eligible.', { short: 'Qualification must be completed' });
    }
    return row('education', 'Education', official, yours, 'MATCH', 'Your qualification is listed in the notification.');
  }
  if (e.or_higher && rank(u.level) != null && e.accepted.some((a) => rank(a) != null && rank(u.level) > rank(a))) {
    return row('education', 'Education', official, yours, 'MATCH', 'The notification accepts higher qualifications (“or higher”).');
  }
  const minReq = Math.min(...e.accepted.map((a) => (rank(a) != null ? rank(a) : 11)));
  if (rank(u.level) != null && rank(u.level) < minReq) {
    return row('education', 'Education', official, yours, 'NOT_ELIGIBLE', 'Your highest qualification is below the minimum in the notification.', { short: 'Qualification below requirement' });
  }
  return row('education', 'Education', official, yours, 'UNKNOWN', 'Qualification equivalency could not be verified. Check the notification or the recruiting body.', { short: 'Equivalency not verified' });
}

function evalField(job, p, eduRow) {
  const e = job.education;
  if (!e || !e.fields || e.fields.includes('any') || eduRow.result === 'NOT_ELIGIBLE') return null;
  const official = e.fields.map((f) => FIELD_LABEL[f] || f).join(', ');
  const f = (p.education || {}).field;
  if (!f) return row('field', 'Degree stream', official, 'Not provided', 'UNKNOWN', 'Tell us your stream to check this.', { short: 'Stream not provided', ask: { field: 'field', prompt: 'What was your degree or diploma stream?' } });
  if (e.fields.includes(f)) return row('field', 'Degree stream', official, FIELD_LABEL[f], 'MATCH', 'Your stream is listed.');
  return row('field', 'Degree stream', official, FIELD_LABEL[f], 'UNKNOWN', 'Your stream is not listed and equivalency could not be verified.', { short: 'Stream not listed' });
}

function evalSubjects(job, p, eduRow) {
  const req = job.education && job.education.subjects;
  if (!req || !req.length || eduRow.result === 'NOT_ELIGIBLE') return null;
  const official = req.join(', ');
  if (!p.subjectsKnown) return row('subjects', 'Subjects', official, 'Not provided', 'UNKNOWN', 'This recruitment requires specific subjects.', { short: `Subjects needed: ${official}`, ask: { field: 'subjects', options: req, prompt: `Did you study these subjects${job.education.subjects_stage ? ' in ' + job.education.subjects_stage : ''}?` } });
  const have = new Set(p.subjects || []);
  const missing = req.filter((s) => !have.has(s));
  return missing.length
    ? row('subjects', 'Subjects', official, [...have].join(', ') || 'None of these', 'NOT_ELIGIBLE', `Missing required subject${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`, { short: `Missing subject: ${missing.join(', ')}` })
    : row('subjects', 'Subjects', official, req.join(', '), 'MATCH', 'All required subjects are present.');
}

// Real calendar date check: "2000-02-31" is not a date. (Date.UTC would silently roll it to March.)
function isRealYMD(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Which relaxations did the candidate claim, and what do they come to under each way of combining them?
// Notifications differ (some add category + PwBD, some give only the highest), and the record rarely says which.
function relaxationScenarios(a, p) {
  const rel = a.relaxation || {}; const parts = [];
  if (p.category && rel[p.category]) parts.push([p.category, rel[p.category]]);
  if (p.pwbd && rel.PwBD) parts.push(['PwBD', rel.PwBD]);
  if ((p.exServicemen || p.exServiceman) && rel.ExServicemen) parts.push(['Ex-servicemen', rel.ExServicemen]);
  const additive = parts.reduce((x, [, n]) => x + n, 0), highest = parts.reduce((x, [, n]) => Math.max(x, n), 0);
  return { parts, additive, highest, rule: a.relaxation_rule === 'HIGHEST' ? 'HIGHEST' : a.relaxation_rule === 'ADDITIVE' ? 'ADDITIVE' : null };
}

// "Not exceeding N years" (default) means completed years <= N. "Must not have attained N years" means completed years <= N-1.
const effectiveMax = (a) => (a.max_kind === 'MUST_NOT_HAVE_ATTAINED' ? a.max - 1 : a.max);

function evalAge(job, p) {
  const a = job.age;
  if (!a || !Number.isInteger(a.min) || !Number.isInteger(a.max) || !isRealYMD(a.cutoff_date)) return row('age', 'Age', 'Not recorded', p.dob || 'Not provided', 'INSUFFICIENT_EVIDENCE', 'The record does not state the age limits and the official cutoff date, so age cannot be decided. Check the official notification.', { short: 'Age rule not recorded in the notice' });
  const official = `${a.min}–${a.max} years as on ${formatYMD(a.cutoff_date)}`;
  if (!p.dob) return row('age', 'Age', official, 'Date of birth not provided', 'UNKNOWN', 'Age is calculated on the notification’s cutoff date, so we need your date of birth.', { short: 'Date of birth needed', ask: { field: 'dob', prompt: 'What is your date of birth?' } });
  if (!isRealYMD(p.dob)) return row('age', 'Age', official, String(p.dob), 'UNKNOWN', 'The date of birth is not a valid calendar date (use YYYY-MM-DD).', { short: 'Date of birth is not a valid date', ask: { field: 'dob', prompt: 'What is your date of birth?' } });
  if (p.dob > a.cutoff_date) return row('age', 'Age', official, `Born ${formatYMD(p.dob)}`, 'NOT_ELIGIBLE', `You were born after the cutoff date (${formatYMD(a.cutoff_date)}), so you had not been born on the date age is counted.`, { short: 'Born after the age cutoff date' });
  const age = ageOn(p.dob, a.cutoff_date);
  const sc = relaxationScenarios(a, p);
  const base = effectiveMax(a);
  const maxAdd = base + sc.additive, maxHi = base + sc.highest;
  const asOf = `Age calculated as of ${formatYMD(a.cutoff_date)}: ${ageText(age)}.`;
  const yours = `${age.years} years ${age.months} months`;
  const partsText = sc.parts.map(([k, n]) => `${k} +${n}`).join(', ');
  // The limit that applies: the notification's own rule if recorded; otherwise the cautious (highest-only) limit, with the additive limit as the optimistic one.
  const ruled = sc.rule === 'ADDITIVE' ? maxAdd : sc.rule === 'HIGHEST' ? maxHi : null;
  const relaxNote = sc.parts.length ? ` Relaxation as listed in the notification (${partsText}); ${sc.rule ? `rule recorded: ${sc.rule === 'ADDITIVE' ? 'added together' : 'highest only'}; upper limit ${ruled}` : sc.parts.length > 1 ? `upper limit is ${maxHi} if only the highest applies, or ${maxAdd} if they are added` : `upper limit ${maxHi}`}.${sc.parts.length > 1 && !sc.rule ? ' The notification’s rule for combining them is not recorded, so verify it.' : ' Verify against the notification.'}` : '';
  const extra = { rule_detail: { min: a.min, max: a.max, effective_max: base, relaxation_applied: sc.parts, upper_limit_highest_only: maxHi, upper_limit_additive: maxAdd, cutoff_date: a.cutoff_date, age_years: age.years, age_months: age.months, age_days: age.days } };
  // Born on 29 Feb, cutoff on 28 Feb of a non-leap year: the person completes the year on 1 March (used here), but some bodies
  // count 28 Feb. If the two conventions give different verdicts, say so instead of picking one silently.
  if (p.dob.slice(5) === '02-29' && a.cutoff_date.slice(5) === '02-28') {
    const alt = age.years + 1, lim = ruled != null ? ruled : maxAdd;
    const v = (yrs) => (yrs < a.min ? 'LOW' : yrs > lim ? 'HIGH' : 'OK');
    if (v(age.years) !== v(alt)) return row('age', 'Age', official, yours, 'CONDITIONAL', asOf + ` Born on 29 February: the year is counted complete on 1 March here (age ${age.years}); if the notice counts 28 February the age is ${alt}, which changes the result. Verify the notice.`, { short: 'Leap-day birthday: result depends on the counting rule', ...extra });
  }
  if (age.years < a.min) return row('age', 'Age', official, yours, 'NOT_ELIGIBLE', asOf + ' Below the minimum age.', { short: 'Below minimum age', ...extra });
  const limit = ruled != null ? ruled : maxHi;
  if (age.years > (ruled != null ? ruled : maxAdd)) return row('age', 'Age', official, yours, 'NOT_ELIGIBLE', asOf + ' Above the upper age limit.' + relaxNote, { short: 'Above upper age limit', ...extra });
  if (ruled == null && age.years > maxHi) return row('age', 'Age', official, yours, 'CONDITIONAL', asOf + ' Within the limit only if the relaxations are added together.' + relaxNote, { short: 'Age fits only if relaxations are added', ...extra });
  return row('age', 'Age', official, yours, 'MATCH', asOf + relaxNote, extra);
}

function evalExperience(job, p) {
  const need = job.experience_years || 0;
  if (!need) return null;
  const official = `${need}+ years`;
  if (!has(p.experienceYears)) return row('experience', 'Experience', official, 'Not provided', 'UNKNOWN', 'Add your relevant work experience.', { short: 'Experience not provided', ask: { field: 'experience', prompt: 'How many years of relevant experience do you have?' } });
  return p.experienceYears >= need
    ? row('experience', 'Experience', official, `${p.experienceYears} years`, 'MATCH', 'Meets the minimum. Confirm the experience counts as “relevant” in the notification.')
    : row('experience', 'Experience', official, `${p.experienceYears} years`, 'NOT_ELIGIBLE', 'Below the minimum experience.', { short: 'Experience below minimum' });
}

function evalDomicile(job, p) {
  const d = job.domicile;
  if (!d || !d.type) return row('domicile', 'State / domicile', 'Not recorded', p.domicileState || 'Not provided', 'INSUFFICIENT_EVIDENCE', 'The record does not state a domicile condition, so no decision is made. Check the official notification.', { short: 'Domicile rule not recorded in the notice' });
  if (d.type === 'ALL_INDIA') return row('domicile', 'State / domicile', 'Open to all India', 'Any state', 'MATCH', 'No domicile condition in the notification.');
  const official = `Domicile of ${d.state} required`;
  if (!has(p.domicileState)) return row('domicile', 'State / domicile', official, 'Not provided', 'UNKNOWN', 'Living in a state does not automatically mean you hold its domicile. Tell us if you have a domicile certificate.', { short: `Domicile of ${d.state} needed`, ask: { field: 'domicile', prompt: 'Which state’s domicile certificate do you hold?' } });
  if (p.domicileState === d.state) return row('domicile', 'State / domicile', official, `${d.state} domicile`, 'MATCH', 'Your stated domicile matches. You will need the certificate at document verification.');
  return row('domicile', 'State / domicile', official, p.domicileState === 'none' ? 'No domicile certificate' : `${p.domicileState} domicile`, 'NOT_ELIGIBLE', `The notification requires ${d.state} domicile.`, { short: `Needs ${d.state} domicile` });
}

function evalPhysical(job) {
  if (!job.physical) return null;
  return row('physical', 'Physical standards', job.physical, 'Check yourself', 'UNKNOWN', 'Physical standards apply. We do not assess these. Confirm against the notification.', { short: 'Physical standards apply' });
}

function evaluate(job, profile = {}) {
  const rows = [];
  const edu = evalEducation(job, profile);
  rows.push(edu);
  for (const r of [evalField(job, profile, edu), evalSubjects(job, profile, edu), evalAge(job, profile), evalExperience(job, profile), evalDomicile(job, profile), evalPhysical(job)]) if (r) rows.push(r);
  rows.forEach((r) => { r.source = (job.field_sources || {})[r.key] || null; });

  const c = (s) => rows.filter((r) => r.result === s).length;
  let overall;
  if (c('NOT_ELIGIBLE')) overall = 'NOT_ELIGIBLE';
  else if (c('INSUFFICIENT_EVIDENCE')) overall = 'INSUFFICIENT_EVIDENCE';
  else if (c('MATCH') === rows.length) overall = 'MATCH';
  else if (c('UNKNOWN') === rows.length) overall = 'UNKNOWN';
  else if (c('CONDITIONAL')) overall = 'CONDITIONALLY_ELIGIBLE';
  else overall = 'PARTIAL_MATCH';

  const blockers = rows.filter((r) => r.result === 'NOT_ELIGIBLE').map((r) => r.short);
  const open = rows.filter((r) => r.result === 'UNKNOWN' || r.result === 'CONDITIONAL').map((r) => r.short);
  const missingEvidence = rows.filter((r) => r.result === 'INSUFFICIENT_EVIDENCE').map((r) => r.short);
  const summary = {
    MATCH: 'Every checked requirement matches your profile.',
    NOT_ELIGIBLE: `Not eligible: ${blockers.join('; ')}.`,
    CONDITIONALLY_ELIGIBLE: `Eligible only if conditions are met: ${open.join('; ')}.`,
    PARTIAL_MATCH: `Matches so far, but we need to verify: ${open.join('; ')}.`,
    UNKNOWN: 'We need more details about you to check this recruitment.',
    INSUFFICIENT_EVIDENCE: `Insufficient evidence: ${missingEvidence.join('; ')}. No eligibility decision is made.`,
  }[overall];
  // Every failed or undecidable criterion, with the official rule, the candidate's value and the cited page: the "why" behind the verdict.
  const failed_criteria = rows.filter((r) => ['NOT_ELIGIBLE', 'CONDITIONAL', 'UNKNOWN', 'INSUFFICIENT_EVIDENCE'].includes(r.result)).map((r) => ({ key: r.key, label: r.label, result: r.result, official_rule: r.official, your_value: r.yours, reason: r.note, source: r.source || null }));
  return { overall, summary, rows, failed_criteria, short_reason: blockers[0] || missingEvidence[0] || open[0] || null };
}

module.exports = { evaluate, evalEducation, evalAge, isRealYMD, relaxationScenarios, effectiveMax, LEVEL_LABEL, FIELD_LABEL };
