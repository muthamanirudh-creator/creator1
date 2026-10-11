// Agent implementations and the orchestrator that moves one document from download to the review queue.
// Nothing here can publish: publishing is a human action in lib/review.js.
const crypto = require('crypto');
const db = require('./db');
const repo = require('./repo');
const registry = require('./registry');
const lifecycle = require('./lifecycle');
const { audit } = require('./audit');
const pipeline = require('./docpipeline');
const { extractDocument, addLineage, REQUIRED_KEYS } = require('./extract');
const { analyzeFraud } = require('./fraud');
const { findDuplicates } = require('./dedupe');
const { findConflicts } = require('./conflict');
const { detectChanges } = require('./diff');
const crawler = require('./crawler');
const queue = require('./queue');
const { route, toolbox } = require('./agents');

const BUCKET_ORDER = ['suspicious', 'conflicting_sources', 'changed_source', 'broken_link', 'potential_duplicate', 'low_confidence', 'medium_confidence', 'high_confidence'];
const BUCKET_BASE = { suspicious: 100, conflicting_sources: 90, changed_source: 80, low_confidence: 70, potential_duplicate: 60, broken_link: 50, medium_confidence: 40, high_confidence: 20 };

function makeTools(env = {}) {
  const asActor = (agent) => ({ type: 'agent', name: agent });
  return {
    'registry.get': registry.getSource,
    'registry.domains': registry.registryDomains,
    'crawler.crawl': (src) => crawler.crawlSource(src, env.crawl),
    'queue.enqueue': queue.enqueue,
    'audit.log': (actor, action, type, id, detail) => audit(`agent:${actor}`, action, type, id, detail),
    'pipeline.validate': pipeline.validateFile,
    'pipeline.scan': pipeline.scan,
    'pipeline.extract': (buf, mime) => pipeline.extractPages(buf, mime, { ocrLangs: (process.env.OCR_LANGS || 'eng,hin,tel').split(',') }),
    'pipeline.sections': (pages) => pages.flatMap((p) => pipeline.detectSections(p.text).map((s) => ({ page_number: p.page_number, ...s }))),
    'store.findDocBySha': repo.findDocBySha,
    'store.findRecruitmentByUrl': repo.findRecruitmentByUrl,
    'store.getRecruitment': (id) => repo.getRecruitment(id),
    'store.latestDocumentId': async (rid) => { const r = await db.query('SELECT id FROM documents WHERE recruitment_id=$1 ORDER BY id DESC LIMIT 1', [rid]); return r.rows[0] ? r.rows[0].id : null; },
    'store.saveFile': repo.saveFile,
    'store.createRecruitment': async (id, sourceId) => { await db.tx(async (c) => { await c.query("INSERT INTO recruitments(id,source_id,lifecycle) VALUES ($1,$2,'DISCOVERED')", [id, sourceId]); await c.query("INSERT INTO lifecycle_events(recruitment_id,from_state,to_state,actor,reason) VALUES ($1,NULL,'DISCOVERED','agent:Document','Document received')", [id]); await audit('agent:Document', 'LIFECYCLE', 'recruitment', id, { from: null, to: 'DISCOVERED' }, c); }); },
    'store.insertDocument': async (d, pages, sections) => db.tx(async (c) => {
      const r = await c.query(`INSERT INTO documents(source_id,recruitment_id,url,title,kind,issued_on,sha256,mime,size_bytes,storage_path,page_count,is_scanned,language,scan_status,scan_method,supersedes_document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CLEAN',$14,$15) RETURNING id`,
        [d.source_id, d.recruitment_id, d.url, d.title, d.kind, d.issued_on, d.sha256, d.mime, d.size, d.storage_path, pages.length, pages.some((p) => p.method === 'OCR'), d.language || 'en', d.scan_method, d.supersedes]);
      const id = r.rows[0].id;
      for (const p of pages) await c.query('INSERT INTO document_pages(document_id,page_number,text,method,ocr_confidence,columns,tables) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, p.page_number, p.text, p.method, p.ocr_confidence, p.columns, JSON.stringify(p.tables)]);
      for (const s of sections) await c.query('INSERT INTO document_sections(document_id,page_number,section,heading,start_char,end_char) VALUES ($1,$2,$3,$4,$5,$6)', [id, s.page_number, s.section, s.heading, s.start, s.end]);
      return id;
    }),
    'lifecycle.advance': (id, to, agent, reason) => {
      if (lifecycle.HUMAN_ONLY.includes(to)) throw new Error(`Agents cannot move a recruitment to ${to}`);
      return lifecycle.transition(id, to, asActor(agent), reason);
    },
    'extract.run': (pages, ctx) => extractDocument(pages, { ...ctx, skipLlm: env.skipLlm, llm: env.llm }),
    'extract.lineage': addLineage,
    'store.saveExtractionRun': async (docId, x) => (await db.query(`INSERT INTO extraction_runs(document_id,provider,model,status,fields,record,validation_errors,provider_attempts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [docId, x.provider, x.model, x.schema_valid ? 'OK' : 'SCHEMA_REJECTED', JSON.stringify(x.fields), JSON.stringify(x.record), JSON.stringify(x.schema_errors), JSON.stringify(x.attempts)])).rows[0].id,
    'fraud.analyze': analyzeFraud,
    'store.dedupeCorpus': repo.dedupeCorpus,
    'dedupe.find': findDuplicates,
    'store.latestApproved': async (rid) => (await db.query("SELECT * FROM recruitment_versions WHERE recruitment_id=$1 AND status='APPROVED' ORDER BY version_no DESC LIMIT 1", [rid])).rows[0],
    'store.documentsFor': async (rid) => (await db.query(`SELECT d.id AS document_id, d.kind, d.issued_on, d.fetched_at, v.data, (s.verification_status='VERIFIED') AS official
      FROM documents d JOIN recruitment_versions v ON v.document_id=d.id LEFT JOIN sources s ON s.source_id=d.source_id WHERE d.recruitment_id=$1 AND v.status IN ('APPROVED','PENDING')`, [rid])).rows,
    'conflict.find': findConflicts,
    'diff.detect': detectChanges,
    'link.check': async (url) => (env.linkCheck ? env.linkCheck(url) : { ok: true, skipped: true }),
    'store.createVersion': async (rid, docId, runId, data, lineage, valid, conf) => {
      const n = (await repo.latestVersionNo(rid)) + 1;
      const r = await db.query('INSERT INTO recruitment_versions(recruitment_id,version_no,document_id,extraction_run_id,data,lineage,schema_valid,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,version_no',
        [rid, n, docId, runId, JSON.stringify(data), JSON.stringify(lineage), valid, conf]);
      return r.rows[0];
    },
    'store.createReviewItem': async (rid, vid, buckets, primary, priority, reasons) => {
      await db.query("UPDATE review_items SET status='REJECTED', resolved_at=now(), resolved_by='system:superseded by a newer document' WHERE recruitment_id=$1 AND status='OPEN'", [rid]);
      return (await db.query('INSERT INTO review_items(recruitment_id,version_id,buckets,primary_bucket,priority,reasons) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [rid, vid, buckets, primary, priority, JSON.stringify(reasons)])).rows[0].id;
    },
    'store.saveChanges': async (rid, from, to, changes, docTitle) => { for (const c of changes) await db.query('INSERT INTO change_events(recruitment_id,from_version,to_version,field,label,from_value,to_value,delta,source,supported,message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [rid, from, to, c.field, c.label, c.from_value, c.to_value, c.delta, c.supported && c.source.to ? `${docTitle}, page ${c.source.to.page}` : null, c.supported, c.message]); },
    'store.saveConflicts': async (rid, list) => { for (const c of list) await db.query('INSERT INTO conflicts(recruitment_id,field,candidates,resolution,chosen) VALUES ($1,$2,$3,$4,$5)', [rid, c.field, JSON.stringify(c.candidates), c.resolution, c.chosen ? JSON.stringify(c.chosen) : null]); },
  };
}

// ---------- agents ----------
const PUBLISHED_STATES = ['PUBLISHED', 'APPLICATION_CLOSED', 'EXAM_PHASE', 'RESULT_PHASE'];

const AGENTS = {
  async SourceDiscovery(ctx, tb) {
    const source = await tb.call('registry.get', ctx.sourceId);
    const res = await tb.call('crawler.crawl', source);
    if (res.skipped) return { skipped: res.skipped };
    let enqueued = 0;
    // First look at a source: take a bounded backlog so old advertisements do not flood in as "new". Later looks take every
    // new link (bounded per run). Documents whose closing date is long past are kept out of the public feed by autopublish.
    const baseline = !(source.last_links && source.last_links.length) && !source.last_success_at;
    const cap = baseline ? Number(process.env.INITIAL_BACKFILL || 15) : Number(process.env.MAX_NEW_PER_CRAWL || 25);
    for (const l of (res.fresh || []).slice(0, cap)) { await tb.call('queue.enqueue', 'PROCESS_URL', { sourceId: ctx.sourceId, url: l.url, title: l.title }); enqueued++; }
    if ((res.rejected || []).length) await tb.call('audit.log', 'SourceDiscovery', 'OFF_DOMAIN_LINKS_IGNORED', 'source', ctx.sourceId, { links: res.rejected.slice(0, 20) });
    return { health: res.health, enqueued, rejected: (res.rejected || []).length };
  },

  async Document(ctx, tb) {
    const v = tb.call('pipeline.validate', ctx.buffer);
    if (!v.ok) { await tb.call('audit.log', 'Document', 'DOCUMENT_REJECTED', 'document', null, { title: ctx.title, errors: v.errors }); return { stop: true, rejected: v.errors }; }
    const s = tb.call('pipeline.scan', ctx.buffer, v.mime);
    if (s.status !== 'CLEAN') { await tb.call('audit.log', 'Document', 'DOCUMENT_REJECTED', 'document', null, { title: ctx.title, scan: s }); return { stop: true, rejected: s.findings, scan: s }; }
    const sha = pipeline.sha256(ctx.buffer);
    const dup = await tb.call('store.findDocBySha', sha);
    if (dup) { await tb.call('audit.log', 'Document', 'DUPLICATE_DOCUMENT_SKIPPED', 'document', dup.id, { sha256: sha, title: ctx.title }); return { stop: true, duplicate_of: dup.id, recruitment_id: dup.recruitment_id }; }

    let pages;
    try { pages = tb.call('pipeline.extract', ctx.buffer, v.mime); } catch (e) { await tb.call('audit.log', 'Document', 'EXTRACTION_FAILED', 'document', null, { title: ctx.title, error: e.message }); return { stop: true, rejected: [e.message] }; }
    if (!pages.some((p) => p.text.trim())) return { stop: true, rejected: ['No readable text found, even after OCR.'] };

    let rid = ctx.recruitmentId || ((await tb.call('store.findRecruitmentByUrl', ctx.url)) || {}).recruitment_id;
    let isNew = false;
    if (!rid) { rid = `rec-${sha.slice(0, 10)}`; await tb.call('store.createRecruitment', rid, ctx.sourceId); isNew = true; }
    const rec = await tb.call('store.getRecruitment', rid);
    if (!rec) throw new Error(`Unknown recruitment ${rid}`);
    if (isNew) await tb.call('lifecycle.advance', rid, 'INGESTED', 'Document', 'Document downloaded, scanned and read');
    else if (PUBLISHED_STATES.includes(rec.lifecycle)) await tb.call('lifecycle.advance', rid, 'UPDATED', 'Document', 'A newer document arrived for a published recruitment');
    const storage_path = tb.call('store.saveFile', sha, v.mime, ctx.buffer);
    const prevDocId = await tb.call('store.latestDocumentId', rid);
    const docId = await tb.call('store.insertDocument', {
      source_id: ctx.sourceId, recruitment_id: rid, url: ctx.url || null, title: ctx.title, kind: ctx.kind || (isNew ? 'ORIGINAL' : 'AMENDMENT'), issued_on: ctx.issuedOn || null,
      sha256: sha, mime: v.mime, size: ctx.buffer.length, storage_path, scan_method: s.method, supersedes: prevDocId,
    }, pages, tb.call('pipeline.sections', pages));
    return { documentId: docId, kind: ctx.kind || (isNew ? 'ORIGINAL' : 'AMENDMENT'), recruitmentId: rid, isNew, pages, mime: v.mime, scan: s };
  },

  async Extraction(ctx, tb) {
    const source = ctx.source;
    const x = await tb.call('extract.run', ctx.pages, { source });
    const runId = await tb.call('store.saveExtractionRun', ctx.documentId, x);
    if (ctx.isNew) await tb.call('lifecycle.advance', ctx.recruitmentId, 'EXTRACTED', 'Extraction', x.schema_valid ? 'Extracted and schema-valid' : 'Extraction failed schema validation (rejected, not guessed)');
    return { extraction: x, runId };
  },

  async Citation(ctx, tb) {
    return { lineage: tb.call('extract.lineage', ctx.pages, ctx.extraction.fields, ctx.documentId) };
  },

  async Verification(ctx, tb) {
    const x = ctx.extraction; const reasons = []; const doc = ctx.documentTitle;
    const domains = await tb.call('registry.domains');
    const fraud = tb.call('fraud.analyze', { pages: ctx.pages, record: x.record, source: ctx.source, registryDomains: domains });
    reasons.push(...fraud.map((f) => ({ ...f, bucket: 'suspicious' })));
    for (const e of x.schema_errors) reasons.push({ code: 'SCHEMA_REJECTED', severity: 'high', message: `${e.path}: ${e.message}`, bucket: 'low_confidence' });
    for (const f of x.flags) reasons.push({ ...f, severity: 'medium', bucket: 'low_confidence' });
    for (const n of x.notes) reasons.push({ code: 'EXTRACTOR_NOTE', severity: 'low', message: n, bucket: 'medium_confidence' });
    for (const d of x.disagreements) reasons.push({ code: 'EXTRACTOR_DISAGREEMENT', severity: 'medium', message: `Rule-based reading and AI reading disagree on ${d.key}. Rules: ${JSON.stringify(d.rules)}. AI: ${JSON.stringify(d.ai)}.`, bucket: 'low_confidence' });

    const corpus = await tb.call('store.dedupeCorpus');
    const dups = tb.call('dedupe.find', x.record, corpus, { ignoreId: ctx.recruitmentId });
    for (const d of dups) reasons.push({ code: 'POTENTIAL_DUPLICATE', severity: 'medium', message: `Looks like "${d.title}" (${d.id}), similarity ${d.score}.`, bucket: 'potential_duplicate' });

    let changes = [];
    const prev = ctx.isNew ? null : await tb.call('store.latestApproved', ctx.recruitmentId);
    if (prev && x.schema_valid) {
      changes = tb.call('diff.detect', { data: prev.data, lineage: prev.lineage }, { data: x.record, lineage: ctx.lineage });
      if (changes.length) reasons.push({ code: 'OFFICIAL_UPDATE', severity: 'medium', message: `${changes.length} field(s) differ from the published version.`, bucket: 'changed_source' });
      for (const c of changes.filter((c) => !c.supported)) reasons.push({ code: 'UNSUPPORTED_CHANGE', severity: 'medium', message: `${c.label} changed, but a cited source is missing in one version. It will not be shown to users.`, bucket: 'changed_source' });
    }

    let conflicts = [];
    if (!ctx.isNew) {
      const docs = await tb.call('store.documentsFor', ctx.recruitmentId);
      docs.push({ document_id: ctx.documentId, kind: ctx.docKind, issued_on: ctx.issuedOn || null, fetched_at: new Date().toISOString(), official: ctx.source.verification_status === 'VERIFIED', data: x.record });
      conflicts = tb.call('conflict.find', docs);
      for (const c of conflicts) {
        const stale = c.resolution === 'UNRESOLVED' || (c.chosen && c.chosen.document_id !== ctx.documentId);
        if (stale) reasons.push({ code: 'SOURCE_CONFLICT', severity: 'high', message: `Documents disagree on ${c.field}${c.resolution === 'UNRESOLVED' ? ' and no source clearly outranks the other.' : '; an older document disagrees with a newer authoritative one.'}`, bucket: 'conflicting_sources' });
      }
    }

    const link = x.record.application_link;
    if (link) { const r = await tb.call('link.check', link); if (!r.ok) reasons.push({ code: 'BROKEN_LINK', severity: 'medium', message: `The application link did not respond (${r.error || r.status}).`, bucket: 'broken_link' }); }
    return { reasons, changes, conflicts, duplicates: dups, fraud };
  },

  async Quality(ctx, tb) {
    const x = ctx.extraction; const lin = ctx.lineage;
    const present = REQUIRED_KEYS.filter((k) => lin[k]);
    const avg = present.length ? present.reduce((a, k) => a + lin[k].confidence, 0) / present.length : 0;
    let conf = Math.round(avg * (present.length / REQUIRED_KEYS.length) * 100) / 100;
    if (!x.schema_valid) conf = Math.min(conf, 0.4);
    if (x.disagreements.length) conf = Math.min(conf, 0.5);
    const buckets = new Set(ctx.verification.reasons.map((r) => r.bucket));
    const confBucket = conf >= 0.9 ? 'high_confidence' : conf >= 0.7 ? 'medium_confidence' : 'low_confidence';
    buckets.add(confBucket);
    if (buckets.size > 1 && confBucket === 'high_confidence') buckets.delete('high_confidence');
    const list = BUCKET_ORDER.filter((b) => buckets.has(b));
    const primary = list[0];
    let priority = BUCKET_BASE[primary] + Math.min(15, 5 * (list.length - 1));
    const close = x.record.dates && x.record.dates.application_close && Date.parse(x.record.dates.application_close);
    const days = close ? (close - Date.now()) / 86400000 : null;
    if (days !== null && days >= 0 && days <= 7) priority += 15;
    if (!ctx.isNew) priority += 10;

    const version = await tb.call('store.createVersion', ctx.recruitmentId, ctx.documentId, ctx.runId, x.record, ctx.lineage, x.schema_valid, conf);
    if (ctx.verification.changes.length) { const prevNo = version.version_no - 1; await tb.call('store.saveChanges', ctx.recruitmentId, prevNo, version.version_no, ctx.verification.changes, ctx.documentTitle); }
    if (ctx.verification.conflicts.length) await tb.call('store.saveConflicts', ctx.recruitmentId, ctx.verification.conflicts);
    const itemId = await tb.call('store.createReviewItem', ctx.recruitmentId, version.id, list, primary, priority, ctx.verification.reasons);

    const lc = (await tb.call('store.getRecruitment', ctx.recruitmentId)).lifecycle;
    if (lc === 'EXTRACTED') await tb.call('lifecycle.advance', ctx.recruitmentId, 'VALIDATING', 'Quality', 'Running checks');
    if (lc !== 'REVIEW_REQUIRED') await tb.call('lifecycle.advance', ctx.recruitmentId, 'REVIEW_REQUIRED', 'Quality', `Queued for human review (${primary})`);
    return { reviewItemId: itemId, versionId: version.id, versionNo: version.version_no, confidence: conf, buckets: list, priority };
  },
};

// ---------- orchestrator ----------
async function ingestDocument(input, env = {}) {
  const tools = makeTools(env);
  const agents = route('PROCESS_DOCUMENT');
  const ctx = { ...input, source: await registry.getSource(input.sourceId) };
  if (!ctx.source) throw new Error(`Source ${input.sourceId} is not in the registry`);
  const trace = [];
  const run = async (name) => { const out = await AGENTS[name](ctx, toolbox(name, tools)); trace.push(name); return out; };

  const d = await run('Document');
  if (d.stop) return { status: 'STOPPED', ...d, agents_run: trace };
  Object.assign(ctx, { docKind: d.kind, documentId: d.documentId, recruitmentId: d.recruitmentId, isNew: d.isNew, pages: d.pages, documentTitle: input.title });
  const e = await run('Extraction'); ctx.extraction = e.extraction; ctx.runId = e.runId;
  const c = await run('Citation'); ctx.lineage = c.lineage;
  ctx.verification = await run('Verification');
  const q = await run('Quality');
  await audit('system:orchestrator', 'DOCUMENT_PROCESSED', 'recruitment', ctx.recruitmentId, { agents_run: trace, document_id: ctx.documentId, review_item: q.reviewItemId, buckets: q.buckets });
  return { status: 'REVIEW_REQUIRED', recruitmentId: ctx.recruitmentId, documentId: ctx.documentId, schema_valid: ctx.extraction.schema_valid, changes: ctx.verification.changes.filter((x) => x.supported).map((x) => x.message), agents_run: trace, ...q };
}

// ---------- queue handlers ----------
function handlers(env = {}) {
  return {
    async CRAWL_SOURCE(p) { const tools = makeTools(env); return AGENTS.SourceDiscovery({ sourceId: p.sourceId }, toolbox('SourceDiscovery', tools)); },
    async PROCESS_URL(p) {
      const source = await registry.getSource(p.sourceId);
      if (!source || !source.crawl_enabled || source.verification_status !== 'VERIFIED') throw new Error('Source is not enabled for crawling');
      const buffer = await crawler.downloadDocument(p.url, source, env.crawl);
      const out = await ingestDocument({ buffer, title: p.title || p.url.split('/').pop(), url: p.url, sourceId: p.sourceId }, env);
      // Automatic lane (lib/autopublish.js): publishes only when every evidence rule holds; otherwise the item stays in the
      // review queue and is shown as "detected, not yet verified". ingestDocument itself still never publishes.
      if (out.status === 'REVIEW_REQUIRED' && out.reviewItemId && env.autoPublish !== false) {
        try { out.auto = await require('./autopublish').tryAutoPublish(out.reviewItemId, env.autoPublishDeps || {}); }
        catch (e) { out.auto = { published: false, error: e.message }; await audit('system:orchestrator', 'AUTO_PUBLISH_ERROR', 'review_item', out.reviewItemId, { error: e.message }); }
      }
      return out;
    },
    async ADVANCE_LIFECYCLE() { return lifecycle.advanceByDates(); },
    async SCHEDULE_CRAWLS() {
      const due = (await db.query("SELECT source_id FROM sources WHERE crawl_enabled AND verification_status='VERIFIED' AND (last_success_at IS NULL OR last_success_at < now() - (crawl_frequency_minutes || ' minutes')::interval) AND (cooldown_until IS NULL OR cooldown_until < now()) AND NOT EXISTS (SELECT 1 FROM job_queue q WHERE q.type='CRAWL_SOURCE' AND q.status IN ('PENDING','RUNNING') AND q.payload->>'sourceId' = sources.source_id)")).rows;
      for (const s of due) await queue.enqueue('CRAWL_SOURCE', { sourceId: s.source_id });
      return due.length;
    },
  };
}

module.exports = { ingestDocument, handlers, makeTools, AGENTS, BUCKET_ORDER };
