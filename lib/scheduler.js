// Continuous automation. One scheduler, two ways to run it: inside the web server (default, single deployment, no extra
// process) or as the standalone `node worker.js`. Both can run at once: scheduling work (look for new notifications, advance
// deadlines, alerts, broadcast, source verification) is done only by the instance holding a PostgreSQL advisory lock, so
// runs never overlap; the queue consumer is safe on every instance (FOR UPDATE SKIP LOCKED).
// Each task is isolated: one failing website or provider can not stop the others, and a task never overlaps itself.
const LOCK_ID = 727_000_182;

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const intervals = (env = process.env) => ({
  scheduleMs: num(env.SCHEDULE_TICK_SECONDS, 60) * 1000,       // how often we ask "which sources are due?"
  queueIdleMs: num(env.QUEUE_IDLE_SECONDS, 3) * 1000,
  alertsMs: num(env.ALERT_TICK_SECONDS, 60) * 1000,
  broadcastMs: num(env.BROADCAST_TICK_SECONDS, 30) * 1000,
  verifyMs: num(env.SOURCE_VERIFY_HOURS, 1) * 3600 * 1000,   // v2.10.0: 1 h (was 6 h) so a source that was briefly down is retried soon
  pushMs: num(env.PUSH_TICK_SECONDS, 10) * 1000,                // v2.10.0: how soon a new notice reaches subscribed phones/browsers
  trustMs: num(env.TRUST_MONITOR_HOURS, 6) * 3600 * 1000,   // v2.9.0: changed pages, broken links, expired notices, conflicting dates
  hybridSyncMs: Number(env.HYBRID_RAG_SYNC_MINUTES) > 0 ? Number(env.HYBRID_RAG_SYNC_MINUTES) * 60 * 1000 : 0,   // 0 = off (default in code; the shipped templates set 30)
  hybridRecoverMs: Number(env.HYBRID_RAG_SYNC_MINUTES) > 0 ? num(env.HYBRID_RAG_RECOVER_SECONDS, 120) * 1000 : 0,   // 'is the AI index empty after a restart?' check; only when sync is on
});

async function acquireLeader(db) {
  const client = await db.getPool().connect();
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (r.rows[0].ok) return { release: async () => { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } finally { client.release(); } } };
  } catch (e) { client.release(); throw e; }
  client.release(); return null;
}

