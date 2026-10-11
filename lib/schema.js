// Strict schema for an extracted recruitment record (same shape as data/jobs.js).
// Anything that fails is rejected. Nothing is defaulted or guessed here.
const LEVELS = ['10th', '12th', 'iti', 'diploma', 'bachelor', 'master', 'phd'];
const DOMAINS = ['railway', 'ssc', 'police', 'state-services', 'banking', 'defence', 'research', 'teaching', 'other'];
const DOMICILE = ['ALL_INDIA', 'STATE'];
const REL_KEYS = ['SC', 'ST', 'OBC', 'EWS', 'PwBD', 'ExServicemen'];
const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isISOIST = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/.test(s) && !Number.isNaN(Date.parse(s));
const isInt = (n, min = 0) => Number.isInteger(n) && n >= min;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 1;

function validateRecord(r) {
  const errs = []; const e = (path, msg) => errs.push({ path, message: msg });
  if (!r || typeof r !== 'object') return [{ path: '', message: 'Record is missing.' }];
  for (const k of ['title', 'organization', 'state']) if (!nonEmpty(r[k])) e(k, 'Required text is missing.');
  if (!nonEmpty(r.department)) e('department', 'Required text is missing.');
  if (!DOMAINS.includes(r.domain)) e('domain', `Must be one of ${DOMAINS.join(', ')}.`);

  const d = r.dates || {};
  if (!isISOIST(d.application_open)) e('dates.application_open', 'Needs an IST timestamp (…+05:30).');
  if (!isISOIST(d.application_close)) e('dates.application_close', 'Needs an IST timestamp (…+05:30).');
  if (isISOIST(d.application_open) && isISOIST(d.application_close) && new Date(d.application_close) <= new Date(d.application_open)) e('dates.application_close', 'Closing must be after opening.');
  if (d.exam_date != null && !isYMD(d.exam_date)) e('dates.exam_date', 'Must be YYYY-MM-DD or null.');
  if (isYMD(d.exam_date) && isISOIST(d.application_close) && new Date(d.exam_date + 'T00:00:00+05:30') < new Date(d.application_close)) e('dates.exam_date', 'Exam date is before the application closes.');

  const ed = r.education || {};
  if (!Array.isArray(ed.accepted) || !ed.accepted.length || ed.accepted.some((x) => !LEVELS.includes(x))) e('education.accepted', `Needs one or more of ${LEVELS.join(', ')}.`);
  if (typeof ed.or_higher !== 'boolean') e('education.or_higher', 'Must be true/false.');
  if (!nonEmpty(ed.label)) e('education.label', 'Required text is missing.');
  if (!Array.isArray(ed.fields) || !ed.fields.length) e('education.fields', 'Needs at least one field (use "any" only if the notification says so).');

  const a = r.age || {};
  if (!isInt(a.min, 14) || !isInt(a.max, 14) || a.min > a.max) e('age', 'Needs whole-number min and max with min <= max.');
  if (!isYMD(a.cutoff_date)) e('age.cutoff_date', 'Needs the official cutoff date (YYYY-MM-DD).');
  if (!a.relaxation || REL_KEYS.some((k) => !isInt(a.relaxation[k]))) e('age.relaxation', `Needs whole years for ${REL_KEYS.join(', ')}.`);

  const dm = r.domicile || {};
  if (!DOMICILE.includes(dm.type)) e('domicile.type', 'Must be ALL_INDIA or STATE.');
  if (dm.type === 'STATE' && !nonEmpty(dm.state)) e('domicile.state', 'State domicile needs a state name.');
  if (r.experience_years != null && !isInt(r.experience_years)) e('experience_years', 'Must be a whole number or omitted.');
  if (r.physical != null && !nonEmpty(r.physical)) e('physical', 'Must be text or null.');

  const f = r.fee || {};
  if (!nonEmpty(f.general) || !nonEmpty(f.reserved)) e('fee', 'Needs general and reserved fee text (or "No fee").');

  const v = r.vacancies || {};
  if (!isInt(v.total, 1)) e('vacancies.total', 'Needs a positive whole number.');
  if (!v.breakdown || typeof v.breakdown !== 'object' || Object.values(v.breakdown).some((x) => !isInt(x))) e('vacancies.breakdown', 'Needs whole numbers per category.');
  if (!isInt(v.pwbd)) e('vacancies.pwbd', 'Needs a whole number (0 if the notification says none).');
  if (!isInt(v.ex_servicemen)) e('vacancies.ex_servicemen', 'Needs a whole number (0 if the notification says none).');

  if (!Array.isArray(r.selection) || !r.selection.length || r.selection.some((s) => !nonEmpty(s))) e('selection', 'Needs the selection stages.');
  if (r.application_link != null && !/^https:\/\/[^\s]+$/.test(r.application_link)) e('application_link', 'Must be an https URL or null.');
  return errs;
}

// Consistency checks that are not shape errors. Returned as flags for the reviewer.
function crossChecks(r) {
  const flags = [];
  const v = r.vacancies;
  if (v && v.breakdown) {
    const sum = Object.values(v.breakdown).reduce((a, b) => a + b, 0);
    if (sum !== v.total) flags.push({ code: 'VACANCY_SUM_MISMATCH', message: `Category vacancies add up to ${sum}, but the total is ${v.total}.` });
  }
  return flags;
}

module.exports = { LEVELS, DOMAINS, REL_KEYS, validateRecord, crossChecks, isYMD, isISOIST };
