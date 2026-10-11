// Conflict resolution: later authoritative official update wins; disagreement is always recorded.
const KIND_RANK = { ORIGINAL: 1, CORRIGENDUM: 2, AMENDMENT: 2, FINAL_UPDATE: 3 };
const authority = (c) => (c.official ? 2 : 1);
const stamp = (c) => (c.issued_on ? Date.parse(c.issued_on) : c.fetched_at ? Date.parse(c.fetched_at) : 0);
const cmp = (a, b) => (authority(a) - authority(b)) || ((KIND_RANK[a.kind] || 1) - (KIND_RANK[b.kind] || 1)) || (stamp(a) - stamp(b));

// candidates: [{ document_id, kind, issued_on, fetched_at, official, value }]
function resolveField(field, candidates) {
  const { canon } = require('./util');
  const distinct = new Set(candidates.map((c) => canon(c.value)));
  if (distinct.size <= 1) return null;
  const ranked = [...candidates].sort((a, b) => cmp(b, a));
  const top = ranked[0], next = ranked.find((c) => canon(c.value) !== canon(top.value));
  const decisive = cmp(top, next) !== 0;
  return { field, candidates, resolution: decisive ? 'RESOLVED_LATER_AUTHORITATIVE' : 'UNRESOLVED', chosen: decisive ? top : null };
}

const FIELDS = ['dates.application_close', 'dates.application_open', 'dates.exam_date', 'vacancies.total', 'age.max', 'age.min', 'age.cutoff_date', 'education', 'fee', 'domicile'];
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

// docs: [{ document_id, kind, issued_on, fetched_at, official, data }] -> conflicts for fields where documents disagree
function findConflicts(docs) {
  const out = [];
  for (const f of FIELDS) {
    const cands = docs.map((d) => ({ document_id: d.document_id, kind: d.kind, issued_on: d.issued_on, fetched_at: d.fetched_at, official: d.official, value: get(d.data, f) })).filter((c) => c.value !== undefined);
    const r = resolveField(f, cands); if (r) out.push(r);
  }
  return out;
}

module.exports = { resolveField, findConflicts, cmp };
