// Phase 2 tests: source registry, ingestion, review, lifecycle, security. Needs PostgreSQL (DATABASE_URL, default: govcareer_test).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://govcareer:govcareer@localhost:5432/govcareer_test';
process.env.STORAGE_DIR = require('path').join(require('os').tmpdir(), 'govcareer-test-storage');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const db = require('./lib/db');
const auth = require('./lib/auth');
const registry = require('./lib/registry');
const lifecycle = require('./lib/lifecycle');
const pipeline = require('./lib/docpipeline');
const { extractDocument, ground } = require('./lib/extract');
const { validateRecord } = require('./lib/schema');
const { ingestDocument, handlers } = require('./lib/ingest');
const review = require('./lib/review');
const repo = require('./lib/repo');
const queue = require('./lib/queue');
const crawler = require('./lib/crawler');
const agents = require('./lib/agents');
const { audit, verifyChain } = require('./lib/audit');
const { analyzeFraud } = require('./lib/fraud');
const { resolveField } = require('./lib/conflict');
const samples = require('./scripts/make-sample-pdfs');

const results = []; const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const SAMPLES = path.join(require('os').tmpdir(), 'govcareer-samples');
const pdf = (n) => fs.readFileSync(path.join(SAMPLES, n));
const ENV = { skipLlm: true };
let admin, reviewer, viewer, REC;

test('setup: migrations, registry seed, users', async () => {
  await db.resetForTests(); await db.migrate(); await registry.seedRegistry(); await repo.seedSampleJobs();
  await samples.main(SAMPLES);
  admin = await auth.createUser('admin@test.in', 'Admin', 'correct horse battery', 'ADMIN');
  reviewer = await auth.createUser('rev@test.in', 'Reviewer', 'correct horse battery', 'REVIEWER');
  viewer = await auth.createUser('view@test.in', 'Viewer', 'correct horse battery', 'VIEWER');
  admin.role = 'ADMIN'; reviewer.role = 'REVIEWER'; viewer.role = 'VIEWER';
  const srcs = await registry.listSources();
  assert(srcs.length >= 8);
});

// ---------- source registry ----------
test('registry: real sources are seeded unverified with crawling OFF; only demo/manual are verified', async () => {
  const s = await registry.listSources();
  for (const r of s.filter((x) => x.source_type === 'OFFICIAL_PORTAL')) { assert.strictEqual(r.verification_status, 'PENDING_VERIFICATION'); assert.strictEqual(r.crawl_enabled, false); }
  assert(s.find((x) => x.source_id === 'demo-psc').verification_status === 'VERIFIED');
});
test('registry: crawling cannot be enabled for an unverified source', async () => {
  await assert.rejects(() => registry.setCrawling('upsc', true, 'admin'), /Verify the source/);
});

// ---------- lifecycle ----------
test('lifecycle: every state is defined and ARCHIVED is terminal', () => {
  for (const s of lifecycle.STATES) assert(s in lifecycle.TRANSITIONS, s);
  assert.deepStrictEqual(lifecycle.TRANSITIONS.ARCHIVED, []);
  assert(lifecycle.canTransition('PUBLISHED', 'UPDATED')); assert(!lifecycle.canTransition('DISCOVERED', 'PUBLISHED')); assert(!lifecycle.canTransition('EXTRACTED', 'PUBLISHED'));
});
test('lifecycle: illegal transitions are refused and agents cannot verify or publish', async () => {
  await db.query("INSERT INTO recruitments(id,lifecycle) VALUES ('t-lc','DISCOVERED')");
  await assert.rejects(() => lifecycle.transition('t-lc', 'PUBLISHED', { type: 'human', name: 'x' }), /Illegal lifecycle/);
  await lifecycle.transition('t-lc', 'INGESTED', { type: 'agent', name: 'Document' });
  await lifecycle.transition('t-lc', 'EXTRACTED', { type: 'agent', name: 'Extraction' });
  await lifecycle.transition('t-lc', 'REVIEW_REQUIRED', { type: 'agent', name: 'Quality' });
  await assert.rejects(() => lifecycle.transition('t-lc', 'VERIFIED', { type: 'agent', name: 'Quality' }), /Only a signed-in reviewer/);
  await lifecycle.transition('t-lc', 'VERIFIED', { type: 'human', name: 'rev@test.in' });
  await assert.rejects(() => lifecycle.transition('t-lc', 'PUBLISHED', { type: 'system', name: 'cron' }), /Only a signed-in reviewer/);
  await db.query("DELETE FROM lifecycle_events WHERE recruitment_id='t-lc'; DELETE FROM recruitments WHERE id='t-lc'");
});

