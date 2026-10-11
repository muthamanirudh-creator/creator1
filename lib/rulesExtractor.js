// Deterministic baseline extractor. Reads labelled lines ("Last date to apply: 24 October 2026").
// Every field comes back with page, quote and confidence. Missing = absent, never guessed.
const { STATES } = require('./search');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
const DATE_RX = '(\\d{1,2}[\\s-](?:[A-Za-z]{3,9})[\\s,-]+\\d{4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{4}-\\d{2}-\\d{2})';

function parseDate(s) {
  s = s.trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return s;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{4})$/.exec(s))) { const i = monthIdx(m[2]); return i < 0 ? null : `${m[3]}-${pad(i + 1)}-${pad(m[1])}`; }
  if ((m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) { const i = monthIdx(m[1]); return i < 0 ? null : `${m[3]}-${pad(i + 1)}-${pad(m[2])}`; }
  return null;
}
const monthIdx = (n) => MONTHS.findIndex((x) => x.startsWith(n.toLowerCase().slice(0, 3)));
const datesIn = (text) => { const out = []; const rx = new RegExp(DATE_RX, 'g'); let m; while ((m = rx.exec(text))) { const d = parseDate(m[1]); if (d) out.push(d); } return out; };
const istISO = (ymd, hms) => `${ymd}T${hms}+05:30`;

function eachLine(pages) {
  const out = [];
  for (const p of pages) {
    let off = 0;
    for (const line of p.text.split('\n')) { out.push({ page: p.page_number, text: line.trim(), offset: off }); off += line.length + 1; }
  }
  return out.filter((l) => l.text);
}

function levelsFrom(text) {
  const t = text.toLowerCase();
  const out = []; const fields = new Set();
  if (/\b(10th|matriculation|class x\b|ssc pass)/.test(t)) out.push('10th');
  if (/\b(12th|intermediate|class xii|higher secondary)/.test(t)) out.push('12th');
  if (/\biti\b/.test(t)) out.push('iti');
  if (/\bdiploma\b/.test(t)) out.push('diploma');
  // "Master's degree" / "post-graduation" must not also count as a bachelor's: that would make a bachelor's holder look eligible
  // for a master's-only post. A bare "degree" is a bachelor's only when nothing higher is named.
  const higher = /\b(m\.?\s?tech|master|post[- ]?graduat(?:e|ion))/.test(t), doctor = /\b(ph\.?\s?d|doctorate)/.test(t);
  const explicitBachelor = /\b(b\.?\s?tech|b\.?\s?e\.?\b|bachelor)/.test(t), looseBachelor = /\b(graduate|graduation|degree)/.test(t) && !/post[- ]?graduat(?:e|ion)/.test(t);
  if (explicitBachelor || (looseBachelor && !higher && !doctor)) out.push('bachelor');
  if (higher) out.push('master');
  if (doctor) out.push('phd');
  if (/\b(b\.?\s?tech|b\.?\s?e\.?\b|engineering)/.test(t)) fields.add('engineering');
  if (/\bscience\b|b\.?\s?sc/.test(t)) fields.add('science');
  if (/any (discipline|stream|branch)|any subject/.test(t)) fields.add('any');
  return { accepted: [...new Set(out)], fields: [...fields] };
}

function deriveDomain(org = '', dept = '') {
  const rules = [[/railway/, 'railway'], [/staff selection/, 'ssc'], [/police/, 'police'], [/bank|insurance/, 'banking'], [/defen[cs]e|army|navy|air force/, 'defence'],
    [/laborator|research|science/, 'research'], [/public service commission|state/, 'state-services'], [/teach|school/, 'teaching']];
  for (const text of [org.toLowerCase(), dept.toLowerCase()]) for (const [rx, d] of rules) if (rx.test(text)) return d;
  return 'other';
}

