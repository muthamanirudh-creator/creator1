// Phase 3: deterministic claim grounding.
// Every date, age, vacancy, fee or page number that appears in an answer must resolve to a typed leaf of the
// published structured record. Matching is EXACT on normalised rendered forms (never substring-in-value).
const { istYMD, formatIST, formatYMD } = require('./dates');

const MODES = ['QUICK', 'DETAILED', 'OFFICIAL_ONLY', 'ELIGIBILITY', 'SOURCE_FIRST', 'EXPLAINED', 'ACTIONABLE'];
const SILENT = 'The official source does not specify this.';

const LABELS = {
  'dates.application_open': 'Application opening date', 'dates.application_close': 'Application closing date', 'dates.exam_date': 'Exam date',
  'age.min': 'Minimum age', 'age.max': 'Maximum age', 'age.cutoff_date': 'Age cutoff date',
  'vacancies.total': 'Total vacancies', 'vacancies.pwbd': 'PwBD vacancies', 'vacancies.ex_servicemen': 'Ex-servicemen vacancies',
  'fee.general': 'Fee (General)', 'fee.reserved': 'Fee (Reserved)',
};
const SOURCE_KEY = { dates: 'dates', age: 'age', vacancies: 'vacancies', education: 'education', domicile: 'domicile', physical: 'physical', experience: 'experience' };

const norm = (s) => String(s).toLowerCase().replace(/[\s,₹]/g, '').replace(/\./g, '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function sourceFor(job, path) {
  const fs = job.field_sources || {};
  const s = fs[path] || fs[SOURCE_KEY[path.split('.')[0]]] || null;
  return s ? { doc: s.doc, page: s.page, section: s.section, ...(s.document_id != null ? { document_id: s.document_id } : {}) } : null;
}

// Every acceptable written form of a leaf value.
function formsOf(path, value) {
  const f = new Set();
  if (value === undefined || value === null || value === '') return f;
  if (isNum(value)) { f.add(String(value)); f.add(value.toLocaleString('en-IN')); f.add(value.toLocaleString('en-US')); return f; }
  const s = String(value);
  f.add(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { f.add(formatYMD(s)); }
  else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); f.add(formatIST(d)); f.add(formatYMD(istYMD(d))); f.add(istYMD(d)); }
  else { const n = s.match(/\d[\d,]*/g); if (n) n.forEach((x) => f.add(x)); } // e.g. "₹500"
  return f;
}

function leaves(job, now = new Date()) {
  const out = [];
  const add = (path, value, extra = {}) => { if (value !== undefined && value !== null && value !== '') out.push({ field: path, label: LABELS[path] || path, value, ...extra }); };
  for (const k of ['application_open', 'application_close', 'exam_date']) add(`dates.${k}`, job.dates?.[k]);
  for (const k of ['min', 'max', 'cutoff_date']) add(`age.${k}`, job.age?.[k]);
  for (const [k, v] of Object.entries(job.age?.relaxation || {})) add(`age.relaxation.${k}`, v, { label: `Age relaxation (${k}) in years` });
  add('vacancies.total', job.vacancies?.total); add('vacancies.pwbd', job.vacancies?.pwbd); add('vacancies.ex_servicemen', job.vacancies?.ex_servicemen);
  for (const [k, v] of Object.entries(job.vacancies?.breakdown || {})) add(`vacancies.breakdown.${k}`, v, { label: `Vacancies (${k})` });
  add('fee.general', job.fee?.general); add('fee.reserved', job.fee?.reserved);
  if (job.dates?.application_close) {
    const ms = new Date(job.dates.application_close) - now;
    if (ms > 0) add('derived.days_left', Math.floor(ms / 864e5), { label: 'Days left to apply', derived: 'computed from dates.application_close', source_field: 'dates.application_close' });
  }
  return out.map((l) => ({ ...l, forms: [...formsOf(l.field, l.value)], source: sourceFor(job, l.source_field || l.field), supported: true }));
}

const claimsForJob = (job, now = new Date()) => {
  const all = leaves(job, now);
  const head = ['dates.application_open', 'dates.application_close', 'age.min', 'age.max', 'age.cutoff_date', 'vacancies.total', 'dates.exam_date'];
  const have = new Set(all.map((c) => c.field));
  const missing = head.filter((h) => !have.has(h)).map((h) => ({ field: h, label: LABELS[h], value: null, forms: [], source: null, supported: false }));
  return [...all, ...missing];
};

