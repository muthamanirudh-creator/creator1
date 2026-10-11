// v2.10.0 - Instant Web Push for new official notifications (phones and browsers, even when the site is closed).
// A feed event (lib/feed.js: NEW_NOTIFICATION / DEADLINE_EXTENDED / AMENDED, optionally DETECTED_UNVERIFIED) is pushed to every
// subscription whose State / category choice matches, at most once per browser (UNIQUE feed_event_id+subscription_id),
// with retries and back-off. A row is SENT only when the push service accepted it. Dead subscriptions (404/410) are removed.
// Facts come only from the stored feed event; nothing is generated. Unverified items are opt-in and always labelled.
const KINDS_DEFAULT = ['NEW_NOTIFICATION', 'DEADLINE_EXTENDED', 'AMENDED'];
const ALL_KINDS = [...KINDS_DEFAULT, 'DETECTED_UNVERIFIED'];
const LABEL = { NEW_NOTIFICATION: 'New', DEADLINE_EXTENDED: 'Deadline extended', AMENDED: 'Amended', DETECTED_UNVERIFIED: 'Detected, not yet verified' };
const MAX_ATTEMPTS = 4;
const backoffSeconds = (n) => Math.min(900, 20 * 2 ** (n - 1));
const CENTRAL = 'All India';

// Only real browser push services are accepted as endpoints. This stops the subscribe API being used to make the server call arbitrary URLs.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return { ok: false, error: 'subscription is required' };
  let u; try { u = new URL(String(sub.endpoint || '')); } catch (_) { return { ok: false, error: 'endpoint is not a valid URL' }; }
  if (u.protocol !== 'https:' || u.username || u.password) return { ok: false, error: 'endpoint must be https' };
  if (!PUSH_HOSTS.some((r) => r.test(u.hostname.toLowerCase()))) return { ok: false, error: 'endpoint is not a known browser push service' };
  if (String(sub.endpoint).length > 1000) return { ok: false, error: 'endpoint is too long' };
  const k = sub.keys || {};
  if (!B64URL.test(String(k.p256dh || '')) || String(k.p256dh).length < 80 || String(k.p256dh).length > 100) return { ok: false, error: 'invalid p256dh key' };
  if (!B64URL.test(String(k.auth || '')) || String(k.auth).length < 20 || String(k.auth).length > 30) return { ok: false, error: 'invalid auth secret' };
  return { ok: true };
}

const cleanList = (v, allowed) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => !allowed || allowed.includes(x)))];
function normalisePrefs(body, { states = [] } = {}) {
  const b = body || {};
  const kinds = cleanList(b.kinds, ALL_KINDS); const include_unverified = b.include_unverified === true;
  const out = {
    states: cleanList(b.states, states.length ? states : null).slice(0, 40),
    kinds: kinds.length ? kinds : KINDS_DEFAULT.slice(),
    include_unverified, include_central: b.include_central !== false,
    lang: /^[a-z]{2,3}$/.test(String(b.lang || '')) ? String(b.lang) : 'en',
  };
  if (include_unverified && !out.kinds.includes('DETECTED_UNVERIFIED')) out.kinds.push('DETECTED_UNVERIFIED');
  if (!include_unverified) out.kinds = out.kinds.filter((x) => x !== 'DETECTED_UNVERIFIED');
  return out;
}

// Same rule as the SQL in pgStore.enqueue. Central (All India / unknown state) events follow include_central; State events follow the State list (empty = all).
function matches(sub, ev) {
  if (!sub || sub.active === false || !ev) return false;
  const kinds = sub.kinds && sub.kinds.length ? sub.kinds : KINDS_DEFAULT;
  if (!kinds.includes(ev.kind)) return false;
  if (ev.kind === 'DETECTED_UNVERIFIED' && !sub.include_unverified) return false;
  const st = String((ev.payload && ev.payload.state) || '').trim() || CENTRAL;
  if (st === CENTRAL) return sub.include_central !== false;
  const list = sub.states || [];
  return list.length === 0 || list.includes(st);
}

const safeHttps = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (_) { return null; } };
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const val = (v, d = 'not stated') => (v === null || v === undefined || v === '' ? d : String(v));