function extractWithRules(pages, ctx = {}) {
  const lines = eachLine(pages);
  const fields = {}; const notes = [];
  const put = (key, value, line, confidence = 0.93, extra = {}) => {
    fields[key] = { value, page: line.page, quote: line.text, confidence, method: 'RULES', ...extra };
  };
  const find = (rx) => { for (const l of lines) { const m = rx.exec(l.text); if (m) return { l, m }; } return null; };

  let r;
  if ((r = find(/(?:Recruitment (?:of|for)|Post(?: Name)?\s*:)\s*(.{3,120})$/i))) put('title', r.m[1].replace(/\.$/, '').trim(), r.l);
  const orgLine = lines.find((l) => l.page === 1 && /(Commission|Board|Corporation|Bank|Service|Authority|Laborator|Ministry|Police|Railway|Council|Institute|Department)/i.test(l.text) && l.text.length < 120);
  if (orgLine) put('organization', orgLine.text.replace(/\s+/g, ' '), orgLine, 0.85);
  if ((r = find(/^Department\s*:\s*(.{3,80})$/i))) put('department', r.m[1].trim(), r.l);
  if ((r = find(new RegExp(`^State\\s*:\\s*(${STATES.join('|')}|All India)$`, 'i')))) put('state', r.m[1], r.l);
  else if (ctx.source && ctx.source.state) fields.state = { value: ctx.source.state, page: null, quote: null, confidence: 0.8, method: 'REGISTRY' };

  const tag = (s) => s.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  if ((r = find(new RegExp(`(?:Application(?:s)? (?:open(?:s)?|start(?:s)?)|Start date|Opening date)[^:\\n]*:\\s*${DATE_RX}`, 'i')))) {
    const t = /(\d{1,2}:\d{2})/.exec(r.l.text);
    put('dates.application_open', istISO(parseDate(r.m[1]), t ? `${t[1]}:00` : '10:00:00'), r.l, t ? 0.93 : 0.8);
    if (!t) notes.push('Opening time is not stated in the source line; 10:00 IST is a placeholder to confirm.');
  }
  if ((r = find(new RegExp(`(?:Last date(?: to apply| for (?:online )?(?:application|submission))?|Application(?:s)? clos(?:e|es|ing)|Closing date)[^:\\n]*:\\s*${DATE_RX}`, 'i')))) {
    const t = /(\d{1,2}:\d{2})/.exec(r.l.text);
    put('dates.application_close', istISO(parseDate(r.m[1]), t ? `${t[1]}:00` : '23:59:00'), r.l, t ? 0.93 : 0.8);
    if (!t) notes.push('Closing time is not stated in the source line; 23:59 IST is a placeholder to confirm.');
  }
  if ((r = find(new RegExp(`(?:(?:Written |Online )?Exam(?:ination)?(?: date)?|Date of exam)[^:\\n]*:\\s*(?:tentatively\\s*)?${DATE_RX}`, 'i')))) put('dates.exam_date', parseDate(r.m[1]), r.l);

  if ((r = find(/(?:Total (?:number of )?vacanc(?:y|ies)|(?:Total )?(?:Number of|No\\. of) (?:posts|vacanc(?:y|ies)))[^:\n]*:\s*([\d,]+)/i))) {
    put('vacancies.total', parseInt(r.m[1].replace(/,/g, ''), 10), r.l);
    const pg = pages.find((p) => p.page_number === r.l.page);
    const bl = lines.filter((l) => l.page === r.l.page && /\bUR\b/.test(l.text) && /\bSC\b/.test(l.text))[0];
    if (bl) {
      const br = {}; for (const k of ['UR', 'SC', 'ST', 'OBC', 'EWS']) { const m = new RegExp(`\\b${k}\\b\\s*[:\\-]?\\s*(\\d[\\d,]*)`).exec(bl.text); if (m) br[k] = parseInt(m[1].replace(/,/g, ''), 10); }
      if (Object.keys(br).length) put('vacancies.breakdown', br, bl);
    }
    const pw = lines.find((l) => l.page === r.l.page && /PwBD|PwD|Persons with Disabilit/i.test(l.text) && /\d/.test(l.text));
    if (pw) put('vacancies.pwbd', parseInt(/(\d[\d,]*)/.exec(pw.text.replace(/PwBD|PwD/gi, ''))[1].replace(/,/g, ''), 10), pw);
    const ex = lines.find((l) => l.page === r.l.page && /Ex-?servicemen/i.test(l.text) && /\d/.test(l.text) && !/year/i.test(l.text));
    if (ex) put('vacancies.ex_servicemen', parseInt(/(\d[\d,]*)/.exec(ex.text.replace(/Ex-?servicemen/i, ''))[1].replace(/,/g, ''), 10), ex);
  }

  if ((r = find(/Education(?:al)?(?: Qualification)?\s*:\s*(.{5,200})$/i))) {
    const lv = levelsFrom(r.m[1]);
    if (lv.accepted.length) {
      const final = /final[- ]year/i.test(r.m[1]) ? !/not (?:be )?(?:eligible|allowed)|cannot/i.test(r.m[1]) : undefined;
      const value = { accepted: lv.accepted, or_higher: /or (?:higher|above)/i.test(r.m[1]), label: r.m[1].replace(/\.$/, '').trim(), fields: lv.fields };
      if (final !== undefined) value.allow_final_year = final;
      put('education', value, r.l, lv.fields.length ? 0.9 : 0.6);
    }
  }
  if ((r = find(new RegExp(`Age(?: limit)?[^:\\n]*:\\s*(?:Minimum\\s*)?(\\d{2})\\s*(?:to|-|–)\\s*(\\d{2})\\s*years?(?:[^\\n]*?as on\\s*${DATE_RX})?`, 'i')))) {
    put('age.min', parseInt(r.m[1], 10), r.l); put('age.max', parseInt(r.m[2], 10), r.l);
    if (r.m[3]) put('age.cutoff_date', parseDate(r.m[3]), r.l);
  }
  if ((r = find(/Relaxation[^:\n]*:\s*(.+)$/i))) {
    const t = r.m[1]; const rel = {};
    if (/no (?:age )?relaxation/i.test(t)) Object.assign(rel, { SC: 0, ST: 0, OBC: 0, EWS: 0, PwBD: 0, ExServicemen: 0 });
    for (const m of t.matchAll(/((?:SC|ST|OBC|EWS|PwBD|PwD|Ex-?servicemen)(?:\s*\/\s*(?:SC|ST|OBC|EWS|PwBD|PwD))*)\s*[:\-]?\s*(\d+)\s*years?/gi)) {
      for (const k of m[1].split('/')) { const key = /ex/i.test(k) ? 'ExServicemen' : /pw/i.test(k) ? 'PwBD' : k.trim().toUpperCase(); rel[key] = parseInt(m[2], 10); }
    }
    if (rel.EWS === undefined && (rel.SC !== undefined || rel.ST !== undefined)) { rel.EWS = 0; notes.push('EWS age relaxation is not stated; recorded as 0 years. Confirm.'); }
    if (Object.keys(rel).length) put('age.relaxation', rel, r.l, 0.9);
  }
  if ((r = find(/Domicile[^:\n]*:\s*(.+)$/i)) || (r = find(/(?:must|should) (?:hold|possess)[^.\n]*domicile/i))) {
    const txt = r.m[1] || r.l.text;
    const st = STATES.find((s) => new RegExp(s, 'i').test(txt));
    if (st && !/not (?:required|needed)/i.test(txt)) put('domicile', { type: 'STATE', state: st }, r.l);
    else if (/(all|any) (?:states|india)|not required|no domicile/i.test(txt)) put('domicile', { type: 'ALL_INDIA' }, r.l);
  }
  if ((r = find(/Physical (?:standards|requirements)[^:\n]*:\s*(.{5,200})$/i))) put('physical', r.m[1].replace(/\.$/, ''), r.l);
  if ((r = find(/^Experience[^:\n]*:\s*(?:minimum\s*)?(\d+)\s*years?/i))) put('experience_years', parseInt(r.m[1], 10), r.l);
  if ((r = find(/Fee[^:\n]*:\s*(.+)$/i)) && /General|No fee|Nil/i.test(r.m[1])) {
    const money = (s) => { const m = /(₹\s?[\d,]+|Rs\.?\s?[\d,]+)/i.exec(s); return m ? m[1].replace(/Rs\.?\s?/i, '₹').replace(/\s/g, '').replace(/,+$/, '') : /no fee|nil|free/i.test(s) ? 'No fee' : null; };
    const g = /General[^,;]*?(₹\s?[\d,]+|Rs\.?\s?[\d,]+|No fee)/i.exec(r.m[1]); const rs = /(?:SC\s*\/\s*ST|Reserved|SC|ST)[^,;]*?(₹\s?[\d,]+|Rs\.?\s?[\d,]+|No fee)/i.exec(r.m[1]);
    if (/No fee|Nil/i.test(r.m[1]) && !g) put('fee', { general: 'No fee', reserved: 'No fee' }, r.l);
    else if (g && rs) put('fee', { general: money(g[1]), reserved: money(rs[1]) }, r.l);
  }
  if ((r = find(/Selection (?:process|stages)\s*:\s*(.+)$/i))) {
    const parts = r.m[1].replace(/\.$/, '').split(/;|,\s*(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) put('selection', parts, r.l);
  }
  if ((r = find(/(?:Online application|Apply online|Application link)[^:\n]*:\s*(https?:\/\/[^\s)]+)/i))) put('application_link', r.m[1].replace(/[.,;]$/, ''), r.l);

  return { fields, notes };
}

