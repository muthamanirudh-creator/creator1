// Human moderation: the ONLY place a recruitment can become VERIFIED or PUBLISHED. Every action is audit-logged.
const db = require('./db');
const { audit } = require('./audit');
const lifecycle = require('./lifecycle');
const { validateRecord } = require('./schema');
const { locate } = require('./extract');
const { detectSections, sectionAt } = require('./docpipeline');
const { ROLES } = require('./auth');

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const actorOf = (u) => ({ type: 'human', name: u.email });
const need = (user, role) => { if (ROLES[user.role] < ROLES[role]) throw httpErr(403, 'Your role cannot do this.'); };

const FIELD_LABELS = {
  title: 'Post title', organization: 'Organization', department: 'Department', state: 'State', 'dates.application_open': 'Applications open', 'dates.application_close': 'Applications close', 'dates.exam_date': 'Exam date',
  education: 'Education', 'age.min': 'Minimum age', 'age.max': 'Maximum age', 'age.cutoff_date': 'Age cutoff date', 'age.relaxation': 'Age relaxation', experience_years: 'Experience (years)', domicile: 'Domicile', physical: 'Physical standards',
  fee: 'Fee', 'vacancies.total': 'Total vacancies', 'vacancies.breakdown': 'Vacancies by category', 'vacancies.pwbd': 'PwBD vacancies', 'vacancies.ex_servicemen': 'Ex-servicemen vacancies', selection: 'Selection process', application_link: 'Application link',
};
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) { x[ks[i]] = x[ks[i]] || {}; x = x[ks[i]]; } x[ks[ks.length - 1]] = v; }

async function listQueue({ bucket, status = 'OPEN', limit = 100 } = {}) {
  const rows = (await db.query(`SELECT i.id, i.recruitment_id, i.buckets, i.primary_bucket, i.priority, i.status, i.created_at, v.version_no, v.confidence, v.schema_valid,
      v.data->>'title' AS title, v.data->>'organization' AS organization, r.lifecycle, r.published_at IS NOT NULL AS is_update
    FROM review_items i JOIN recruitment_versions v ON v.id=i.version_id JOIN recruitments r ON r.id=i.recruitment_id
    WHERE i.status=$1 AND ($2::text IS NULL OR $2 = ANY(i.buckets)) ORDER BY i.priority DESC, i.created_at LIMIT $3`, [status, bucket || null, limit])).rows;
  const counts = (await db.query("SELECT b AS bucket, COUNT(*)::int n FROM review_items, unnest(buckets) b WHERE status='OPEN' GROUP BY b")).rows;
  return { items: rows, bucket_counts: Object.fromEntries(counts.map((c) => [c.bucket, c.n])) };
}

async function getItem(id) {
  const item = (await db.query('SELECT * FROM review_items WHERE id=$1', [id])).rows[0];
  if (!item) throw httpErr(404, 'Review item not found.');
  const version = (await db.query('SELECT * FROM recruitment_versions WHERE id=$1', [item.version_id])).rows[0];
  const recruitment = (await db.query('SELECT id,source_id,lifecycle,published_version,published_at FROM recruitments WHERE id=$1', [item.recruitment_id])).rows[0];
  const docIds = [...new Set(Object.values(version.lineage).map((l) => l.document_id))].concat(version.document_id);
  const documents = (await db.query('SELECT id,title,kind,issued_on,sha256,mime,page_count,is_scanned,scan_method,url FROM documents WHERE id = ANY($1) ORDER BY id', [[...new Set(docIds)]])).rows;
  const pages = (await db.query('SELECT document_id,page_number,text,method,ocr_confidence FROM document_pages WHERE document_id = ANY($1) ORDER BY document_id,page_number', [documents.map((d) => d.id)])).rows;
  const changes = (await db.query('SELECT field,label,from_value,to_value,delta,supported,message,source FROM change_events WHERE recruitment_id=$1 AND to_version=$2 ORDER BY id', [item.recruitment_id, version.version_no])).rows;
  const conflicts = (await db.query('SELECT field,candidates,resolution,chosen FROM conflicts WHERE recruitment_id=$1 ORDER BY id DESC LIMIT 20', [item.recruitment_id])).rows;
  const fields = Object.keys(FIELD_LABELS).map((key) => ({ key, label: FIELD_LABELS[key], value: get(version.data, key), lineage: version.lineage[key] || null })).filter((f) => f.value !== undefined || f.lineage || ['title', 'dates.application_close', 'vacancies.total', 'age.max', 'education', 'domicile'].includes(f.key));
  return { item, recruitment, version: { id: version.id, version_no: version.version_no, status: version.status, schema_valid: version.schema_valid, confidence: version.confidence, data: version.data }, fields, documents, pages, changes, conflicts };
}

