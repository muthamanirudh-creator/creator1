'use strict';
// Conflict / amendment / deadline-change flags (v2.9.0).
//
// A flag is raised IMMEDIATELY (the moment a new version or document is compared), not when someone happens to notice.
// Flags are never auto-resolved: a reviewer closes each one with a reason, and the closure is written to the ledger.
// Detection is pure (versions in, flags out). Persistence is a separate, tiny store.
const crypto = require('crypto');
const { canon, same } = require('../util');
const { findConflicts } = require('../conflict');
const { CRITICAL_FIELDS } = require('./policy');
const ledger = require('./ledger');

const get = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const ymd = (v) => (v ? String(v).slice(0, 10) : null);
const days = (a, b) => Math.round((Date.parse(ymd(b)) - Date.parse(ymd(a))) / 864e5);

const KINDS = ['DEADLINE_CHANGED', 'CONFLICTING_AMENDMENT', 'CONFLICTING_SOURCES', 'REVERSED_AMENDMENT', 'UNSUPPORTED_CHANGE', 'CRITICAL_FIELD_CHANGED', 'LARGE_VACANCY_CHANGE', 'AMENDMENT_OVERRIDES_EARLIER', 'SOURCE_PAGE_CHANGED', 'SOURCE_UNREACHABLE', 'SOURCE_DATE_MISMATCH', 'NOTICE_EXPIRED'];
const SEVERITY_ORDER = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const evidenceOf = (v, field) => { const l = v && v.lineage && (v.lineage[field] || v.lineage[field.split('.')[0]]); return l && l.page_number && l.quote ? { document_id: l.document_id ?? null, page: l.page_number, quote: l.quote } : null; };
function mk(recruitment_id, f) { return { status: 'OPEN', ...f, recruitment_id, dedupe_key: `${f.kind}:${recruitment_id}:${f.field}:${sha(canon([f.from, f.to, f.documents || null]))}` }; }

