'use strict';
// v2.9.1: GovCareer database -> Hybrid RAG record sync. No network, no database: the db and the transport are stubs.
const assert = require('assert');
const hr = require('./lib/hybridRecords');

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  ok -', name); };

const source = { source_id: 's1', organization: 'Test Board', official_domain: 'testboard.gov.in', portal_url: 'https://www.testboard.gov.in/', source_type: 'OFFICIAL_PORTAL',
  verification_status: 'VERIFIED', auto_verified: false, last_success_at: new Date('2026-10-09T10:00:00Z'), last_failure_at: null, last_error: null };
const row = (o = {}) => ({ id: 'r-1', source_id: 's1', title: 'Junior Clerk', organization: 'Test Board', lifecycle: 'PUBLISHED', is_sample: false,
  published_at: new Date('2026-09-20T05:00:00Z'), verification: { level: 'HUMAN_REVIEWED' },
  data: { title: 'Junior Clerk', organization: 'Test Board', state: 'All India', dates: { application_open: '2026-09-21T10:00:00+05:30', application_close: '2026-10-31T23:59:00+05:30' } }, ...o });
const docs = [{ id: 1, title: 'Notice.pdf', kind: 'ORIGINAL', url: 'https://www.testboard.gov.in/n.pdf', issued_on: '2026-09-20' },
  { id: 2, title: 'Corrigendum.pdf', kind: 'CORRIGENDUM', url: 'https://www.testboard.gov.in/c.pdf', issued_on: '2026-10-01' }];
const pagesByDoc = new Map([[1, [{ page_number: 1, text: 'Eligibility: Graduate with minimum 60% marks.' }]], [2, [{ page_number: 1, text: 'Last date extended.' }]]]);
const ctx = (o = {}) => ({ source, docs, pagesByDoc, ...o });