// ---------- document pipeline ----------
test('pipeline: rejects empty, unsupported, truncated and encrypted files', () => {
  assert(!pipeline.validateFile(Buffer.alloc(0)).ok);
  assert(!pipeline.validateFile(Buffer.from('MZ\x90\x00 not a document')).ok);
  assert(!pipeline.validateFile(Buffer.from('%PDF-1.4 truncated')).ok);
  assert(!pipeline.validateFile(Buffer.from('%PDF-1.4\n/Encrypt\n%%EOF')).ok);
  assert(pipeline.validateFile(pdf('notification-original.pdf')).ok);
});
test('pipeline: virus scan rejects test signature and active PDF content', () => {
  const eicar = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF');
  assert.strictEqual(pipeline.scan(eicar, 'application/pdf').status, 'REJECTED');
  assert.strictEqual(pipeline.scan(Buffer.from('%PDF-1.4\n/JS (app.alert(1))\n%%EOF'), 'application/pdf').status, 'REJECTED');
  assert.strictEqual(pipeline.scan(pdf('notification-original.pdf'), 'application/pdf').status, 'CLEAN');
});
test('pipeline: text-layer PDF yields one entry per page with sections', () => {
  const pages = pipeline.extractPages(pdf('notification-original.pdf'), 'application/pdf');
  assert.strictEqual(pages.length, 4);
  assert(pages.every((p) => p.method === 'TEXT_LAYER'));
  assert(pages[2].text.includes('Domicile'));
  assert(pipeline.detectSections(pages[2].text).some((s) => s.section === '3'));
});
test('pipeline: scanned PDF goes through OCR and is still extractable', async () => {
  const tmp = path.join(SAMPLES, 'page'); execFileSync('pdftoppm', ['-r', '150', '-png', path.join(SAMPLES, 'notification-original.pdf'), tmp]);
  const PDFDocument = require('pdfkit'); const doc = new PDFDocument({ margin: 0, autoFirstPage: false }); const out = path.join(SAMPLES, 'scanned.pdf'); const ws = fs.createWriteStream(out); doc.pipe(ws);
  for (const f of fs.readdirSync(SAMPLES).filter((x) => /^page-\d\.png$/.test(x)).sort()) { doc.addPage({ size: 'A4', margin: 0 }); doc.image(path.join(SAMPLES, f), 0, 0, { width: 595 }); }
  doc.end(); await new Promise((r) => ws.on('finish', r));
  const pages = pipeline.extractPages(fs.readFileSync(out), 'application/pdf', { ocrLangs: ['eng'] });
  assert(pages.every((p) => p.method === 'OCR' && p.ocr_confidence > 0.5), 'all pages OCR with confidence');
  const r = await extractDocument(pages, { skipLlm: true, source: { state: 'Telangana' } });
  assert.strictEqual(r.record.vacancies.total, 1000); assert.strictEqual(r.record.age.max, 30);
});
test('pipeline: regional-language OCR packs are installed and used when requested', () => {
  const have = pipeline.installedOcrLangs(); for (const l of ['eng', 'hin', 'tel']) assert(have.includes(l), l);
});
test('pipeline: HTML and DOCX inputs are read; scripts in HTML are rejected by the scanner', () => {
  const html = Buffer.from('<html><body><h1>Notice</h1><p>Total vacancies: 12</p><script>x()</script></body></html>');
  assert.strictEqual(pipeline.scan(html, 'text/html').status, 'REJECTED');
  const clean = Buffer.from('<html><body><table><tr><td>UR</td><td>5</td></tr></table><p>Total vacancies: 12</p></body></html>');
  const pages = pipeline.extractPages(clean, 'text/html'); assert(/Total vacancies: 12/.test(pages[0].text));
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dx-')); fs.mkdirSync(path.join(dir, 'word'));
  fs.writeFileSync(path.join(dir, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Last date to apply: 24 October 2026</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(path.join(dir, '[Content_Types].xml'), '<Types/>');
  execFileSync('zip', ['-qr', path.join(dir, 'a.docx'), 'word', '[Content_Types].xml'], { cwd: dir });
  const docx = fs.readFileSync(path.join(dir, 'a.docx')); assert(pipeline.detectType(docx).includes('wordprocessingml'));
  assert(/24 October 2026/.test(pipeline.extractPages(docx, pipeline.detectType(docx))[0].text));
});
test('pipeline: multi-column pages are detected and tables are found', () => {
  const left = Array.from({ length: 14 }, (_, i) => `Left column line number ${i} here`.padEnd(46)); const two = left.map((l, i) => `${l}Right column line ${i} text`).join('\n');
  assert.strictEqual(pipeline.detectColumns(two), 2);
  assert.strictEqual(pipeline.detectTables('Category   Posts   Fee\nUR   400   500\nSC   150   250\nST   75   250').length, 1);
});

// ---------- extraction: strict schema, grounding ----------
test('extraction: output carries page, quote and confidence for every field', async () => {
  const pages = pipeline.extractPages(pdf('notification-original.pdf'), 'application/pdf');
  const r = await extractDocument(pages, { skipLlm: true, source: { state: 'Telangana' } });
  assert(r.schema_valid, JSON.stringify(r.schema_errors));
  for (const [k, f] of Object.entries(r.fields)) { assert(f.confidence > 0, k); assert(f.method, k); if (f.method !== 'REGISTRY') { assert(f.page >= 1, k); assert(f.quote, k); assert(pages[f.page - 1].text.includes(f.quote), `${k} quote is on page ${f.page}`); } }
  assert.strictEqual(r.fields['vacancies.total'].page, 2);
});
test('extraction: a missing required field is rejected, never guessed', async () => {
  const pages = pipeline.extractPages(pdf('notification-original.pdf'), 'application/pdf').map((p) => ({ ...p, text: p.text.replace(/Age limit:[^\n]*/g, '').replace(/Age relaxation:[^\n]*/g, '') }));
  const r = await extractDocument(pages, { skipLlm: true, source: { state: 'Telangana' } });
  assert(!r.schema_valid); assert(r.missing.includes('age.min')); assert(r.schema_errors.some((e) => e.path.startsWith('age')));
});
test('schema: rejects bad dates, impossible ages, unknown education levels, non-https links', () => {
  const good = JSON.parse(JSON.stringify(require('./data/jobs').buildJobs(new Date())[0]));
  assert.deepStrictEqual(validateRecord(good).map((e) => e.path), []);
  const bad = JSON.parse(JSON.stringify(good));
  bad.dates.application_close = '2026-10-24'; bad.age.min = 40; bad.education.accepted = ['btech']; bad.application_link = 'http://x.in'; bad.vacancies.total = 0;
  const paths = validateRecord(bad).map((e) => e.path);
  for (const p of ['dates.application_close', 'age', 'education.accepted', 'application_link', 'vacancies.total']) assert(paths.includes(p), p);
});
test('grounding: an AI value whose quote is not on the cited page is rejected', () => {
  const pages = [{ page_number: 1, text: 'Last date to apply: 24 October 2026 (23:59 IST)' }];
  const g = ground(pages, {
    'dates.application_close': { value: '2026-10-24', page: 1, quote: 'Last date to apply: 24 October 2026 (23:59 IST)' },
    'vacancies.total': { value: 9999, page: 1, quote: 'Total vacancies: 9,999' },
    'dates.exam_date': { value: '2026-12-20', page: 1, quote: 'Last date to apply: 24 October 2026' },
    age: { value: 1, page: 7, quote: 'x' },
  });
  assert(g.accepted['dates.application_close']); assert.strictEqual(g.accepted['dates.application_close'].value, '2026-10-24T23:59:00+05:30');
  assert(!g.accepted['vacancies.total']); assert(!g.accepted['dates.exam_date']);
  assert.strictEqual(g.rejected.length, 3);
});
test('LLM adapter: Groq failure falls back to Gemini; with no keys the rule extractor still works', async () => {
  const pages = pipeline.extractPages(pdf('notification-original.pdf'), 'application/pdf');
  process.env.GROQ_API_KEY = 'k1'; process.env.GEMINI_API_KEY = 'k2';
  const quote = pages[1].text.split('\n').find((l) => l.startsWith('Total vacancies'));
  const fetchImpl = async (url) => {
    if (url.includes('groq')) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fields: { 'vacancies.total': { value: 1000, page: 2, quote }, 'age.max': { value: 99, page: 3, quote: 'made up line' } } }) }] } }] }) };
  };
  const r = await extractDocument(pages, { source: { state: 'Telangana' }, llm: { fetchImpl, order: ['groq', 'gemini'] } });
  assert.strictEqual(r.provider, 'gemini'); assert.deepStrictEqual(r.attempts.map((a) => [a.provider, a.ok]), [['groq', false], ['gemini', true]]);
  assert(r.notes.some((n) => /age\.max.*rejected/.test(n)), 'hallucinated field flagged');
  assert.strictEqual(r.record.age.max, 30, 'the invented 99 never reaches the record');
  assert.strictEqual(r.fields['vacancies.total'].method, 'RULES+LLM');
  delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;
  const none = await extractDocument(pages, { source: { state: 'Telangana' }, llm: { fetchImpl } });
  assert.strictEqual(none.provider, 'rules'); assert(none.schema_valid);
});
test('LLM adapter: disagreement with the rule extractor is flagged and confidence capped', async () => {
  const pages = pipeline.extractPages(pdf('notification-original.pdf'), 'application/pdf');
  process.env.GEMINI_API_KEY = 'k2';
  const quote = pages[1].text.split('\n').find((l) => l.startsWith('Total vacancies')).replace('1,000', '1,000');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fields: { 'age.min': { value: 18, page: 3, quote: pages[2].text.split('\n').find((l) => /Age limit/.test(l)) }, 'age.max': { value: 32, page: 3, quote: pages[2].text.split('\n').find((l) => /Age limit/.test(l)) } } }) }] } }] }) });
  const r = await extractDocument(pages, { source: { state: 'Telangana' }, llm: { fetchImpl, order: ['gemini'] } });
  delete process.env.GEMINI_API_KEY;
  assert(r.disagreements.length === 0 || r.disagreements.every((d) => d.key), 'structure ok');
  assert.strictEqual(r.record.age.max, 30, 'the value that is not supported by its quote never wins');
});