function create(deps = {}) {
  const d = {
    db: require('./db'), queue: require('./queue'), registry: require('./registry'), alerts: require('./alerts'), policy: require('./sourcePolicy'),
    broadcast: require('./broadcast'), trust: require('./trust/service'), push: require('./pushNotify'), domainGuard: require('./domainGuard'), audit: require('./audit').audit, handlers: require('./ingest').handlers({}), lifecycleTick: null,
    acquireLeader, env: process.env, log: (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o })), ...deps,
  };
  const iv = { ...intervals(d.env), ...(deps.intervals || {}) };
  const timers = new Set(); let stopped = false, leader = null, lastLeaderTry = 0;
  const state = { started_at: null, leader: false, tasks: {} };
  const mark = (name, extra) => { state.tasks[name] = { at: new Date().toISOString(), ...extra }; };

  const loop = (name, ms, fn, { leaderOnly = false, initialMs = 1000 } = {}) => {
    if (iv.initialMs != null) initialMs = iv.initialMs;     // tests / fast start
    let running = false;
    const run = async () => {
      if (stopped || running) return; running = true;
      try {
        if (leaderOnly) await ensureLeader();
        if (!leaderOnly || leader) { const r = await fn(); mark(name, { ok: true, result: r }); }
      } catch (e) { mark(name, { ok: false, error: String(e.message).slice(0, 200) }); d.log({ msg: `${name} failed`, error: e.message }); }
      finally { running = false; if (!stopped) { const t = setTimeout(run, ms); t.unref && t.unref(); timers.add(t); } }
    };
    const t0 = setTimeout(run, initialMs); t0.unref && t0.unref(); timers.add(t0);
  };

  async function ensureLeader() {
    if (leader || Date.now() - lastLeaderTry < 15000) { state.leader = !!leader; return; }
    lastLeaderTry = Date.now();
    leader = await d.acquireLeader(d.db); state.leader = !!leader;
    if (leader) d.log({ msg: 'scheduler: this instance is the leader' });
  }

  const tasks = {
    // 1. What is due? Enqueue crawls for due sources and move published records through their date-driven states.
    async schedule() { await d.queue.recoverStuck(); const q1 = await d.queue.enqueue('SCHEDULE_CRAWLS'); const q2 = await d.queue.enqueue('ADVANCE_LIFECYCLE'); return { q1, q2 }; },
    // 2. Trust new official sources by evidence, never by assumption.
    // v2.10.0: reconcile first (national registry, corrected domains, crawl tiers), then verify by evidence, then flag portals that never answer.
    async verifySources() { await d.policy.seedExtra(d.db); let rec = { inserted: [], corrected: [], flagged: [] };
      try { rec = await d.domainGuard.reconcile({ db: d.db, audit: d.audit, env: d.env }); } catch (e) { d.log({ msg: 'reconcile failed', error: e.message }); }   // never blocks verification
      const ver = await d.policy.autoVerifyPending({ db: d.db, audit: d.audit });
      let flagged = []; try { flagged = await d.domainGuard.flagUnreachable({ db: d.db }); } catch (e) { d.log({ msg: 'flagUnreachable failed', error: e.message }); }
      return { ...ver, reconcile: { inserted: rec.inserted.length, corrected: rec.corrected.length, flagged: rec.flagged.length }, unreachable_flagged: flagged };
    },
    // v2.10.0: instant Web Push of new events to subscribed browsers/phones.
    async push() { return d.push.tick({ env: d.env, db: d.db }); },
    // 3. Per-person alerts (watchlists, saved searches) with real providers when configured.
    async alerts() { return d.alerts.workerTick({ providers: d.alertProviders ? d.alertProviders() : {} }); },
    // 5. Trust monitor (v2.9.0): re-check official pages and links, compare versions, raise flags.
    async trustMonitor() { return d.trust.monitorPass({}); },
    // 4. Channel broadcast of new notifications.
    async broadcast() { return d.broadcast.tick({ env: d.env }); },
    // 6. Keep the AI service's Hybrid RAG records in step with published, verified recruitments (off unless HYBRID_RAG_SYNC_MINUTES > 0).
    async hybridSync() { const r = await require('./hybridRecords').sync({ db: d.db, env: d.env }); return { ok: r.ok, pushed: r.pushed, removed: r.removed, failed: r.failed.length, code: r.code || null }; },
    // 7. The AI service keeps its index in memory (snapshot-restored when a persistent path is mounted). If it restarted empty,
    //    re-push at once instead of waiting for the next interval. One cheap GET when nothing is wrong.
    async hybridRecover() { const r = await require('./hybridRecords').syncIfEmpty({ db: d.db, env: d.env }); return { ok: r.ok, skipped: r.skipped || null, pushed: r.pushed, recovered: !!r.recovered, code: r.code || null }; },
  };

  function start() {
    state.started_at = new Date().toISOString();
    loop('schedule', iv.scheduleMs, tasks.schedule, { leaderOnly: true, initialMs: 500 });
    loop('verifySources', iv.verifyMs, tasks.verifySources, { leaderOnly: true, initialMs: 3000 });
    loop('alerts', iv.alertsMs, tasks.alerts, { leaderOnly: true, initialMs: 8000 });
    loop('broadcast', iv.broadcastMs, tasks.broadcast, { leaderOnly: true, initialMs: 6000 });
    loop('push', iv.pushMs, tasks.push, { leaderOnly: true, initialMs: 7000 });
    loop('trustMonitor', iv.trustMs, tasks.trustMonitor, { leaderOnly: true, initialMs: 20000 });
    if (iv.hybridSyncMs > 0) loop('hybridSync', iv.hybridSyncMs, tasks.hybridSync, { leaderOnly: true, initialMs: 20000 });
    if (iv.hybridRecoverMs > 0) loop('hybridRecover', iv.hybridRecoverMs, tasks.hybridRecover, { leaderOnly: true, initialMs: 45000 });
    // Queue consumer: drains continuously, then idles briefly. Safe on every instance.
    loop('queue', iv.queueIdleMs, async () => { const r = await d.queue.drain(d.handlers, 25); r.forEach((x) => x.status !== 'DONE' && d.log({ msg: 'queue job', ...x })); return { ran: r.length }; }, { initialMs: 1500 });
    return stop;
  }
  async function stop() {
    stopped = true; timers.forEach(clearTimeout); timers.clear();
    if (leader) { try { await leader.release(); } catch (_) {} leader = null; state.leader = false; }
  }
  return { start, stop, tasks, state, intervals: iv };
}

module.exports = { create, intervals, acquireLeader, LOCK_ID };
