// Behavioral tests for the alert engine. Uses an in-memory store that enforces the same UNIQUE(account_id,dedupe_key)
// rule as the schema. It does NOT execute the SQL in lib/alerts.js (needs PostgreSQL) - see README.
const assert = require('assert');
const { planDeadlineAlerts, planMatchAlerts } = require('./lib/alertPlanner');
const { deliverBatch, backoffSeconds } = require('./lib/alertDelivery');
let pass = 0, fail = 0; const queue = [];
const t = (n, f) => queue.push([n, f]);
const NOW = new Date('2026-10-03T10:00:00Z');
const row = (o = {}) => ({ account_id: 1, recruitment_id: 'R1', to_version: 2, field: 'dates.application_close', label: 'Last date', from_value: '2026-10-20', to_value: '2026-11-05', supported: true, detected_at: '2026-10-02T09:00:00Z', title: 'Group D', published_version: 2, watch_created_at: '2026-09-01T00:00:00Z', account_active: true, ...o });

function memStore() {
  const s = { alerts: [], deliveries: [], log: [] };
  s.insertAlert = async (p, channels = ['IN_APP', 'EMAIL', 'PUSH']) => {
    if (s.alerts.some((a) => a.accountId === p.accountId && a.dedupeKey === p.dedupeKey)) return { created: false };
    const id = s.alerts.length + 1; s.alerts.push({ id, ...p });
    for (const ch of channels) s.deliveries.push({ id: s.deliveries.length + 1, alert_id: id, channel: ch, status: 'QUEUED', attempts: 0, next_attempt_at: new Date(0), account_id: p.accountId, payload: p.payload });
    return { created: true, id };
  };
  s.accounts = { 1: { email: 'a@x.in', active: true }, 2: { email: 'b@x.in', active: true } };
  s.claimDeliveries = async (limit, now) => { const due = s.deliveries.filter((d) => d.status === 'QUEUED' && d.next_attempt_at <= now).slice(0, limit); due.forEach((d) => { d.status = 'SENDING'; }); return due.map((d) => ({ id: d.id, alert_id: d.alert_id, channel: d.channel, attempts: d.attempts, payload: d.payload, email: s.accounts[d.account_id].email, account_active: s.accounts[d.account_id].active })); };
  s.finishDelivery = async (id, patch) => { const d = s.deliveries.find((x) => x.id === id); for (const [k, v] of Object.entries(patch)) if (v !== undefined) d[k] = v; };
  return s;
}
const persist = async (store, plans) => { let c = 0; for (const p of plans) if ((await store.insertAlert(p)).created) c++; return c; };

// ---- planner: eligibility ----
t('baseline: one valid change -> one alert', () => assert.strictEqual(planDeadlineAlerts([row()], { now: NOW }).length, 1));
t('unsupported (no evidence) change never alerts', () => assert.strictEqual(planDeadlineAlerts([row({ supported: false })], { now: NOW }).length, 0));
t('supported must be strictly true (null/undefined do not alert)', () => { assert.strictEqual(planDeadlineAlerts([row({ supported: null })], { now: NOW }).length, 0); assert.strictEqual(planDeadlineAlerts([row({ supported: undefined })], { now: NOW }).length, 0); });
t('change in a version still under review never alerts', () => assert.strictEqual(planDeadlineAlerts([row({ to_version: 3, published_version: 2 })], { now: NOW }).length, 0));
t('missing published_version never alerts', () => assert.strictEqual(planDeadlineAlerts([row({ published_version: null })], { now: NOW }).length, 0));
t('change before the user started watching never alerts', () => assert.strictEqual(planDeadlineAlerts([row({ watch_created_at: '2026-10-03T00:00:00Z' })], { now: NOW }).length, 0));
t('withdrawn / inactive account never alerts', () => assert.strictEqual(planDeadlineAlerts([row({ account_active: false })], { now: NOW }).length, 0));
t('non-date fields are ignored', () => assert.strictEqual(planDeadlineAlerts([row({ field: 'vacancies.total' })], { now: NOW }).length, 0));
t('changes older than lookback are ignored', () => assert.strictEqual(planDeadlineAlerts([row({ detected_at: '2026-06-01T00:00:00Z', watch_created_at: '2026-05-01T00:00:00Z' })], { now: NOW }).length, 0));
t('"dates" prefix does not match unrelated fields like "datesheet"', () => assert.strictEqual(planDeadlineAlerts([row({ field: 'datesheet.x' })], { now: NOW }).length, 0));

