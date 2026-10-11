// Append-only, hash-chained audit log. The database also rejects UPDATE/DELETE on it.
const crypto = require('crypto');
const { canon } = require('./util');
const db = require('./db');

async function audit(actor, action, entityType, entityId, detail = {}, client) {
  const run = async (c) => {
    await c.query('LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE');
    const last = (await c.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    const prev = last ? last.hash : 'GENESIS';
    const at = new Date().toISOString();
    const body = canon({ actor, action, entityType, entityId: entityId == null ? null : String(entityId), detail, at, prev });
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    await c.query('INSERT INTO audit_log(actor,action,entity_type,entity_id,detail,at,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [actor, action, entityType, entityId == null ? null : String(entityId), detail, at, prev, hash]);
  };
  if (client) return run(client);
  return db.tx(run);
}

async function verifyChain() {
  const rows = (await db.query('SELECT * FROM audit_log ORDER BY id')).rows;
  let prev = 'GENESIS';
  for (const r of rows) {
    const body = canon({ actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id, detail: r.detail, at: r.at.toISOString(), prev });
    const h = crypto.createHash('sha256').update(body).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}

module.exports = { audit, verifyChain };
