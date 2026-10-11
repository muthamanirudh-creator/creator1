// PostgreSQL access + a small migration runner.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://govcareer:govcareer@localhost:5432/govcareer', max: 10, connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 2000), idleTimeoutMillis: 10000 });
  }
  return pool;
}
const query = (text, params) => getPool().query(text, params);

async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function migrate() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async (c) => { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); });
  }
}

async function resetForTests() {
  await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
async function close() { if (pool) { await pool.end(); pool = null; } }

module.exports = { getPool, query, tx, migrate, resetForTests, close };
