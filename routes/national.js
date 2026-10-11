'use strict';
// v2.10.0 national coverage + instant push API. Additive: no existing route changes meaning.
//   GET  /api/push/config            is push available, VAPID public key
//   POST /api/push/subscribe         register a browser/phone (States, kinds, include_unverified)
//   POST /api/push/preferences       change the choices of an existing subscription
//   POST /api/push/unsubscribe       remove it
//   POST /api/push/test              send one test notification to that subscription
//   GET  /api/national/coverage      every State / UT: sources, how many are verified and being watched
//   GET  /api/national/sources       the allowlist with domain status (public facts only)
//   GET  /api/feed.atom              Atom feed of verified official notices (any feed reader / Telegram RSS bot / IFTTT)
//   GET  /api/admin/national/domain-issues   (ADMIN)  sources whose domain needs a person's review
//   POST /api/admin/national/reconcile       (ADMIN)  re-run registry reconcile + domain guard now
const express = require('express');
const rateLimit = require('express-rate-limit');
const push = require('../lib/pushNotify');
const guard = require('../lib/domainGuard');
const NS = require('../lib/nationalSources');
const registry = require('../lib/registry');   // earlier seed rows (UPSC, SSC, IBPS, SBI, AP PSC, TGPSC) count towards coverage too

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const esc = (v) => String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const safeHttps = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (_) { return null; } };

function coverageFromRows(rows) {
  const by = new Map(NS.STATES_AND_UTS.map((s) => [s, { state: s, sources: 0, verified_and_watched: 0, pending: 0, needs_review: 0, online: 0 }]));
  const central = { state: 'All India', sources: 0, verified_and_watched: 0, pending: 0, needs_review: 0, online: 0 };
  for (const r of rows) {
    const t = by.get(r.state) || (r.state === 'All India' ? central : null); if (!t) continue;
    t.sources++;
    if (r.verification_status === 'VERIFIED' && r.crawl_enabled) { t.verified_and_watched++; if (r.health === 'ONLINE') t.online++; }
    else if (r.verification_status === 'PENDING_VERIFICATION') t.pending++;
    if (r.domain_status === 'REVIEW') t.needs_review++;
  }
  const states = [...by.values()];
  return { states, central, states_without_any_source: states.filter((s) => s.sources === 0).map((s) => s.state), states_without_a_watched_source: states.filter((s) => s.verified_and_watched === 0).map((s) => s.state) };
}