// versions: [{ version_no, data, lineage, document: { id, kind, issued_on, official }, published?: bool }] oldest first.
// documents: optional [{ document_id, kind, issued_on, fetched_at, official, data }] for same-time disagreement detection.
function detectFlags({ recruitment_id, versions = [], documents = [], previousFlags = [] }) {
  const out = [];
  const vs = [...versions].sort((a, b) => a.version_no - b.version_no);

  for (let i = 1; i < vs.length; i++) {
    const a = vs[i - 1], b = vs[i];
    // 1. Deadline moved.
    const ca = get(a.data, 'dates.application_close'), cb = get(b.data, 'dates.application_close');
    if (ca && cb && !same(ca, cb)) {
      const n = days(ca, cb);
      const ev = { from: evidenceOf(a, 'dates.application_close'), to: evidenceOf(b, 'dates.application_close') };
      out.push(mk(recruitment_id, {
        kind: 'DEADLINE_CHANGED', field: 'dates.application_close', from: ca, to: cb, severity: n < 0 ? 'CRITICAL' : 'HIGH', evidence: ev,
        summary: n === 0 ? `Closing time changed from ${ca} to ${cb}.` : n > 0 ? `Closing date extended by ${n} day${n === 1 ? '' : 's'} (${ymd(ca)} -> ${ymd(cb)}).` : `Closing date ADVANCED by ${-n} day${n === -1 ? '' : 's'} (${ymd(ca)} -> ${ymd(cb)}). Applicants who planned for the earlier date may now be late.`,
        to_version: b.version_no, from_version: a.version_no,
      }));
      if (!ev.from || !ev.to) out.push(mk(recruitment_id, { kind: 'UNSUPPORTED_CHANGE', field: 'dates.application_close', from: ca, to: cb, severity: 'HIGH', evidence: ev, summary: 'The deadline changed but one of the two versions has no cited page and quote. Do not announce it as official until a reviewer checks.', to_version: b.version_no }));
    }
    // 2. Any other critical field moved.
    for (const f of CRITICAL_FIELDS) {
      if (f === 'dates.application_close') continue;
      const x = get(a.data, f), y = get(b.data, f);
      if (x === undefined && y === undefined) continue;
      if (same(x, y)) continue;
      const ev = { from: evidenceOf(a, f), to: evidenceOf(b, f) };
      out.push(mk(recruitment_id, { kind: 'CRITICAL_FIELD_CHANGED', field: f, from: x, to: y, severity: 'MEDIUM', evidence: ev, summary: `${f} changed from ${typeof x === 'object' ? JSON.stringify(x) : x} to ${typeof y === 'object' ? JSON.stringify(y) : y}. Earlier confirmations of this field no longer apply.`, to_version: b.version_no, from_version: a.version_no }));
      if (f === 'vacancies.total' && typeof x === 'number' && typeof y === 'number' && x > 0 && Math.abs(y - x) / x > 0.2) out.push(mk(recruitment_id, { kind: 'LARGE_VACANCY_CHANGE', field: f, from: x, to: y, severity: 'MEDIUM', evidence: ev, summary: `Vacancies changed by more than 20% (${x} -> ${y}). Confirm against the official corrigendum.`, to_version: b.version_no }));
      if (!ev.from || !ev.to) out.push(mk(recruitment_id, { kind: 'UNSUPPORTED_CHANGE', field: f, from: x, to: y, severity: 'MEDIUM', evidence: ev, summary: `${f} changed without a cited page and quote in both versions.`, to_version: b.version_no }));
    }
  }

  // 3. A -> B -> A on any critical field is suspicious: a reverted amendment, or an extraction flip-flop.
  for (const f of CRITICAL_FIELDS) {
    const seq = vs.map((v) => get(v.data, f)).filter((x) => x !== undefined);
    for (let i = 2; i < seq.length; i++) if (same(seq[i], seq[i - 2]) && !same(seq[i], seq[i - 1])) { out.push(mk(recruitment_id, { kind: 'REVERSED_AMENDMENT', field: f, from: seq[i - 1], to: seq[i], severity: 'HIGH', summary: `${f} went ${JSON.stringify(seq[i - 2])} -> ${JSON.stringify(seq[i - 1])} -> ${JSON.stringify(seq[i])}. Check whether an amendment was withdrawn or an extraction flipped.` })); break; }
  }

  // 4. Official documents that disagree. Same authority + same date => nobody may pick a winner.
  if (documents.length > 1) {
    for (const c of findConflicts(documents)) {
      const distinct = c.candidates.map((x) => canon(x.value));
      const label = c.candidates.map((x) => `${x.kind || 'document'} ${x.document_id ?? ''}: ${typeof x.value === 'object' ? JSON.stringify(x.value) : x.value}`).join(' vs ');
      if (c.resolution === 'UNRESOLVED') out.push(mk(recruitment_id, { kind: 'CONFLICTING_AMENDMENT', field: c.field, from: c.candidates[0].value, to: c.candidates[1] ? c.candidates[1].value : null, severity: 'CRITICAL', documents: c.candidates.map((x) => x.document_id), summary: `Official documents disagree and none is clearly later or more authoritative (${label}).`, candidates: c.candidates }));
      else out.push(mk(recruitment_id, { kind: 'AMENDMENT_OVERRIDES_EARLIER', field: c.field, from: c.candidates.find((x) => canon(x.value) !== canon(c.chosen.value))?.value, to: c.chosen.value, severity: 'INFO', documents: distinct, summary: `A later official ${c.chosen.kind || 'document'} overrides an earlier value for ${c.field} (${label}).`, candidates: c.candidates }));
    }
  }

  // Do not re-raise what is already open or was dismissed with a reason.
  const known = new Set(previousFlags.map((f) => f.dedupe_key));
  return out.filter((f) => !known.has(f.dedupe_key)).sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}

