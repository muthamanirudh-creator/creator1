// Semantic change detection between two versions of one recruitment.
// A change is only announced to users when BOTH versions have a cited source for the field.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = (s) => { if (!s) return 'not stated'; const d = String(s).slice(0, 10).split('-'); return `${parseInt(d[2], 10)} ${MONTHS[parseInt(d[1], 10) - 1]} ${d[0]}`; };
const fmtNum = (n) => Number(n).toLocaleString('en-IN');
const days = (a, b) => Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000);
const { same: sameJson } = require('./util');

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

const TRACKED = [
  { key: 'dates.application_close', label: 'Application deadline', fmt: fmtDate, delta: (a, b) => { const n = days(a, b); return n === 0 ? 'time changed' : n > 0 ? `extended by ${n} day${n === 1 ? '' : 's'}` : `advanced by ${-n} day${n === -1 ? '' : 's'}`; } },
  { key: 'dates.application_open', label: 'Application opening date', fmt: fmtDate },
  { key: 'dates.exam_date', label: 'Exam date', fmt: fmtDate, delta: (a, b) => (a && b ? (days(a, b) > 0 ? `moved ${days(a, b)} days later` : `moved ${-days(a, b)} days earlier`) : null) },
  { key: 'vacancies.total', label: 'Vacancies', fmt: fmtNum, delta: (a, b) => `${b - a > 0 ? '+' : ''}${fmtNum(b - a)}` },
  { key: 'education', label: 'Educational qualification', fmt: (v) => (v ? v.label : 'not stated'), lineage: 'education' },
  { key: 'age.min', label: 'Minimum age', fmt: (v) => `${v} years` },
  { key: 'age.max', label: 'Maximum age', fmt: (v) => `${v} years`, delta: (a, b) => `${b - a > 0 ? '+' : ''}${b - a} years` },
  { key: 'age.cutoff_date', label: 'Age cutoff date', fmt: fmtDate },
  { key: 'age.relaxation', label: 'Age relaxation', fmt: (v) => Object.entries(v || {}).map(([k, n]) => `${k} ${n}y`).join(', ') },
  { key: 'domicile', label: 'Domicile condition', fmt: (v) => (v ? (v.type === 'STATE' ? `${v.state} domicile` : 'Open to all India') : 'not stated') },
  { key: 'fee', label: 'Application fee', fmt: (v) => (v ? `General ${v.general}, reserved ${v.reserved}` : 'not stated') },
  { key: 'selection', label: 'Selection process', fmt: (v) => (v || []).join(' → ') },
  { key: 'application_link', label: 'Application link', fmt: (v) => v || 'not stated' },
  { key: 'syllabus', label: 'Syllabus', fmt: (v) => (Array.isArray(v) ? v.join(', ') : v || 'not stated') },
];

// old/new: { data, lineage, document }  (document: { id, title, kind })
function detectChanges(oldV, newV) {
  const out = [];
  for (const t of TRACKED) {
    const a = get(oldV.data, t.key), b = get(newV.data, t.key);
    if (a === undefined && b === undefined) continue;
    if (sameJson(a, b)) continue;
    const lk = t.lineage || t.key;
    const la = oldV.lineage && oldV.lineage[lk], lb = newV.lineage && newV.lineage[lk];
    const supported = !!(la && lb && la.page_number && lb.page_number && la.quote && lb.quote);
    const delta = t.delta && a != null && b != null ? t.delta(a, b) : null;
    const from = t.fmt(a), to = t.fmt(b);
    out.push({
      field: t.key, label: t.label, from_value: from, to_value: to, delta, supported,
      source: { from: la ? { document_id: la.document_id, page: la.page_number } : null, to: lb ? { document_id: lb.document_id, page: lb.page_number } : null },
      message: supported ? `Official Update Detected: ${t.label.toLowerCase()} previously ${from}, now ${to}${delta ? ` (${delta})` : ''}.` : null,
    });
  }
  return out;
}

module.exports = { detectChanges, fmtDate, TRACKED };
