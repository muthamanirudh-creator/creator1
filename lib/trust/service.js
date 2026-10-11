'use strict';
// Trust service (v2.9.0): the only module that touches both the trust policy and the database.
// Everything it returns is derived from rows a person or the pipeline wrote; it invents nothing.
const db = require('../db');
const runtime = require('../runtime');
const policy = require('./policy');
const ledger = require('./ledger');
const flags = require('./flags');
const monitor = require('./sourceMonitor');
const guard = require('./aiGuard');

let _stores = null, _mode = null;
function stores() {
  if (_stores && _mode === runtime.isDemo()) return _stores;
  _mode = runtime.isDemo();
  const l = runtime.isDemo() ? ledger.memoryStore() : ledger.pgStore(db);
  _stores = { ledger: l, flags: runtime.isDemo() ? flags.memoryStore(l) : flags.pgStore(db, l) };
  // verification + ledger share one object so confirmField can write both
  _stores.verifier = Object.assign(Object.create(l), { ledger: l });
  return _stores;
}
const reset = () => { _stores = null; };

// Trust for a batch of published jobs: two queries total, not two per job.
async function trustForJobs(jobs, now = new Date()) {
  const s = stores(); const out = {};
  const ids = jobs.filter((j) => !j.sample).map((j) => j.id);
  let verifs = {}, open = {}, gone = {};
  if (ids.length && !runtime.isDemo()) {
    for (const r of (await db.query('SELECT * FROM field_verifications WHERE recruitment_id = ANY($1) ORDER BY id', [ids])).rows) (verifs[r.recruitment_id] = verifs[r.recruitment_id] || []).push({ ...r, verified_at: r.verified_at instanceof Date ? r.verified_at.toISOString() : r.verified_at });
    for (const f of await s.flags.open()) (open[f.recruitment_id] = open[f.recruitment_id] || []).push(f);
    for (const r of (await db.query("SELECT recruitment_id FROM source_checks WHERE recruitment_id = ANY($1) AND kind='PAGE' GROUP BY recruitment_id HAVING bool_and(status IN ('BROKEN','SOFT_404','TIMEOUT')) AND COUNT(*) >= 3", [ids])).rows) gone[r.recruitment_id] = true;
  } else for (const f of await s.flags.open()) (open[f.recruitment_id] = open[f.recruitment_id] || []).push(f);
  for (const j of jobs) out[j.id] = policy.computeTrust(j, { now, verifications: verifs[j.id] || [], flags: open[j.id] || [], source: { gone: !!gone[j.id] }, detected_only: j.detected_only === true });
  return out;
}
async function trustForJob(job, now) { return (await trustForJobs([job], now))[job.id]; }
async function verificationFor(id) { const j = (await require('../repo').publishedJobs()).find((x) => x.id === id); return j ? (await trustForJob(j)).verification : null; }

// ---- reviewer actions ------------------------------------------------------------------------------------------------
// The sheet a reviewer works from: each critical field, its current value, and the evidence the pipeline recorded for it.
async function confirmationSheet(recruitmentId) {
  const job = (await require('../repo').publishedJobs()).find((j) => j.id === recruitmentId); if (!job) throw Object.assign(new Error('Recruitment not found or not published.'), { status: 404 });
  const t = await trustForJob(job);
  let lineage = {};
  if (!runtime.isDemo() && !job.sample) { const v = (await db.query('SELECT v.lineage,v.document_id FROM recruitment_versions v JOIN recruitments r ON r.id=v.recruitment_id AND r.published_version=v.version_no WHERE v.recruitment_id=$1', [recruitmentId])).rows[0]; if (v) lineage = v.lineage || {}; }
  const get = (p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), job);
  return { recruitment_id: recruitmentId, title: job.title, display_status: t.display_status, fields: policy.CRITICAL_FIELDS.map((f) => { const l = lineage[f] || lineage[f.split('.')[0]] || null; return { field: f, value: get(f) ?? null, status: (t.critical_fields.status[f] || { status: 'NOT_RECORDED' }).status, suggested_evidence: l && l.page_number ? { document_id: l.document_id, page: l.page_number, quote: l.quote } : null }; }) };
}

