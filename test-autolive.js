// v2.8.2 automatic lane. Dependency-free: 'pg' and lib/db are stubbed, HTTP is mocked, no live government site is contacted.
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const Module = require('module');
const calls = []; let queryImpl = async () => ({ rows: [], rowCount: 0 });
const fakeDb = { query: (t, p) => { calls.push([t, p]); return queryImpl(t, p); }, tx: async (fn) => fn({ query: (t, p) => { calls.push([t, p]); return queryImpl(t, p); } }), getPool: () => ({}) };
const dbPath = path.join(__dirname, 'lib', 'db.js'); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const auditPath = path.join(__dirname, 'lib', 'audit.js'); const audits = []; require.cache[auditPath] = { id: auditPath, filename: auditPath, loaded: true, exports: { audit: async (...a) => { audits.push(a); }, verifyChain: async () => ({ ok: true }) } };
const R = (m) => require(path.join(__dirname, m));
let pass = 0, fail = 0; const tests = [];
const t = (n, f) => tests.push([n, f]);
const sample = { title: 'Junior Assistant', organization: 'Demo Board', vacancies: { total: 120 }, dates: { application_open: '2026-10-01', application_close: '2026-11-15' }, education: { label: 'Graduate' }, age: { min: 18, max: 30 }, application_link: 'https://x.gov.in/apply' };
const lin = { title: { page_number: 1 }, organization: { page_number: 1 } };
const src = { source_id: 's', verification_status: 'VERIFIED', source_type: 'OFFICIAL_PORTAL', official_domain: 'x.gov.in', portal_url: 'https://x.gov.in/', organization: 'X' };
const base = { source: src, record: sample, lineage: lin, confidence: 0.92, schemaValid: true, buckets: ['high_confidence'], isUpdate: false, changes: [] };
const cfg = { enabled: true, minConfidence: 0.85, maxStaleDays: 30 }; const now = new Date('2026-10-10T00:00:00Z');
const codes = (x) => x.reasons.map((r) => r.code);

// ---------- auto-publish policy ----------
const AP = () => R('lib/autopublish.js');
t('policy: a cited, high-confidence notice from a verified official source is eligible', () => assert.strictEqual(AP().evaluate(base, cfg, now).ok, true));
t('policy: demo, manual-upload and unverified sources are never auto-published', () => {
  for (const s of [{ ...src, source_type: 'DEMO' }, { ...src, source_type: 'MANUAL_UPLOAD' }, { ...src, verification_status: 'PENDING_VERIFICATION' }, null]) assert.strictEqual(AP().evaluate({ ...base, source: s }, cfg, now).ok, false);
});
t('policy: low confidence, schema failure and any risky review flag block publication', () => {
  assert(codes(AP().evaluate({ ...base, confidence: 0.6 }, cfg, now)).includes('LOW_CONFIDENCE'));
  assert(codes(AP().evaluate({ ...base, schemaValid: false }, cfg, now)).includes('SCHEMA_INVALID'));
  for (const b of ['suspicious', 'conflicting_sources', 'potential_duplicate', 'broken_link', 'low_confidence']) assert.strictEqual(AP().evaluate({ ...base, buckets: [b] }, cfg, now).ok, false, b);
});
t('policy: title and organisation must be cited to a page', () => assert(codes(AP().evaluate({ ...base, lineage: {} }, cfg, now)).includes('UNCITED_FIELD')));
t('policy: a document with neither vacancies nor a closing date is not treated as a notification', () => assert(codes(AP().evaluate({ ...base, record: { ...sample, vacancies: undefined, dates: {} } }, cfg, now)).includes('NOT_A_NOTIFICATION')));
t('policy: invalid and long-past closing dates are refused; a recent one is fine', () => {
  assert(codes(AP().evaluate({ ...base, record: { ...sample, dates: { application_close: 'soon' } } }, cfg, now)).includes('BAD_DATE'));
  assert(codes(AP().evaluate({ ...base, record: { ...sample, dates: { application_close: '2026-06-01' } } }, cfg, now)).includes('STALE_DEADLINE'));
  assert.strictEqual(AP().evaluate({ ...base, record: { ...sample, dates: { application_close: '2026-10-05' } } }, cfg, now).ok, true);
});
t('policy: an update needs a change and every change cited; "changed_source" is allowed only for updates', () => {
  const ch = [{ field: 'dates.application_close', supported: true, delta: 'extended by 7 days' }];
  assert.strictEqual(AP().evaluate({ ...base, isUpdate: true, buckets: ['changed_source'], changes: ch }, cfg, now).ok, true);
  assert(codes(AP().evaluate({ ...base, isUpdate: true, buckets: ['changed_source'], changes: [] }, cfg, now)).includes('NO_CHANGE'));
  assert(codes(AP().evaluate({ ...base, isUpdate: true, buckets: ['changed_source'], changes: [{ ...ch[0], supported: false }] }, cfg, now)).includes('UNCITED_CHANGE'));
  assert.strictEqual(AP().evaluate({ ...base, buckets: ['changed_source'] }, cfg, now).ok, false);
});
t('policy: AUTO_PUBLISH off disables everything; deadline extension is classified from the official delta', () => {
  assert(codes(AP().evaluate(base, { ...cfg, enabled: false }, now)).includes('DISABLED'));
  assert.strictEqual(AP().classify([{ field: 'dates.application_close', delta: 'extended by 7 days' }]), 'DEADLINE_EXTENDED');
  assert.strictEqual(AP().classify([{ field: 'dates.application_close', delta: 'moved earlier' }]), 'AMENDED');
  assert.strictEqual(AP().classify([{ field: 'vacancies.total', delta: '+20' }]), 'AMENDED');
});
t('summary never invents values: missing facts stay null', () => { const s = AP().summarize({ title: 'T' }); assert.strictEqual(s.vacancies, null); assert.strictEqual(s.application_close, null); assert.strictEqual(s.eligibility.education, null); });