// Assemble the flat field map into the job-record shape.
function assembleRecord(fields, ctx = {}) {
  const g = (k) => (fields[k] ? fields[k].value : undefined);
  const rec = {
    title: g('title'), organization: g('organization'), department: g('department'), state: g('state'),
    domain: deriveDomain(g('organization'), g('department')),
    summary: g('title') ? `${g('title')} recruitment by ${g('organization') || 'the organization'}.` : undefined,
    dates: { application_open: g('dates.application_open'), application_close: g('dates.application_close'), exam_date: g('dates.exam_date') === undefined ? null : g('dates.exam_date') },
    education: g('education'),
    age: { min: g('age.min'), max: g('age.max'), cutoff_date: g('age.cutoff_date'), relaxation: g('age.relaxation') },
    domicile: g('domicile'),
    physical: g('physical') === undefined ? null : g('physical'),
    fee: g('fee'),
    vacancies: { total: g('vacancies.total'), breakdown: g('vacancies.breakdown'), pwbd: g('vacancies.pwbd'), ex_servicemen: g('vacancies.ex_servicemen') },
    selection: g('selection'),
    application_link: g('application_link') === undefined ? null : g('application_link'),
  };
  if (g('experience_years') !== undefined) rec.experience_years = g('experience_years');
  return rec;
}

module.exports = { extractWithRules, assembleRecord, parseDate, datesIn, levelsFrom, deriveDomain };