(async () => {
  console.log('hybridRecords');
  await t('maps a published, official recruitment with real notice text and the source\'s own verification time', () => {
    const { payload, skip } = hr.toRecord(row(), ctx());
    assert.ok(!skip, skip);
    assert.strictEqual(payload.record_id, 'gc:r-1');
    assert.strictEqual(payload.authority, 'official');
    assert.strictEqual(payload.last_verified_at, '2026-10-09T10:00:00.000Z');       // the crawl time, not "now"
    assert.strictEqual(payload.source_status, 'reachable');
    assert.strictEqual(payload.opens_at, '2026-09-21');
    assert.strictEqual(payload.deadline, '2026-10-31');
    assert.strictEqual(payload.extraction_status, 'reviewed');
    assert.ok(payload.text.includes('Graduate with minimum 60% marks') && payload.text.includes('CORRIGENDUM'));
    assert.strictEqual(payload.url, 'https://www.testboard.gov.in/n.pdf');
  });
  await t('never sends sample / demo records', () => {
    assert.strictEqual(hr.toRecord(row({ is_sample: true }), ctx()).skip, 'sample_record');
    assert.strictEqual(hr.toRecord(row({ data: { ...row().data, sample: true } }), ctx()).skip, 'sample_record');
  });
  await t('skips records with no stored notice text instead of fabricating one', () => {
    assert.strictEqual(hr.toRecord(row(), ctx({ pagesByDoc: new Map() })).skip, 'no_notice_text');
  });
  await t('skips lifecycle states that are not publishable', () => {
    assert.match(hr.toRecord(row({ lifecycle: 'REVIEW_REQUIRED' }), ctx()).skip, /lifecycle_review_required/);
  });
  await t('official claim needs a verified official source AND a document on its own domain', () => {
    const offDomain = [{ ...docs[0], url: 'https://mirror.example.com/n.pdf' }];
    assert.strictEqual(hr.toRecord(row(), ctx({ docs: offDomain })).payload.authority, 'verified');
    assert.strictEqual(hr.toRecord(row(), ctx({ source: { ...source, verification_status: 'PENDING_VERIFICATION' } })).payload.authority, 'third_party');
    assert.strictEqual(hr.toRecord(row(), ctx({ source: null })).payload.authority, 'verified');       // human reviewed, no source row
    assert.strictEqual(hr.toRecord(row({ verification: { level: 'AUTO_EXTRACTED' } }), ctx({ source: null })).payload.authority, 'third_party');
  });
  await t('auto-extracted records stay auto_extracted (eligibility can then only be provisional)', () => {
    assert.strictEqual(hr.toRecord(row({ verification: { level: 'AUTO_EXTRACTED', awaiting_human_audit: true } }), ctx()).payload.extraction_status, 'auto_extracted');
  });
  await t('an unreachable source keeps the last successful time and is reported as unreachable', () => {
    const s = { ...source, last_failure_at: new Date('2026-10-10T10:00:00Z'), last_error: 'timeout' };
    const { payload } = hr.toRecord(row(), ctx({ source: s }));
    assert.strictEqual(payload.source_status, 'unreachable');
    assert.strictEqual(payload.last_verified_at, '2026-10-09T10:00:00.000Z');
    assert.strictEqual(payload.source_error, 'timeout');
  });
  await t('a source that was never crawled has no verification time', () => {
    const { payload } = hr.toRecord(row(), ctx({ source: { ...source, last_success_at: null } }));
    assert.strictEqual(payload.last_verified_at, null);
    assert.strictEqual(payload.source_status, 'never_checked');
  });
  await t('missing dates / advertisement number are omitted, not invented', () => {
    const { payload } = hr.toRecord(row({ data: { title: 'Junior Clerk', organization: 'Test Board', dates: {} } }), ctx());
    assert.strictEqual(payload.deadline, null);
    assert.strictEqual('advt_no' in payload, false);
    const withNo = hr.toRecord(row({ data: { ...row().data, advt_no: 'Advt. 03/2026' } }), ctx()).payload;
    assert.strictEqual(withNo.advt_no, 'Advt. 03/2026');
  });
  await t('record ids are made safe for the AI service id rules', () => {
    const { payload } = hr.toRecord(row({ id: 'a b/c?d' }), ctx());
    assert.match(payload.record_id, /^[A-Za-z0-9_.:\-]{1,80}$/);
  });

  // sync() with a stub db + transport
  const fakeDb = (rows) => ({ async query(sql, params) {
    if (/FROM recruitments/.test(sql)) return { rows };
    if (/FROM sources/.test(sql)) return { rows: [source] };
    if (/FROM documents/.test(sql)) return { rows: docs };
    if (/FROM document_pages/.test(sql)) return { rows: pagesByDoc.get(params[0]) || [] };
    throw new Error('unexpected sql ' + sql);
  } });
  await t('sync pushes publishable rows, removes archived ones, skips the rest and reports honestly', async () => {
    const calls = [];
    const push = async (path, body, method) => { calls.push({ path, method, body }); return { status: method === 'DELETE' ? 200 : 200, body: {} }; };
    const out = await hr.sync({ db: fakeDb([row(), row({ id: 'r-2', lifecycle: 'ARCHIVED' }), row({ id: 'r-3', lifecycle: 'REVIEW_REQUIRED' })]), push });
    assert.strictEqual(out.ok, true); assert.strictEqual(out.pushed, 1); assert.strictEqual(out.removed, 1);
    assert.strictEqual(out.skipped.lifecycle_review_required, 1);
    assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /rag/hybrid/records', 'DELETE /rag/hybrid/records/gc%3Ar-2']);
  });
  await t('sync reports failures per record and never claims success', async () => {
    const push = async () => ({ status: 422, body: { detail: { code: 'INVALID_RECORD' } } });
    const out = await hr.sync({ db: fakeDb([row()]), push });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.pushed, 0);
    assert.deepStrictEqual(out.failed, [{ id: 'r-1', status: 422, code: 'INVALID_RECORD' }]);
  });
  await t('sync without AI service configuration returns a structured error and sends nothing', async () => {
    const out = await hr.sync({ db: fakeDb([row()]), env: {} });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.code, 'AI_SERVICE_NOT_CONFIGURED'); assert.strictEqual(out.pushed, 0);
  });
  await t('a database read failure is reported, not thrown', async () => {
    const out = await hr.sync({ db: { query: async () => { throw new Error('db down'); } }, push: async () => ({ status: 200, body: {} }) });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.code, 'DB_READ_FAILED');
  });
  await t('scheduler hybrid sync is off by default and on only when HYBRID_RAG_SYNC_MINUTES > 0', () => {
    const sch = require('./lib/scheduler');
    assert.strictEqual(sch.intervals({}).hybridSyncMs, 0);
    assert.strictEqual(sch.intervals({ HYBRID_RAG_SYNC_MINUTES: '15' }).hybridSyncMs, 15 * 60 * 1000);
  });
  await t('scheduler: recovery check runs only when sync is on', () => {
    const sch = require('./lib/scheduler');
    assert.strictEqual(sch.intervals({}).hybridRecoverMs, 0);
    assert.strictEqual(sch.intervals({ HYBRID_RAG_SYNC_MINUTES: '30' }).hybridRecoverMs, 120000);
    assert.strictEqual(sch.intervals({ HYBRID_RAG_SYNC_MINUTES: '30', HYBRID_RAG_RECOVER_SECONDS: '60' }).hybridRecoverMs, 60000);
  });
  await t('syncIfEmpty: an index that restarted empty is re-synced at once', async () => {
    const pushed = [];
    const out = await hr.syncIfEmpty({ db: fakeDb([row()]), get: async () => ({ status: 200, body: { records: 0, needs_sync: true } }),
      push: async (p, b) => { pushed.push(p); return { status: 200, body: {} }; } });
    assert.strictEqual(out.recovered, true); assert.strictEqual(out.pushed, 1); assert.ok(pushed.length >= 1);
  });
  await t('syncIfEmpty: a populated index is left alone (one GET, no pushes)', async () => {
    let pushes = 0;
    const out = await hr.syncIfEmpty({ db: fakeDb([row()]), get: async () => ({ status: 200, body: { records: 7, needs_sync: false } }),
      push: async () => { pushes++; return { status: 200, body: {} }; } });
    assert.strictEqual(out.skipped, 'index_not_empty'); assert.strictEqual(pushes, 0);
  });
  await t('syncIfEmpty: an unreachable AI service is reported, never thrown, and nothing is pushed', async () => {
    let pushes = 0;
    const out = await hr.syncIfEmpty({ db: fakeDb([row()]), get: async () => ({ status: 0, body: { code: 'AI_SERVICE_UNAVAILABLE' } }),
      push: async () => { pushes++; return { status: 200, body: {} }; } });
    assert.strictEqual(out.ok, false); assert.strictEqual(out.skipped, 'ai_service_unreachable'); assert.strictEqual(pushes, 0);
  });
  await t('health: not configured is a structured result', async () => {
    const h = await hr.health({ env: {} });
    assert.strictEqual(h.ok, false); assert.strictEqual(h.code, 'AI_SERVICE_NOT_CONFIGURED');
  });
  await t('admin route is ADMIN-only and audited', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'routes/admin.js'), 'utf8');
    assert.match(src, /router\.post\('\/hybrid-rag\/sync', auth\.requireRole\('ADMIN'\)/);
    assert.match(src, /'HYBRID_RAG_SYNC'/);
  });
  await t('contract: every field the mapper sends is declared by the AI service RecordPayload model, and the shared fixture matches', () => {
    const fs = require('fs'), path = require('path');
    const py = fs.readFileSync(path.join(__dirname, 'campus/ai-ml-service/app/routers/hybrid_rag.py'), 'utf8');
    const model = py.slice(py.indexOf('class RecordPayload'), py.indexOf('@router.post("/records")'));
    const declared = new Set([...model.matchAll(/^    (\w+):/gm)].map((m) => m[1]));
    const { payload } = hr.toRecord(row(), ctx());
    for (const k of Object.keys(payload)) assert.ok(declared.has(k), `mapper sends "${k}" but RecordPayload does not declare it`);
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'campus/ai-ml-service/tests/eval/node_record_payload.json'), 'utf8'));
    for (const k of Object.keys(fixture)) assert.ok(declared.has(k), `fixture field "${k}" not declared`);
    assert.match(fixture.record_id, /^gc:/);
  });
  console.log(`hybridRecords: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