function mount(app, { db, runtime, auth, audit, env = process.env }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again in a minute.' } });
  const needDb = (res) => { if (runtime.isDemo()) { res.status(503).json({ error: 'Push alerts need the database. Run with PostgreSQL (see RUNTIME_GUIDE.md).', mode: 'DEMO' }); return true; } return false; };

  r.get('/push/config', wrap(async (_req, res) => {
    if (runtime.isDemo() || env.WEB_PUSH === '0') return res.json({ supported: false, reason: runtime.isDemo() ? 'PostgreSQL is not connected' : 'WEB_PUSH=0', states: NS.STATES_AND_UTS });
    const v = await push.loadVapid({ env, db });
    res.json({ supported: !!v, publicKey: v ? v.publicKey : null, states: NS.STATES_AND_UTS, kinds: push.ALL_KINDS, default_kinds: push.KINDS_DEFAULT,
      note: 'Notifications are sent when the official source is next checked (every 5 to 20 minutes) and the notice has been read. Unverified items are opt-in and labelled.' });
  }));

  r.post('/push/subscribe', limiter, wrap(async (req, res) => {
    if (needDb(res)) return;
    const body = req.body || {}; const v = push.validateSubscription(body.subscription);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const p = push.normalisePrefs(body, { states: NS.STATES_AND_UTS });
    const s = body.subscription;
    await db.query(`INSERT INTO push_subscriptions(endpoint,p256dh,auth,states,kinds,include_unverified,include_central,lang)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, states=EXCLUDED.states, kinds=EXCLUDED.kinds,
        include_unverified=EXCLUDED.include_unverified, include_central=EXCLUDED.include_central, lang=EXCLUDED.lang, active=TRUE, failures=0, last_error=NULL`,
      [s.endpoint, s.keys.p256dh, s.keys.auth, p.states, p.kinds, p.include_unverified, p.include_central, p.lang]);
    res.json({ ok: true, preferences: p });
  }));

  r.post('/push/preferences', limiter, wrap(async (req, res) => {
    if (needDb(res)) return;
    const body = req.body || {}; if (typeof body.endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
    const p = push.normalisePrefs(body, { states: NS.STATES_AND_UTS });
    const u = await db.query('UPDATE push_subscriptions SET states=$2, kinds=$3, include_unverified=$4, include_central=$5, lang=$6 WHERE endpoint=$1 RETURNING id', [body.endpoint, p.states, p.kinds, p.include_unverified, p.include_central, p.lang]);
    if (!u.rows.length) return res.status(404).json({ error: 'subscription not found' });
    res.json({ ok: true, preferences: p });
  }));

  r.post('/push/unsubscribe', limiter, wrap(async (req, res) => {
    if (needDb(res)) return;
    const endpoint = (req.body || {}).endpoint; if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
    await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    res.json({ ok: true });
  }));

  r.post('/push/test', rateLimit({ windowMs: 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Test notifications are limited to 3 per minute.' } }), wrap(async (req, res) => {
    if (needDb(res)) return;
    const endpoint = (req.body || {}).endpoint; if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
    const sub = (await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint=$1 AND active', [endpoint])).rows[0];
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    const vapid = await push.loadVapid({ env, db }); const send = push.makeSender({ vapid, env });
    const out = await send(sub, { title: 'GovCareer AI: alerts are on', body: 'This is a test. Real notices are sent only from official sources, labelled verified or not.', tag: 'gc-test', kind: 'TEST', verified: true, url: '/?open=latest', official_url: null });
    res.status(out.ok ? 200 : 502).json({ ok: !!out.ok, status: out.status || null });
  }));

  r.get('/national/coverage', wrap(async (_req, res) => {
    if (runtime.isDemo()) {
      const rows = NS.NATIONAL_SOURCES.concat(registry.SEED.filter((x) => !['DEMO', 'MANUAL_UPLOAD'].includes(x.source_type))).map((s) => ({ state: s.state, verification_status: 'PENDING_VERIFICATION', crawl_enabled: false, health: null, domain_status: 'UNCHECKED' }));
      return res.json({ mode: 'DEMO', ...coverageFromRows(rows), note: 'Demo mode: sources are listed but nothing is watched until PostgreSQL is connected.' });
    }
    const rows = (await db.query("SELECT state, verification_status, crawl_enabled, health, domain_status FROM sources WHERE source_type NOT IN ('DEMO','MANUAL_UPLOAD')")).rows;
    res.json({ mode: 'LIVE', ...coverageFromRows(rows), tiers_minutes: NS.TIER_MINUTES });
  }));

  r.get('/national/sources', wrap(async (req, res) => {
    const state = req.query.state ? String(req.query.state) : null;
    if (runtime.isDemo()) return res.json({ mode: 'DEMO', sources: NS.NATIONAL_SOURCES.filter((s) => !state || s.state === state).map((s) => ({ source_id: s.source_id, organization: s.organization, state: s.state, official_domain: s.official_domain, portal_url: s.portal_url, tier: s.tier, domain_confirmed: s.confirmed, verification_status: 'PENDING_VERIFICATION' })) });
    const rows = (await db.query(`SELECT source_id, organization, state, official_domain, portal_url, priority_tier, verification_status, crawl_enabled, health, last_success_at, last_checked_at, crawl_frequency_minutes, domain_status, domain_note
      FROM sources WHERE source_type NOT IN ('DEMO','MANUAL_UPLOAD') AND ($1::text IS NULL OR state=$1) ORDER BY state, organization`, [state])).rows;
    res.json({ mode: 'LIVE', sources: rows });
  }));

  // Atom: verified/amended/extended notices only (never DETECTED_UNVERIFIED), last 7 days.
  r.get('/feed.atom', wrap(async (req, res) => {
    const base = env.PUBLIC_BASE_URL && /^https:\/\//.test(env.PUBLIC_BASE_URL) ? env.PUBLIC_BASE_URL.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
    const state = req.query.state ? String(req.query.state) : null;
    let events = [];
    if (!runtime.isDemo()) {
      events = (await db.query(`SELECT id, kind, title, organization, payload, created_at FROM feed_events
        WHERE kind IN ('NEW_NOTIFICATION','DEADLINE_EXTENDED','AMENDED') AND created_at > now() - interval '7 days'
          AND ($1::text IS NULL OR payload->>'state' = $1 OR COALESCE(payload->>'state','All India') = 'All India') ORDER BY id DESC LIMIT 100`, [state])).rows;
    }
    const updated = events[0] ? new Date(events[0].created_at).toISOString() : new Date().toISOString();
    const entry = (e) => {
      const p = push.buildPayload({ ...e, payload: e.payload || {} }); const link = p.official_url || `${base}/`;
      return `<entry><id>tag:govcareer,2026:event-${esc(e.id)}</id><title>${esc(p.title)}</title><updated>${new Date(e.created_at).toISOString()}</updated><link href="${esc(link)}"/><summary>${esc(p.body)}</summary></entry>`;
    };
    res.set('content-type', 'application/atom+xml; charset=utf-8').set('cache-control', 'public, max-age=60');
    res.send(`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>tag:govcareer,2026:official-notices</id><title>GovCareer AI: official recruitment notices</title><updated>${updated}</updated><link rel="self" href="${esc(base)}/api/feed.atom"/>${events.map(entry).join('')}</feed>`);
  }));

  // ---- admin ----
  const admin = express.Router();
  admin.get('/domain-issues', auth.requireRole('VIEWER'), wrap(async (_req, res) => {
    const rows = (await db.query("SELECT source_id, organization, state, official_domain, portal_url, verification_status, domain_status, domain_note, consecutive_failures, last_error FROM sources WHERE domain_status IN ('REVIEW','CORRECTED') ORDER BY state, source_id")).rows;
    res.json({ issues: rows });
  }));
  admin.post('/reconcile', auth.requireRole('ADMIN'), wrap(async (req, res) => {
    const out = await guard.reconcile({ db, audit, env });
    res.json(out);
  }));

  app.use('/api', r);
  app.use('/api/admin/national', admin);
}

module.exports = { mount, coverageFromRows };
