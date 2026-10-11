// DB-backed job queue (no Redis): FOR UPDATE SKIP LOCKED, retries with exponential backoff.
const db = require('./db');

async function enqueue(type, payload = {}, { runAt = new Date(), maxAttempts = 3 } = {}) {
  const r = await db.query('INSERT INTO job_queue(type,payload,run_at,max_attempts) VALUES ($1,$2,$3,$4) RETURNING id', [type, payload, runAt, maxAttempts]);
  return r.rows[0].id;
}

async function claim() {
  return db.tx(async (c) => {
    const r = await c.query(`SELECT * FROM job_queue WHERE status='PENDING' AND run_at<=now() ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!r.rows[0]) return null;
    await c.query(`UPDATE job_queue SET status='RUNNING', locked_at=now(), attempts=attempts+1 WHERE id=$1`, [r.rows[0].id]);
    return { ...r.rows[0], attempts: r.rows[0].attempts + 1 };
  });
}

async function runOne(handlers) {
  const job = await claim();
  if (!job) return null;
  try {
    const h = handlers[job.type];
    if (!h) throw new Error(`No handler for ${job.type}`);
    await h(job.payload, job);
    await db.query(`UPDATE job_queue SET status='DONE' WHERE id=$1`, [job.id]);
    return { id: job.id, status: 'DONE' };
  } catch (e) {
    const dead = job.attempts >= job.max_attempts;
    const backoff = Math.min(3600, 30 * 2 ** (job.attempts - 1));
    await db.query(`UPDATE job_queue SET status=$2, last_error=$3, run_at=now() + ($4 || ' seconds')::interval WHERE id=$1`,
      [job.id, dead ? 'FAILED' : 'PENDING', String(e.message).slice(0, 500), String(backoff)]);
    return { id: job.id, status: dead ? 'FAILED' : 'RETRY', error: e.message };
  }
}

async function drain(handlers, limit = 100) {
  const out = [];
  for (let i = 0; i < limit; i++) { const r = await runOne(handlers); if (!r) break; out.push(r); }
  return out;
}

// Jobs stuck in RUNNING (worker crashed) go back to PENDING.
async function recoverStuck(minutes = 15) {
  const r = await db.query(`UPDATE job_queue SET status='PENDING' WHERE status='RUNNING' AND locked_at < now() - ($1 || ' minutes')::interval RETURNING id`, [String(minutes)]);
  return r.rowCount;
}

module.exports = { enqueue, claim, runOne, drain, recoverStuck };