// edits: [{ path, value, source?: { page, quote? } }]
async function applyEdits(version, edits, user) {
  const data = JSON.parse(JSON.stringify(version.data)); const lineage = JSON.parse(JSON.stringify(version.lineage));
  const pages = (await db.query('SELECT page_number,text FROM document_pages WHERE document_id=$1', [version.document_id])).rows;
  const sectionsByPage = Object.fromEntries(pages.map((p) => [p.page_number, detectSections(p.text)]));
  for (const e of edits) {
    if (!FIELD_LABELS[e.path]) throw httpErr(400, `Unknown field ${e.path}.`);
    setPath(data, e.path, e.value);
    const prev = lineage[e.path] || {};
    const page = (e.source && e.source.page) || prev.page_number;
    if (!page) throw httpErr(400, `Cite the page in the source document for ${FIELD_LABELS[e.path]}.`);
    const pg = pages.find((p) => p.page_number === page);
    if (!pg) throw httpErr(400, `Page ${page} does not exist in the source document.`);
    let loc = prev.source_text_location || null; let quote = prev.quote || null;
    if (e.source && e.source.quote) { loc = locate(pg.text, e.source.quote); if (!loc) throw httpErr(400, `That passage was not found on page ${page}.`); quote = e.source.quote; }
    lineage[e.path] = { document_id: version.document_id, page_number: page, section: sectionAt(sectionsByPage, page, loc ? loc.start : 0), source_text_location: loc, quote, extraction_method: 'HUMAN_EDIT', confidence: 1, value: e.value, edited_by: user.email };
  }
  return { data, lineage };
}

async function approve(itemId, user, { edits = [], note = '' } = {}) {
  need(user, 'REVIEWER');
  return db.tx(async (c) => {
    const item = (await c.query('SELECT * FROM review_items WHERE id=$1 FOR UPDATE', [itemId])).rows[0];
    if (!item) throw httpErr(404, 'Review item not found.');
    if (item.status !== 'OPEN') throw httpErr(409, 'This item has already been resolved.');
    if (item.buckets.includes('suspicious')) { need(user, 'ADMIN'); if (String(note).trim().length < 10) throw httpErr(400, 'Suspicious items need an administrator note explaining why they are safe.'); }
    if ((item.buckets.includes('conflicting_sources') || item.buckets.includes('potential_duplicate')) && String(note).trim().length < 10) throw httpErr(400, 'Explain how you resolved the conflict or duplicate in a note.');
    const version = (await c.query('SELECT * FROM recruitment_versions WHERE id=$1 FOR UPDATE', [item.version_id])).rows[0];
    let { data, lineage } = version;
    if (edits.length) ({ data, lineage } = await applyEdits(version, edits, user));
    const errors = validateRecord(data);
    if (errors.length) throw httpErr(400, 'The record still fails schema validation. Fix these fields first.', { errors });
    await c.query("UPDATE recruitment_versions SET data=$2, lineage=$3, schema_valid=TRUE, status='APPROVED' WHERE id=$1", [version.id, JSON.stringify(data), JSON.stringify(lineage)]);
    await c.query("UPDATE review_items SET status='APPROVED', resolved_at=now(), resolved_by=$2 WHERE id=$1", [itemId, user.email]);
    await lifecycle.transition(item.recruitment_id, 'VERIFIED', actorOf(user), note || 'Approved by reviewer', c);
    await audit(`human:${user.email}`, edits.length ? 'REVIEW_APPROVED_WITH_EDITS' : 'REVIEW_APPROVED', 'review_item', itemId, { recruitment_id: item.recruitment_id, version: version.version_no, edits: edits.map((e) => ({ path: e.path, from: get(version.data, e.path), to: e.value })), note }, c);
    return { ok: true, recruitment_id: item.recruitment_id, lifecycle: 'VERIFIED' };
  });
}