// tryAutoPublish against a scripted transaction
function script(over = {}) {
  const item = { id: 7, status: 'OPEN', version_id: 3, recruitment_id: 'rec-1', buckets: ['high_confidence'], ...over.item };
  const ver = { id: 3, version_no: 1, data: sample, lineage: lin, confidence: '0.92', schema_valid: true, document_id: 9, ...over.ver };
  const rec = { id: 'rec-1', source_id: 's', published_at: null, ...over.rec };
  const log = []; const inserted = [];
  const q = async (text, p) => {
    log.push(text);
    if (/FROM review_items WHERE id/.test(text)) return { rows: [item] };
    if (/FROM recruitment_versions WHERE id/.test(text)) return { rows: [ver] };
    if (/FROM recruitments WHERE id/.test(text)) return { rows: [rec] };
    if (/FROM sources WHERE source_id/.test(text)) return { rows: [over.source || src] };
    if (/FROM documents WHERE id/.test(text)) return { rows: [{ id: 9, title: 'Notification.pdf', url: 'https://x.gov.in/n.pdf' }] };
    if (/FROM change_events/.test(text)) return { rows: over.changes || [] };
    if (/INSERT INTO feed_events/.test(text)) { inserted.push(p); return { rows: [{ id: 41 }], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  };
  const transitions = [];
  const deps = { db: { tx: async (fn) => fn({ query: q }) }, lifecycle: { transition: async (id, to, actor) => { transitions.push([to, actor]); } }, audit: async () => {}, validateRecord: () => [], now: () => now, cfg };
  return { deps, log, inserted, transitions };
}
t('tryAutoPublish: publishes through VERIFIED then PUBLISHED as the named policy actor and writes one feed event', async () => {
  const s = script(); const out = await AP().tryAutoPublish(7, s.deps);
  assert.strictEqual(out.published, true); assert.strictEqual(out.kind, 'NEW_NOTIFICATION');
  assert.deepStrictEqual(s.transitions.map((x) => x[0]), ['VERIFIED', 'PUBLISHED']); assert(s.transitions.every((x) => x[1].type === 'policy' && x[1].name === 'auto-publish'));
  assert.strictEqual(s.inserted.length, 1); assert(s.inserted[0][2].startsWith('NEW_NOTIFICATION:rec-1:v1'));
  const v = s.log.find((x) => /SET data=/.test(x)); assert(v, 'record updated'); assert(JSON.parse(s.inserted[0][5]).verified === true);
});
t('tryAutoPublish: an extension on a published record becomes DEADLINE_EXTENDED', async () => {
  const s = script({ rec: { published_at: new Date() }, item: { buckets: ['changed_source'] }, ver: { version_no: 2 }, changes: [{ field: 'dates.application_close', label: 'Application deadline', from_value: '1 Nov', to_value: '8 Nov', delta: 'extended by 7 days', supported: true }] });
  const out = await AP().tryAutoPublish(7, s.deps); assert.strictEqual(out.kind, 'DEADLINE_EXTENDED'); assert(s.inserted[0][2].startsWith('DEADLINE_EXTENDED:rec-1:v2'));
});
t('tryAutoPublish: a risky item is NOT published, stays in review, and is announced only as "detected, not verified"', async () => {
  const s = script({ item: { buckets: ['low_confidence'] }, ver: { confidence: '0.5' } }); const out = await AP().tryAutoPublish(7, s.deps);
  assert.strictEqual(out.published, false); assert.strictEqual(out.detected, true); assert.deepStrictEqual(s.transitions, []);
  assert.strictEqual(s.inserted[0][1].split(':')[0], 'DETECTED_UNVERIFIED'); assert.strictEqual(JSON.parse(s.inserted[0][4]).verified, false);
});
t('tryAutoPublish: suspicious items are never announced; resolved items are skipped', async () => {
  const s = script({ item: { buckets: ['suspicious'] } }); const out = await AP().tryAutoPublish(7, s.deps); assert.strictEqual(out.published, false); assert.strictEqual(out.detected, false); assert.strictEqual(s.inserted.length, 0);
  const s2 = script({ item: { status: 'APPROVED' } }); assert.strictEqual((await AP().tryAutoPublish(7, s2.deps)).skipped, 'review item is not open');
});
t('retract requires a reason and archives; confirm needs an auto-published record', async () => {
  await assert.rejects(() => AP().retract('r', { email: 'a@b' }, 'x', { db: fakeDb }), /short reason/);
  const trans = []; const q = async (text) => (/FROM recruitments WHERE id/.test(text) ? { rows: [{ id: 'r', title: 'T', published_at: new Date() }] } : { rows: [], rowCount: 1 });
  const out = await AP().retract('r', { email: 'a@b' }, 'published by mistake', { db: { tx: async (f) => f({ query: q }) }, lifecycle: { transition: async (id, to, a) => trans.push([to, a.type]) }, audit: async () => {} });
  assert.strictEqual(out.lifecycle, 'ARCHIVED'); assert.deepStrictEqual(trans[0], ['ARCHIVED', 'human']);
  queryImpl = async () => ({ rows: [] }); await assert.rejects(() => AP().confirm('r', { email: 'a@b' }, { db: fakeDb, audit: async () => {} }), /Nothing to confirm/);
});

// ---------- lifecycle: only the named policy may publish without a person ----------
t('lifecycle: agents still cannot publish; the policy actor can, and only while AUTO_PUBLISH is on', async () => {
  const L = R('lib/lifecycle.js'); const c = { query: async (x) => (/SELECT lifecycle/.test(x) ? { rows: [{ lifecycle: 'REVIEW_REQUIRED' }] } : { rows: [], rowCount: 1 }) };
  await assert.rejects(() => L.transition('r', 'VERIFIED', { type: 'agent', name: 'Quality' }, '', c), /Only a signed-in reviewer/);
  await assert.rejects(() => L.transition('r', 'VERIFIED', { type: 'policy', name: 'something-else' }, '', c), /Only a signed-in reviewer/);
  assert.deepStrictEqual(await L.transition('r', 'VERIFIED', { type: 'policy', name: 'auto-publish' }, '', c), { from: 'REVIEW_REQUIRED', to: 'VERIFIED' });
  process.env.AUTO_PUBLISH = '0'; try { await assert.rejects(() => L.transition('r', 'VERIFIED', { type: 'policy', name: 'auto-publish' }, '', c), /Only a signed-in reviewer/); } finally { delete process.env.AUTO_PUBLISH; }
});

// ---------- source policy ----------
const SP = () => R('lib/sourcePolicy.js');
t('source policy: official domains accepted, look-alikes and IPs rejected', () => {
  for (const h of ['upsc.gov.in', 'www.ssc.gov.in', 'joinindianarmy.nic.in', 'ibps.in', 'www.sbi.co.in']) assert(SP().isOfficialDomain(h), h);
  for (const h of ['upsc.gov.in.evil.com', 'gov.in.example.com', 'freejobalert.com', 'sarkari-result.com', '10.0.0.1', '', 'notgov.in']) assert(!SP().isOfficialDomain(h), h);
});
t('source policy: SSRF guard refuses http, localhost, private ranges, metadata hosts and credentials in URLs', () => {
  for (const u of ['http://x.gov.in/', 'https://localhost/', 'https://127.0.0.1/', 'https://10.1.2.3/', 'https://192.168.0.5/', 'https://172.16.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://metadata.google.internal/', 'https://user:pw@x.gov.in/', 'ftp://x.gov.in/', 'not a url']) assert(!SP().isSafeUrl(u), u);
  assert(SP().isSafeUrl('https://www.upsc.gov.in/'));
});
t('source policy: judge needs official domain, page answering, html content and recruitment wording', () => {
  const ok = { status: 200, contentType: 'text/html', body: '<a>Recruitment notification</a>' };
  assert.strictEqual(SP().judge(src, ok).ok, true);
  assert.strictEqual(SP().judge(src, { ...ok, body: 'cooking recipes' }).ok, false);
  assert.strictEqual(SP().judge(src, { ...ok, status: 503 }).ok, false);
  assert.strictEqual(SP().judge(src, { ...ok, contentType: 'application/pdf' }).ok, false);
  assert.strictEqual(SP().judge({ ...src, official_domain: 'evil.com', portal_url: 'https://evil.com/' }, ok).ok, false);
});
t('source policy: autoVerifyPending verifies good sources, leaves bad ones pending with a reason, never contacts a non-official host', async () => {
  const rows = [{ ...src, source_id: 'good' }, { ...src, source_id: 'bad-domain', official_domain: 'evil.com', portal_url: 'https://evil.com/' }, { ...src, source_id: 'offtopic' }];
  const upd = []; const db = { query: async (text, p) => { if (/SELECT \* FROM sources/.test(text)) return { rows }; upd.push([text, p]); return { rows: [] }; } };
  const fetched = []; const fetch = async (url) => { fetched.push(url); return { status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => (fetched.length === 1 ? 'Recruitment' : 'nothing here') }; };
  const out = await SP().autoVerifyPending({ db, audit: async (...a) => audits.push(a), fetch });
  assert.deepStrictEqual(out.verified, ['good']); assert.deepStrictEqual(out.left_pending.map((x) => x.source_id).sort(), ['bad-domain', 'offtopic']); assert.strictEqual(fetched.length, 2, 'evil.com never fetched');
  assert(upd.some(([x, p]) => /VERIFIED/.test(x) && p[0] === 'good'));
});
t('source policy: extra sources are real-looking official domains and all pass the static policy', () => { for (const s of SP().EXTRA_SOURCES) assert(SP().judge(s, null).ok, s.source_id); });

// ---------- crawler: conditional GET, redirects, cool-down ----------
const C = () => R('lib/crawler.js');
const hdr = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const crawlSrc = { source_id: 's', official_domain: 'x.gov.in', portal_url: 'https://x.gov.in/recruitment', crawl_enabled: true, verification_status: 'VERIFIED', min_request_interval_ms: 0, last_links: [], source_type: 'OFFICIAL_PORTAL' };
const env = (fn, seen = []) => ({ fetch: async (u, o) => { seen.push([u, o]); return fn(u, o); }, sleep: async () => {}, now: () => Date.now() });
t('crawler: sends If-None-Match and treats 304 as healthy with no work', async () => {
  const seen = []; const r = await C().crawlSource({ ...crawlSrc, etag: '"abc"', last_modified: 'Wed, 01 Oct 2026 00:00:00 GMT', last_links: [{ url: 'https://x.gov.in/a.pdf' }] }, env((u) => (u.endsWith('robots.txt') ? { ok: false, status: 404 } : { ok: false, status: 304, headers: hdr({}) }), seen));
  assert.strictEqual(r.notModified, true); assert.strictEqual(r.health, 'ONLINE'); assert.deepStrictEqual(r.fresh, []);
  const main = seen.find(([u]) => u === crawlSrc.portal_url); assert.strictEqual(main[1].headers['if-none-match'], '"abc"'); assert(main[1].headers['if-modified-since']);
});
t('crawler: stores validators and finds only NEW official links; off-domain links are rejected', async () => {
  calls.length = 0;
  const html = '<a href="/n1.pdf">Recruitment notification 1</a><a href="https://evil.com/n.pdf">Recruitment 2</a><a href="/old.pdf">Recruitment old</a>';
  const r = await C().crawlSource({ ...crawlSrc, last_links: [{ url: 'https://x.gov.in/old.pdf' }] }, env((u) => (u.endsWith('robots.txt') ? { ok: false, status: 404 } : { ok: true, status: 200, headers: hdr({ etag: '"v2"', 'last-modified': 'Thu, 02 Oct 2026 00:00:00 GMT' }), text: async () => html })));
  assert.deepStrictEqual(r.fresh.map((x) => x.url), ['https://x.gov.in/n1.pdf']); assert.strictEqual(r.rejected.length, 1);
  const rec = calls.find(([x]) => /UPDATE sources SET health/.test(x)); assert.strictEqual(rec[1][6], '"v2"');
});
t('crawler: follows a same-domain redirect (www) but refuses one that leaves the official domain', async () => {
  const seen = []; const ok = await C().crawlSource({ ...crawlSrc, official_domain: 'x.gov.in' }, env((u) => (u.endsWith('robots.txt') ? { ok: false, status: 404 } : u === 'https://x.gov.in/recruitment' ? { ok: false, status: 301, headers: hdr({ location: 'https://www.x.gov.in/recruitment' }) } : { ok: true, status: 200, headers: hdr({}), text: async () => '<a href="/z.pdf">Notification</a>' }), seen));
  assert.strictEqual(ok.health, 'ONLINE'); assert(seen.some(([u]) => u === 'https://www.x.gov.in/recruitment'));
  const bad = await C().crawlSource({ ...crawlSrc }, env((u) => (u.endsWith('robots.txt') ? { ok: false, status: 404 } : { ok: false, status: 302, headers: hdr({ location: 'https://evil.com/' }) })));
  assert.strictEqual(bad.health, 'TEMPORARILY_UNAVAILABLE');
});
t('crawler: a source in cool-down is skipped without any request', async () => {
  const seen = []; const r = await C().crawlSource({ ...crawlSrc, cooldown_until: new Date(Date.now() + 600000).toISOString() }, env(() => ({}), seen)); assert.strictEqual(r.cooldown, true); assert.strictEqual(seen.length, 0);
});
t('registry: health SQL counts failures, resets on success and sets a capped cool-down', () => { const s = fs.readFileSync('lib/registry.js', 'utf8'); assert(/consecutive_failures \+ 1 >= 5/.test(s) && /LEAST\(360/.test(s) && /last_checked_at = now\(\)/.test(s)); });

// ---------- broadcast ----------
const B = () => R('lib/broadcast.js');
const ev = { kind: 'DEADLINE_EXTENDED', title: 'Junior Assistant', organization: 'Demo Board', payload: { vacancies: 120, application_close: '2026-11-22', eligibility: { education: 'Graduate', age_min: 18, age_max: 30 }, document_url: 'https://x.gov.in/n.pdf', application_link: 'https://x.gov.in/apply', source_url: 'https://x.gov.in/', changes: [{ label: 'Application deadline', from: '15 Nov', to: '22 Nov', delta: 'extended by 7 days' }] } };
t('broadcast: message carries every required alert field and the honesty line; unknown facts say "not stated"', () => {
  const m = B().formatMessage(ev); for (const x of ['DEADLINE EXTENDED', 'Junior Assistant', 'Demo Board', 'Vacancies: 120', 'Graduate', 'Last date: 2026-11-22', 'extended by 7 days', 'https://x.gov.in/n.pdf', 'Apply (official)', 'Source page', 'confirm on the official']) assert(m.includes(x), x);
  const e = B().formatMessage({ kind: 'NEW_NOTIFICATION', title: 'T', payload: {} }); assert(e.includes('Vacancies: not stated') && e.includes('Last date: not stated'));
  assert(B().formatMessage({ kind: 'DETECTED_UNVERIFIED', title: 'T', payload: { verified: false } }).includes('Not yet verified'));
});
t('broadcast: providers exist only when their secrets are configured; Discord only accepts discord hosts; nothing is hard-coded', () => {
  assert.deepStrictEqual(Object.keys(B().buildProviders({})), []);
  assert.deepStrictEqual(Object.keys(B().buildProviders({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '2', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b', EMAIL_BROADCAST_TO: 'c@d' })).sort(), ['DISCORD', 'EMAIL', 'TELEGRAM']);
  assert.deepStrictEqual(Object.keys(B().buildProviders({ DISCORD_WEBHOOK_URL: 'https://evil.example/hook' })), []);
  assert(!/(bot\d+:[A-Za-z0-9_-]{20,}|hooks\.slack|AKIA)/.test(fs.readFileSync('lib/broadcast.js', 'utf8')));
});
t('broadcast: Telegram, Discord and e-mail providers call the right endpoint and require a returned message id', async () => {
  const sent = []; const fetch = async (u, o) => { sent.push([u, JSON.parse(o.body), o.headers]); return { ok: true, status: 200, json: async () => (u.includes('telegram') ? { ok: true, result: { message_id: 5 } } : { id: 'm1' }) }; };
  const p = B().buildProviders({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '-100', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.in', EMAIL_BROADCAST_TO: 'c@d.in, e@f.in' }, fetch);
  assert.strictEqual((await p.TELEGRAM(ev)).id, '5'); assert.strictEqual((await p.DISCORD(ev)).id, 'm1'); assert.strictEqual((await p.EMAIL(ev)).id, 'm1');
  assert(sent[0][0].startsWith('https://api.telegram.org/bot1:a/sendMessage') && sent[0][1].chat_id === '-100'); assert(sent[1][0].includes('wait=true') && sent[1][1].allowed_mentions.parse.length === 0);
  assert.deepStrictEqual(sent[2][1].to, ['c@d.in', 'e@f.in']); assert.strictEqual(sent[2][2].authorization, 'Bearer k');
  const bad = B().buildProviders({ TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '2' }, async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  assert.strictEqual((await bad.TELEGRAM(ev).catch((e) => e)).id, undefined);
});
t('broadcast: queue sends once, retries with back-off, fails after the limit, redacts bot tokens, and does nothing when unconfigured', async () => {
  const rows = [{ id: 1, channel: 'TELEGRAM', attempts: 0, event: ev }, { id: 2, channel: 'TELEGRAM', attempts: 3, event: ev }, { id: 3, channel: 'DISCORD', attempts: 0, event: ev }]; const fin = {};
  const store = { enqueue: async () => 3, claim: async () => rows, finish: async (id, p) => { fin[id] = p; } };
  const out = await B().processQueue(store, { TELEGRAM: async () => { throw new Error('boom bot123456:SECRETSECRET'); }, DISCORD: async () => ({ id: 'ok' }) }, { now: new Date('2026-10-10T00:00:00Z') });
  assert.deepStrictEqual([out.sent, out.retried, out.failed], [1, 1, 1]); assert.strictEqual(fin[1].status, 'QUEUED'); assert(fin[1].next_attempt_at > new Date('2026-10-10T00:00:00Z')); assert.strictEqual(fin[2].status, 'FAILED'); assert.strictEqual(fin[3].status, 'SENT'); assert(!/SECRETSECRET/.test(fin[1].last_error));
  let touched = false; const none = await B().processQueue({ enqueue: async () => { touched = true; }, claim: async () => { touched = true; return []; }, finish: async () => {} }, {}); assert.strictEqual(none.sent, 0); assert.strictEqual(touched, false);
});
t('broadcast: SQL is idempotent per (event, channel)', () => { const s = fs.readFileSync('lib/broadcast.js', 'utf8'), m = fs.readFileSync('db/migrations/009_autolive.sql', 'utf8'); assert(/ON CONFLICT \(feed_event_id,channel\) DO NOTHING/.test(s) && /UNIQUE \(feed_event_id, channel\)/.test(m) && /FOR UPDATE SKIP LOCKED/.test(s)); });

// ---------- scheduler ----------
const S = () => R('lib/scheduler.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkDeps = (over = {}) => { const ran = []; return { ran, d: { db: fakeDb, queue: { recoverStuck: async () => 0, enqueue: async (x) => { ran.push('enqueue:' + x); }, drain: async () => { ran.push('drain'); return []; } }, policy: { seedExtra: async () => {}, autoVerifyPending: async () => { ran.push('verify'); return {}; } }, alerts: { workerTick: async () => { ran.push('alerts'); return {}; } }, broadcast: { tick: async () => { ran.push('broadcast'); return {}; } }, handlers: {}, log: () => {}, intervals: { initialMs: 5, scheduleMs: 20, queueIdleMs: 20, alertsMs: 20, broadcastMs: 20, verifyMs: 1000 }, acquireLeader: async () => ({ release: async () => { ran.push('release'); } }), ...over } }; };
t('scheduler: the leader runs scheduling, verification, alerts and broadcast; the queue consumer runs too', async () => {
  const { ran, d } = mkDeps(); const s = S().create(d); s.start(); await sleep(250); await s.stop();
  for (const x of ['enqueue:SCHEDULE_CRAWLS', 'enqueue:ADVANCE_LIFECYCLE', 'verify', 'alerts', 'broadcast', 'drain', 'release']) assert(ran.includes(x), x);
});
t('scheduler: a standby instance (no advisory lock) never schedules but still consumes the queue', async () => {
  const { ran, d } = mkDeps({ acquireLeader: async () => null }); const s = S().create(d); s.start(); await sleep(250); await s.stop();
  assert(ran.includes('drain')); for (const x of ['enqueue:SCHEDULE_CRAWLS', 'verify', 'alerts', 'broadcast']) assert(!ran.includes(x), x);
});
t('scheduler: one failing task does not stop the others, and a slow task never overlaps itself', async () => {
  let concurrent = 0, maxC = 0; const { ran, d } = mkDeps(); d.alerts = { workerTick: async () => { throw new Error('smtp down'); } };
  d.broadcast = { tick: async () => { concurrent++; maxC = Math.max(maxC, concurrent); await sleep(70); concurrent--; ran.push('broadcast'); return {}; } };
  const s = S().create(d); s.start(); await sleep(300); await s.stop();
  assert(ran.includes('broadcast') && ran.includes('drain')); assert.strictEqual(maxC, 1); assert.strictEqual(s.state.tasks.alerts.ok, false);
});
t('scheduler: stop() halts every timer', async () => { const { ran, d } = mkDeps(); const s = S().create(d); s.start(); await sleep(120); await s.stop(); const n = ran.length; await sleep(150); assert.strictEqual(ran.length, n); });
t('scheduler: intervals are configurable from the environment and fall back safely', () => { const i = S().intervals({ SCHEDULE_TICK_SECONDS: '15', BROADCAST_TICK_SECONDS: 'abc' }); assert.strictEqual(i.scheduleMs, 15000); assert.strictEqual(i.broadcastMs, 30000); });
t('queue scheduling skips cooling-down sources and sources already queued (no overlapping crawls)', () => { const s = fs.readFileSync('lib/ingest.js', 'utf8'); assert(/cooldown_until IS NULL OR cooldown_until < now\(\)/.test(s) && /NOT EXISTS \(SELECT 1 FROM job_queue q WHERE q.type='CRAWL_SOURCE'/.test(s)); });

// ---------- feed, detector, wiring ----------
t('demo detector: first look is only a baseline; links that appear later are "detected, not verified"; repeats are not re-announced', () => {
  const D = R('lib/detected.js'); D.reset(); const chk = (links) => [{ source_id: 'u', name: 'UPSC', status: 'ONLINE', links }];
  assert.strictEqual(D.observe(chk([{ title: 'Old', url: 'https://upsc.gov.in/old' }])).length, 0);
  const f = D.observe(chk([{ title: 'Old', url: 'https://upsc.gov.in/old' }, { title: 'Recruitment 2026', url: 'https://upsc.gov.in/new' }])); assert.strictEqual(f.length, 1); assert.strictEqual(f[0].payload.verified, false);
  assert.strictEqual(D.observe(chk([{ title: 'Recruitment 2026', url: 'https://upsc.gov.in/new' }])).length, 0); assert.strictEqual(D.observe([{ source_id: 'u', status: 'TIMEOUT', links: [] }]).length, 0);
});
t('feed: kinds map to realtime event names; status reports freshness honestly', async () => {
  const F = R('lib/feed.js'); assert.strictEqual(F.KIND_EVENT.NEW_NOTIFICATION, 'job.new'); assert.strictEqual(F.KIND_EVENT.DEADLINE_EXTENDED, 'deadline.extended');
  const seq = [{ rows: [{ monitored: 5, online: 4, pending_verification: 2, cooling_down: 0, last_success_at: '2026-10-10T05:00:00Z', last_checked_at: '2026-10-10T05:01:00Z', interval_minutes: 30 }] }, { rows: [] }, { rows: [{ status: 'PENDING', n: 3 }] }, { rows: [{ kind: 'NEW_NOTIFICATION', n: 2 }] }, { rows: [{ n: 2 }] }, { rows: [{ n: 4 }] }];
  const st = await F.status({ query: async () => seq.shift() }, { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' });
  assert.strictEqual(st.freshness.interval_minutes, 30); assert(/not instant/i.test(st.freshness.note)); assert.deepStrictEqual(st.broadcast_channels, ['TELEGRAM']); assert(!JSON.stringify(st).includes('"t"'));
});
t('server: feed + status routes, SSE feed polling, inline scheduler and the campus redirect are wired', () => {
  const s = fs.readFileSync('server.js', 'utf8');
  for (const x of ["app.get('/api/feed'", "app.get('/api/autolive/status'", 'pollFeed', 'startInlineWorker()', "res.redirect(302, '/campus/')", "req.query.embed !== 'campus'", "RUN_WORKER_INLINE === '0'"]) assert(s.includes(x), x);
  const rt = fs.readFileSync('lib/realtime.js', 'utf8'); assert(rt.includes('pollFeed') && rt.includes("publish('jobs.changed', { reason: 'feed'"));
  assert(fs.readFileSync('routes/admin.js', 'utf8').includes('/auto-published/:id/retract'));
});
t('worker and scheduler: leader lock, graceful shutdown, and no secrets', () => { const w = fs.readFileSync('worker.js', 'utf8'), s = fs.readFileSync('lib/scheduler.js', 'utf8'); assert(w.includes('SIGTERM') && s.includes('pg_try_advisory_lock')); });
t('campus: the GovCareer AI sub-tab is gone; Roadmaps & Govt Jobs tab definitions are unchanged', () => {
  const rt = fs.readFileSync('campus/frontend/app-runtime.js', 'utf8'), idx = fs.readFileSync('campus/frontend/index.html', 'utf8');
  for (const x of ['GovCareerAiPanel', "setCtSector('govcareer')", 'gc-unread', "'govcareer:unread'", '__openGovCareer']) assert(!rt.includes(x), 'still present: ' + x);
  assert(!idx.includes('govcareer-live.js'));
  assert.strictEqual((rt.match(/\{ id: 'careerTracks', label: '1000\+ Roadmaps & Govt Jobs'/g) || []).length, 2, 'same two tab definitions as v2.8.1');
  assert(rt.includes("setCtSector('government')") && rt.includes("setCtSector('private')"), 'Govt Jobs and Roadmaps sub-tabs must remain');
});
t('UI: the feed section is in the Overview, loaded and cached, and shows verification state per item', () => {
  const html = fs.readFileSync('public/index.html', 'utf8'), sw = fs.readFileSync('public/sw.js', 'utf8'), js = fs.readFileSync('public/autolive.js', 'utf8');
  assert(html.includes('autolive.js') && html.includes('autolive.css') && sw.includes('/autolive.js')); assert(js.includes('not yet verified') && js.includes('not instant detection') && js.includes("rel=\"noopener noreferrer\""));
  assert(!/sample|lorem|demo job/i.test(js));
});
t('migration 009 is additive (no DROP TABLE / DELETE)', () => { const m = fs.readFileSync('db/migrations/009_autolive.sql', 'utf8'); assert(!/DROP TABLE|DELETE FROM|TRUNCATE/i.test(m)); assert(/feed_events/.test(m) && /broadcast_log/.test(m)); });

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e && e.message); } } console.log(`\nAutomatic lane: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