// ---- stores --------------------------------------------------------------------------------------------------------
function memoryStore(ledgerStore) {
  const rows = [];
  return {
    kind: 'memory', _rows: rows, ledger: ledgerStore,
    async insert(f) { if (rows.some((r) => r.dedupe_key === f.dedupe_key)) return { created: false, flag: rows.find((r) => r.dedupe_key === f.dedupe_key) }; const r = { ...f, id: rows.length + 1, raised_at: new Date().toISOString() }; rows.push(r); return { created: true, flag: r }; },
    async open(recruitment_id) { return rows.filter((r) => r.status === 'OPEN' && (!recruitment_id || r.recruitment_id === recruitment_id)); },
    async all(recruitment_id) { return rows.filter((r) => !recruitment_id || r.recruitment_id === recruitment_id); },
    async get(id) { return rows.find((r) => r.id === +id) || null; },
    async close(id, patch) { const r = rows.find((x) => x.id === +id); Object.assign(r, patch); return r; },
  };
}
function pgStore(db, ledgerStore) {
  const map = (r) => ({ ...r.detail, id: r.id, recruitment_id: r.recruitment_id, kind: r.kind, severity: r.severity, field: r.field, summary: r.summary, status: r.status, dedupe_key: r.dedupe_key, raised_at: r.raised_at instanceof Date ? r.raised_at.toISOString() : r.raised_at, resolved_by: r.resolved_by, resolved_at: r.resolved_at, resolution_note: r.resolution_note });
  return {
    kind: 'pg', ledger: ledgerStore,
    async insert(f) {
      const { kind, severity, field, summary, status, recruitment_id, dedupe_key, ...detail } = f;
      const r = await db.query(`INSERT INTO trust_flags(recruitment_id,kind,severity,field,summary,detail,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedupe_key) DO NOTHING RETURNING *`, [recruitment_id, kind, severity, field, summary, JSON.stringify(detail), dedupe_key]);
      if (r.rows[0]) return { created: true, flag: map(r.rows[0]) };
      return { created: false, flag: map((await db.query('SELECT * FROM trust_flags WHERE dedupe_key=$1', [dedupe_key])).rows[0]) };
    },
    async open(recruitment_id) { return (await db.query(`SELECT * FROM trust_flags WHERE status='OPEN' AND ($1::text IS NULL OR recruitment_id=$1) ORDER BY id`, [recruitment_id || null])).rows.map(map); },
    async all(recruitment_id) { return (await db.query(`SELECT * FROM trust_flags WHERE ($1::text IS NULL OR recruitment_id=$1) ORDER BY id`, [recruitment_id || null])).rows.map(map); },
    async get(id) { const r = (await db.query('SELECT * FROM trust_flags WHERE id=$1', [+id])).rows[0]; return r ? map(r) : null; },
    async close(id, patch) { const r = (await db.query(`UPDATE trust_flags SET status=$2, resolved_by=$3, resolved_at=$4, resolution_note=$5 WHERE id=$1 RETURNING *`, [+id, patch.status, patch.resolved_by, patch.resolved_at, patch.resolution_note])).rows[0]; return r ? map(r) : null; },
  };
}

// Persist new flags (idempotent) and write each one to the ledger. Returns the flags that were NEW.
async function raiseAll(store, flags, { actor = 'system:trust-monitor' } = {}) {
  const created = [];
  for (const f of flags) {
    const r = await store.insert(f);
    if (r.created) { created.push(r.flag); await ledger.record(store.ledger, { recruitment_id: f.recruitment_id, kind: 'FLAG_RAISED', actor, detail: { kind: f.kind, severity: f.severity, field: f.field, summary: f.summary, flag_id: r.flag.id } }); }
  }
  return created;
}

// A person closes a flag. Conflicts and critical flags need a real explanation, not a click.
async function resolveFlag(store, id, reviewer, { resolution = 'RESOLVED', note = '' } = {}) {
  if (!reviewer || !reviewer.email) throw Object.assign(new Error('A signed-in reviewer is required.'), { status: 401 });
  if (!['RESOLVED', 'DISMISSED'].includes(resolution)) throw Object.assign(new Error('resolution must be RESOLVED or DISMISSED'), { status: 400 });
  const f = await store.get(id); if (!f) throw Object.assign(new Error('Flag not found.'), { status: 404 });
  if (f.status !== 'OPEN') throw Object.assign(new Error('This flag is already closed.'), { status: 409 });
  const needsNote = ['CRITICAL', 'HIGH'].includes(f.severity) || /^CONFLICTING/.test(f.kind);
  if (needsNote && String(note).trim().length < 10) throw Object.assign(new Error('Explain how this was resolved (at least 10 characters). Conflicts and high-severity flags cannot be closed silently.'), { status: 400 });
  const closed = await store.close(id, { status: resolution, resolved_by: reviewer.email, resolved_at: new Date().toISOString(), resolution_note: String(note).trim() });
  await ledger.record(store.ledger, { recruitment_id: f.recruitment_id, kind: 'FLAG_RESOLVED', actor: `human:${reviewer.email}`, detail: { flag_id: f.id, kind: f.kind, field: f.field, resolution, note: String(note).trim() } });
  return closed;
}

// pg helper: load versions + documents for detection.
async function loadVersions(db, recruitment_id) {
  const rows = (await db.query(`SELECT v.version_no, v.data, v.lineage, v.document_id, v.status, d.kind, d.issued_on, d.title
    FROM recruitment_versions v LEFT JOIN documents d ON d.id=v.document_id WHERE v.recruitment_id=$1 AND v.status IN ('APPROVED','SUPERSEDED','PENDING') ORDER BY v.version_no`, [recruitment_id])).rows;
  return rows.map((r) => ({ version_no: r.version_no, data: r.data, lineage: r.lineage, status: r.status, document: { id: r.document_id, kind: r.kind, issued_on: r.issued_on, title: r.title, official: true } }));
}

module.exports = { KINDS, SEVERITY_ORDER, detectFlags, memoryStore, pgStore, raiseAll, resolveFlag, loadVersions };