function buildPayload(ev) {
  const p = ev.payload || {};
  const unverified = ev.kind === 'DETECTED_UNVERIFIED' || p.verified === false;
  const lines = [];
  if (ev.organization) lines.push(clip(ev.organization, 80));
  if (p.state && p.state !== CENTRAL) lines.push(clip(p.state, 40));
  if (p.vacancies != null) lines.push(`${val(p.vacancies)} posts`);
  if (p.application_close) lines.push(`last date ${clip(p.application_close, 20)}`);
  if (ev.kind === 'DEADLINE_EXTENDED' || ev.kind === 'AMENDED') { const c = (p.changes || [])[0]; if (c) lines.push(clip(`${c.label}: ${c.from} to ${c.to}`, 90)); }
  lines.push(unverified ? 'Not yet verified. Open the official page first.' : 'From the official source. Confirm on the official notice before applying.');
  const official = safeHttps(p.document_url || p.official_url || p.application_link || p.source_url);
  return {
    title: clip(`${LABEL[ev.kind] || ev.kind}: ${ev.title || 'Recruitment notice'}`, 110),
    body: clip(lines.join(' · '), 240),
    tag: `gc-${ev.id != null ? ev.id : (ev.feed_event_id || 'x')}`,
    kind: ev.kind, verified: !unverified, feed_id: ev.id != null ? Number(ev.id) : null,
    url: '/?open=latest', official_url: official,
  };
}

// store: { enqueue(), claim(limit, now), finish(id, patch), deactivate(subId, why), touch(subId, ok, err), recoverStuck() }
async function processQueue(store, send, { limit = 100, now = new Date() } = {}) {
  const out = { queued: 0, claimed: 0, sent: 0, retried: 0, failed: 0, gone: 0 };
  out.queued = await store.enqueue();
  const rows = await store.claim(limit, now); out.claimed = rows.length;
  for (const r of rows) {
    const attempt = r.attempts + 1;
    let res;
    try { res = await send(r.subscription, buildPayload(r.event)); } catch (e) { res = { ok: false, error: e.message }; }
    if (res && res.ok) { await store.finish(r.id, { status: 'SENT', attempts: attempt, sent_at: now }); await store.touch(r.subscription.id, true); out.sent++; continue; }
    const status = res && res.status; const err = String((res && res.error) || `HTTP ${status}`).slice(0, 300);
    if (status === 404 || status === 410) { await store.finish(r.id, { status: 'GONE', attempts: attempt, last_error: err }); await store.deactivate(r.subscription.id, 'push service reports the subscription is gone'); out.gone++; continue; }
    const permanent = status === 400 || status === 401 || status === 403 || status === 413;
    const dead = permanent || attempt >= MAX_ATTEMPTS;
    await store.finish(r.id, { status: dead ? 'FAILED' : 'QUEUED', attempts: attempt, last_error: err, next_attempt_at: dead ? undefined : new Date(now.getTime() + backoffSeconds(attempt) * 1000) });
    await store.touch(r.subscription.id, false, err);
    dead ? out.failed++ : out.retried++;
  }
  return out;
}

