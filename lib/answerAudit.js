// Per-answer audit trail: what was asked, which route/mode, which fields were read, from which page, and the
// verification result. Hash-chained so edits are detectable. Pluggable store: memory (tests) or PostgreSQL.
const crypto = require('crypto');
const { canon } = require('./util');

function memoryStore() {
  const rows = [];
  return {
    kind: 'memory',
    async last() { return rows[rows.length - 1] || null; },
    async insert(r) { r.id = rows.length + 1; rows.push(r); return r; },
    async get(id) { return rows.find((r) => r.id === +id) || null; },
    async list(limit = 50) { return rows.slice(-limit).reverse(); },
    async all() { return rows.slice(); },
    _rows: rows,
  };
}

function pgStore(db) {
  return {
    kind: 'pg',
    async last() { return (await db.query('SELECT hash FROM answer_audits WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1')).rows[0] || null; },
    async insert(r) {
      const x = (await db.query(`INSERT INTO answer_audits(actor,question,mode,recruitment_id,answer,claims,verification,filters,intent,segments,sources,prev_hash,hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,created_at`,
        [r.actor, r.question, r.mode, r.recruitment_id, r.answer, JSON.stringify(r.claims), JSON.stringify(r.verification), JSON.stringify(r.filters || {}), r.intent, JSON.stringify(r.segments), JSON.stringify(r.sources), r.prev_hash, r.hash])).rows[0];
      return { ...r, ...x };
    },
    async get(id) { return (await db.query('SELECT * FROM answer_audits WHERE id=$1', [+id])).rows[0] || null; },
    async list(limit = 50) { return (await db.query('SELECT id,question,mode,intent,recruitment_id,verification,created_at FROM answer_audits ORDER BY id DESC LIMIT $1', [limit])).rows; },
    async all() { return (await db.query('SELECT * FROM answer_audits ORDER BY id')).rows; },
  };
}

const bodyOf = (r) => canon({ actor: r.actor, question: r.question, mode: r.mode, intent: r.intent, recruitment_id: r.recruitment_id, answer: r.answer, verification: r.verification, sources: r.sources, prev: r.prev_hash });

async function record(store, { actor = 'public', question, result, jobId }) {
  const last = await store.last();
  const entry = {
    actor, question, mode: result.mode, intent: result.intent, recruitment_id: jobId || result.recruitment_id,
    answer: result.text, claims: (result.claims || []).map((c) => ({ field: c.field, label: c.label, value: c.value, source: c.source })),
    segments: result.segments || [], sources: result.where_did_this_come_from || [],
    verification: { ok: result.audit.ok, tokens_checked: result.audit.checks.length, unsupported: result.audit.unsupported, official_silent: !!result.official_silent },
    filters: {}, prev_hash: last ? last.hash : 'GENESIS',
  };
  entry.hash = crypto.createHash('sha256').update(bodyOf(entry)).digest('hex');
  return store.insert(entry);
}

async function verifyChain(store) {
  let prev = 'GENESIS';
  for (const r of await store.all()) {
    const h = crypto.createHash('sha256').update(bodyOf({ ...r, prev_hash: prev })).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}

module.exports = { memoryStore, pgStore, record, verifyChain };
