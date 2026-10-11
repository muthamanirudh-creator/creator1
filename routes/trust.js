'use strict';
// v2.9.0 trust & evidence API. Everything here is additive; no existing route is changed in meaning.
const express = require('express');
const policy = require('../lib/trust/policy');
const trustSvc = require('../lib/trust/service');
const ledger = require('../lib/trust/ledger');
const flagsLib = require('../lib/trust/flags');
const evalLib = require('../lib/trust/evaluation');
const guardLib = require('../lib/trust/aiGuard');
const prefs = require('../lib/trust/alertPrefs');
const careerFit = require('../lib/trust/careerFit');
const prepQ = require('../lib/trust/prepQuality');
const privacy = require('../lib/trust/accountPrivacy');
const { evaluate } = require('../lib/eligibility');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mask = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}***@${d}` : 'reviewer'; };
const publicTrust = (t) => ({ ...t, critical_fields: { ...t.critical_fields, status: Object.fromEntries(Object.entries(t.critical_fields.status).map(([k, v]) => [k, { ...v, verified_by: v.verified_by ? mask(v.verified_by) : undefined }])) } });

const { extractionReport, eligibilitySelfTest } = require('../lib/trust/selftests');

function mount(app, { db, runtime, repo, citizenAuth, auth, needAccounts, audit }) {
  const r = express.Router();
  const jobById = async (id) => (await repo.publishedJobs(new Date())).find((j) => j.id === id);

  // ---- public ---------------------------------------------------------------------------------------------------------
  r.get('/policy', wrap(async (_req, res) => res.json({
    critical_fields: policy.CRITICAL_FIELDS, verification_labels: policy.VERIFICATION_LABEL, phase_labels: policy.PHASE_LABEL,
    rules: ['Newly detected notices are shown as unverified.', 'Candidate notices are indexed automatically but are never treated as confirmed vacancies.',
      'Critical fields need confirmation by a named reviewer, against a page and quote, on the current value.', 'The original document, evidence, reviewer and change history are preserved.',
      'Conflicting amendments and changed deadlines are flagged immediately.', 'Extraction confidence is not accuracy.'],
    human_verification: policy.humanVerificationRequired(extractionReport()),
  })));
  r.get('/jobs', wrap(async (_req, res) => { const jobs = await repo.publishedJobs(new Date()); const t = await trustSvc.trustForJobs(jobs); res.json(jobs.map((j) => ({ id: j.id, title: j.title, display_status: t[j.id].display_status, verification: t[j.id].verification, phase: t[j.id].phase, amended: t[j.id].amended, can_rely_on_for_decisions: t[j.id].can_rely_on_for_decisions }))); }));
  r.get('/jobs/:id', wrap(async (req, res) => {
    const job = await jobById(req.params.id); if (!job) return res.status(404).json({ error: 'Recruitment not found or not yet published.' });
    const t = await trustSvc.trustForJob(job); const s = trustSvc.stores();
    const history = (await s.ledger.ledgerFor(job.id)).map((e) => ({ at: e.at, kind: e.kind, actor: String(e.actor).startsWith('human:') ? `human:${mask(String(e.actor).slice(6))}` : e.actor, summary: e.detail && (e.detail.summary || e.detail.field || null), hash: e.hash }));
    res.json({ recruitment_id: job.id, trust: publicTrust(t), history, flags: (await s.flags.all(job.id)).map((f) => ({ id: f.id, kind: f.kind, severity: f.severity, field: f.field, summary: f.summary, status: f.status, raised_at: f.raised_at })) });
  }));
  r.post('/eligibility/:id', wrap(async (req, res) => {
    const job = await jobById(req.params.id); if (!job) return res.status(404).json({ error: 'Recruitment not found or not yet published.' });
    const t = await trustSvc.trustForJob(job); const e = evaluate(job, (req.body || {}).profile || {});
    const basis = t.verification === 'VERIFIED' ? 'VERIFIED_RECORD' : t.verification === 'SAMPLE' ? 'SAMPLE_RECORD' : 'UNVERIFIED_RECORD';
    res.json({ ...e, evidence_basis: basis, trust: { display_status: t.display_status, why: t.why },
      caution: basis === 'UNVERIFIED_RECORD' ? 'This result uses a record that a person has not fully confirmed. Check the official notification before acting.' : basis === 'SAMPLE_RECORD' ? 'Sample record: not a real recruitment.' : null,
      official_vs_generated: { official_rules: e.rows.map((x) => ({ key: x.key, rule: x.official, source: x.source })), computed: 'The verdict and per-criterion results are computed by rule from the official rules and your inputs. No language model is involved.' } });
  }));
  r.get('/evaluation/extraction', wrap(async (_req, res) => res.json(extractionReport())));
  r.get('/evaluation/eligibility', wrap(async (_req, res) => res.json(eligibilitySelfTest())));
  r.post('/guard/text', wrap(async (req, res) => { const { text, recruitmentId } = req.body || {}; const job = recruitmentId ? await jobById(recruitmentId) : null; res.json(guardLib.guardFreeText({ text, job })); }));
  r.post('/career-fit/explain', wrap(async (req, res) => { const m = (req.body || {}).match; if (!m || !m.eligibility || !m.readiness) return res.status(400).json({ error: 'Send one match row from the Bridge analysis.' }); res.json(careerFit.explainMatch(m)); }));
  r.post('/prep/check-questions', wrap(async (req, res) => res.json(prepQ.checkQuestionSet((req.body || {}).questions))));
  r.post('/prep/analytics', wrap(async (req, res) => res.json(prepQ.progressAnalytics((req.body || {}).attempts, {}))));
  r.post('/prep/adaptive-plan', wrap(async (req, res) => { const b = req.body || {}; if (!Array.isArray(b.topics) || !b.topics.length) return res.status(400).json({ error: 'topics is required.' }); res.json(prepQ.adaptivePlan({ topics: b.topics, analytics: prepQ.progressAnalytics(b.attempts || []), days: Number(b.days) || 30, minutesPerDay: Number(b.minutes_per_day) || 120 })); }));
  r.get('/prep/syllabus/:versionId', wrap(async (req, res) => {
    const id = Number(req.params.versionId); let version, nodes;
    if (runtime.isDemo()) { version = runtime.exams().find((x) => x.version_id === id); nodes = runtime.syllabus(id) || []; }
    else { version = (await db.query('SELECT ev.*, e.name FROM exam_versions ev JOIN exams e ON e.id=ev.exam_id WHERE ev.id=$1', [id])).rows[0]; nodes = version ? (await db.query('SELECT * FROM syllabus_nodes WHERE exam_version_id=$1', [id])).rows : []; }
    if (!version) return res.status(404).json({ error: 'Exam version not found.' });
    res.json({ exam_version: id, ...prepQ.syllabusStatus(version, nodes), sample: runtime.isDemo() });
  }));
  app.use('/api/trust', r);

  // ---- citizen account ----------------------------------------------------------------------------------------------
  const a = express.Router(); const G = [needAccounts, citizenAuth.middleware];
  a.get('/alert-preferences', ...G, wrap(async (req, res) => { const x = (await db.query('SELECT channels,deadline_changes,new_match,trust_flags,min_trust FROM alert_preferences WHERE account_id=$1', [req.citizen.id])).rows[0]; res.json(x || prefs.DEFAULTS); }));
  a.put('/alert-preferences', ...G, wrap(async (req, res) => {
    const p = prefs.normalisePrefs(req.body || {});
    await db.query(`INSERT INTO alert_preferences(account_id,channels,deadline_changes,new_match,trust_flags,min_trust) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (account_id) DO UPDATE SET channels=$2,deadline_changes=$3,new_match=$4,trust_flags=$5,min_trust=$6,updated_at=now()`, [req.citizen.id, p.channels, p.deadline_changes, p.new_match, p.trust_flags, p.min_trust]);
    res.json(p);
  }));
  a.get('/alerts/receipts', ...G, wrap(async (req, res) => {
    const rows = (await db.query(`SELECT d.alert_id,d.channel,d.status,d.attempts,d.provider_message_id,d.last_error,d.sent_at,ae.event_type,ae.recruitment_id,ae.payload,ae.created_at AS alert_created_at
      FROM notification_deliveries d JOIN alert_events ae ON ae.id=d.alert_id WHERE ae.account_id=$1 ORDER BY d.alert_id DESC, d.id LIMIT 300`, [req.citizen.id])).rows;
    res.json({ receipts: prefs.receipts(rows), note: 'Delivered is shown only when the provider returned a confirmation id.' });
  }));
  a.get('/consents', ...G, wrap(async (req, res) => res.json(privacy.currentConsents((await db.query('SELECT version,action,purpose,at FROM consent_events WHERE account_id=$1 ORDER BY id', [req.citizen.id])).rows))));
  a.post('/consents', ...G, wrap(async (req, res) => {
    const { purpose, action } = req.body || {}; privacy.validateChange(purpose, action);
    await db.query('INSERT INTO consent_events(account_id,version,action,purpose) VALUES($1,$2,$3,$4)', [req.citizen.id, process.env.PRIVACY_POLICY_VERSION || '2026-10', action, purpose]);
    if (action === 'WITHDRAWN' && purpose === 'ALERTS') await db.query("UPDATE notification_deliveries SET status='SKIPPED', last_error='alerts consent withdrawn' WHERE status='QUEUED' AND alert_id IN (SELECT id FROM alert_events WHERE account_id=$1)", [req.citizen.id]);
    res.json(privacy.currentConsents((await db.query('SELECT version,action,purpose,at FROM consent_events WHERE account_id=$1 ORDER BY id', [req.citizen.id])).rows));
  }));
  a.get('/sessions', ...G, wrap(async (req, res) => res.json(privacy.describeSessions((await db.query('SELECT token_hash,created_at,expires_at FROM citizen_sessions WHERE account_id=$1 AND expires_at>now() ORDER BY created_at DESC', [req.citizen.id])).rows, require('../lib/citizenAuth').sha(req.citizenToken)))));
  a.delete('/sessions/others', ...G, wrap(async (req, res) => { const n = (await db.query('DELETE FROM citizen_sessions WHERE account_id=$1 AND token_hash<>$2', [req.citizen.id, require('../lib/citizenAuth').sha(req.citizenToken)])).rowCount; res.json({ signed_out_elsewhere: n }); }));
  a.post('/recommendation-outcome', ...G, wrap(async (req, res) => {
    const { recruitment_id, action_code, outcome } = req.body || {};
    if (!recruitment_id || !action_code || !['SHOWN', 'APPLIED', 'SAVED', 'IGNORED', 'DISMISSED'].includes(outcome)) return res.status(400).json({ error: 'recruitment_id, action_code and a valid outcome are required.' });
    await db.query('INSERT INTO recommendation_outcomes(account_id,recruitment_id,action_code,outcome) VALUES($1,$2,$3,$4)', [req.citizen.id, String(recruitment_id).slice(0, 80), String(action_code).slice(0, 40), outcome]); res.status(201).json({ ok: true });
  }));
  a.get('/recommendation-outcomes/summary', ...G, wrap(async (req, res) => res.json(careerFit.measureRecommendations((await db.query("SELECT action_code,outcome FROM recommendation_outcomes WHERE account_id=$1 AND outcome<>'SHOWN'", [req.citizen.id])).rows))));
  app.use('/api/account', a);

  // ---- reviewers / admins ---------------------------------------------------------------------------------------------
  const m = express.Router();
  const need = (role) => auth.requireRole(role);
  m.get('/flags', need('VIEWER'), wrap(async (req, res) => { const s = trustSvc.stores(); res.json(req.query.status === 'ALL' ? await s.flags.all(req.query.recruitment_id) : await s.flags.open(req.query.recruitment_id)); }));
  m.post('/flags/:id/resolve', need('REVIEWER'), wrap(async (req, res) => res.json(await flagsLib.resolveFlag(trustSvc.stores().flags, req.params.id, req.user, req.body || {}))));
  m.get('/recruitments/:id/sheet', need('VIEWER'), wrap(async (req, res) => res.json(await trustSvc.confirmationSheet(req.params.id))));
  m.post('/recruitments/:id/confirm', need('REVIEWER'), wrap(async (req, res) => {
    const items = (req.body || {}).items; if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items: [{ field, evidence: { document_id, page, quote }, note }] is required.' });
    const out = await trustSvc.confirmFields({ recruitmentId: req.params.id, items, reviewer: req.user }); await audit(`human:${req.user.email}`, 'TRUST_FIELDS_CONFIRMED', 'recruitment', req.params.id, { fields: items.map((i) => i.field) }); res.json(out);
  }));
  m.get('/recruitments/:id/history', need('VIEWER'), wrap(async (req, res) => res.json(await trustSvc.stores().ledger.ledgerFor(req.params.id))));
  m.post('/recruitments/:id/scan', need('REVIEWER'), wrap(async (req, res) => res.json(await trustSvc.scanRecruitment(req.params.id))));
  m.post('/monitor/run', need('ADMIN'), wrap(async (_req, res) => res.json(await trustSvc.monitorPass())));
  m.get('/ledger/verify', need('ADMIN'), wrap(async (_req, res) => res.json(await ledger.verifyLedger(trustSvc.stores().ledger))));
  m.post('/evaluation/extraction/record', need('ADMIN'), wrap(async (_req, res) => { const rep = extractionReport(); if (!runtime.isDemo()) await db.query('INSERT INTO extraction_eval_runs(documents,real_documents,evidence_grade,report) VALUES($1,$2,$3,$4)', [rep.documents, rep.real_documents, rep.evidence_grade, JSON.stringify(rep)]); res.json({ recorded: !runtime.isDemo(), evidence_grade: rep.evidence_grade }); }));
  app.use('/api/admin/trust', m);
}

// Extra sections for the account export, so a new table cannot be silently left out.
async function exportExtras(db, id) {
  const [cons, prefsRow, receiptsRows] = await Promise.all([
    db.query('SELECT version,action,purpose,at FROM consent_events WHERE account_id=$1 ORDER BY id', [id]),
    db.query('SELECT channels,deadline_changes,new_match,trust_flags,min_trust,updated_at FROM alert_preferences WHERE account_id=$1', [id]),
    db.query('SELECT d.alert_id,d.channel,d.status,d.attempts,d.provider_message_id,d.sent_at FROM notification_deliveries d JOIN alert_events ae ON ae.id=d.alert_id WHERE ae.account_id=$1 ORDER BY d.id', [id]),
  ]);
  return { consents: privacy.currentConsents(cons.rows), alert_preferences: prefsRow.rows[0] || prefs.DEFAULTS, delivery_receipts: receiptsRows.rows };
}

module.exports = { mount, exportExtras, extractionReport, eligibilitySelfTest };
