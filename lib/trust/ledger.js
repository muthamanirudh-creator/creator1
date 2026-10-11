'use strict';
// Evidence ledger + per-field human verification (v2.9.0).
//
// Two things are kept, and both are append-only:
//   field_verifications   WHO confirmed WHICH field, at WHAT value, against WHICH page and quote of WHICH document
//   evidence_ledger       a hash-chained history of every trust-relevant event (confirmation, rejection, amendment,
//                         conflict, flag raised/resolved, retraction, source check), so the reason a record is shown
//                         as verified / detected / amended can be reconstructed and tampering is detectable.
const crypto = require('crypto');
const { canon } = require('../util');
const { CRITICAL_FIELDS, hashValue } = require('./policy');

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const get = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const KINDS = ['FIELD_CONFIRMED', 'FIELD_REJECTED', 'RECORD_PUBLISHED', 'RECORD_AMENDED', 'RECORD_RETRACTED', 'FLAG_RAISED', 'FLAG_RESOLVED', 'SOURCE_CHECKED', 'DOCUMENT_PRESERVED', 'NOTE'];

// ---- stores ------------------------------------------------------------------------------------------------------
function memoryStore() {
  const ledger = [], verifs = [];
  return {
    kind: 'memory', _ledger: ledger, _verifs: verifs,
    async append(build) { const prev = ledger.length ? ledger[ledger.length - 1].hash : 'GENESIS'; const e = build(prev); e.id = ledger.length + 1; ledger.push(e); return e; },
    async allLedger() { return ledger.slice(); },
    async ledgerFor(id) { return ledger.filter((e) => e.recruitment_id === id); },
    async addVerification(v) { v.id = verifs.length + 1; verifs.push(v); return v; },
    async verificationsFor(id) { return verifs.filter((v) => v.recruitment_id === id); },
  };
}