async function confirmFields({ recruitmentId, items, reviewer }) {
  const job = (await require('../repo').publishedJobs()).find((j) => j.id === recruitmentId); if (!job) throw Object.assign(new Error('Recruitment not found or not published.'), { status: 404 });
  if (job.sample) throw Object.assign(new Error('Sample records are fictional and cannot be verified.'), { status: 409 });
  const s = stores(); const done = [];
  for (const it of items) {
    let pages = null; const ev = it.evidence || {};
    if (!runtime.isDemo() && ev.document_id != null) {
      pages = (await db.query('SELECT page_number,text FROM document_pages WHERE document_id=$1', [ev.document_id])).rows;
      const d = (await db.query('SELECT sha256 FROM documents WHERE id=$1', [ev.document_id])).rows[0]; if (!d) throw Object.assign(new Error(`Document ${ev.document_id} not found.`), { status: 400 }); ev.document_sha256 = d.sha256;
    }
    const ver = !runtime.isDemo() ? (await db.query('SELECT published_version FROM recruitments WHERE id=$1', [recruitmentId])).rows[0] : null;
    done.push(await ledger.confirmField({ store: s.verifier, job, field: it.field, evidence: ev, reviewer, note: it.note || '', pages, version_no: ver ? ver.published_version : null }));
  }
  return { confirmed: done.length, trust: await trustForJob(job) };
}

// Compare versions/documents of one recruitment and raise any new flags. Called after every approve/publish and by the monitor.
async function scanRecruitment(recruitmentId) {
  if (runtime.isDemo()) return { raised: [] };
  const s = stores(); const versions = await flags.loadVersions(db, recruitmentId);
  const docs = versions.filter((v) => v.status !== 'PENDING' || true).map((v) => ({ document_id: v.document.id, kind: v.document.kind, issued_on: v.document.issued_on, official: true, data: v.data }));
  const prev = await s.flags.all(recruitmentId);
  const found = flags.detectFlags({ recruitment_id: recruitmentId, versions, documents: docs, previousFlags: prev });
  const raised = await flags.raiseAll(s.flags, found);
  return { raised };
}

// One monitoring pass over published, non-sample recruitments. fetch is injectable.
async function monitorPass({ fetch = globalThis.fetch, now = new Date(), limit = 50 } = {}) {
  if (runtime.isDemo()) return { skipped: 'demo mode (no database)' };
  const s = stores(); const jobs = (await require('../repo').publishedJobs()).filter((j) => !j.sample).slice(0, limit); const summary = { checked: 0, raised: 0 };
  for (const job of jobs) {
    const urls = (job.sources || []).map((x) => x.url).filter((u) => /^https:/.test(u || ''));
    const link = job.application_link && /^https:/.test(job.application_link) ? [job.application_link] : [];
    const results = []; let page = null;
    for (const u of [...urls, ...link]) {
      const r = await monitor.checkLink(u, { fetch, returnText: true }); results.push(r);
      await db.query('INSERT INTO source_checks(recruitment_id,url,kind,status,http_status,detail,fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7)', [job.id, u, 'PAGE', r.status, r.http || null, r.detail || null, r.text ? monitor.fingerprint(r.text) : null]);
      if (r.text && !page) page = { url: u, text: r.text };
    }
    let prevSnap = null;
    if (page) { prevSnap = (await db.query('SELECT text FROM source_snapshots WHERE recruitment_id=$1 AND url=$2', [job.id, page.url])).rows[0]; await db.query('INSERT INTO source_snapshots(recruitment_id,url,text,fingerprint) VALUES ($1,$2,$3,$4) ON CONFLICT (recruitment_id,url) DO UPDATE SET text=EXCLUDED.text, fingerprint=EXCLUDED.fingerprint, taken_at=now()', [job.id, page.url, page.text.slice(0, 200000), monitor.fingerprint(page.text)]); }
    const missing = (await db.query("SELECT COUNT(*)::int n FROM (SELECT status FROM source_checks WHERE recruitment_id=$1 AND kind='PAGE' ORDER BY id DESC LIMIT 3) x WHERE status IN ('BROKEN','SOFT_404','TIMEOUT')", [job.id])).rows[0].n;
    const found = monitor.findingsFor(job, { page: page ? { prev: prevSnap ? { text: prevSnap.text } : null, next: { text: page.text } } : null, links: results, missing_count: missing }, now);
    const raised = await flags.raiseAll(s.flags, found, { actor: 'system:source-monitor' });
    summary.checked++; summary.raised += raised.length;
    await scanRecruitment(job.id).then((r) => { summary.raised += r.raised.length; }).catch(() => {});
  }
  return summary;
}

module.exports = { stores, reset, trustForJobs, trustForJob, verificationFor, confirmationSheet, confirmFields, scanRecruitment, monitorPass, guardAnswer: guard.guardAnswer };