async function publish(recruitmentId, user) {
  need(user, 'REVIEWER');
  return db.tx(async (c) => {
    const rec = (await c.query('SELECT * FROM recruitments WHERE id=$1 FOR UPDATE', [recruitmentId])).rows[0];
    if (!rec) throw httpErr(404, 'Recruitment not found.');
    if (rec.lifecycle !== 'VERIFIED') throw httpErr(409, `Only a VERIFIED recruitment can be published (currently ${rec.lifecycle}).`);
    const v = (await c.query("SELECT * FROM recruitment_versions WHERE recruitment_id=$1 AND status='APPROVED' ORDER BY version_no DESC LIMIT 1", [recruitmentId])).rows[0];
    if (!v || !v.schema_valid) throw httpErr(409, 'There is no approved, schema-valid version to publish.');
    await c.query("UPDATE recruitment_versions SET status='SUPERSEDED' WHERE recruitment_id=$1 AND status='APPROVED' AND id<>$2", [recruitmentId, v.id]);
    await c.query('UPDATE recruitments SET data=$2, title=$3, organization=$4, published_version=$5, published_at=now(), updated_at=now(), verification=NULL WHERE id=$1', [recruitmentId, JSON.stringify(v.data), v.data.title, v.data.organization, v.version_no]);
    await lifecycle.transition(recruitmentId, 'PUBLISHED', actorOf(user), `Published version ${v.version_no}`, c);
    await audit(`human:${user.email}`, 'PUBLISH', 'recruitment', recruitmentId, { version: v.version_no, document_id: v.document_id }, c);
    return { ok: true, recruitment_id: recruitmentId, version: v.version_no, lifecycle: 'PUBLISHED' };
  });
}

async function reject(itemId, user, { reason = '' } = {}) {
  need(user, 'REVIEWER');
  if (String(reason).trim().length < 5) throw httpErr(400, 'Give a short reason for rejecting.');
  return db.tx(async (c) => {
    const item = (await c.query('SELECT * FROM review_items WHERE id=$1 FOR UPDATE', [itemId])).rows[0];
    if (!item) throw httpErr(404, 'Review item not found.');
    if (item.status !== 'OPEN') throw httpErr(409, 'This item has already been resolved.');
    await c.query("UPDATE recruitment_versions SET status='REJECTED' WHERE id=$1", [item.version_id]);
    await c.query("UPDATE review_items SET status='REJECTED', resolved_at=now(), resolved_by=$2 WHERE id=$1", [itemId, user.email]);
    const rec = (await c.query('SELECT published_at FROM recruitments WHERE id=$1', [item.recruitment_id])).rows[0];
    if (rec.published_at) {
      // A rejected update: the previously published version stays live.
      await lifecycle.transition(item.recruitment_id, 'VERIFIED', actorOf(user), `Update rejected: ${reason}`, c);
      await lifecycle.transition(item.recruitment_id, 'PUBLISHED', actorOf(user), 'Previously published version retained', c);
    } else await lifecycle.transition(item.recruitment_id, 'ARCHIVED', actorOf(user), `Rejected: ${reason}`, c);
    await audit(`human:${user.email}`, 'REVIEW_REJECTED', 'review_item', itemId, { recruitment_id: item.recruitment_id, reason }, c);
    return { ok: true, recruitment_id: item.recruitment_id };
  });
}

async function timeline(recruitmentId) {
  const rec = (await db.query('SELECT id,title,lifecycle,published_version FROM recruitments WHERE id=$1', [recruitmentId])).rows[0];
  if (!rec) throw httpErr(404, 'Recruitment not found.');
  const docs = (await db.query(`SELECT d.id,d.title,d.kind,d.issued_on,d.fetched_at,d.sha256,d.url,v.version_no,v.status AS version_status
    FROM documents d LEFT JOIN recruitment_versions v ON v.document_id=d.id WHERE d.recruitment_id=$1 ORDER BY d.id`, [recruitmentId])).rows;
  const changes = (await db.query('SELECT to_version,label,from_value,to_value,delta,supported,message,source,detected_at FROM change_events WHERE recruitment_id=$1 ORDER BY id', [recruitmentId])).rows;
  const life = (await db.query('SELECT from_state,to_state,actor,reason,at FROM lifecycle_events WHERE recruitment_id=$1 ORDER BY id', [recruitmentId])).rows;
  const KIND = { ORIGINAL: 'Original notification', AMENDMENT: 'Amendment', CORRIGENDUM: 'Corrigendum', FINAL_UPDATE: 'Final update' };
  let amend = 0;
  const entries = docs.map((d) => ({ at: d.fetched_at, type: 'DOCUMENT', title: d.kind === 'AMENDMENT' ? `Amendment ${++amend}` : KIND[d.kind], document_id: d.id, file: d.title, sha256: d.sha256.slice(0, 12), version: d.version_no, version_status: d.version_status, changes: changes.filter((c) => c.to_version === d.version_no) }));
  return { recruitment: rec, entries, lifecycle: life };
}

module.exports = { listQueue, getItem, approve, publish, reject, timeline, FIELD_LABELS };