// ---- planner: grouping / dedupe keys ----
t('two date fields changed in one version -> ONE alert carrying both', () => {
  const p = planDeadlineAlerts([row(), row({ field: 'dates.exam_date', label: 'Exam date', from_value: '2026-12-01', to_value: '2026-12-15' })], { now: NOW });
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].payload.changes.length, 2);
});
t('different versions of the same recruitment -> separate alerts', () => assert.strictEqual(planDeadlineAlerts([row(), row({ to_version: 3, published_version: 3 })], { now: NOW }).length, 2));
t('two watchers of one change -> exactly one alert each', () => { const p = planDeadlineAlerts([row(), row({ account_id: 2 })], { now: NOW }); assert.deepStrictEqual(p.map((x) => x.accountId).sort(), [1, 2]); });
t('dedupe key is stable across runs', () => assert.strictEqual(planDeadlineAlerts([row()], { now: NOW })[0].dedupeKey, planDeadlineAlerts([row()], { now: new Date(NOW.getTime() + 3600e3) })[0].dedupeKey));

// ---- persistence dedupe (schema UNIQUE emulated) ----
t('re-running the engine on the same data creates zero new alerts', async () => {
  const s = memStore(); const plans = planDeadlineAlerts([row(), row({ account_id: 2 })], { now: NOW });
  assert.strictEqual(await persist(s, plans), 2); assert.strictEqual(await persist(s, plans), 0); assert.strictEqual(s.alerts.length, 2); assert.strictEqual(s.deliveries.length, 6);
});

// ---- new match planner ----
const runSearch = (jobs, f) => jobs.filter((j) => !f.state || j.state === f.state);
const job = (id, verified, state = 'UP') => ({ id, title: id, state, verification: { verified_at: verified } });
t('NEW_MATCH only for jobs published after the search was created', () => {
  const p = planMatchAlerts({ searches: [{ id: 9, account_id: 1, name: 's', filters: { state: 'UP' }, created_at: '2026-09-15T00:00:00Z' }], jobs: [job('old', '2026-09-01T00:00:00Z'), job('new', '2026-09-20T00:00:00Z')], runSearch, now: NOW });
  assert.deepStrictEqual(p.map((x) => x.recruitmentId), ['new']);
});
t('NEW_MATCH is silent when publish time is unknown', () => assert.strictEqual(planMatchAlerts({ searches: [{ id: 9, account_id: 1, name: 's', filters: {}, created_at: '2026-09-15T00:00:00Z' }], jobs: [job('x', undefined)], runSearch, now: NOW }).length, 0));
t('two searches matching one job -> one alert per account', () => assert.strictEqual(planMatchAlerts({ searches: [1, 2].map((i) => ({ id: i, account_id: 1, name: 's' + i, filters: {}, created_at: '2026-09-15T00:00:00Z' })), jobs: [job('j', '2026-09-20T00:00:00Z')], runSearch, now: NOW }).length, 1));
t('two accounts same search -> one alert each', () => assert.strictEqual(planMatchAlerts({ searches: [1, 2].map((i) => ({ id: i, account_id: i, name: 's', filters: {}, created_at: '2026-09-15T00:00:00Z' })), jobs: [job('j', '2026-09-20T00:00:00Z')], runSearch, now: NOW }).length, 2));