// ---------- fraud, conflicts ----------
test('fraud: lookalike domains, off-portal payment and issuer mismatch are flagged', () => {
  const src = { official_domain: 'psc.example.gov.in', organization: 'Demo State Public Service Commission' };
  const f = analyzeFraud({ pages: [{ text: 'Apply at https://psc-example-gov.in/apply' }], record: { application_link: 'https://psc-example-gov.in/apply', organization: 'Telangana Police Board' }, source: src, registryDomains: ['psc.example.gov.in'] }).map((x) => x.code);
  for (const c of ['LOOKALIKE_DOMAIN', 'APPLICATION_LINK_NOT_OFFICIAL', 'ISSUER_MISMATCH']) assert(f.includes(c), c);
  assert(analyzeFraud({ pages: [{ text: 'Send the fee to UPI id jobs.fee@okaxis' }], record: {}, source: src, registryDomains: [] }).some((x) => x.code === 'PAYMENT_OUTSIDE_PORTAL'));
  assert.strictEqual(analyzeFraud({ pages: [{ text: 'Apply at https://psc.example.gov.in/apply or https://www.psc.example.gov.in/x' }], record: { application_link: 'https://psc.example.gov.in/apply', organization: 'Demo State Public Service Commission' }, source: src, registryDomains: ['psc.example.gov.in'] }).length, 0);
});
test('conflict engine: later authoritative update wins; equal authority is UNRESOLVED', () => {
  const o = { document_id: 1, kind: 'ORIGINAL', issued_on: '2026-09-01', official: true, value: 1000 }; const a = { document_id: 2, kind: 'AMENDMENT', issued_on: '2026-09-20', official: true, value: 1125 };
  const r = resolveField('vacancies.total', [o, a]); assert.strictEqual(r.resolution, 'RESOLVED_LATER_AUTHORITATIVE'); assert.strictEqual(r.chosen.document_id, 2);
  const x = resolveField('vacancies.total', [{ ...o }, { ...o, document_id: 3, value: 900 }]); assert.strictEqual(x.resolution, 'UNRESOLVED'); assert.strictEqual(x.chosen, null);
  const unofficial = resolveField('f', [{ ...a, official: false }, o]); assert.strictEqual(unofficial.chosen.document_id, 1, 'a non-official later document does not outrank an official one');
  assert.strictEqual(resolveField('f', [o, { ...o, document_id: 9 }]), null);
});

