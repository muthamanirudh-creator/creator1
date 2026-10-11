// v2.10.0 national coverage, domain guard (Punjab fix), instant Web Push. Dependency-light: pg/lib/db are stubbed, no network,
// no real push service and no government site is contacted.
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const calls = []; let queryImpl = async () => ({ rows: [], rowCount: 0 });
const fakeDb = { query: (t, p) => { calls.push([t, p]); return queryImpl(t, p); }, tx: async (fn) => fn(fakeDb), getPool: () => ({}) };
const dbPath = path.join(__dirname, 'lib', 'db.js'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const R = (m) => require(path.join(__dirname, m));
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
let pass = 0, fail = 0; const tests = []; const t = (n, f) => tests.push([n, f]);

const NS = R('lib/nationalSources.js'); const guard = R('lib/domainGuard.js'); const policy = R('lib/sourcePolicy.js'); const push = R('lib/pushNotify.js');
const { SEED } = R('lib/registry.js');

// ---------- registry ----------
t('registry: every State and Union Territory has at least one source (36 of 36)', () => {
  assert.strictEqual(NS.STATES_AND_UTS.length, 36);
  const covered = new Set([...NS.NATIONAL_SOURCES, ...SEED.map((s) => ({ state: s.state }))].map((s) => s.state));
  const missing = NS.STATES_AND_UTS.filter((s) => !covered.has(s)); assert.deepStrictEqual(missing, []);
});
t('registry: ids are unique and do not collide with earlier registries', () => {
  const ids = NS.NATIONAL_SOURCES.map((s) => s.source_id); assert.strictEqual(new Set(ids).size, ids.length);
  const old = new Set(SEED.map((s) => s.source_id).concat(['ncs', 'rrb-apply', 'indian-railways', 'rbi', 'drdo', 'isro', 'join-indian-army', 'epfo', 'ongc', 'ntpc', 'powergrid', 'iocl', 'kvs', 'mha']));
  assert.deepStrictEqual(ids.filter((i) => old.has(i)), []);
});
t('registry: every row passes the domain guard (https, official domain, portal inside domain, right state)', () => {
  const bad = NS.NATIONAL_SOURCES.map((s) => ({ id: s.source_id, v: guard.check(s) })).filter((x) => !x.v.ok);
  assert.deepStrictEqual(bad.map((b) => b.id + ': ' + b.v.problems.map((p) => p.code).join(',')), []);
});
t('registry: tiers are 1-3 and map to 5/10/20 minutes; env can override', () => {
  assert(NS.NATIONAL_SOURCES.every((s) => [1, 2, 3].includes(s.tier)));
  assert.deepStrictEqual([NS.tierMinutes(1, {}), NS.tierMinutes(2, {}), NS.tierMinutes(3, {})], [5, 10, 20]); assert.strictEqual(NS.tierMinutes(1, { CRAWL_MINUTES_T1: '2' }), 2); assert.strictEqual(NS.tierMinutes(1, { CRAWL_MINUTES_T1: 'x' }), 5);
});

// ---------- Punjab ----------
t('Punjab: PPSC is ppsc.gov.in and PSSSB is sssb.punjab.gov.in, both Punjab, both tier 1 (5 minutes)', () => {
  const p = NS.NATIONAL_SOURCES.find((s) => s.source_id === 'ppsc'), s = NS.NATIONAL_SOURCES.find((x) => x.source_id === 'psssb');
  assert.strictEqual(p.official_domain, 'ppsc.gov.in'); assert.strictEqual(p.portal_url, 'https://ppsc.gov.in/'); assert.strictEqual(p.state, 'Punjab');
  assert.strictEqual(s.official_domain, 'sssb.punjab.gov.in'); assert.strictEqual(s.portal_url, 'https://sssb.punjab.gov.in/'); assert.strictEqual(s.state, 'Punjab'); assert([p, s].every((x) => x.tier === 1 && x.confirmed));
});
t('Punjab: Pakistan\'s Punjab commission (ppsc.gop.pk) and other foreign look-alikes are never official', () => {
  for (const h of ['ppsc.gop.pk', 'www.ppsc.gop.pk', 'ppsc.gov.pk', 'x.com.pk', 'psc.gov.bd']) { assert.strictEqual(policy.isOfficialDomain(h), false, h); assert(guard.foreignLookalike(h), h); }
  assert.strictEqual(guard.foreignLookalike('ppsc.gov.in'), null);
});
t('Punjab: a row holding a wrong domain is flagged and corrected to the right one', () => {
  for (const wrong of ['ppsc.gop.pk', 'ppsc.nic.in', 'pspsc.gov.in']) {
    const v = guard.check({ source_id: 'ppsc', official_domain: wrong, portal_url: `https://${wrong}/`, state: 'Punjab' });
    assert.strictEqual(v.ok, false, wrong); assert.deepStrictEqual(v.fix, { official_domain: 'ppsc.gov.in', portal_url: 'https://ppsc.gov.in/' }, wrong);
  }
  const v2 = guard.check({ source_id: 'psssb', official_domain: 'psssb.gov.in', portal_url: 'https://psssb.gov.in/', state: 'Punjab' }); assert.strictEqual(v2.fix.official_domain, 'sssb.punjab.gov.in');
});
t('Punjab: a Punjab source filed on another state\'s sub-domain is caught', () => {
  const v = guard.check({ source_id: 'x', official_domain: 'uppsc.up.nic.in', portal_url: 'https://uppsc.up.nic.in/', state: 'Punjab' });
  assert(v.problems.some((p) => p.code === 'WRONG_STATE'));
  assert.strictEqual(guard.check({ source_id: 'x', official_domain: 'sssb.punjab.gov.in', portal_url: 'https://sssb.punjab.gov.in/', state: 'Punjab' }).ok, true);
});
t('Bihar: the stale bpsc.bih.nic.in domain is corrected to bpsc.bihar.gov.in', () => {
  const v = guard.check({ source_id: 'bpsc', official_domain: 'bpsc.bih.nic.in', portal_url: 'https://bpsc.bih.nic.in/', state: 'Bihar' }); assert.strictEqual(v.fix.official_domain, 'bpsc.bihar.gov.in');
});

// ---------- guard ----------
t('guard: http, IP addresses, localhost, portal outside the domain, and non-official domains are rejected', () => {
  const codes = (s) => guard.check(s).problems.map((p) => p.code);
  assert(codes({ source_id: 'a', official_domain: 'x.gov.in', portal_url: 'http://x.gov.in/', state: 'All India' }).includes('UNSAFE_URL'));
  assert(codes({ source_id: 'a', official_domain: '10.0.0.5', portal_url: 'https://10.0.0.5/', state: 'All India' }).includes('IP_ADDRESS'));
  assert(codes({ source_id: 'a', official_domain: 'x.gov.in', portal_url: 'https://y.gov.in/', state: 'All India' }).includes('PORTAL_OUTSIDE_DOMAIN'));
  assert(codes({ source_id: 'a', official_domain: 'jobs-portal.com', portal_url: 'https://jobs-portal.com/', state: 'All India' }).includes('NOT_OFFICIAL_DOMAIN'));
  assert(codes({ source_id: 'a', official_domain: 'evil.gov.in.attacker.com', portal_url: 'https://evil.gov.in.attacker.com/', state: 'All India' }).includes('NOT_OFFICIAL_DOMAIN'));
});
t('policy: PSU domains added in v2.10.0 are official, look-alikes are not, earlier domains still are', () => {
  for (const h of ['pspcl.in', 'www.pnbindia.in', 'ibps.in', 'upsc.gov.in', 'sssb.punjab.gov.in']) assert.strictEqual(policy.isOfficialDomain(h), true, h);
  for (const h of ['pspcl.in.evil.com', 'notpspcl.in', 'pnbindia.in.example.org']) assert.strictEqual(policy.isOfficialDomain(h), false, h);
});

// ---------- reconcile (fake database) ----------
t('reconcile: inserts missing national sources as PENDING, corrects a wrong Punjab domain, tiers only default intervals', async () => {
  calls.length = 0; const audits = [];
  queryImpl = async (sql, params) => {
    if (/^INSERT INTO sources/.test(sql.trim())) return { rows: params[0] === 'ppsc' ? [] : [{ source_id: params[0] }], rowCount: 1 };
    if (/^SELECT source_id, official_domain/.test(sql.trim())) return { rows: [{ source_id: 'ppsc', official_domain: 'ppsc.gop.pk', portal_url: 'https://ppsc.gop.pk/', state: 'Punjab', verification_status: 'VERIFIED' }, { source_id: 'psssb', official_domain: 'sssb.punjab.gov.in', portal_url: 'https://sssb.punjab.gov.in/', state: 'Punjab', verification_status: 'PENDING_VERIFICATION' }] };
    return { rows: [], rowCount: 1 };
  };
  const out = await guard.reconcile({ db: fakeDb, audit: async (...a) => audits.push(a), env: {} });
  assert(out.inserted.length === NS.NATIONAL_SOURCES.length - 1 && !out.inserted.includes('ppsc'));
  assert.deepStrictEqual(out.corrected, [{ source_id: 'ppsc', from: 'ppsc.gop.pk', to: 'ppsc.gov.in' }]);
  const upd = calls.find(([s]) => /SET official_domain=\$2/.test(s)); assert(upd && upd[1][1] === 'ppsc.gov.in' && /verification_status='PENDING_VERIFICATION', crawl_enabled=FALSE/.test(upd[0]));
  assert(audits.some((a) => a[1] === 'SOURCE_DOMAIN_CORRECTED' && a[3] === 'ppsc'));
  assert(calls.some(([s]) => /crawl_frequency_minutes IN \(30,360\)/.test(s)), 'admin-set intervals are never overwritten');
  const ins = calls.find(([s, p]) => /^INSERT INTO sources/.test(s.trim()) && p[0] === 'psssb'); assert(/'PENDING_VERIFICATION'/.test(ins[0]) && ins[1][6] === 1 && ins[1][7] === 5);
  queryImpl = async () => ({ rows: [], rowCount: 0 });
});
t('reconcile: a source on a non-official domain is switched to REVIEW with crawling off, never contacted', async () => {
  calls.length = 0;
  queryImpl = async (sql) => (/^SELECT source_id, official_domain/.test(sql.trim()) ? { rows: [{ source_id: 'x1', official_domain: 'jobs-portal.com', portal_url: 'https://jobs-portal.com/', state: 'Assam', verification_status: 'PENDING_VERIFICATION' }] } : { rows: [], rowCount: 0 });
  const out = await guard.reconcile({ db: fakeDb, nationalSources: [], env: {} }); assert.strictEqual(out.flagged.length, 1);
  assert(calls.some(([s]) => /domain_status='REVIEW'.*crawl_enabled=FALSE/.test(s))); queryImpl = async () => ({ rows: [], rowCount: 0 });
});

// ---------- push: subscription validation ----------
const P256 = 'B' + 'a'.repeat(86), AUTH = 'b'.repeat(22);
const goodSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: P256, auth: AUTH } };
t('push: a real browser push endpoint with well-formed keys is accepted', () => { assert.strictEqual(push.validateSubscription(goodSub).ok, true); for (const e of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Q', 'https://wns2-par02p.notify.windows.com/w']) assert.strictEqual(push.validateSubscription({ ...goodSub, endpoint: e }).ok, true, e); });
t('push: SSRF-style endpoints (http, metadata IP, internal host, userinfo, lookalike host) are rejected', () => {
  for (const e of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.com/x', 'https://u:p@fcm.googleapis.com/x', 'not a url']) assert.strictEqual(push.validateSubscription({ ...goodSub, endpoint: e }).ok, false, e);
  assert.strictEqual(push.validateSubscription({ ...goodSub, keys: { p256dh: 'short', auth: AUTH } }).ok, false); assert.strictEqual(push.validateSubscription({ ...goodSub, keys: { p256dh: P256, auth: '<script>' } }).ok, false); assert.strictEqual(push.validateSubscription(null).ok, false);
});
t('push: preferences are cleaned (unknown States dropped, unverified is opt-in and labelled kind added only when opted in)', () => {
  const a = push.normalisePrefs({ states: ['Punjab', 'Narnia'], kinds: ['NEW_NOTIFICATION', 'HACK'] }, { states: NS.STATES_AND_UTS }); assert.deepStrictEqual(a.states, ['Punjab']); assert.deepStrictEqual(a.kinds, ['NEW_NOTIFICATION']); assert.strictEqual(a.include_unverified, false);
  const b = push.normalisePrefs({ include_unverified: true }, { states: NS.STATES_AND_UTS }); assert(b.kinds.includes('DETECTED_UNVERIFIED')); assert.deepStrictEqual(push.normalisePrefs({}, {}).kinds, push.KINDS_DEFAULT);
  assert.strictEqual(push.normalisePrefs({ kinds: ['DETECTED_UNVERIFIED'] }, {}).kinds.includes('DETECTED_UNVERIFIED'), false);
});

// ---------- push: matching ----------
const ev = (kind, state, extra = {}) => ({ id: 7, kind, title: 'Junior Engineer', organization: 'Punjab SSSB', payload: { state, vacancies: 262, application_close: '2026-11-15', verified: kind !== 'DETECTED_UNVERIFIED', document_url: 'https://sssb.punjab.gov.in/n.pdf', ...extra } });
t('push: all-India subscribers get every State; State subscribers get only their State plus central; central can be switched off', () => {
  const all = { active: true, states: [], include_central: true, kinds: push.KINDS_DEFAULT }, pb = { ...all, states: ['Punjab'] }, noc = { ...pb, include_central: false };
  assert(push.matches(all, ev('NEW_NOTIFICATION', 'Kerala')) && push.matches(all, ev('NEW_NOTIFICATION', 'All India')));
  assert(push.matches(pb, ev('NEW_NOTIFICATION', 'Punjab')) && !push.matches(pb, ev('NEW_NOTIFICATION', 'Kerala')) && push.matches(pb, ev('NEW_NOTIFICATION', 'All India')));
  assert(!push.matches(noc, ev('NEW_NOTIFICATION', 'All India')) && push.matches(noc, ev('NEW_NOTIFICATION', 'Punjab')));
  assert(push.matches(all, ev('NEW_NOTIFICATION', undefined)), 'unknown state is treated as central');
});
t('push: unverified detections reach only people who opted in; inactive subscriptions get nothing; retractions are not pushed by default', () => {
  const base = { active: true, states: [], include_central: true };
  assert(!push.matches({ ...base, kinds: push.KINDS_DEFAULT }, ev('DETECTED_UNVERIFIED', 'Punjab'))); assert(!push.matches({ ...base, include_unverified: false, kinds: push.ALL_KINDS }, ev('DETECTED_UNVERIFIED', 'Punjab')));
  assert(push.matches({ ...base, include_unverified: true, kinds: push.ALL_KINDS }, ev('DETECTED_UNVERIFIED', 'Punjab'))); assert(!push.matches({ ...base, active: false, kinds: push.KINDS_DEFAULT }, ev('NEW_NOTIFICATION', 'Punjab'))); assert(!push.matches({ ...base, kinds: push.KINDS_DEFAULT }, ev('RETRACTED', 'Punjab')));
});

// ---------- push: payload ----------
t('push: payload carries only stored facts, labels verification, and only https links', () => {
  const p = push.buildPayload(ev('NEW_NOTIFICATION', 'Punjab')); assert(/^New: Junior Engineer/.test(p.title)); assert(/262 posts/.test(p.body) && /2026-11-15/.test(p.body) && /Punjab/.test(p.body) && /official source/i.test(p.body)); assert.strictEqual(p.verified, true); assert.strictEqual(p.official_url, 'https://sssb.punjab.gov.in/n.pdf'); assert.strictEqual(p.tag, 'gc-7');
  const u = push.buildPayload(ev('DETECTED_UNVERIFIED', 'Punjab')); assert(/not yet verified/i.test(u.title + u.body) && u.verified === false);
  const h = push.buildPayload(ev('NEW_NOTIFICATION', 'Punjab', { document_url: 'javascript:alert(1)', source_url: 'http://x.gov.in/a' })); assert.strictEqual(h.official_url, null);
  const x = push.buildPayload({ id: 1, kind: 'AMENDED', title: 'T'.repeat(500), organization: 'O\u0000'.repeat(200), payload: { changes: [{ label: 'Last date', from: '2026-11-15', to: '2026-11-30' }] } }); assert(x.title.length <= 110 && x.body.length <= 240 && !/\u0000/.test(x.body)); assert(JSON.stringify(x).length < 1500);
});

// ---------- push: queue ----------
function memStore(rows) {
  const log = new Map(); const subs = new Map(rows.map((r) => [r.subscription.id, { ...r.subscription, active: true, failures: 0 }]));
  const items = rows.map((r, i) => ({ id: i + 1, attempts: r.attempts || 0, event: r.event, subscription: r.subscription, status: 'QUEUED' }));
  return { subs, items, log, async enqueue() { return items.length; }, async claim() { return items.filter((i) => i.status === 'QUEUED'); },
    async finish(id, p) { const it = items.find((i) => i.id === id); Object.assign(it, p); log.set(id, p.status); }, async deactivate(id) { subs.get(id).active = false; }, async touch(id, ok) { const s = subs.get(id); s.failures = ok ? 0 : s.failures + 1; } };
}
t('push queue: SENT only when the push service accepted it; 404/410 deactivate; transient errors retry with back-off; 4 failures stop', async () => {
  const rows = [1, 2, 3, 4, 5].map((i) => ({ event: ev('NEW_NOTIFICATION', 'Punjab'), subscription: { id: i, endpoint: `https://fcm.googleapis.com/${i}`, p256dh: P256, auth: AUTH } }));
  rows[4].attempts = 3; const st = memStore(rows); const statusBy = { 1: { ok: true, status: 201 }, 2: { ok: false, status: 410 }, 3: { ok: false, status: 503 }, 4: 'throw', 5: { ok: false, status: 503 } };
  const out = await push.processQueue(st, async (sub) => { const r = statusBy[sub.id]; if (r === 'throw') throw new Error('socket hang up'); return r; }, { now: new Date('2026-10-11T00:00:00Z') });
  assert.deepStrictEqual([out.sent, out.gone, out.retried, out.failed], [1, 1, 2, 1]);
  assert.strictEqual(st.items[0].status, 'SENT'); assert.strictEqual(st.items[1].status, 'GONE'); assert.strictEqual(st.subs.get(2).active, false); assert.strictEqual(st.items[2].status, 'QUEUED'); assert(st.items[2].next_attempt_at > new Date('2026-10-11T00:00:20Z') - 1); assert.strictEqual(st.items[4].status, 'FAILED');
  const bad = await push.processQueue(memStore([{ event: ev('NEW_NOTIFICATION', 'Punjab'), subscription: { id: 9, endpoint: 'https://fcm.googleapis.com/9', p256dh: P256, auth: AUTH } }]), async () => ({ ok: false, status: 403 })); assert.strictEqual(bad.failed, 1, 'auth errors are not retried');
});
t('push tick: does nothing (and says so) when WEB_PUSH=0; never reports sent without a sender result', async () => {
  const off = await push.tick({ env: { WEB_PUSH: '0' }, db: fakeDb }); assert.strictEqual(off.configured, false);
  const st = memStore([{ event: ev('NEW_NOTIFICATION', 'Goa'), subscription: { id: 1, endpoint: 'https://fcm.googleapis.com/1', p256dh: P256, auth: AUTH } }]);
  const on = await push.tick({ env: {}, db: fakeDb, store: st, sender: async () => ({ ok: true, status: 201 }) }); assert.strictEqual(on.configured, true); assert.strictEqual(on.sent, 1);
});
t('push SQL: one row per (event, subscription), never to a newer subscriber for older events, central/State rule matches matches()', () => {
  const src = read('lib/pushNotify.js');
  assert(/ON CONFLICT \(feed_event_id, subscription_id\) DO NOTHING/.test(src)); assert(/e\.created_at >= s\.created_at/.test(src)); assert(/e\.kind <> 'DETECTED_UNVERIFIED' OR s\.include_unverified/.test(src)); assert(/FOR UPDATE SKIP LOCKED/.test(src));
});
t('vapid: keys come from the environment, otherwise one pair is generated once and stored', async () => {
  const env = await push.loadVapid({ env: { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' } }); assert.deepStrictEqual([env.publicKey, env.source], ['pub', 'env']);
  let stored = null; const db = { query: async (sql, p) => { if (/^SELECT public_key/.test(sql)) return { rows: stored ? [stored] : [] }; if (/^INSERT INTO push_vapid/.test(sql)) { stored = { public_key: p[0], private_key: p[1] }; return { rows: [] }; } return { rows: [] }; } };
  const v = await push.loadVapid({ env: {}, db }); assert(v.publicKey && v.privateKey && v.source === 'database' && v.publicKey === stored.public_key);
});

// ---------- HTTP routes (express, stub auth, fake db) ----------
function startApp({ demo, rows = {}, role = true }) {
  const express = require('express'); const app = express(); app.use(express.json());
  const db = { query: async (sql, p) => { if (/FROM feed_events/.test(sql)) return { rows: rows.events || [] }; if (/FROM sources/.test(sql) && /GROUP|domain_status IN/.test(sql) === false) return { rows: rows.sources || [] }; if (/INSERT INTO push_subscriptions/.test(sql)) { rows.saved = p; return { rows: [], rowCount: 1 }; } if (/SELECT public_key/.test(sql)) return { rows: [{ public_key: 'PUB', private_key: 'PRIV' }] }; return { rows: [], rowCount: 0 }; } };
  R('routes/national.js').mount(app, { db, runtime: { isDemo: () => !!demo }, auth: { requireRole: () => (req, res, next) => (role ? next() : res.status(401).json({ error: 'no' })) }, audit: async () => {}, env: {} });
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve({ srv, port: srv.address().port, rows })); });
}
const req = (port, method, p, body) => new Promise((resolve, reject) => { const data = body ? JSON.stringify(body) : null; const r = http.request({ port, method, path: p, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b })); }); r.on('error', reject); if (data) r.write(data); r.end(); });
t('routes (demo mode): push is reported unsupported, subscribe says it needs the database, coverage lists all sources as not watched', async () => {
  const { srv, port } = await startApp({ demo: true }); try {
    const c = JSON.parse((await req(port, 'GET', '/api/push/config')).body); assert.strictEqual(c.supported, false); assert.strictEqual(c.states.length, 36);
    const s = await req(port, 'POST', '/api/push/subscribe', { subscription: goodSub }); assert.strictEqual(s.status, 503);
    const cov = JSON.parse((await req(port, 'GET', '/api/national/coverage')).body); assert.strictEqual(cov.mode, 'DEMO'); assert.strictEqual(cov.states.length, 36); assert.strictEqual(cov.states_without_a_watched_source.length, 36); assert.deepStrictEqual(cov.states_without_any_source, []);
    const pb = JSON.parse((await req(port, 'GET', '/api/national/sources?state=Punjab')).body).sources; assert.deepStrictEqual(pb.map((x) => x.official_domain).sort(), ['ppsc.gov.in', 'pspcl.in', 'punjab.gov.in', 'punjabpolice.gov.in', 'sssb.punjab.gov.in']);
  } finally { srv.close(); }
});
t('routes (live): subscribe validates and stores cleaned preferences; bad endpoints are 400; config exposes the public key only', async () => {
  push.resetVapidCache(); const { srv, port, rows } = await startApp({ demo: false }); try {
    const c = JSON.parse((await req(port, 'GET', '/api/push/config')).body); assert.strictEqual(c.supported, true); assert.strictEqual(c.publicKey, 'PUB'); assert(!JSON.stringify(c).includes('PRIV'));
    assert.strictEqual((await req(port, 'POST', '/api/push/subscribe', { subscription: { ...goodSub, endpoint: 'https://169.254.169.254/x' } })).status, 400);
    const ok = await req(port, 'POST', '/api/push/subscribe', { subscription: goodSub, states: ['Punjab', 'Nope'], include_unverified: false }); assert.strictEqual(ok.status, 200); assert.deepStrictEqual(rows.saved[3], ['Punjab']); assert.strictEqual(rows.saved[5], false);
    assert.strictEqual((await req(port, 'POST', '/api/push/preferences', {})).status, 400); assert.strictEqual((await req(port, 'POST', '/api/push/unsubscribe', {})).status, 400);
    assert.strictEqual((await req(port, 'POST', '/api/push/preferences', { endpoint: goodSub.endpoint })).status, 404);
  } finally { srv.close(); }
});
t('routes: the Atom feed is valid XML, escapes content, lists only verified kinds, and uses only https official links', async () => {
  const events = [{ id: 5, kind: 'NEW_NOTIFICATION', title: 'JE <b>& "Co"', organization: 'PSSSB', payload: { state: 'Punjab', vacancies: 262, document_url: 'https://sssb.punjab.gov.in/a.pdf' }, created_at: new Date('2026-10-11T00:00:00Z') }];
  const { srv, port } = await startApp({ demo: false, rows: { events } }); try {
    const r = await req(port, 'GET', '/api/feed.atom'); assert.strictEqual(r.status, 200); assert(/atom\+xml/.test(r.type)); assert(/<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/.test(r.body)); assert(!/<b>/.test(r.body) && /&lt;b&gt;/.test(r.body)); assert(/href="https:\/\/sssb\.punjab\.gov\.in\/a\.pdf"/.test(r.body));
  } finally { srv.close(); }
  assert(/kind IN \('NEW_NOTIFICATION','DEADLINE_EXTENDED','AMENDED'\)/.test(read('routes/national.js')) && !/DETECTED_UNVERIFIED/.test(read('routes/national.js').split('feed.atom')[1].split('admin')[0]));
});
t('routes: admin endpoints require the role middleware', async () => {
  const { srv, port } = await startApp({ demo: false, role: false }); try { assert.strictEqual((await req(port, 'GET', '/api/admin/national/domain-issues')).status, 401); assert.strictEqual((await req(port, 'POST', '/api/admin/national/reconcile')).status, 401); } finally { srv.close(); }
});

// ---------- wiring (nothing removed, everything hooked up) ----------
t('wiring: server mounts national routes after trust; startup reconciles; no earlier route removed', () => {
  const s = read('server.js'); assert(/routes\/national'\)\.mount/.test(s)); assert(/domainGuard'\)\.reconcile/.test(s)); for (const r of ["'/api/feed'", "'/api/autolive/status'", "'/api/live/opportunities'", "routes/trust", "'/api/admin'"]) assert(s.includes(r), r);
});
t('wiring: scheduler runs reconcile -> verify -> flag unreachable, and a push loop every 10 s by default; verify retries hourly', () => {
  const s = read('lib/scheduler.js'); assert(/loop\('push'/.test(s)); assert(/domainGuard\.reconcile/.test(s)); assert(/flagUnreachable/.test(s)); const i = R('lib/scheduler.js').intervals({}); assert.strictEqual(i.pushMs, 10000); assert.strictEqual(i.verifyMs, 3600000); assert.strictEqual(R('lib/scheduler.js').intervals({ PUSH_TICK_SECONDS: '3' }).pushMs, 3000);
});
t('wiring: service worker handles push and click, only opens https official links, and caches the new files (v20+)', () => {
  const s = read('public/sw.js'); assert(/govcareer-shell-v2\d/.test(s)); assert(/addEventListener\('push'/.test(s) && /addEventListener\('notificationclick'/.test(s)); assert(/national\.js/.test(s) && /national\.css/.test(s)); assert(/protocol==='https:'/.test(s)); assert(/showNotification/.test(s));
});
t('wiring: UI is loaded, CSP-safe (no inline handlers, no eval), shows honest wording, and never claims instant-to-the-second', () => {
  const h = read('public/index.html'), j = read('public/national.js'); assert(/national\.js/.test(h) && /national\.css/.test(h)); assert(!/\son(click|change|load)=/.test(j) && !/eval\(|new Function\(/.test(j)); assert(/not instant to the second/.test(j)); assert(/not yet verified/i.test(j)); assert(/Notification\.requestPermission/.test(j));
  const csp = read('server.js').match(/Content-Security-Policy': "([^"]+)"/)[1]; assert(/connect-src 'self'/.test(csp) && /worker-src 'self'/.test(csp));
});
t('wiring: migration 011 is additive (no DROP, DELETE FROM, TRUNCATE or column type change)', () => {
  const m = read('db/migrations/011_national_push.sql'); assert(!/DROP\s|DELETE\s+FROM|TRUNCATE|ALTER COLUMN/i.test(m)); for (const x of ['push_subscriptions', 'push_log', 'push_vapid', 'domain_status', 'priority_tier']) assert(m.includes(x), x); assert(/UNIQUE \(feed_event_id, subscription_id\)/.test(m));
});
t('wiring: crawler also recognises regional and corrigendum wording; earlier keywords are kept', () => {
  const c = read('lib/crawler.js'); for (const k of ['recruit', 'notification', 'advertisement', 'vacanc', 'bharti', 'corrigendum', 'भर्ती', 'ਭਰਤੀ']) assert(c.includes(k), k);
});
t('wiring: three more UTs are selectable, every earlier State is kept', () => {
  const s = R('lib/search.js').STATES; for (const x of ['Punjab', 'Andhra Pradesh', 'West Bengal', 'Delhi', 'Lakshadweep', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu']) assert(s.includes(x), x);
  for (const x of NS.STATES_AND_UTS) assert(s.includes(x), x);
});
t('wiring: package.json keeps every earlier script and test, adds web-push and the new suite', () => {
  const p = JSON.parse(read('package.json')); assert(p.dependencies['web-push']); assert(/test-national\.js/.test(p.scripts.test) && /test-trust\.js/.test(p.scripts.test) && /test-autolive\.js/.test(p.scripts.test) && /test-govcareer-subtab\.js/.test(p.scripts.test)); assert(/lib\/pushNotify\.js/.test(p.scripts.check) && /routes\/national\.js/.test(p.scripts.check));
});

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.stack.split('\n').slice(0, 3).join('\n       ')); } } console.log(`\nNational coverage + push: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
