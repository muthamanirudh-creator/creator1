// Phase 3: deterministic intent routing. Maps a question to the structured field(s) that can answer it.
// No model decides which fact is true; the router only decides which fields to read.
const RULES = [
  { intent: 'DEADLINE',    re: /\b(last date|deadline|clos(e|es|ing)|due|apply (by|before)|till when|how long)\b/i, fields: ['dates.application_close', 'derived.days_left'] },
  { intent: 'OPEN_DATE',   re: /\b(when (does|do|will).*(open|start|begin)|opening date|start date|apply from|begins?)\b/i, fields: ['dates.application_open'] },
  { intent: 'EXAM_DATE',   re: /\b(exam|test|cbt|written)\s*(date|when|schedule)?\b.*|\bwhen.*(exam|test)\b/i, fields: ['dates.exam_date'], weak: true },
  { intent: 'AGE',         re: /\b(age|old|young|relaxation|age limit|maximum age|minimum age|cut-?off)\b/i, fields: ['age.min', 'age.max', 'age.cutoff_date'] },
  { intent: 'RELAXATION',  re: /\b(relaxation|relax)\b.*\b(sc|st|obc|ews|pwbd|ex-?servicem[ae]n)\b|\b(sc|st|obc|ews|pwbd|ex-?servicem[ae]n)\b.*\b(relaxation|relax)\b/i, fields: [], dynamic: 'relaxation' },
  { intent: 'VACANCY_CAT', re: /\b(sc|st|obc|ews|ur|general|pwbd|ex-?servicem[ae]n)\b.*\b(vacanc\w*|posts?|seats?)\b|\b(vacanc\w*|posts?|seats?)\b.*\b(for|in)\b.*\b(sc|st|obc|ews|ur|general|pwbd)\b/i, fields: [], dynamic: 'vacancy_cat' },
  { intent: 'VACANCY',     re: /\b(vacanc(y|ies)|posts?|seats?|openings?|how many)\b/i, fields: ['vacancies.total'] },
  { intent: 'FEE',         re: /\b(fee|fees|cost|charges?|payment|pay|how much)\b/i, fields: ['fee.general', 'fee.reserved'] },
  { intent: 'EDUCATION',   re: /\b(education|qualification|degree|diploma|iti|pass|eligible for|studied)\b/i, fields: [], text: 'education' },
  { intent: 'SELECTION',   re: /\b(selection|stages?|process|rounds?|how (are|is).*selected)\b/i, fields: [], text: 'selection' },
  { intent: 'HOW_TO_APPLY', re: /\b(how (do|should|can|to) (i )?apply|application process|steps to apply|apply online|how to register)\b/i, fields: ['dates.application_close', 'derived.days_left'], howto: true },
  { intent: 'SOURCE',      re: /\b(where did|source|which (page|document)|proof|official (document|notification))\b/i, fields: [], source: true },
  { intent: 'COMPARE',     re: /\b(compare|versus|\bvs\b|difference between|better than)\b/i, fields: [], multi: true },
  { intent: 'ELIGIBILITY', re: /\b(can i|am i|do i qualify|eligib|qualif)\b/i, fields: [], eligibility: true },
];
const CAT = { sc: 'SC', st: 'ST', obc: 'OBC', ews: 'EWS', ur: 'UR', general: 'UR', pwbd: 'PwBD', exservicemen: 'ExServicemen', exservicemean: 'ExServicemen' };

function classify(question) {
  const q = String(question || '').trim();
  const hits = RULES.filter((r) => r.re.test(q));
  // Specific beats generic: relaxation/vacancy-category/source/compare outrank AGE/VACANCY/EDUCATION.
  const rank = (r) => (r.dynamic ? 0 : r.howto ? 1 : r.source || r.multi ? 1 : r.eligibility ? 2 : r.weak ? 4 : 3);
  hits.sort((a, b) => rank(a) - rank(b));
  const primary = hits[0] || null;
  const cat = (q.match(/\b(sc|st|obc|ews|ur|general|pwbd|ex-?servicem[ae]n)\b/i) || [])[1];
  const catKey = cat ? CAT[cat.toLowerCase().replace('-', '')] : null;
  const extra = [];
  if (primary?.dynamic === 'relaxation' && catKey) extra.push(`age.relaxation.${catKey}`);
  if (primary?.dynamic === 'vacancy_cat' && catKey) extra.push(catKey === 'PwBD' ? 'vacancies.pwbd' : catKey === 'ExServicemen' ? 'vacancies.ex_servicemen' : `vacancies.breakdown.${catKey}`);
  // "Source of the age limit": a SOURCE question inherits the fields of the other intents it mentions.
  const inherited = primary?.source ? hits.slice(1).flatMap((h) => h.fields || []) : [];
  return {
    intent: primary ? primary.intent : 'UNKNOWN',
    fields: [...new Set([...(primary?.fields || []), ...extra, ...inherited])],
    text: primary?.text || null, wantsSource: !!primary?.source, wantsCompare: !!primary?.multi, wantsEligibility: !!primary?.eligibility,
    secondary: hits.slice(1).map((h) => h.intent),
  };
}

// Minimal clarification: ask at most ONE question, only when the answer would otherwise be a guess.
function clarification({ route, job, candidates = [], profile = {} }) {
  if (!job && candidates.length !== 1) {
    return { type: 'RECRUITMENT', question: 'Which recruitment do you mean?', options: candidates.slice(0, 6).map((j) => ({ id: j.id, title: j.title })) };
  }
  if (route.intent === 'UNKNOWN') return { type: 'TOPIC', question: 'What would you like to know: dates, age, vacancies, fee, education or selection?', options: ['Dates', 'Age', 'Vacancies', 'Fee', 'Education', 'Selection'].map((t) => ({ id: t.toLowerCase(), title: t })) };
  if (route.wantsEligibility && !(profile.dob || profile.age) && !(profile.education && profile.education.level)) {
    return { type: 'PROFILE', question: 'To check eligibility I need your date of birth and highest qualification. Which would you like to share first?', options: [{ id: 'dob', title: 'Date of birth' }, { id: 'education', title: 'Qualification' }] };
  }
  return null;
}

// Resolve which recruitment the user means from the text (id, title, organisation or distinctive title words).
function resolveJob(jobs, question, hintId) {
  if (hintId) { const j = jobs.find((x) => x.id === hintId); if (j) return { job: j, candidates: [j] }; }
  const q = String(question || '').toLowerCase();
  const exact = jobs.filter((j) => q.includes(j.id.toLowerCase()) || q.includes(j.title.toLowerCase()));
  if (exact.length === 1) return { job: exact[0], candidates: exact };
  const stop = new Set(['the', 'of', 'and', 'for', 'grade', 'demo', 'recruitment', 'board', 'commission', 'staff', 'selection', 'combined']);
  const scored = jobs.map((j) => {
    const words = `${j.title} ${j.id.replace(/-/g, ' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w));
    return { j, n: new Set(words.filter((w) => new RegExp(`\\b${w}\\b`).test(q))).size };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  if (scored.length && (scored.length === 1 || scored[0].n > scored[1].n)) return { job: scored[0].j, candidates: [scored[0].j] };
  return { job: null, candidates: scored.length ? scored.map((x) => x.j) : jobs };
}

module.exports = { classify, clarification, resolveJob, RULES };
