// Channel broadcast of NEW official notifications, deadline extensions and amendments: Telegram channel/chat, Discord webhook,
// and an e-mail HTTP API (Resend). Secrets come from environment variables only. A feed event is sent at most once per
// channel (UNIQUE feed_event_id+channel), failures retry with back-off, and a channel is never reported SENT unless the
// provider returned a message id. Per-person alerts (watchlists / saved searches / in-app / e-mail) stay in lib/alerts.js.
const KINDS_DEFAULT = ['NEW_NOTIFICATION', 'DEADLINE_EXTENDED', 'AMENDED'];
const LABEL = { NEW_NOTIFICATION: 'NEW NOTIFICATION', DEADLINE_EXTENDED: 'DEADLINE EXTENDED', AMENDED: 'NOTIFICATION AMENDED', DETECTED_UNVERIFIED: 'DETECTED, NOT YET VERIFIED' };
const MAX_ATTEMPTS = 4;
const backoffSeconds = (n) => Math.min(3600, 60 * 2 ** (n - 1));
const val = (v, dash = 'not stated') => (v === null || v === undefined || v === '' ? dash : String(v));
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 300);

function formatMessage(ev) {
  const p = ev.payload || {}; const L = [];
  L.push(`${LABEL[ev.kind] || ev.kind}: ${clean(ev.title)}`);
  L.push(`Organisation: ${clean(val(ev.organization))}`);
  L.push(`Vacancies: ${val(p.vacancies)}`);
  const el = p.eligibility || {};
  L.push(`Eligibility: ${val(el.education)}${el.age_min != null || el.age_max != null ? ` · age ${val(el.age_min, '?')}–${val(el.age_max, '?')}` : ''}`);
  L.push(`Applications open: ${val(p.application_open)}`);
  L.push(`Last date: ${val(p.application_close)}`);
  if (ev.kind === 'DEADLINE_EXTENDED' || ev.kind === 'AMENDED') for (const c of (p.changes || []).slice(0, 5)) L.push(`Change: ${clean(c.label)}: ${clean(c.from)} → ${clean(c.to)}${c.delta ? ` (${clean(c.delta)})` : ''}`);
  if (p.document_url) L.push(`Official notification: ${p.document_url}`);
  if (p.application_link) L.push(`Apply (official): ${p.application_link}`);
  if (p.source_url) L.push(`Source page: ${p.source_url}`);
  L.push(p.verified === false ? 'Not yet verified. Open the official document before relying on any detail.' : 'Read automatically from the official document. Always confirm on the official notification before applying.');
  return L.join('\n');
}

const post = async (fetch, url, body, headers = {}) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try { return await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
  finally { clearTimeout(t); }
};
const rateLimited = (r) => { if (r.status === 429) { const e = new Error('rate limited by provider'); e.retryable = true; throw e; } };

function buildProviders(env = process.env, fetch = globalThis.fetch) {
  const out = {};
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    out.TELEGRAM = async (ev) => {
      const r = await post(fetch, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text: formatMessage(ev), disable_web_page_preview: true });
      rateLimited(r); const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok || !j.result || j.result.message_id == null) throw new Error(`telegram: ${(j && j.description) || 'no message id, HTTP ' + r.status}`);
      return { id: String(j.result && j.result.message_id) };
    };
  }
  if (env.DISCORD_WEBHOOK_URL) {
    let host = ''; try { host = new URL(env.DISCORD_WEBHOOK_URL).hostname; } catch (_) {}
    if (/^(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)$/.test(host)) {
      out.DISCORD = async (ev) => {
        const r = await post(fetch, env.DISCORD_WEBHOOK_URL + (env.DISCORD_WEBHOOK_URL.includes('?') ? '&' : '?') + 'wait=true', { content: formatMessage(ev).slice(0, 1900), allowed_mentions: { parse: [] } });
        rateLimited(r); const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) throw new Error(`discord: HTTP ${r.status}`);
        return { id: String(j.id) };
      };
    }
  }
  if (env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_BROADCAST_TO) {
    out.EMAIL = async (ev) => {
      const r = await post(fetch, 'https://api.resend.com/emails', { from: env.EMAIL_FROM, to: env.EMAIL_BROADCAST_TO.split(',').map((x) => x.trim()).filter(Boolean), subject: `${LABEL[ev.kind] || ev.kind}: ${clean(ev.title)}`.slice(0, 200), text: formatMessage(ev) }, { authorization: `Bearer ${env.RESEND_API_KEY}` });
      rateLimited(r); const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.id) throw new Error(`email: HTTP ${r.status}`);
      return { id: String(j.id) };
    };
  }
  return out;
}

