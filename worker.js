// Standalone background worker. The same scheduler also runs inside the web server (RUN_WORKER_INLINE, default on), so this
// process is optional: run it when you want crawling on a separate machine. Only one instance schedules at a time (advisory lock).
const db = require('./lib/db');
const registry = require('./lib/registry');
const scheduler = require('./lib/scheduler');
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
async function main() {
  await db.migrate(); await registry.seedRegistry();
  const s = scheduler.create({ log, alertProviders: require('./lib/providers').alertProviders });
  const stop = s.start();
  log({ msg: 'worker started', intervals: s.intervals });
  const bye = async (sig) => { log({ msg: 'worker stopping', sig }); await stop(); await db.close(); process.exit(0); };
  process.on('SIGTERM', () => bye('SIGTERM')); process.on('SIGINT', () => bye('SIGINT'));
  return s;
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