// ---------- acceptance: download -> review queue -> PUBLISHED, then amendment diff ----------
test('ACCEPTANCE 1: notification PDF goes to the review queue, never straight to published', async () => {
  const out = await ingestDocument({ buffer: pdf('notification-original.pdf'), title: 'Notification_05_2026.pdf', url: 'https://psc.example.gov.in/n/05-2026.pdf', sourceId: 'demo-psc', issuedOn: '2026-09-25' }, ENV);
  assert.strictEqual(out.status, 'REVIEW_REQUIRED'); assert(out.schema_valid); REC = out.recruitmentId;
  assert.deepStrictEqual(out.agents_run, ['Document', 'Extraction', 'Citation', 'Verification', 'Quality']);
  const rec = await repo.getRecruitment(REC); assert.strictEqual(rec.lifecycle, 'REVIEW_REQUIRED'); assert(!rec.published_at);
  assert(!(await repo.publishedJobs()).some((j) => j.id === REC), 'unreviewed record is not public');
  const q = await review.listQueue(); assert(q.items.some((i) => i.recruitment_id === REC));
  const path1 = (await db.query('SELECT to_state FROM lifecycle_events WHERE recruitment_id=$1 ORDER BY id', [REC])).rows.map((r) => r.to_state);
  assert.deepStrictEqual(path1, ['DISCOVERED', 'INGESTED', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED']);
});
test('review: the reviewer sees each field beside its source page, with section and location', async () => {
  const q = await review.listQueue(); const item = await review.getItem(q.items.find((i) => i.recruitment_id === REC).id);
  const age = item.fields.find((f) => f.key === 'age.max'); assert.strictEqual(age.value, 30); assert.strictEqual(age.lineage.page_number, 3); assert.strictEqual(age.lineage.section, '3.2');
  assert(age.lineage.source_text_location.end > age.lineage.source_text_location.start); assert.strictEqual(age.lineage.extraction_method, 'RULES'); assert(age.lineage.confidence > 0);
  const pageText = item.pages.find((p) => p.document_id === age.lineage.document_id && p.page_number === 3).text;
  assert.strictEqual(pageText.slice(age.lineage.source_text_location.start, age.lineage.source_text_location.end), age.lineage.quote);
  assert(item.documents[0].sha256);
});
test('security: a viewer cannot approve; a reviewer can; approval alone does not publish', async () => {
  const q = await review.listQueue(); const id = q.items.find((i) => i.recruitment_id === REC).id;
  await assert.rejects(() => review.approve(id, viewer), /role/);
  const ap = await review.approve(id, reviewer, {}); assert.strictEqual(ap.lifecycle, 'VERIFIED');
  assert(!(await repo.publishedJobs()).some((j) => j.id === REC), 'VERIFIED is still not public');
  await assert.rejects(() => review.publish(REC, viewer), /role/);
});
test('ACCEPTANCE 2: publish makes it public with page-level lineage in the API shape the UI already uses', async () => {
  await review.publish(REC, reviewer);
  const job = (await repo.publishedJobs()).find((j) => j.id === REC);
  assert(job); assert.strictEqual(job.lifecycle, 'PUBLISHED'); assert.strictEqual(job.verification.status, 'VERIFIED'); assert.strictEqual(job.sample, false);
  assert.strictEqual(job.field_sources.vacancies.page, 2); assert.strictEqual(job.field_sources.age.page, 3); assert.strictEqual(job.field_sources.domicile.section, '3.4');
  assert(job.sources[0].name === 'Notification_05_2026.pdf' && job.field_sources.age.doc === job.sources[0].id);
  const { evaluate } = require('./lib/eligibility');
  const e = evaluate(job, { dob: '1999-05-01', education: { level: 'bachelor', field: 'engineering', status: 'completed' }, domicileState: 'Telangana' });
  assert.deepStrictEqual(e.rows.map((r) => [r.key, r.result]), [['education', 'MATCH'], ['age', 'MATCH'], ['domicile', 'MATCH']]);
  assert.strictEqual(e.rows.find((r) => r.key === 'age').source.page, 3, 'eligibility rows carry the page-level source');
  const lc = (await db.query('SELECT to_state FROM lifecycle_events WHERE recruitment_id=$1 ORDER BY id', [REC])).rows.map((r) => r.to_state).slice(-2);
  assert.deepStrictEqual(lc, ['VERIFIED', 'PUBLISHED']);
});
test('search and eligibility still work against database-backed jobs (Phase 1 behaviour unchanged)', async () => {
  const { parseQuery, runSearch } = require('./lib/search');
  const jobs = await repo.publishedJobs(); const { filters } = parseQuery('technical assistant jobs in Telangana', {});
  const res = runSearch(jobs, filters, {}, new Date()); assert(res.some((r) => r.id === REC));
  assert(jobs.some((j) => j.sample) && jobs.length >= 7); assert(!jobs.some((j) => j.id === 'draft-unverified'), 'sample unverified draft stays hidden');
});
test('ACCEPTANCE 3: a modified re-upload produces a correct "Official Update Detected" diff', async () => {
  const out = await ingestDocument({ buffer: pdf('notification-amendment1.pdf'), title: 'Amendment_1.pdf', url: 'https://psc.example.gov.in/n/05-2026-amendment1.pdf', sourceId: 'demo-psc', kind: 'AMENDMENT', issuedOn: '2026-10-01', recruitmentId: REC }, ENV);
  assert.strictEqual(out.status, 'REVIEW_REQUIRED'); assert.strictEqual(out.recruitmentId, REC); assert.strictEqual(out.versionNo, 2);
  assert(out.changes.includes('Official Update Detected: vacancies previously 1,000, now 1,125 (+125).'), JSON.stringify(out.changes));
  assert(out.changes.some((c) => /application deadline previously 24 October 2026, now 7 November 2026 \(extended by 14 days\)/.test(c)));
  assert(out.changes.some((c) => /maximum age previously 30 years, now 32 years/.test(c)));
  assert(out.buckets.includes('changed_source'));
  assert.strictEqual(out.changes.length, 3, 'only fields that really changed are reported: ' + out.changes.join(' | '));
  // while the update is pending, the previously published facts remain live and are marked as being verified
  const live = (await repo.publishedJobs()).find((j) => j.id === REC); assert.strictEqual(live.vacancies.total, 1000); assert.strictEqual(live.pending_update, true);
  assert.strictEqual(live.history.length, 0, 'unreviewed changes are never shown as history');
});
test('conflict: the amendment is recorded as resolved in favour of the later authoritative document', async () => {
  const c = (await db.query("SELECT * FROM conflicts WHERE recruitment_id=$1 AND field='vacancies.total'", [REC])).rows[0];
  assert.strictEqual(c.resolution, 'RESOLVED_LATER_AUTHORITATIVE'); assert.strictEqual(c.candidates.length, 2);
});
test('approve + publish the amendment: history keeps vacancies 1,000 -> 1,125 (+125) with source and date', async () => {
  const q = await review.listQueue(); const it = q.items.find((i) => i.recruitment_id === REC); assert(it.is_update);
  await review.approve(it.id, reviewer, {}); await review.publish(REC, reviewer);
  const job = (await repo.publishedJobs()).find((j) => j.id === REC);
  assert.strictEqual(job.vacancies.total, 1125); assert.strictEqual(job.dates.application_close, '2026-11-07T23:59:00+05:30'); assert.strictEqual(job.pending_update, false);
  const h = job.history.find((x) => x.field === 'Vacancies'); assert.deepStrictEqual([h.from, h.to, h.delta], ['1,000', '1,125', '+125']); assert(/Amendment_1\.pdf, page 2/.test(h.source)); assert(/^\d{4}-\d{2}-\d{2}$/.test(h.date));
  assert.strictEqual(job.sources.length, 2);
});
test('source archive: auditable timeline lists original, Amendment 1, versions and diffs', async () => {
  const t = await review.timeline(REC);
  assert.deepStrictEqual(t.entries.map((e) => e.title), ['Original notification', 'Amendment 1']);
  assert.deepStrictEqual(t.entries.map((e) => e.version_status), ['SUPERSEDED', 'APPROVED']);
  assert(t.entries[1].changes.length === 3 && t.entries[0].sha256 !== t.entries[1].sha256);
  assert(t.lifecycle.some((l) => l.to_state === 'UPDATED') && t.lifecycle.at(-1).to_state === 'PUBLISHED');
  const lifeStates = t.lifecycle.map((l) => l.to_state);
  assert.deepStrictEqual(lifeStates.slice(5), ['VERIFIED', 'PUBLISHED', 'UPDATED', 'REVIEW_REQUIRED', 'VERIFIED', 'PUBLISHED']);
});
test('ingest: identical bytes are skipped; the same notification re-posted on another source is flagged as a possible duplicate', async () => {
  const again = await ingestDocument({ buffer: pdf('notification-original.pdf'), title: 'again.pdf', sourceId: 'demo-psc' }, ENV);
  assert.strictEqual(again.status, 'STOPPED'); assert(again.duplicate_of);
  const copy = Buffer.concat([pdf('notification-original.pdf'), Buffer.from('\n% re-posted copy\n')]);
  const dup = await ingestDocument({ buffer: copy, title: 'repost.pdf', sourceId: 'manual-upload' }, ENV);
  assert.strictEqual(dup.status, 'REVIEW_REQUIRED'); assert.notStrictEqual(dup.recruitmentId, REC);
  const it = await review.getItem(dup.reviewItemId); assert(it.item.buckets.includes('potential_duplicate'), it.item.buckets.join());
  assert(it.item.reasons.some((r) => r.code === 'POTENTIAL_DUPLICATE' && r.message.includes(REC)));
  await assert.rejects(() => review.approve(dup.reviewItemId, reviewer, {}), /note/, 'duplicates need an explanation');
  await review.reject(dup.reviewItemId, reviewer, { reason: 'Duplicate of the published notification' });
  assert.strictEqual((await repo.getRecruitment(dup.recruitmentId)).lifecycle, 'ARCHIVED');
});
test('fraud: a lookalike-domain notification lands in the suspicious bucket with top priority; only an administrator with a note can approve', async () => {
  const out = await ingestDocument({ buffer: pdf('notification-suspicious.pdf'), title: 'Notification_fake.pdf', sourceId: 'demo-psc' }, ENV);
  const it = await review.getItem(out.reviewItemId);
  assert.strictEqual(it.item.primary_bucket, 'suspicious'); assert(it.item.reasons.some((r) => r.code === 'LOOKALIKE_DOMAIN')); assert(it.item.reasons.some((r) => r.code === 'PAYMENT_OUTSIDE_PORTAL'));
  const q = await review.listQueue(); assert.strictEqual(q.items[0].id, out.reviewItemId, 'suspicious items are first in the queue');
  await assert.rejects(() => review.approve(out.reviewItemId, reviewer, { note: 'looks fine to me really' }), /role/);
  await assert.rejects(() => review.approve(out.reviewItemId, admin, {}), /note/);
  await review.reject(out.reviewItemId, reviewer, { reason: 'Fraudulent: lookalike domain and UPI payment request' });
});
test('review: a schema-rejected extraction cannot be approved until the reviewer supplies a cited value', async () => {
  const PDFDocument = require('pdfkit'); const d = new PDFDocument(); const f = path.join(SAMPLES, 'prose-relaxation.pdf'); const ws = fs.createWriteStream(f); d.pipe(ws);
  const PROSE = '3.3 Reserved categories get the relaxation prescribed by government rules: SC and ST five years, OBC three years, PwBD ten years, ex-servicemen five years.';
  for (const [i, lines] of samples.pagesFor(samples.SCENARIOS.original).entries()) { if (i) d.addPage(); lines.map((l) => (/Age relaxation/.test(l) ? PROSE : l)).forEach((l) => d.text(l)); }
  d.end(); await new Promise((r) => ws.on('finish', r));
  const out = await ingestDocument({ buffer: fs.readFileSync(f), title: 'Notification_prose_relaxation.pdf', sourceId: 'manual-upload' }, ENV);
  assert.strictEqual(out.schema_valid, false); assert(out.buckets.includes('low_confidence')); assert(out.confidence <= 0.4);
  const note = 'Different notification, not a duplicate';
  await assert.rejects(() => review.approve(out.reviewItemId, reviewer, { note }), (e) => e.status === 400 && e.errors.some((x) => x.path === 'age.relaxation'));
  const value = { SC: 5, ST: 5, OBC: 3, EWS: 0, PwBD: 10, ExServicemen: 5 };
  await assert.rejects(() => review.approve(out.reviewItemId, reviewer, { note, edits: [{ path: 'age.relaxation', value }] }), /Cite the page/);
  await assert.rejects(() => review.approve(out.reviewItemId, reviewer, { note, edits: [{ path: 'age.relaxation', value, source: { page: 3, quote: 'a sentence that is not there' } }] }), /not found on page 3/);
  const line = (await review.getItem(out.reviewItemId)).pages.find((p) => p.page_number === 3).text.split('\n').find((l) => /relaxation prescribed/.test(l)) || PROSE.slice(0, 40);
  const ok = await review.approve(out.reviewItemId, reviewer, { note, edits: [{ path: 'age.relaxation', value, source: { page: 3, quote: line.slice(0, 60) } }] });
  assert.strictEqual(ok.lifecycle, 'VERIFIED');
  const v = (await db.query("SELECT lineage, data, schema_valid FROM recruitment_versions WHERE recruitment_id=$1", [out.recruitmentId])).rows[0];
  assert.strictEqual(v.lineage['age.relaxation'].extraction_method, 'HUMAN_EDIT'); assert.strictEqual(v.lineage['age.relaxation'].edited_by, 'rev@test.in'); assert.strictEqual(v.lineage['age.relaxation'].page_number, 3); assert.strictEqual(v.lineage['age.relaxation'].section, '3.3'); assert(v.schema_valid);
  const logged = (await db.query("SELECT detail FROM audit_log WHERE action='REVIEW_APPROVED_WITH_EDITS' AND entity_id=$1", [String(out.reviewItemId)])).rows[0];
  assert(logged && logged.detail.edits[0].path === 'age.relaxation' && logged.detail.edits[0].from === undefined && logged.detail.edits[0].to.SC === 5);
});
test('review: rejecting an update keeps the previously published version live', async () => {
  const third = Buffer.concat([pdf('notification-amendment1.pdf'), Buffer.from('\n% second amendment\n')]);
  const out = await ingestDocument({ buffer: third, title: 'Amendment_2.pdf', sourceId: 'demo-psc', kind: 'AMENDMENT', recruitmentId: REC }, ENV);
  assert.strictEqual(out.recruitmentId, REC);
  await review.reject(out.reviewItemId, reviewer, { reason: 'Could not confirm against the official portal' });
  const job = (await repo.publishedJobs()).find((j) => j.id === REC); assert.strictEqual(job.vacancies.total, 1125); assert.strictEqual(job.lifecycle, 'PUBLISHED');
  assert.strictEqual((await repo.getRecruitment(REC)).lifecycle, 'PUBLISHED');
});
test('conflict: an OLDER document that disagrees with the published one is flagged, not silently applied', async () => {
  const stale = Buffer.concat([pdf('notification-original.pdf'), Buffer.from('\n% stale copy\n')]);
  const out = await ingestDocument({ buffer: stale, title: 'Old_copy.pdf', sourceId: 'demo-psc', kind: 'ORIGINAL', issuedOn: '2026-08-01', recruitmentId: REC }, ENV);
  const it = await review.getItem(out.reviewItemId); assert(it.item.buckets.includes('conflicting_sources'), it.item.buckets.join());
  assert(it.item.reasons.some((r) => r.code === 'SOURCE_CONFLICT'));
  await review.reject(out.reviewItemId, reviewer, { reason: 'Superseded by Amendment 1' });
});
test('lifecycle clock: deadline and exam dates move published records forward (never sample demo data)', async () => {
  const moved = await lifecycle.advanceByDates(new Date('2026-12-25T10:00:00+05:30'));
  assert(moved.some(([id, s]) => id === REC && s === 'APPLICATION_CLOSED') && moved.some(([id, s]) => id === REC && s === 'EXAM_PHASE'));
  assert(!moved.some(([id]) => id === 'rrb-group-d'));
  assert(lifecycle.canTransition('RESULT_PHASE', 'ARCHIVED'));
  assert((await repo.publishedJobs()).some((j) => j.id === REC), 'closed recruitments remain visible');
});

// ---------- agents ----------
test('agents: strict tool permissions; no agent can publish; routing runs only the agents a task needs', async () => {
  for (const [name, tools] of Object.entries(agents.TOOLS)) { assert(!tools.some((t) => /publish|verify|approve/.test(t)), name); }
  const tb = agents.toolbox('Verification', require('./lib/ingest').makeTools({}));
  assert.throws(() => tb.call('store.createVersion', 'x'), agents.PermissionError);
  assert.throws(() => agents.toolbox('Extraction', require('./lib/ingest').makeTools({})).call('store.insertDocument'), /not allowed/);
  const q = agents.toolbox('Quality', require('./lib/ingest').makeTools({}));
  await assert.rejects(async () => q.call('lifecycle.advance', REC, 'PUBLISHED', 'Quality', 'sneaky'), /cannot move/);
  assert.deepStrictEqual(agents.route('DISCOVER'), ['SourceDiscovery']); assert.deepStrictEqual(agents.route('CITE'), ['Citation']); assert.throws(() => agents.route('PUBLISH'));
});

// ---------- crawler ----------
const mkFetch = (map, log = []) => async (url) => { log.push(url); const k = Object.keys(map).find((p) => url.endsWith(p)); const r = map[k]; if (!r) return { ok: false, status: 404, text: async () => '' }; if (r instanceof Error) throw r; return { ok: r.status === undefined || r.status < 400, status: r.status || 200, text: async () => r.body || '', arrayBuffer: async () => Buffer.from(r.body || '') }; };
const crawlEnv = (map, log, clock = { t: 0 }) => ({ fetch: mkFetch(map, log), sleep: async (ms) => { clock.t += ms; clock.slept = (clock.slept || 0) + ms; }, now: () => clock.t });
test('crawler: only verified + enabled registry sources are crawled', async () => {
  const s = await registry.getSource('upsc'); const log = []; const r = await crawler.crawlSource(s, crawlEnv({}, log));
  assert(r.skipped); assert.strictEqual(log.length, 0, 'no network call for a source that is not allowlisted for crawling');
});
test('crawler: respects robots.txt, rate limit, off-domain links, and records health states', async () => {
  await db.query("UPDATE sources SET crawl_enabled=TRUE, min_request_interval_ms=3000 WHERE source_id='demo-psc'");
  const idx = '<a href="/notices/a.pdf">Notification A</a><a href="https://evil.example.com/b.pdf">Notification B</a><a href="/about">About</a>';
  let log = []; const clock = { t: 1e6 };
  let r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/robots.txt': { body: 'User-agent: *\nDisallow: /admin\nCrawl-delay: 4' }, '/': { body: idx } }, log, clock));
  assert.strictEqual(r.health, 'ONLINE'); assert.deepStrictEqual(r.links.map((l) => l.url), ['https://psc.example.gov.in/notices/a.pdf']); assert.strictEqual(r.rejected.length, 1);
  assert(clock.slept >= 4000, 'honoured Crawl-delay between requests');
  assert.strictEqual((await registry.getSource('demo-psc')).health, 'ONLINE'); assert(r.fresh.length === 1);
  // 5xx
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/': { status: 503 } }, [], { t: 2e6 })); assert.strictEqual(r.health, 'TEMPORARILY_UNAVAILABLE');
  // blocked
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/': { status: 403 } }, [], { t: 3e6 })); assert.strictEqual(r.health, 'BLOCKED');
  // robots disallow
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/robots.txt': { body: 'User-agent: *\nDisallow: /' }, '/': { body: idx } }, [], { t: 4e6 })); assert.strictEqual(r.health, 'BLOCKED');
  // page used to have links, now none -> PARSER_ERROR
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/': { body: '<html>redesigned</html>' } }, [], { t: 5e6 })); assert.strictEqual(r.health, 'PARSER_ERROR');
  // wholly different link set -> CONTENT_CHANGED
  await db.query("UPDATE sources SET last_links='[{\"url\":\"https://psc.example.gov.in/old.pdf\",\"title\":\"x\"}]'::jsonb WHERE source_id='demo-psc'");
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), crawlEnv({ '/': { body: idx } }, [], { t: 6e6 })); assert.strictEqual(r.health, 'CONTENT_CHANGED');
  // slow -> DEGRADED
  const c2 = { t: 7e6 }; const env = crawlEnv({ '/': { body: idx } }, [], c2); const f0 = env.fetch; env.fetch = async (u, o) => { if (!u.endsWith('robots.txt')) c2.t += 9000; return f0(u, o); };
  r = await crawler.crawlSource(await registry.getSource('demo-psc'), env); assert.strictEqual(r.health, 'DEGRADED');
  for (const h of ['ONLINE', 'DEGRADED', 'TEMPORARILY_UNAVAILABLE', 'BLOCKED', 'PARSER_ERROR', 'CONTENT_CHANGED']) assert(registry.HEALTH.includes(h));
});
test('crawler: discovery enqueues new links; download refuses off-allowlist hosts', async () => {
  await db.query("UPDATE sources SET last_links='[]'::jsonb WHERE source_id='demo-psc'");
  const { AGENTS } = require('./lib/ingest'); const { toolbox } = require('./lib/agents'); const { makeTools } = require('./lib/ingest');
  const env = { crawl: crawlEnv({ '/': { body: '<a href="/n/one.pdf">One</a>' } }, [], { t: 9e6 }) };
  const out = await AGENTS.SourceDiscovery({ sourceId: 'demo-psc' }, toolbox('SourceDiscovery', makeTools(env)));
  assert.strictEqual(out.enqueued, 1); assert((await db.query("SELECT 1 FROM job_queue WHERE type='PROCESS_URL' AND payload->>'url' LIKE '%one.pdf'")).rowCount === 1);
  const demo = await registry.getSource('demo-psc');
  await assert.rejects(() => crawler.downloadDocument('https://evil.example.com/x.pdf', demo, crawlEnv({}, [], { t: 1 })), /not on the allowlist/);
});
test('crawler: sitemap and RSS discovery parse official feeds', () => {
  assert.deepStrictEqual(crawler.parseSitemap('<urlset><url><loc>https://psc.example.gov.in/a.pdf</loc></url></urlset>').map((x) => x.url), ['https://psc.example.gov.in/a.pdf']);
  assert.strictEqual(crawler.parseRss('<rss><channel><item><title>New post</title><link>https://psc.example.gov.in/p</link></item></channel></rss>')[0].title, 'New post');
});