// store: { enqueue(channels, kinds), claim(limit, now), finish(id, patch) }
async function processQueue(store, providers, { limit = 50, now = new Date(), kinds = KINDS_DEFAULT } = {}) {
  const channels = Object.keys(providers);
  const out = { channels, queued: 0, claimed: 0, sent: 0, retried: 0, failed: 0 };
  if (!channels.length) return out;      // nothing configured: nothing is queued, nothing is reported as sent
  out.queued = await store.enqueue(channels, kinds);
  const rows = await store.claim(limit, now); out.claimed = rows.length;
  for (const r of rows) {
    const attempt = r.attempts + 1;
    try {
      const res = await providers[r.channel](r.event);
      if (!res || !res.id) throw new Error('provider returned no message id');
      await store.finish(r.id, { status: 'SENT', attempts: attempt, provider_message_id: res.id, sent_at: now }); out.sent++;
    } catch (e) {
      const dead = attempt >= MAX_ATTEMPTS;
      await store.finish(r.id, { status: dead ? 'FAILED' : 'QUEUED', attempts: attempt, last_error: String(e.message).slice(0, 300).replace(/bot\d+:[\w-]+/g, 'bot<redacted>'), next_attempt_at: dead ? undefined : new Date(now.getTime() + backoffSeconds(attempt) * 1000) });
      dead ? out.failed++ : out.retried++;
    }
  }
  return out;
}

const pgStore = (db = require('./db')) => ({
  async enqueue(channels, kinds) {
    let n = 0;
    for (const ch of channels) n += (await db.query(`INSERT INTO broadcast_log(feed_event_id,channel) SELECT id,$1 FROM feed_events WHERE kind = ANY($2) AND created_at > now() - interval '3 days' ON CONFLICT (feed_event_id,channel) DO NOTHING`, [ch, kinds])).rowCount;
    return n;
  },
  async claim(limit, now) {
    return (await db.query(`WITH c AS (SELECT id FROM broadcast_log WHERE status='QUEUED' AND next_attempt_at <= $2 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED),
      u AS (UPDATE broadcast_log b SET status='SENDING', locked_at=now() FROM c WHERE b.id=c.id RETURNING b.id,b.channel,b.attempts,b.feed_event_id)
      SELECT u.id,u.channel,u.attempts, json_build_object('kind',f.kind,'title',f.title,'organization',f.organization,'payload',f.payload) AS event FROM u JOIN feed_events f ON f.id=u.feed_event_id ORDER BY u.id`, [limit, now])).rows;
  },
  async finish(id, p) {
    await db.query(`UPDATE broadcast_log SET status=$2, attempts=COALESCE($3,attempts), last_error=$4, provider_message_id=COALESCE($5,provider_message_id), sent_at=COALESCE($6,sent_at), next_attempt_at=COALESCE($7,next_attempt_at), locked_at=NULL WHERE id=$1`,
      [id, p.status, p.attempts ?? null, p.last_error ?? null, p.provider_message_id ?? null, p.sent_at ?? null, p.next_attempt_at ?? null]);
  },
  async recoverStuck(minutes = 10) { return (await db.query(`UPDATE broadcast_log SET status='QUEUED', locked_at=NULL WHERE status='SENDING' AND locked_at < now() - ($1 || ' minutes')::interval`, [String(minutes)])).rowCount; },
});

async function tick({ env = process.env, fetch = globalThis.fetch, store = pgStore() } = {}) {
  const kinds = env.BROADCAST_UNVERIFIED === '1' ? [...KINDS_DEFAULT, 'DETECTED_UNVERIFIED'] : KINDS_DEFAULT;
  if (store.recoverStuck) await store.recoverStuck();
  return processQueue(store, buildProviders(env, fetch), { kinds });
}

module.exports = { KINDS_DEFAULT, MAX_ATTEMPTS, formatMessage, buildProviders, processQueue, pgStore, tick, backoffSeconds };