const pgStore = (db = require('./db')) => ({
  async enqueue() {
    const r = await db.query(`INSERT INTO push_log(feed_event_id, subscription_id)
      SELECT e.id, s.id FROM feed_events e JOIN push_subscriptions s ON s.active
      WHERE e.created_at > now() - interval '2 days' AND e.created_at >= s.created_at
        AND e.kind = ANY(s.kinds) AND (e.kind <> 'DETECTED_UNVERIFIED' OR s.include_unverified)
        AND ( (COALESCE(NULLIF(e.payload->>'state',''),'All India') = 'All India' AND s.include_central)
           OR (COALESCE(NULLIF(e.payload->>'state',''),'All India') <> 'All India' AND (cardinality(s.states) = 0 OR COALESCE(e.payload->>'state','') = ANY(s.states))) )
      ON CONFLICT (feed_event_id, subscription_id) DO NOTHING`);
    return r.rowCount || 0;
  },
  async claim(limit, now) {
    return (await db.query(`WITH c AS (SELECT id FROM push_log WHERE status='QUEUED' AND next_attempt_at <= GREATEST($2::timestamptz, now()) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED),
      u AS (UPDATE push_log p SET status='SENDING', locked_at=now() FROM c WHERE p.id=c.id RETURNING p.id, p.attempts, p.feed_event_id, p.subscription_id)
      SELECT u.id, u.attempts,
        json_build_object('id',f.id,'kind',f.kind,'title',f.title,'organization',f.organization,'payload',f.payload) AS event,
        json_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth) AS subscription
      FROM u JOIN feed_events f ON f.id=u.feed_event_id JOIN push_subscriptions s ON s.id=u.subscription_id WHERE s.active ORDER BY u.id`, [limit, now])).rows;
  },
  async finish(id, p) {
    await db.query(`UPDATE push_log SET status=$2, attempts=COALESCE($3,attempts), last_error=$4, sent_at=COALESCE($5,sent_at), next_attempt_at=COALESCE($6,next_attempt_at), locked_at=NULL WHERE id=$1`,
      [id, p.status, p.attempts ?? null, p.last_error ?? null, p.sent_at ?? null, p.next_attempt_at ?? null]);
  },
  async deactivate(subId, why) { await db.query('UPDATE push_subscriptions SET active=FALSE, last_error=$2 WHERE id=$1', [subId, String(why).slice(0, 300)]); },
  async touch(subId, ok, err) {
    if (ok) await db.query('UPDATE push_subscriptions SET failures=0, last_ok_at=now(), last_error=NULL WHERE id=$1', [subId]);
    else await db.query('UPDATE push_subscriptions SET failures=failures+1, last_error=$2, active = (failures + 1 < 8) WHERE id=$1', [subId, String(err || '').slice(0, 300)]);
  },
  async recoverStuck(minutes = 5) { return (await db.query(`UPDATE push_log SET status='QUEUED', locked_at=NULL WHERE status='SENDING' AND locked_at < now() - ($1 || ' minutes')::interval`, [String(minutes)])).rowCount; },
});

let vapidCache = null;
// Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. When absent, one pair is generated once and kept in the database.
async function loadVapid({ env = process.env, db = null, webpush = null } = {}) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, source: 'env' };
  if (vapidCache) return vapidCache;
  if (!db) return null;
  let row = (await db.query('SELECT public_key, private_key FROM push_vapid WHERE id=1')).rows[0];
  if (!row) {
    const wp = webpush || require('web-push'); const k = wp.generateVAPIDKeys();
    await db.query('INSERT INTO push_vapid(id,public_key,private_key) VALUES (1,$1,$2) ON CONFLICT (id) DO NOTHING', [k.publicKey, k.privateKey]);
    row = (await db.query('SELECT public_key, private_key FROM push_vapid WHERE id=1')).rows[0];
  }
  return (vapidCache = { publicKey: row.public_key, privateKey: row.private_key, source: 'database' });
}
const subjectFor = (env = process.env) => env.VAPID_SUBJECT || (/@/.test(env.CRAWLER_CONTACT || '') ? `mailto:${env.CRAWLER_CONTACT}` : (/^https:\/\//.test(env.PUBLIC_BASE_URL || '') ? env.PUBLIC_BASE_URL : 'mailto:alerts@govcareer.example'));

function makeSender({ webpush = require('web-push'), vapid, env = process.env }) {
  webpush.setVapidDetails(subjectFor(env), vapid.publicKey, vapid.privateKey);
  return async (sub, payload) => {
    try {
      const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: 'high', timeout: 10000 });
      return { ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode };
    } catch (e) { return { ok: false, status: e.statusCode, error: e.body || e.message }; }
  };
}

async function tick({ env = process.env, db = require('./db'), store = pgStore(db), webpush, sender } = {}) {
  if (env.WEB_PUSH === '0') return { configured: false, reason: 'WEB_PUSH=0' };
  if (!sender) {
    const vapid = await loadVapid({ env, db, webpush }); if (!vapid) return { configured: false };
    sender = makeSender({ webpush: webpush || require('web-push'), vapid, env });
  }
  if (store.recoverStuck) await store.recoverStuck();
  return { configured: true, ...(await processQueue(store, sender)) };
}

const resetVapidCache = () => { vapidCache = null; };

module.exports = { resetVapidCache, KINDS_DEFAULT, ALL_KINDS, PUSH_HOSTS, validateSubscription, normalisePrefs, matches, buildPayload, processQueue, pgStore, loadVapid, makeSender, tick, subjectFor };
