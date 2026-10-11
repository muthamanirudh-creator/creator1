'use strict';
// Extraction accuracy measurement (v2.9.0): precision and recall against a manually adjudicated dataset.
//
//   TP  extracted a value and it equals the gold value
//   FP  extracted a value that is wrong, or extracted one where gold says the notice does not state it
//   FN  gold has a value and the extractor returned nothing or something else
//   TN  gold says "not stated" and the extractor correctly returned nothing
//
// A wrong value counts as BOTH a false positive and a false negative (standard practice), because the person who relied on
// it was misled AND the right value was not found. Abstaining on a field the notice does not state is a TRUE negative:
// an extractor must never be rewarded for guessing.
//
// A number measured on synthetic text says how the code handles that text. It does NOT say how it handles real notices.
// The report therefore separates corpora by provenance and refuses to call anything "measured accuracy on real notices"
// until real, doubly-adjudicated documents are in the dataset.
const { canon } = require('../util');
const { CRITICAL_FIELDS } = require('./policy');

// Normalise so equivalent renderings compare equal (dates to YYYY-MM-DD, numbers, text case/space, key order).
function normaliseValue(field, v) {
  if (v === undefined || v === null) return null;
  if (/^dates\.(application_open|application_close)$/.test(field)) return String(v).slice(0, 10);
  if (/^dates\.exam_date$|cutoff_date$/.test(field)) return String(v).slice(0, 10);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim().toLowerCase();
  if (field === 'education') return { accepted: [...(v.accepted || [])].sort(), or_higher: !!v.or_higher, fields: [...(v.fields || [])].sort(), ...(v.allow_final_year !== undefined ? { allow_final_year: !!v.allow_final_year } : {}) };
  if (Array.isArray(v)) return v.map((x) => normaliseValue(field, x));
  return v;
}
const equal = (field, a, b) => canon(normaliseValue(field, a)) === canon(normaliseValue(field, b));

// 95% Wilson score interval: honest about small samples (100% on 10 documents is NOT "100% accurate").
function wilson(successes, n, z = 1.96) {
  if (!n) return { lower: 0, upper: 1, point: null };
  const p = successes / n, z2 = z * z, den = 1 + z2 / n, centre = p + z2 / (2 * n), half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { lower: Math.max(0, (centre - half) / den), upper: Math.min(1, (centre + half) / den), point: p };
}
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

// cases: [{ id, provenance: 'SYNTHETIC'|'REAL', adjudicators: n, family, gold: { field: value | undefined } }]
// predictions: { [caseId]: { field: value } }
function scoreExtraction(cases, predictions) {
  const per = new Map(); const errors = [];
  const bucket = (f) => { if (!per.has(f)) per.set(f, { field: f, tp: 0, fp: 0, fn: 0, tn: 0 }); return per.get(f); };
  const byFamily = new Map();
  for (const c of cases) {
    const pred = predictions[c.id] || {};
    // Only fields the case was adjudicated for are scored. A value the extractor returns for a field nobody adjudicated
    // (e.g. a fee on a case whose gold does not list fees) is not an error we can prove; it is simply unscored.
    const fields = new Set([...Object.keys(c.gold || {}), ...(c.fields_in_scope || [])]);
    for (const f of fields) {
      const gv = c.gold ? c.gold[f] : undefined, pv = pred[f];
      const hasG = gv !== undefined && gv !== null, hasP = pv !== undefined && pv !== null;
      const b = bucket(f); const fam = byFamily.get(c.family) || byFamily.set(c.family, { tp: 0, fp: 0, fn: 0 }).get(c.family);
      if (hasG && hasP && equal(f, gv, pv)) { b.tp++; fam.tp++; }
      else if (hasG && hasP) { b.fp++; b.fn++; fam.fp++; fam.fn++; errors.push({ case: c.id, field: f, kind: 'WRONG_VALUE', gold: gv, got: pv }); }
      else if (hasG) { b.fn++; fam.fn++; errors.push({ case: c.id, field: f, kind: 'MISSED', gold: gv, got: null }); }
      else if (hasP) { b.fp++; fam.fp++; errors.push({ case: c.id, field: f, kind: 'INVENTED', gold: null, got: pv }); }
      else b.tn++;
    }
  }
  const rows = [...per.values()].map((b) => {
    const pDen = b.tp + b.fp, rDen = b.tp + b.fn, pw = wilson(b.tp, pDen), rw = wilson(b.tp, rDen);
    const p = pDen ? b.tp / pDen : null, r = rDen ? b.tp / rDen : null;
    return { ...b, precision: r4(p), recall: r4(r), f1: p != null && r != null && p + r > 0 ? r4((2 * p * r) / (p + r)) : null, precision_lower_bound: r4(pw.lower), recall_lower_bound: r4(rw.lower), support: rDen, critical: CRITICAL_FIELDS.includes(b.field) };
  }).sort((a, b) => Number(b.critical) - Number(a.critical) || a.field.localeCompare(b.field));
  const sum = (rs, k) => rs.reduce((x, r) => x + r[k], 0);
  const micro = (rs) => { const tp = sum(rs, 'tp'), fp = sum(rs, 'fp'), fn = sum(rs, 'fn'); return { tp, fp, fn, precision: tp + fp ? r4(tp / (tp + fp)) : null, recall: tp + fn ? r4(tp / (tp + fn)) : null, precision_lower_bound: r4(wilson(tp, tp + fp).lower), recall_lower_bound: r4(wilson(tp, tp + fn).lower) }; };
  const real = cases.filter((c) => c.provenance === 'REAL' && (c.adjudicators || 0) >= 2);
  const families = [...byFamily.entries()].map(([family, b]) => ({ family, tp: b.tp, fp: b.fp, fn: b.fn, precision: b.tp + b.fp ? r4(b.tp / (b.tp + b.fp)) : null, recall: b.tp + b.fn ? r4(b.tp / (b.tp + b.fn)) : null })).sort((a, b) => String(a.family).localeCompare(String(b.family)));
  return {
    documents: cases.length, real_documents: real.length, synthetic_documents: cases.filter((c) => c.provenance !== 'REAL').length,
    overall: micro(rows), critical: rows.filter((r) => r.critical), critical_overall: micro(rows.filter((r) => r.critical)),
    fields: rows, families, errors,
    evidence_grade: real.length >= 200 ? 'REAL_NOTICES_MEASURED' : real.length > 0 ? 'REAL_NOTICES_TOO_FEW' : 'SYNTHETIC_ONLY',
    claim: real.length >= 200
      ? `Measured on ${real.length} doubly-adjudicated real notices.`
      : real.length > 0 ? `Only ${real.length} adjudicated real notices: too few to support any accuracy claim (need 200+).`
        : 'NO accuracy claim can be made for real SSC, UPSC, railway, banking or state notices: the dataset contains no adjudicated real documents. These numbers describe behaviour on synthetic text only.',
  };
}

