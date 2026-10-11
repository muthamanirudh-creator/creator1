const express = require('express');
const fs = require('fs');
const db = require('../lib/db');
const auth = require('../lib/auth');
const review = require('../lib/review');
const registry = require('../lib/registry');
const queue = require('../lib/queue');
const { audit, verifyChain } = require('../lib/audit');
const { ingestDocument } = require('../lib/ingest');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

router.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const r = await auth.login(email, password, req.ip);
  res.json(r);
}));
router.post('/logout', auth.requireRole('VIEWER'), wrap(async (req, res) => { await auth.logout(req.token); res.json({ ok: true }); }));
router.get('/me', auth.requireRole('VIEWER'), (req, res) => res.json({ user: req.user }));

router.get('/dashboard', auth.requireRole('VIEWER'), wrap(async (_req, res) => {
  const sources = (await registry.listSources()).map((s) => ({ source_id: s.source_id, organization: s.organization, official_domain: s.official_domain, source_type: s.source_type, health: s.health, verification_status: s.verification_status, crawl_enabled: s.crawl_enabled, last_success_at: s.last_success_at, last_failure_at: s.last_failure_at, last_error: s.last_error }));
  const q = await review.listQueue({ limit: 1 });
  const jobs = (await db.query('SELECT status, COUNT(*)::int n FROM job_queue GROUP BY status')).rows;
  const lc = (await db.query('SELECT lifecycle, COUNT(*)::int n FROM recruitments WHERE NOT is_sample GROUP BY lifecycle')).rows;
  res.json({ sources, review_buckets: q.bucket_counts, job_queue: Object.fromEntries(jobs.map((j) => [j.status, j.n])), lifecycle: Object.fromEntries(lc.map((l) => [l.lifecycle, l.n])) });
}));

router.post('/sources/:id/verify', auth.requireRole('ADMIN'), wrap(async (req, res) => { await registry.setVerification(req.params.id, req.body.status, req.user.email); res.json({ ok: true }); }));
router.post('/sources/:id/crawling', auth.requireRole('ADMIN'), wrap(async (req, res) => { await registry.setCrawling(req.params.id, !!req.body.enabled, req.user.email); res.json({ ok: true }); }));
router.post('/sources/:id/crawl', auth.requireRole('REVIEWER'), wrap(async (req, res) => { const id = await queue.enqueue('CRAWL_SOURCE', { sourceId: req.params.id }); res.json({ queued: id }); }));

// Auto-published items awaiting a person's audit (v2.8.2). Confirm = a reviewer checked it against the official document.
// Retract = take it down (archived, announced as RETRACTED). Both are audit-logged.
const autopublish = require('../lib/autopublish');
router.get('/auto-published', auth.requireRole('VIEWER'), wrap(async (_req, res) => res.json({ items: await autopublish.listAwaitingAudit() })));
router.post('/auto-published/:id/confirm', auth.requireRole('REVIEWER'), wrap(async (req, res) => res.json(await autopublish.confirm(req.params.id, req.user))));
router.post('/auto-published/:id/retract', auth.requireRole('REVIEWER'), wrap(async (req, res) => res.json(await autopublish.retract(req.params.id, req.user, (req.body || {}).reason))));
router.post('/sources/auto-verify', auth.requireRole('ADMIN'), wrap(async (_req, res) => { const policy = require('../lib/sourcePolicy'); await policy.seedExtra(db); res.json(await policy.autoVerifyPending({ db, audit })); }));

router.get('/queue', auth.requireRole('VIEWER'), wrap(async (req, res) => res.json(await review.listQueue({ bucket: req.query.bucket, status: req.query.status || 'OPEN' }))));
router.get('/review/:id', auth.requireRole('VIEWER'), wrap(async (req, res) => res.json(await review.getItem(+req.params.id))));
router.post('/review/:id/approve', auth.requireRole('REVIEWER'), wrap(async (req, res) => {
  const out = await review.approve(+req.params.id, req.user, req.body || {});
  // v2.9.0: compare the approved version with earlier ones and raise deadline / conflict flags immediately.
  try { const it = (await db.query('SELECT recruitment_id FROM review_items WHERE id=$1', [+req.params.id])).rows[0]; if (it) await require('../lib/trust/service').scanRecruitment(it.recruitment_id); } catch (_) {}
  res.json(out);
}));
router.post('/review/:id/reject', auth.requireRole('REVIEWER'), wrap(async (req, res) => res.json(await review.reject(+req.params.id, req.user, req.body || {}))));
router.post('/recruitments/:id/publish', auth.requireRole('REVIEWER'), wrap(async (req, res) => { const out = await review.publish(req.params.id, req.user); try { require('../lib/realtime').publish('jobs.changed', { recruitment_id: req.params.id, reason: 'published' }); } catch (_) {} res.json(out); }));
router.get('/recruitments', auth.requireRole('VIEWER'), wrap(async (_req, res) => res.json((await db.query("SELECT id,title,organization,lifecycle,published_version,published_at,source_id FROM recruitments WHERE NOT is_sample ORDER BY created_at DESC")).rows)));
router.get('/recruitments/:id/timeline', auth.requireRole('VIEWER'), wrap(async (req, res) => res.json(await review.timeline(req.params.id))));