// Strict: the claim text must equal one rendered form of a leaf (optionally a specific field).
function verifyClaim(job, claim, nowOrOpts = new Date()) {
  const opts = nowOrOpts instanceof Date ? {} : (nowOrOpts || {});
  const now = nowOrOpts instanceof Date ? nowOrOpts : (opts.now || new Date());
  const c = norm(claim);
  if (!c) return { supported: false, reason: 'Empty claim.' };
  const hits = leaves(job, now).filter((l) => (!opts.field || l.field === opts.field) && l.forms.some((f) => norm(f) === c));
  if (!hits.length) return { supported: false, reason: opts.field ? `Value does not match ${opts.field}.` : 'Claim does not match a verified structured field.' };
  const h = hits[0];
  return { supported: true, field: h.field, value: h.value, source: h.source, also: hits.slice(1).map((x) => x.field) };
}

// ---- Free-text audit: every factual token in an answer must be grounded. ----
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*';
const TOKEN_RE = new RegExp([
  `\\d{1,2}\\s+${MONTH}\\.?\\s+\\d{4}(?:,\\s*\\d{1,2}:\\d{2}\\s*[ap]m(?:\\s*IST)?)?`,
  '\\d{4}-\\d{2}-\\d{2}(?:T[\\d:+.\\-]+)?',
  '\\d{1,3}(?:,\\d{2,3})+(?!\\d)',
  '\\d+',
].join('|'), 'gi');

function auditText(job, text, now = new Date()) {
  let body = String(text);
  const srcs = Object.values(job.field_sources || {});
  const pages = new Set(srcs.map((s) => String(s.page)));
  const sections = new Set(srcs.map((s) => String(s.section)));
  const checks = [];
  // Citation parts are verified against recorded sources, then masked so they are not read as facts.
  const docNames = [...new Set([...srcs.map((s) => s.doc), ...(job.sources || []).flatMap((x) => [x.id, x.name])].filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const d of docNames) body = body.split(d).join(' ');
  body = body.replace(/\bsection\s+(\d+(?:\.\d+)*[a-z]?)/gi, (m, sec) => { const ok = sections.has(sec); checks.push({ token: `section ${sec}`, kind: 'section', field: 'section', supported: ok, reason: ok ? undefined : 'Section is not a recorded source section.' }); return ' '; });
  const identity = norm(`${job.title} ${job.organization} ${job.id}`);
  let m; TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    const token = m[0].trim();
    const before = body.slice(Math.max(0, m.index - 8), m.index).toLowerCase();
    if (/page\s*$/.test(before)) { const ok = pages.has(token); checks.push({ token, kind: 'page', field: 'page', supported: ok, reason: ok ? undefined : 'Page is not a recorded source page.' }); continue; }
    const v = verifyClaim(job, token, { now });
    if (v.supported) { checks.push({ token, kind: 'fact', ...v }); continue; }
    if (/^\d+$/.test(token) && identity.includes(token)) { checks.push({ token, kind: 'identity', supported: true, field: 'identity' }); continue; }
    checks.push({ token, kind: 'fact', ...v });
  }
  return { ok: checks.every((c) => c.supported), checks, unsupported: checks.filter((c) => !c.supported).map((c) => c.token) };
}

function renderLeaf(c) { return c.forms.length > 1 && !isNum(c.value) && /^\d{4}-\d{2}-\d{2}/.test(String(c.value)) ? c.forms.find((f) => /[A-Za-z]{3}/.test(f)) || c.value : (isNum(c.value) ? c.value.toLocaleString('en-IN') : c.value); }

function officialOnly(job, fields = [], now = new Date()) {
  const all = claimsForJob(job, now);
  return fields.map((f) => { const c = all.find((x) => x.field === f || x.label.toLowerCase() === String(f).toLowerCase()); return !c || !c.supported ? SILENT : `${c.label}: ${renderLeaf(c)}.`; });
}

module.exports = { MODES, SILENT, LABELS, claimsForJob, verifyClaim, officialOnly, auditText, auditClaims: auditText, sourceFor, formsOf, leaves, renderLeaf };