// Run an extractor over cases. `extract(pages, ctx)` returns { fields: { key: { value } } } (the shape of extractWithRules).
function runExtractor(cases, extract) {
  const predictions = {};
  for (const c of cases) {
    let out; try { out = extract(c.pages, c.ctx || {}); } catch (e) { out = { fields: {}, error: e.message }; }
    predictions[c.id] = Object.fromEntries(Object.entries(out.fields || {}).map(([k, f]) => [k, f && f.value]));
  }
  return predictions;
}

// Independent of the extractor's own date parser (so a parser bug cannot validate its own gold).
const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function dateAppears(text, ymd) {
  const [y, m, d] = ymd.split('-').map(Number); const t = String(text).toLowerCase();
  const mon = MON[m - 1], abbr = mon.slice(0, 3), dd = String(d).padStart(2, '0'), mm = String(m).padStart(2, '0');
  const day = `0?${d}(?:st|nd|rd|th)?`;
  const pats = [`\\b${day}[\\s,.-]+(?:${mon}|${abbr})[a-z]*\\.?,?[\\s-]+${y}\\b`, `\\b(?:${mon}|${abbr})[a-z]*\\.?\\s+${day},?\\s+${y}\\b`, `\\b${dd}[/.-]${mm}[/.-]${y}\\b`, `\\b${y}-${mm}-${dd}\\b`];
  return pats.some((p) => new RegExp(p, 'i').test(t));
}

// Corpus-level sanity: every gold value must be findable in its own document (otherwise the "gold" is wrong, not the extractor).
function validateGold(cases) {
  const problems = [];
  for (const c of cases) {
    if (!c.id || !Array.isArray(c.pages) || !c.pages.length) { problems.push({ case: c.id, problem: 'missing id or pages' }); continue; }
    if (!['SYNTHETIC', 'REAL'].includes(c.provenance)) problems.push({ case: c.id, problem: 'provenance must be SYNTHETIC or REAL' });
    if (c.provenance === 'REAL') {
      if (!c.source_url || !/^https:\/\//.test(c.source_url)) problems.push({ case: c.id, problem: 'REAL cases need the official source_url' });
      if (!c.document_sha256) problems.push({ case: c.id, problem: 'REAL cases need document_sha256 of the preserved original' });
      if ((c.adjudicators || 0) < 2) problems.push({ case: c.id, problem: 'REAL cases need two independent adjudicators' });
    }
    for (const [f, gv] of Object.entries(c.gold || {})) {
      if (gv === undefined || gv === null || (c.derived_fields || []).includes(f)) continue; // derived labels are judgements, not quotes
      const text = c.pages.map((p) => p.text).join('\n');
      const digits = (s) => String(s).replace(/\D/g, '');
      if (typeof gv === 'number' && !(c.derived_fields || []).includes(f) && !text.replace(/,/g, '').includes(String(gv))) problems.push({ case: c.id, field: f, problem: `gold value ${gv} does not appear in the document` });
      if (/^dates\.|cutoff_date$/.test(f) && !dateAppears(text, String(gv).slice(0, 10))) problems.push({ case: c.id, field: f, problem: `gold date ${gv} does not appear in the document` });
      if (typeof gv === 'string' && !/^dates\.|cutoff_date$/.test(f) && f !== 'title' && !text.toLowerCase().includes(gv.toLowerCase().slice(0, 12)) && digits(gv).length === 0) problems.push({ case: c.id, field: f, problem: `gold text "${gv}" does not appear in the document` });
    }
  }
  return problems;
}

module.exports = { dateAppears, normaliseValue, equal, wilson, scoreExtraction, runExtractor, validateGold };