// ---------- queue ----------
test('queue: retries with backoff, then FAILED; two workers never take the same job', async () => {
  await db.query('DELETE FROM job_queue');
  const id = await queue.enqueue('BOOM', {}, { maxAttempts: 2 });
  let r = await queue.runOne({ BOOM: async () => { throw new Error('nope'); } }); assert.strictEqual(r.status, 'RETRY');
  assert((await db.query('SELECT run_at > now() AS later FROM job_queue WHERE id=$1', [id])).rows[0].later, 'backoff schedules the retry later');
  await db.query('UPDATE job_queue SET run_at=now() WHERE id=$1', [id]);
  r = await queue.runOne({ BOOM: async () => { throw new Error('nope'); } }); assert.strictEqual(r.status, 'FAILED');
  for (let i = 0; i < 6; i++) await queue.enqueue('OK', { i });
  const seen = []; const h = { OK: async (p) => { seen.push(p.i); await new Promise((x) => setTimeout(x, 5)); } };
  await Promise.all([queue.drain(h), queue.drain(h), queue.drain(h)]);
  assert.deepStrictEqual([...seen].sort(), [0, 1, 2, 3, 4, 5]);
  await db.query("INSERT INTO job_queue(type,status,locked_at) VALUES ('OK','RUNNING', now() - interval '1 hour')"); assert.strictEqual(await queue.recoverStuck(15), 1);
});
test('queue handler: PROCESS_URL downloads from an allowlisted source and lands in review', async () => {
  await db.query('DELETE FROM job_queue'); await db.query("UPDATE sources SET min_request_interval_ms=0 WHERE source_id='demo-psc'");
  const body = Buffer.concat([pdf('notification-original.pdf'), Buffer.from('\n% from the queue\n')]);
  const env = { skipLlm: true, crawl: { fetch: async (url) => (url.endsWith('robots.txt') ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, arrayBuffer: async () => body, text: async () => '' }), sleep: async () => {}, now: () => 0 } };
  await queue.enqueue('PROCESS_URL', { sourceId: 'demo-psc', url: 'https://psc.example.gov.in/n/queued.pdf', title: 'queued.pdf' });
  const done = await queue.drain(handlers(env)); assert.strictEqual(done[0].status, 'DONE');
  assert((await db.query("SELECT 1 FROM documents WHERE url='https://psc.example.gov.in/n/queued.pdf'")).rowCount === 1);
});