// ---- delivery ----
t('without providers EMAIL/PUSH are SKIPPED, never falsely SENT; IN_APP is SENT', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); const r = await deliverBatch(s, {}, { now: NOW });
  const by = Object.fromEntries(s.deliveries.map((d) => [d.channel, d]));
  assert.strictEqual(by.IN_APP.status, 'SENT'); assert.strictEqual(by.EMAIL.status, 'SKIPPED'); assert.strictEqual(by.PUSH.status, 'SKIPPED'); assert(by.EMAIL.last_error.includes('nothing was sent')); assert.strictEqual(r.sent, 1); assert.strictEqual(r.skipped, 2);
});
t('a configured provider sends once with an idempotency key and records its message id', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); const calls = [];
  await deliverBatch(s, { EMAIL: async (m) => { calls.push(m); return { id: 'msg-1' }; }, PUSH: async () => ({ id: 'p-1' }) }, { now: NOW });
  assert.strictEqual(calls.length, 1); assert.strictEqual(calls[0].to, 'a@x.in'); assert(calls[0].idempotencyKey.startsWith('alert-1-')); assert.strictEqual(s.deliveries.find((d) => d.channel === 'EMAIL').provider_message_id, 'msg-1');
});
t('second worker tick never re-sends already delivered rows', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); let n = 0; const prov = { EMAIL: async () => { n++; return { id: 'm' }; } };
  await deliverBatch(s, prov, { now: NOW }); const r2 = await deliverBatch(s, prov, { now: NOW }); assert.strictEqual(n, 1); assert.strictEqual(r2.claimed, 0);
});
t('concurrent workers get disjoint rows (claim flips state)', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); const [a, b] = [await s.claimDeliveries(100, NOW), await s.claimDeliveries(100, NOW)]; assert.strictEqual(a.length, 3); assert.strictEqual(b.length, 0);
});
t('provider failure retries with backoff, then FAILED after max attempts', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); const prov = { EMAIL: async () => { throw new Error('smtp down'); } };
  let now = NOW; const em = () => s.deliveries.find((d) => d.channel === 'EMAIL');
  await deliverBatch(s, prov, { now }); assert.strictEqual(em().status, 'QUEUED'); assert.strictEqual(em().attempts, 1); assert(em().next_attempt_at > now);
  const r = await deliverBatch(s, prov, { now }); assert.strictEqual(r.claimed, 0, 'not due yet -> not retried early');
  now = new Date(now.getTime() + 3600e3); await deliverBatch(s, prov, { now }); assert.strictEqual(em().attempts, 2);
  now = new Date(now.getTime() + 3600e3); await deliverBatch(s, prov, { now }); assert.strictEqual(em().status, 'FAILED'); assert.strictEqual(em().attempts, 3);
});
t('provider returning no id is treated as failure, not success', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); await deliverBatch(s, { EMAIL: async () => ({}) }, { now: NOW }); assert.strictEqual(s.deliveries.find((d) => d.channel === 'EMAIL').status, 'QUEUED');
});
t('consent withdrawn after queueing -> pending deliveries are SKIPPED, nothing sent', async () => {
  const s = memStore(); await persist(s, planDeadlineAlerts([row()], { now: NOW })); s.accounts[1].active = false; let n = 0;
  await deliverBatch(s, { EMAIL: async () => { n++; return { id: 'x' }; } }, { now: NOW }); assert.strictEqual(n, 0); assert(s.deliveries.every((d) => d.status === 'SKIPPED'));
});
t('backoff grows and is capped', () => { assert(backoffSeconds(2) > backoffSeconds(1)); assert.strictEqual(backoffSeconds(30), 3600); });

(async () => { for (const [n, f] of queue) { try { await f(); pass++; console.log('✓', n); } catch (e) { fail++; console.log('✗', n, '-', e.message); } } console.log(`\nPhase 4 behavior: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
