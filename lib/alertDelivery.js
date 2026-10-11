// Delivery state machine. Never reports SENT unless a provider confirmed it.
// QUEUED -> SENDING (claimed) -> SENT | QUEUED (retry with backoff) | FAILED | SKIPPED
const MAX_ATTEMPTS = 3;
const backoffSeconds = (attempt) => Math.min(3600, 60 * 2 ** (attempt - 1));

async function deliverBatch(store, providers = {}, { limit = 100, maxAttempts = MAX_ATTEMPTS, now = new Date() } = {}) {
  const rows = await store.claimDeliveries(limit, now);
  const out = { claimed: rows.length, sent: 0, skipped: 0, retried: 0, failed: 0 };
  for (const r of rows) {
    if (!r.account_active) { await store.finishDelivery(r.id, { status: 'SKIPPED', last_error: 'consent withdrawn or account inactive' }); out.skipped++; continue; }
    if (r.channel === 'IN_APP') { await store.finishDelivery(r.id, { status: 'SENT', provider_message_id: 'in-app', sent_at: now }); out.sent++; continue; }
    const p = providers[r.channel];
    if (!p) { await store.finishDelivery(r.id, { status: 'SKIPPED', last_error: `no ${r.channel} provider configured; nothing was sent` }); out.skipped++; continue; }
    const attempt = r.attempts + 1;
    try {
      const res = await p({ channel: r.channel, to: r.email, payload: r.payload, alertId: r.alert_id, idempotencyKey: `alert-${r.alert_id}-${r.channel}` });
      if (!res || !res.id) throw new Error('provider returned no message id');
      await store.finishDelivery(r.id, { status: 'SENT', provider_message_id: String(res.id), sent_at: now, attempts: attempt }); out.sent++;
    } catch (e) {
      const dead = attempt >= maxAttempts;
      await store.finishDelivery(r.id, { status: dead ? 'FAILED' : 'QUEUED', attempts: attempt, last_error: String(e.message).slice(0, 300), next_attempt_at: dead ? undefined : new Date(now.getTime() + backoffSeconds(attempt) * 1000) });
      dead ? out.failed++ : out.retried++;
    }
  }
  return out;
}
module.exports = { deliverBatch, backoffSeconds, MAX_ATTEMPTS };
