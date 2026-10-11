'use strict';
// GovCareer database -> Hybrid RAG records (pass 3).
//
// The AI service (campus/ai-ml-service/app/rag_core) holds the searchable index and decides drive status and
// eligibility. This module only TRANSLATES what the GovCareer pipeline has already stored and pushes it, so:
//   * demo / sample records are never sent (they are fictional and must not look like verified data);
//   * the notice text is the real extracted page text of the stored documents - nothing is rendered from guesses;
//   * freshness comes from the source's own last successful crawl, never from "now";
//   * an unreachable source keeps its old verification time and is reported as unreachable;
//   * unknown stays unknown: a missing deadline or advertisement number is omitted, not invented.
const http = require('http');
const https = require('https');

const MAX_TEXT = 190000;           // the AI service caps one record at 200 000 characters
const PUSHABLE = new Set(['PUBLISHED', 'UPDATED', 'VERIFIED', 'APPLICATION_CLOSED', 'EXAM_PHASE', 'RESULT_PHASE']);

const cfg = (env = process.env) => ({
  url: String(env.AI_ML_SERVICE_URL || '').replace(/\/+$/, ''),
  token: String(env.AI_ML_SERVICE_TOKEN || ''),
  timeoutMs: Number(env.HYBRID_RAG_SYNC_TIMEOUT_MS || 20000),
  batch: Math.max(1, Math.min(50, Number(env.HYBRID_RAG_SYNC_BATCH || 20))),
});

const ymd = (v) => {
  if (!v) return null;
  const m = String(v instanceof Date ? v.toISOString() : v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};
const iso = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (url, domain) => { const h = hostOf(url), d = String(domain || '').toLowerCase().replace(/^www\./, ''); return !!h && !!d && (h === d || h.endsWith('.' + d)); };

// "FIRST-CLASS" authority claim. The AI service still applies its own official-domain policy and downgrades
// "official" to "verified" when the URL is not on the allow-list; this only avoids claiming more than we know.
function authorityOf(row, source, docUrl) {
  if (!source) return row.verification && row.verification.level === 'HUMAN_REVIEWED' ? 'verified' : 'third_party';
  const officialType = /^OFFICIAL_/.test(source.source_type || '');
  const verifiedSource = source.verification_status === 'VERIFIED' || source.auto_verified === true;
  if (officialType && verifiedSource && docUrl && onDomain(docUrl, source.official_domain)) return 'official';
  if (verifiedSource) return 'verified';
  return 'third_party';
}

// Newest first by issue date / id; original + amendments are joined so a corrigendum is searchable with its notice.
function composeText(docs, pagesByDoc) {
  const parts = [];
  for (const d of docs) {
    const pages = (pagesByDoc.get(d.id) || []).map((p) => String(p.text || '').trim()).filter(Boolean);
    if (!pages.length) continue;
    parts.push(`### ${d.kind || 'ORIGINAL'}: ${d.title || 'document'}${d.issued_on ? ` (issued ${ymd(d.issued_on)})` : ''}\n${pages.join('\n\n')}`);
  }
  return parts.join('\n\n').slice(0, MAX_TEXT);
}

// Pure mapping. `ctx` = { source, docs, pagesByDoc }. Returns { skip: reason } or { payload }.
function toRecord(row, ctx = {}) {
  if (!row || !row.id) return { skip: 'no_id' };
  if (row.is_sample || (row.data && row.data.sample)) return { skip: 'sample_record' };
  if (!PUSHABLE.has(row.lifecycle)) return { skip: `lifecycle_${String(row.lifecycle || '').toLowerCase()}` };
  const data = row.data || {};
  const source = ctx.source || null;
  const docs = ctx.docs || [];
  const original = docs.find((d) => d.kind === 'ORIGINAL') || docs[0] || null;
  const docUrl = (original && /^https:\/\//.test(original.url || '') && original.url) || null;
  const text = composeText(docs, ctx.pagesByDoc || new Map());
  if (!text) return { skip: 'no_notice_text' };                 // nothing real to ground an answer or an eligibility check on

  const dates = data.dates || {};
  const unreachable = !!(source && source.last_failure_at && (!source.last_success_at || new Date(source.last_failure_at) > new Date(source.last_success_at)));
  const verified = row.verification || {};
  const payload = {
    record_id: `gc:${String(row.id).replace(/[^A-Za-z0-9_.:\-]/g, '_')}`.slice(0, 80),
    organization: data.organization || row.organization || (source && source.organization) || '',
    role: data.title || row.title || '',
    title: row.title || data.title || '',
    url: docUrl || (source && /^https:\/\//.test(source.portal_url || '') ? source.portal_url : '') || '',
    text,
    published_at: ymd(row.published_at),
    opens_at: ymd(dates.application_open),
    deadline: ymd(dates.application_close),
    location: data.state || '',
    authority: authorityOf(row, source, docUrl),
    // Freshness is the source's last SUCCESSFUL check. Never "now", never the publication time.
    last_verified_at: iso(source && source.last_success_at),
    source_status: !source ? 'never_checked' : unreachable ? 'unreachable' : source.last_success_at ? 'reachable' : 'never_checked',
    source_error: unreachable ? String(source.last_error || 'last check failed').slice(0, 200) : '',
    extraction_status: verified.level === 'AUTO_EXTRACTED' || verified.awaiting_human_audit ? 'auto_extracted' : 'reviewed',
    domain: 'government',
  };
  if (data.advt_no || data.notification_no) payload.advt_no = String(data.advt_no || data.notification_no);
  if (!payload.organization || !payload.role) return { skip: 'missing_organization_or_role' };
  return { payload };
}

// ---- database loading (parameterised, read-only) ---------------------------------------------------------------
async function loadRows(db, { limit = 500 } = {}) {
  const rows = (await db.query(
    "SELECT * FROM recruitments WHERE NOT is_sample AND data IS NOT NULL ORDER BY updated_at DESC LIMIT $1", [Math.max(1, Math.min(2000, limit))])).rows;
  const out = [];
  for (const row of rows) {
    const source = row.source_id ? (await db.query('SELECT * FROM sources WHERE source_id=$1', [row.source_id])).rows[0] : null;
    const docs = (await db.query(
      "SELECT id,title,kind,url,issued_on FROM documents WHERE recruitment_id=$1 AND scan_status='CLEAN' ORDER BY (kind='ORIGINAL') DESC, issued_on DESC NULLS LAST, id DESC", [row.id])).rows;
    const pagesByDoc = new Map();
    for (const d of docs) pagesByDoc.set(d.id, (await db.query('SELECT page_number,text FROM document_pages WHERE document_id=$1 ORDER BY page_number', [d.id])).rows);
    out.push({ row, ctx: { source, docs, pagesByDoc } });
  }
  return out;
}

// ---- transport -------------------------------------------------------------------------------------------------
function post(conf, path, body, method = 'POST') {
  return new Promise((resolve) => {
    let u; try { u = new URL(conf.url + path); } catch { return resolve({ status: 0, body: { code: 'AI_SERVICE_NOT_CONFIGURED' } }); }
    const raw = body == null ? '' : JSON.stringify(body);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method, timeout: conf.timeoutMs,
      headers: { accept: 'application/json', 'x-service-token': conf.token, 'x-user-role': 'admin',
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) },
    }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => { let parsed = {}; try { parsed = data ? JSON.parse(data) : {}; } catch { /* non-JSON */ } resolve({ status: res.statusCode || 502, body: parsed }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: { code: 'AI_SERVICE_UNAVAILABLE' } }));
    if (raw) req.write(raw);
    req.end();
  });
}