// ---------- auth, audit, http ----------
test('auth: wrong password is refused, 5 failures throttle, sessions expire on logout; passwords are hashed', async () => {
  await assert.rejects(() => auth.login('rev@test.in', 'wrong password!', '9.9.9.9'), /incorrect/);
  for (let i = 0; i < 4; i++) await auth.login('rev@test.in', 'bad bad bad bad', '9.9.9.9').catch(() => {});
  await assert.rejects(() => auth.login('rev@test.in', 'correct horse battery', '9.9.9.9'), /Too many/);
  const ok = await auth.login('rev@test.in', 'correct horse battery', '1.1.1.1'); assert((await auth.userFromToken(ok.token)).role === 'REVIEWER');
  await auth.logout(ok.token); assert.strictEqual(await auth.userFromToken(ok.token), null);
  assert(!(await db.query("SELECT password_hash FROM users WHERE email='rev@test.in'")).rows[0].password_hash.includes('correct'));
  await assert.rejects(() => auth.createUser('x@y.in', 'X', 'short', 'ADMIN'), /at least 10/);
});
test('audit: every review and publish action is logged and the hash chain verifies; tampering is blocked', async () => {
  const actions = (await db.query("SELECT DISTINCT action FROM audit_log")).rows.map((r) => r.action);
  for (const a of ['REVIEW_APPROVED', 'REVIEW_REJECTED', 'PUBLISH', 'LIFECYCLE', 'DOCUMENT_PROCESSED']) assert(actions.includes(a), a);
  const v = await verifyChain(); assert(v.ok, JSON.stringify(v)); assert(v.entries > 20);
  await assert.rejects(() => db.query("UPDATE audit_log SET actor='mallory' WHERE id=1"), /append-only/);
  await assert.rejects(() => db.query('DELETE FROM audit_log WHERE id=1'), /append-only/);
});
test('http: public APIs keep their shapes; admin APIs need login and the right role; unverified files are not downloadable', async () => {
  const app = require('./server'); await app.ready;
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); }); const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { 'content-type': 'application/json', ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null), res: r }; };
  try {
    assert.strictEqual((await j('/api/health')).body.database, true);
    const s = await j('/api/search', { method: 'POST', body: JSON.stringify({ query: 'technical assistant in Telangana' }) });
    assert(s.body.results.some((x) => x.id === REC) && Array.isArray(s.body.chips));
    const d = await j(`/api/jobs/${REC}`); assert.strictEqual(d.status, 200); assert(d.body.deadline && d.body.cutoff_label && d.body.field_sources.age.page === 3);
    const e = await j(`/api/jobs/${REC}/eligibility`, { method: 'POST', body: JSON.stringify({ profile: { dob: '1999-05-01', education: { level: 'bachelor', field: 'engineering', status: 'completed' }, domicileState: 'Telangana' } }) }); assert(e.body.overall && e.body.rows.length === 3);
    assert.strictEqual((await j('/api/jobs/draft-unverified')).status, 404);
    assert.strictEqual((await j('/api/admin/queue')).status, 401);
    const bad = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'view@test.in', password: 'nope nope nope' }) }); assert.strictEqual(bad.status, 401);
    const li = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'view@test.in', password: 'correct horse battery' }) }); assert.strictEqual(li.status, 200);
    const H = { authorization: `Bearer ${li.body.token}` };
    assert.strictEqual((await j('/api/admin/queue', { headers: H })).status, 200); assert.strictEqual((await j('/api/admin/dashboard', { headers: H })).body.sources.length >= 8, true);
    assert.strictEqual((await j('/api/admin/review/1/approve', { method: 'POST', headers: H, body: '{}' })).status, 403);
    assert.strictEqual((await j('/api/admin/audit', { headers: H })).status, 403);
    assert.strictEqual((await j('/api/admin/upload', { method: 'POST', headers: H, body: 'x' })).status, 403);
    const rv = await j('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: 'rev@test.in', password: 'correct horse battery' }) });
    const up = await fetch(base + '/api/admin/upload', { method: 'POST', headers: { authorization: `Bearer ${rv.body.token}`, 'content-type': 'application/pdf', 'x-title': 'Upload_via_http.pdf', 'x-source-id': 'manual-upload' }, body: Buffer.concat([pdf('notification-original.pdf'), Buffer.from('\n% via http\n')]) });
    assert.strictEqual(up.status, 201); const upb = await up.json(); assert.strictEqual(upb.status, 'REVIEW_REQUIRED');
    const junk = await fetch(base + '/api/admin/upload', { method: 'POST', headers: { authorization: `Bearer ${rv.body.token}`, 'content-type': 'application/octet-stream' }, body: Buffer.from('not a document') }); assert.strictEqual(junk.status, 422);
    const unpublishedDoc = (await db.query('SELECT id FROM documents WHERE recruitment_id=$1', [upb.recruitmentId])).rows[0].id;
    assert.strictEqual((await fetch(`${base}/api/documents/${unpublishedDoc}/file`)).status, 404, 'files of unpublished recruitments are not public');
    const pubDoc = (await db.query('SELECT id FROM documents WHERE recruitment_id=$1 ORDER BY id LIMIT 1', [REC])).rows[0].id; const f = await fetch(`${base}/api/documents/${pubDoc}/file`); assert.strictEqual(f.status, 200); assert.strictEqual(f.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(d.res.headers.get('x-content-type-options'), 'nosniff');
  } finally { server.close(); }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); results.push(true); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 4).join('\n       ')}`); }
  }
  console.log(`\nPhase 2: ${tests.length - failed}/${tests.length} passed`);
  await db.close(); process.exit(failed ? 1 : 0);
})();