function pgStore(db) {
  return {
    kind: 'pg',
    async append(build, client) {
      const run = async (c) => {
        await c.query('LOCK TABLE evidence_ledger IN SHARE ROW EXCLUSIVE MODE');
        const last = (await c.query('SELECT hash FROM evidence_ledger ORDER BY id DESC LIMIT 1')).rows[0];
        const e = build(last ? last.hash : 'GENESIS');
        const r = await c.query('INSERT INTO evidence_ledger(recruitment_id,kind,actor,detail,at,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [e.recruitment_id, e.kind, e.actor, JSON.stringify(e.detail), e.at, e.prev_hash, e.hash]);
        return { ...e, id: r.rows[0].id };
      };
      return client ? run(client) : db.tx(run);
    },
    async allLedger() { return (await db.query('SELECT id,recruitment_id,kind,actor,detail,at,prev_hash,hash FROM evidence_ledger ORDER BY id')).rows.map((r) => ({ ...r, at: r.at instanceof Date ? r.at.toISOString() : r.at })); },
    async ledgerFor(id) { return (await db.query('SELECT id,recruitment_id,kind,actor,detail,at,hash FROM evidence_ledger WHERE recruitment_id=$1 ORDER BY id', [id])).rows; },
    async addVerification(v, client) {
      const c = client || db;
      const r = await c.query(`INSERT INTO field_verifications(recruitment_id,version_no,field,value,value_hash,evidence,verified_by,verified_at,method,note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [v.recruitment_id, v.version_no ?? null, v.field, JSON.stringify(v.value ?? null), v.value_hash, JSON.stringify(v.evidence), v.verified_by, v.verified_at, v.method, v.note || null]);
      return { ...v, id: r.rows[0].id };
    },
    async verificationsFor(id) {
      return (await db.query('SELECT id,recruitment_id,version_no,field,value,value_hash,evidence,verified_by,verified_at,method,note FROM field_verifications WHERE recruitment_id=$1 ORDER BY id', [id]))
        .rows.map((r) => ({ ...r, verified_at: r.verified_at instanceof Date ? r.verified_at.toISOString() : r.verified_at }));
    },
  };
}

// ---- ledger ------------------------------------------------------------------------------------------------------
const body = (e) => canon({ recruitment_id: e.recruitment_id ?? null, kind: e.kind, actor: e.actor, detail: e.detail, at: e.at, prev: e.prev_hash });

async function record(store, { recruitment_id = null, kind, actor, detail = {}, at = new Date().toISOString() }, client) {
  if (!KINDS.includes(kind)) throw httpErr(400, `Unknown ledger kind ${kind}.`);
  if (!actor) throw httpErr(400, 'A ledger entry must name its actor.');
  return store.append((prev) => { const e = { recruitment_id, kind, actor: String(actor), detail, at, prev_hash: prev }; e.hash = sha(body(e)); return e; }, client);
}

async function verifyLedger(store) {
  let prev = 'GENESIS'; const rows = await store.allLedger();
  for (const r of rows) {
    const at = r.at instanceof Date ? r.at.toISOString() : r.at;
    if (r.prev_hash !== prev || r.hash !== sha(body({ ...r, at, prev_hash: prev }))) return { ok: false, brokenAt: r.id, entries: rows.length };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

// ---- evidence ----------------------------------------------------------------------------------------------------
// The quote must really be on the cited page of the preserved document. `pages` = [{ page_number, text }].
function checkEvidence(evidence, pages) {
  if (!evidence || typeof evidence !== 'object') return 'Evidence is required.';
  if (!Number.isInteger(evidence.page) || evidence.page < 1) return 'Cite the page number in the official document.';
  if (!evidence.quote || String(evidence.quote).trim().length < 4) return 'Quote the passage that states the value.';
  if (evidence.document_id == null && !evidence.document_sha256) return 'Name the preserved official document (document_id or document_sha256).';
  if (pages) {
    const p = pages.find((x) => x.page_number === evidence.page);
    if (!p) return `Page ${evidence.page} does not exist in the preserved document.`;
    if (!flat(p.text).includes(flat(evidence.quote))) return `That passage was not found on page ${evidence.page}.`;
  }
  return null;
}

// Does the quoted passage actually contain the value being confirmed? Prevents confirming "30 Nov" against a quote about fees.
function quoteSupportsValue(field, value, quote) {
  const q = String(quote).replace(/,/g, '');
  const digits = (v) => String(v).replace(/\D/g, '');
  if (typeof value === 'number') return q.includes(String(value));
  if (/^dates\./.test(field) || /cutoff_date$/.test(field)) {
    const { datesIn } = require('../rulesExtractor');
    return datesIn(quote).includes(String(value).slice(0, 10));
  }
  if (field === 'education' && value && Array.isArray(value.accepted)) {
    const { levelsFrom } = require('../rulesExtractor');
    const found = levelsFrom(quote).accepted; return value.accepted.every((l) => found.includes(l));
  }
  return digits(quote).includes(digits(value)) || flat(quote).includes(flat(value));
}

// A reviewer confirms ONE critical field of a record's CURRENT value. `job` is the record as currently published/pending.
async function confirmField({ store, job, field, evidence, reviewer, note = '', pages = null, version_no = null, method = 'HUMAN_CONFIRMATION', now = new Date(), client }) {
  if (!reviewer || !reviewer.email) throw httpErr(401, 'A signed-in reviewer is required.');
  if (!CRITICAL_FIELDS.includes(field)) throw httpErr(400, `${field} is not a critical field. Critical fields: ${CRITICAL_FIELDS.join(', ')}.`);
  const value = get(job, field);
  if (value === undefined || value === null || value === '') throw httpErr(409, `The record has no value for ${field}, so there is nothing to confirm. Mark it as missing instead.`);
  const bad = checkEvidence(evidence, pages); if (bad) throw httpErr(400, bad);
  if (!quoteSupportsValue(field, value, evidence.quote)) throw httpErr(400, `The quoted passage does not contain the recorded value for ${field}. Quote the exact line that states it.`);
  const row = { recruitment_id: job.id, version_no, field, value, value_hash: hashValue(value), evidence: { document_id: evidence.document_id ?? null, document_sha256: evidence.document_sha256 ?? null, page: evidence.page, quote: String(evidence.quote).trim() }, verified_by: reviewer.email, verified_at: now.toISOString(), method, note };
  const saved = await store.addVerification(row, client);
  await record(store, { recruitment_id: job.id, kind: 'FIELD_CONFIRMED', actor: `human:${reviewer.email}`, at: now.toISOString(), detail: { field, value_hash: row.value_hash, evidence: row.evidence, note, verification_id: saved.id } }, client);
  return saved;
}

module.exports = { KINDS, memoryStore, pgStore, record, verifyLedger, checkEvidence, quoteSupportsValue, confirmField };