// One full pass. `push(path, body, method)` is injectable for tests. Never throws; returns an honest summary.
async function sync({ db, push, env = process.env, limit = 500 } = {}) {
  const conf = cfg(env);
  const send = push || ((p, b, m) => post(conf, p, b, m));
  if (!push && (!conf.url || !conf.token)) {
    return { ok: false, code: 'AI_SERVICE_NOT_CONFIGURED', message: 'AI_ML_SERVICE_URL and AI_ML_SERVICE_TOKEN must be set to sync recruitment records.', pushed: 0, skipped: {}, failed: [] };
  }
  const summary = { ok: true, pushed: 0, removed: 0, skipped: {}, failed: [], unreachable_sources: 0, at: new Date().toISOString() };
  let loaded;
  try { loaded = await loadRows(db, { limit }); } catch (e) { return { ...summary, ok: false, code: 'DB_READ_FAILED', message: String(e && e.message || e).slice(0, 200) }; }
  for (const { row, ctx } of loaded) {
    if (row.lifecycle === 'ARCHIVED') {                      // retracted / archived: stop serving it as an answer source
      const rid = `gc:${String(row.id).replace(/[^A-Za-z0-9_.:\-]/g, '_')}`.slice(0, 80);
      const r = await send(`/rag/hybrid/records/${encodeURIComponent(rid)}`, null, 'DELETE');
      if (r.status === 200) summary.removed += 1;           // 404 = never indexed: nothing to do
      continue;
    }
    const m = toRecord(row, ctx);
    if (m.skip) { summary.skipped[m.skip] = (summary.skipped[m.skip] || 0) + 1; continue; }
    if (m.payload.source_status === 'unreachable') summary.unreachable_sources += 1;
    const r = await send('/rag/hybrid/records', m.payload, 'POST');
    if (r.status === 200 || r.status === 201) summary.pushed += 1;
    else summary.failed.push({ id: row.id, status: r.status, code: (r.body && (r.body.code || (r.body.detail && r.body.detail.code))) || 'PUSH_FAILED' });
  }
  if (summary.failed.length) summary.ok = false;
  return summary;
}

// Ask the AI service whether its index is empty (restart / never synced). Never throws.
// `get(path)` is injectable for tests. Returns { ok, needsSync, records, reranker, persistence } or { ok:false, code }.
async function health({ get, env = process.env } = {}) {
  const conf = cfg(env);
  const call = get || ((p) => post(conf, p, null, 'GET'));
  if (!get && (!conf.url || !conf.token)) return { ok: false, code: 'AI_SERVICE_NOT_CONFIGURED' };
  const r = await call('/rag/hybrid/status');
  if (r.status !== 200) return { ok: false, code: (r.body && r.body.code) || 'AI_SERVICE_UNAVAILABLE', status: r.status };
  const b = r.body || {};
  return { ok: true, needsSync: b.needs_sync === true || Number(b.records) === 0, records: Number(b.records) || 0, reranker: b.reranker || null, persistence: b.persistence || null };
}

// Sync only if the AI service came back empty. Cheap (one GET) so it can run every couple of minutes.
async function syncIfEmpty(opts = {}) {
  const h = await health(opts);
  if (!h.ok) return { ok: false, skipped: 'ai_service_unreachable', code: h.code, pushed: 0, removed: 0, failed: [] };
  if (!h.needsSync) return { ok: true, skipped: 'index_not_empty', records: h.records, pushed: 0, removed: 0, failed: [] };
  return { ...(await sync(opts)), recovered: true };
}

module.exports = { health, syncIfEmpty, toRecord, composeText, authorityOf, loadRows, sync, cfg, PUSHABLE };