// Manual upload of an official document by a reviewer. Raw body; metadata in headers.
router.post('/upload', auth.requireRole('REVIEWER'), express.raw({ type: '*/*', limit: '26mb' }), wrap(async (req, res) => {
  const h = (k) => req.get(k) || undefined;
  const out = await ingestDocument({ buffer: req.body, title: decodeURIComponent(h('x-title') || 'Uploaded document'), url: h('x-url'), sourceId: h('x-source-id') || 'manual-upload', kind: h('x-kind'), issuedOn: h('x-issued-on'), recruitmentId: h('x-recruitment-id') }, req.app.get('ingestEnv') || {});
  await audit(`human:${req.user.email}`, 'UPLOAD', 'recruitment', out.recruitmentId || null, { title: h('x-title'), status: out.status });
  res.status(out.status === 'STOPPED' ? 422 : 201).json(out);
}));

router.get('/audit', auth.requireRole('ADMIN'), wrap(async (req, res) => res.json((await db.query('SELECT id,actor,action,entity_type,entity_id,detail,at FROM audit_log ORDER BY id DESC LIMIT $1', [Math.min(+req.query.limit || 100, 500)])).rows)));
router.get('/audit/verify', auth.requireRole('ADMIN'), wrap(async (_req, res) => res.json(await verifyChain())));
router.get('/documents/:id/file', auth.requireRole('VIEWER'), wrap(async (req, res) => {
  const d = (await db.query('SELECT storage_path,mime,title FROM documents WHERE id=$1', [+req.params.id])).rows[0];
  if (!d) return res.status(404).json({ error: 'Not found.' });
  res.type(d.mime).set('Content-Disposition', `inline; filename="${d.title.replace(/[^\w.-]/g, '_')}"`).send(fs.readFileSync(d.storage_path));
}));

// Mock tests: every question must declare its origin; previous-year questions need a source and a legal basis.
const study = require('../lib/study');
router.post('/mock-tests', auth.requireRole('REVIEWER'), wrap(async (req, res) => {
  const { exam_version_id, title, questions, source_ref } = req.body || {};
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required.' });
  const v = (await db.query("SELECT id FROM exam_versions WHERE id=$1 AND status='VERIFIED'", [+exam_version_id])).rows[0];
  if (!v) return res.status(404).json({ error: 'Verified exam version not found.' });
  const chk = study.validateQuestions(questions);
  if (!chk.ok) return res.status(400).json({ error: 'Invalid questions.', details: chk.errors });
  const r = await db.query('INSERT INTO mock_tests(exam_version_id,title,questions,source_ref) VALUES($1,$2,$3,$4) RETURNING id', [v.id, title, JSON.stringify(questions), source_ref || null]);
  await audit(`user:${req.user.email}`, 'MOCK_TEST_CREATED', 'mock_test', r.rows[0].id, { questions: questions.length, ai_generated: questions.filter((q) => q.origin === 'AI_GENERATED').length });
  res.status(201).json({ id: r.rows[0].id });
}));

// Hybrid RAG record sync (v2.9.1). Pushes real, published (never sample) recruitments with their stored notice text and the
// source's last successful verification time to the AI service. ADMIN only; the summary reports what was skipped and why.
router.post('/hybrid-rag/sync', auth.requireRole('ADMIN'), wrap(async (req, res) => {
  const out = await require('../lib/hybridRecords').sync({ db });
  await audit(`user:${req.user.email}`, 'HYBRID_RAG_SYNC', 'hybrid_rag', null, { pushed: out.pushed, removed: out.removed, failed: out.failed.length, code: out.code || null });
  res.status(out.ok ? 200 : (out.code === 'AI_SERVICE_NOT_CONFIGURED' ? 503 : 502)).json(out);
}));

module.exports = router;
