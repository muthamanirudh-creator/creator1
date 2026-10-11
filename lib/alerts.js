// Phase 4 alert engine: SQL store + orchestration. Decisions live in alertPlanner.js, delivery in alertDelivery.js.
const db = require('./db');
const { runSearch } = require('./search');
const repo = require('./repo');
const { planDeadlineAlerts, planMatchAlerts } = require('./alertPlanner');
const { deliverBatch } = require('./alertDelivery');
const CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'];
const LOOKBACK_DAYS = 30;

const pgStore = {
  // Only changes that (a) have page+quote evidence, (b) are in a published version, (c) happened after the user began watching.
  async deadlineRows(days = LOOKBACK_DAYS) {
    return (await db.query(`SELECT w.account_id, ce.recruitment_id, ce.to_version, ce.field, ce.label, ce.from_value, ce.to_value, ce.supported, ce.detected_at, r.title, r.published_version, w.created_at AS watch_created_at, a.active AS account_active
      FROM change_events ce
      JOIN recruitments r ON r.id=ce.recruitment_id AND r.published_at IS NOT NULL AND r.lifecycle<>'ARCHIVED' AND ce.to_version<=r.published_version
      JOIN watchlists w ON w.recruitment_id=ce.recruitment_id AND ce.detected_at>=w.created_at
      JOIN citizen_accounts a ON a.id=w.account_id AND a.active
      WHERE ce.supported AND (ce.field LIKE 'dates.%' OR ce.field='dates') AND ce.detected_at > now() - ($1 || ' days')::interval
      ORDER BY ce.id`, [String(days)])).rows;
  },
  async activeSearches() {
    return (await db.query(`SELECT s.id,s.account_id,s.name,s.filters,s.created_at FROM saved_searches s JOIN citizen_accounts a ON a.id=s.account_id AND a.active WHERE s.enabled`)).rows
      .map((s) => ({ ...s, created_at: s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at }));
  },
  // Alert row and its delivery rows commit together, so a crash can never leave an alert with no deliveries.
  async insertAlert(p, channels = CHANNELS) {
    return db.tx(async (c) => {
      const r = await c.query('INSERT INTO alert_events(account_id,recruitment_id,event_type,dedupe_key,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,dedupe_key) DO NOTHING RETURNING id', [p.accountId, p.recruitmentId, p.eventType, p.dedupeKey, p.payload]);
      if (!r.rows[0]) return { created: false };
      for (const ch of channels) await c.query('INSERT INTO notification_deliveries(alert_id,channel) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, ch]);
      return { created: true, id: r.rows[0].id };
    });
  },
  // Atomic claim: concurrent workers never receive the same row.
  async claimDeliveries(limit, now) {
    return (await db.query(`WITH c AS (SELECT id FROM notification_deliveries WHERE status='QUEUED' AND next_attempt_at<=$2 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED),
      u AS (UPDATE notification_deliveries nd SET status='SENDING', locked_at=now() FROM c WHERE nd.id=c.id RETURNING nd.id,nd.alert_id,nd.channel,nd.attempts)
      SELECT u.id,u.alert_id,u.channel,u.attempts,ae.payload,ca.email,ca.active AS account_active FROM u JOIN alert_events ae ON ae.id=u.alert_id JOIN citizen_accounts ca ON ca.id=ae.account_id ORDER BY u.id`, [limit, now])).rows;
  },
  async finishDelivery(id, patch) {
    await db.query(`UPDATE notification_deliveries SET status=$2, attempts=COALESCE($3,attempts), last_error=$4, provider_message_id=COALESCE($5,provider_message_id), sent_at=COALESCE($6,sent_at), next_attempt_at=COALESCE($7,next_attempt_at), locked_at=NULL WHERE id=$1`,
      [id, patch.status, patch.attempts ?? null, patch.last_error ?? null, patch.provider_message_id ?? null, patch.sent_at ?? null, patch.next_attempt_at ?? null]);
  },
  // Leases left by a crashed worker go back to the queue.
  async recoverStuck(minutes = 10) { return (await db.query(`UPDATE notification_deliveries SET status='QUEUED', locked_at=NULL WHERE status='SENDING' AND locked_at < now() - ($1 || ' minutes')::interval`, [String(minutes)])).rowCount; },
  publishedJobs: () => repo.publishedJobs(),
  // v2.9.0 trust support
  async preferences(ids) { const r = await db.query('SELECT account_id,channels,deadline_changes,new_match,trust_flags,min_trust FROM alert_preferences WHERE account_id = ANY($1)', [[...new Set(ids)]]); return Object.fromEntries(r.rows.map((x) => [x.account_id, x])); },
  async openTrustFlags() { return (await db.query("SELECT id,recruitment_id,kind,severity,field,summary,detail,dedupe_key,raised_at FROM trust_flags WHERE status='OPEN' AND raised_at > now() - interval '30 days' ORDER BY id")).rows.map((r) => ({ ...r.detail, ...r, raised_at: r.raised_at instanceof Date ? r.raised_at.toISOString() : r.raised_at })); },
  // v2.9.0: computed trust level per recruitment (same policy as the UI), so "only verified" preferences are honoured.
  async verificationOf(ids) { const jobs = (await repo.publishedJobs()).filter((j) => ids.includes(j.id)); const t = await require('./trust/service').trustForJobs(jobs); return Object.fromEntries(Object.entries(t).map(([id, v]) => [id, v.verification])); },
  async watchersOf(ids) { return (await db.query('SELECT w.account_id,w.recruitment_id,w.created_at AS watch_created_at,a.active AS account_active,r.title FROM watchlists w JOIN citizen_accounts a ON a.id=w.account_id JOIN recruitments r ON r.id=w.recruitment_id WHERE w.recruitment_id = ANY($1)', [ids])).rows.map((x) => ({ ...x, watch_created_at: x.watch_created_at instanceof Date ? x.watch_created_at.toISOString() : x.watch_created_at })); },
};

// v2.9.0: a plan may carry the person's chosen channels (alertPrefs.applyPreferences); otherwise every channel, as before.
async function persist(store, plans) { let created = 0; for (const p of plans) if ((await store.insertAlert(p, p.channels && p.channels.length ? p.channels : undefined)).created) created++; return created; }
const prefs = require('./trust/alertPrefs');
async function preferenceFilter(store, plans) {
  if (!store.preferences || !plans.length) return plans;
  const byAcc = await store.preferences(plans.map((p) => p.accountId));
  const ver = store.verificationOf ? await store.verificationOf(plans.map((p) => p.recruitmentId)) : {};
  return prefs.applyPreferences(plans, byAcc, ver).plans;
}
async function processTrustAlerts(store = pgStore) {
  if (!store.openTrustFlags || !store.watchersOf) return { planned: 0, created: 0, skipped: 'store has no trust support' };
  const flags = await store.openTrustFlags(); if (!flags.length) return { planned: 0, created: 0 };
  const watchers = await store.watchersOf([...new Set(flags.map((f) => f.recruitment_id))]);
  const plans = await preferenceFilter(store, prefs.planTrustAlerts(flags, watchers));
  return { planned: plans.length, created: await persist(store, plans) };
}
async function processDeadlineAlerts(store = pgStore) { const rows = await store.deadlineRows(); const plans = await preferenceFilter(store, planDeadlineAlerts(rows, { now: new Date() })); return { changes: rows.length, planned: plans.length, created: await persist(store, plans) }; }
async function processNewMatchingJobs(store = pgStore, now = new Date()) {
  const [jobs, searches] = await Promise.all([store.publishedJobs(), store.activeSearches()]);
  const plans = await preferenceFilter(store, planMatchAlerts({ searches, jobs, runSearch, now })); return { planned: plans.length, created: await persist(store, plans) };
}
async function workerTick({ providers = {}, store = pgStore, now = new Date() } = {}) {
  const recovered = await store.recoverStuck();
  const deadline = await processDeadlineAlerts(store); const matches = await processNewMatchingJobs(store, now); const trust = await processTrustAlerts(store);
  const delivery = await deliverBatch(store, providers, { now });
  return { recovered, deadline, matches, trust, delivery };
}
module.exports = { workerTick, processDeadlineAlerts, processNewMatchingJobs, processTrustAlerts, pgStore };
