// Automatic publication lane. A document reaches the public feed WITHOUT a person only when every rule below holds.
// Anything else stays in the human review queue AND is shown as "detected, not yet verified" with a link to the official
// document, so a new notification is never hidden - but it is also never presented as verified when it was not.
//
// Rules (all must hold):
//  - AUTO_PUBLISH is not switched off (AUTO_PUBLISH=0)
//  - the source is a VERIFIED official source (not DEMO, not a manual upload)
//  - the extraction is schema-valid and its confidence >= AUTO_PUBLISH_MIN_CONFIDENCE (default 0.85)
//  - no suspicious / conflicting / duplicate / broken-link / low-confidence flag
//  - title and organisation are cited to a page of the official document
//  - the notification states a vacancy count or a closing date (otherwise it may not be a recruitment notice at all)
//  - a closing date, if present, is a real date and not long past
//  - for an update (corrigendum / extension): at least one change, and every change is cited in BOTH versions
// The published record keeps its full page-level lineage and is labelled AUTO_EXTRACTED until a person confirms it.
const POLICY = { type: 'policy', name: 'auto-publish' };

const CFG = () => ({
  enabled: process.env.AUTO_PUBLISH !== '0',
  minConfidence: Number(process.env.AUTO_PUBLISH_MIN_CONFIDENCE || 0.85),
  maxStaleDays: Number(process.env.AUTO_PUBLISH_MAX_STALE_DAYS || 30),
});

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

function evaluate(input, cfg = CFG(), now = new Date()) {
  const reasons = []; const fail = (code, message) => reasons.push({ code, message });
  const { source, record = {}, lineage = {}, confidence, schemaValid, buckets = [], isUpdate = false, changes = [] } = input;
  if (!cfg.enabled) fail('DISABLED', 'Automatic publication is switched off (AUTO_PUBLISH=0).');
  if (!source || source.verification_status !== 'VERIFIED') fail('SOURCE_NOT_VERIFIED', 'The source is not a verified official source.');
  else if (['DEMO', 'MANUAL_UPLOAD'].includes(source.source_type)) fail('SOURCE_TYPE', 'Demo and manual-upload sources are always reviewed by a person.');
  if (!schemaValid) fail('SCHEMA_INVALID', 'The extraction did not pass schema validation.');
  if (!(Number(confidence) >= cfg.minConfidence)) fail('LOW_CONFIDENCE', `Parsing confidence ${confidence} is below ${cfg.minConfidence}.`);
  const allowed = new Set(['high_confidence', 'medium_confidence', ...(isUpdate ? ['changed_source'] : [])]);
  for (const b of buckets) if (!allowed.has(b)) fail(`FLAG_${String(b).toUpperCase()}`, `Review flag "${b}" requires a person.`);
  for (const k of ['title', 'organization']) if (!lineage[k] || !lineage[k].page_number) fail('UNCITED_FIELD', `${k} is not cited to a page of the official document.`);
  const close = get(record, 'dates.application_close');
  const vac = get(record, 'vacancies.total');
  if (close == null && vac == null) fail('NOT_A_NOTIFICATION', 'No vacancy count and no closing date were found; this may not be a recruitment notice.');
  if (close != null) {
    const t = Date.parse(close);
    if (Number.isNaN(t)) fail('BAD_DATE', 'The closing date is not a valid date.');
    else if (now.getTime() - t > cfg.maxStaleDays * 864e5) fail('STALE_DEADLINE', `The closing date passed more than ${cfg.maxStaleDays} days ago.`);
  }
  if (isUpdate) {
    if (!changes.length) fail('NO_CHANGE', 'The new document changes nothing in the published record.');
    if (changes.some((c) => !c.supported)) fail('UNCITED_CHANGE', 'At least one change is not cited in both versions.');
  }
  return { ok: reasons.length === 0, reasons };
}

// DEADLINE_EXTENDED only when the official delta says so; everything else is AMENDED.
function classify(changes = []) {
  return changes.some((c) => c.field === 'dates.application_close' && /extended/i.test(String(c.delta || ''))) ? 'DEADLINE_EXTENDED' : 'AMENDED';
}

// The facts an alert or a card needs. Missing values stay null (shown as "not stated"), never guessed.
function summarize(data = {}, extra = {}) {
  const edu = data.education && (data.education.label || data.education.level) || null;
  return {
    title: data.title || null, organization: data.organization || null, department: data.department || null, state: data.state || null,
    vacancies: get(data, 'vacancies.total') ?? null,
    application_open: get(data, 'dates.application_open') ?? null, application_close: get(data, 'dates.application_close') ?? null, exam_date: get(data, 'dates.exam_date') ?? null,
    eligibility: { education: edu, age_min: get(data, 'age.min') ?? null, age_max: get(data, 'age.max') ?? null },
    application_link: data.application_link || null,
    ...extra,
  };
}

// Runs inside ONE transaction, so a crash can never leave a half-published record, and the dedupe_key makes a repeat harmless.
async function tryAutoPublish(reviewItemId, deps = {}) {
  const d = { db: require('./db'), lifecycle: require('./lifecycle'), audit: require('./audit').audit, validateRecord: require('./schema').validateRecord, now: () => new Date(), cfg: CFG(), ...deps };
  return d.db.tx(async (c) => {
    const item = (await c.query('SELECT * FROM review_items WHERE id=$1 FOR UPDATE', [reviewItemId])).rows[0];
    if (!item || item.status !== 'OPEN') return { published: false, skipped: 'review item is not open' };
    const v = (await c.query('SELECT * FROM recruitment_versions WHERE id=$1 FOR UPDATE', [item.version_id])).rows[0];
    const rec = (await c.query('SELECT * FROM recruitments WHERE id=$1 FOR UPDATE', [item.recruitment_id])).rows[0];
    const source = rec.source_id ? (await c.query('SELECT * FROM sources WHERE source_id=$1', [rec.source_id])).rows[0] : null;
    const doc = (await c.query('SELECT id,title,url FROM documents WHERE id=$1', [v.document_id])).rows[0] || {};
    const isUpdate = !!rec.published_at;
    const changes = isUpdate ? (await c.query('SELECT field,label,from_value,to_value,delta,supported FROM change_events WHERE recruitment_id=$1 AND to_version=$2', [rec.id, v.version_no])).rows : [];
    const verdict = evaluate({ source, record: v.data, lineage: v.lineage || {}, confidence: v.confidence, schemaValid: v.schema_valid && d.validateRecord(v.data).length === 0, buckets: item.buckets || [], isUpdate, changes }, d.cfg, d.now());
    const facts = (extra) => summarize(v.data, { version: v.version_no, confidence: Number(v.confidence), document_url: doc.url || null, document_title: doc.title || null, source_url: source ? source.portal_url : null, source_name: source ? source.organization : null, ...extra });

    if (!verdict.ok) {
      const quiet = (item.buckets || []).includes('suspicious') || verdict.reasons.some((r) => ['NO_CHANGE', 'STALE_DEADLINE', 'NOT_A_NOTIFICATION', 'DISABLED'].includes(r.code));
      let detected = false;
      if (!quiet && v.data && v.data.title) {
        const r = await c.query(`INSERT INTO feed_events(kind,recruitment_id,dedupe_key,title,organization,payload) VALUES ('DETECTED_UNVERIFIED',$1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
          [rec.id, `DETECTED_UNVERIFIED:${rec.id}:v${v.version_no}`, v.data.title, v.data.organization || null, JSON.stringify(facts({ verified: false, review_item_id: item.id, reasons: verdict.reasons.map((x) => x.code), is_update: isUpdate }))]);
        detected = r.rowCount > 0;
      }
      return { published: false, detected, reasons: verdict.reasons };
    }

    await c.query("UPDATE recruitment_versions SET status='APPROVED', schema_valid=TRUE WHERE id=$1", [v.id]);
    await c.query("UPDATE review_items SET status='APPROVED', resolved_at=now(), resolved_by='policy:auto-publish' WHERE id=$1", [item.id]);
    await d.lifecycle.transition(rec.id, 'VERIFIED', POLICY, 'Auto-approved: verified official source, schema-valid, key fields cited', c);
    await c.query("UPDATE recruitment_versions SET status='SUPERSEDED' WHERE recruitment_id=$1 AND status='APPROVED' AND id<>$2", [rec.id, v.id]);
    const verification = {
      status: 'VERIFIED', level: 'AUTO_EXTRACTED', verified_at: d.now().toISOString(), confidence: Number(v.confidence), awaiting_human_audit: true,
      method: 'Read automatically from an official document on a verified government domain. Every key field is cited to a page. A person has not yet audited it; confirm on the official document before applying.',
    };
    await c.query('UPDATE recruitments SET data=$2, title=$3, organization=$4, published_version=$5, published_at=now(), updated_at=now(), verification=$6 WHERE id=$1',
      [rec.id, JSON.stringify(v.data), v.data.title, v.data.organization, v.version_no, JSON.stringify(verification)]);
    await d.lifecycle.transition(rec.id, 'PUBLISHED', POLICY, `Auto-published version ${v.version_no}`, c);
    const kind = isUpdate ? classify(changes) : 'NEW_NOTIFICATION';
    const payload = facts({ verified: true, level: 'AUTO_EXTRACTED', changes: changes.map((x) => ({ label: x.label, from: x.from_value, to: x.to_value, delta: x.delta })) });
    const fe = await c.query('INSERT INTO feed_events(kind,recruitment_id,dedupe_key,title,organization,payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id',
      [kind, rec.id, `${kind}:${rec.id}:v${v.version_no}`, v.data.title, v.data.organization, JSON.stringify(payload)]);
    await d.audit('policy:auto-publish', 'AUTO_PUBLISHED', 'recruitment', rec.id, { version: v.version_no, kind, confidence: Number(v.confidence), document_id: v.document_id }, c);
    return { published: true, kind, recruitment_id: rec.id, version: v.version_no, feed_event_id: fe.rows[0] ? Number(fe.rows[0].id) : null };
  });
}

// ---- human audit of what the machine published (admin) ----
async function listAwaitingAudit(db = require('./db'), limit = 100) {
  return (await db.query(`SELECT id,title,organization,lifecycle,published_version,published_at,verification FROM recruitments
    WHERE NOT is_sample AND published_at IS NOT NULL AND verification->>'level'='AUTO_EXTRACTED' AND lifecycle<>'ARCHIVED' ORDER BY published_at DESC LIMIT $1`, [limit])).rows;
}
async function confirm(recruitmentId, user, deps = {}) {
  const db = deps.db || require('./db'); const audit = deps.audit || require('./audit').audit;
  const r = await db.query(`UPDATE recruitments SET verification = COALESCE(verification,'{}'::jsonb) || $2::jsonb, updated_at=now()
    WHERE id=$1 AND published_at IS NOT NULL AND verification->>'level'='AUTO_EXTRACTED' RETURNING id`,
    [recruitmentId, JSON.stringify({ level: 'HUMAN_CONFIRMED', awaiting_human_audit: false, confirmed_by: user.email, confirmed_at: new Date().toISOString(), method: 'Read automatically from an official document, then audited by a reviewer against the document.' })]);
  if (!r.rows[0]) { const e = new Error('Nothing to confirm: record is not an auto-published item.'); e.status = 409; throw e; }
  await audit(`human:${user.email}`, 'AUTO_PUBLISH_CONFIRMED', 'recruitment', recruitmentId, {});
  return { ok: true, recruitment_id: recruitmentId, level: 'HUMAN_CONFIRMED' };
}
async function retract(recruitmentId, user, reason, deps = {}) {
  const db = deps.db || require('./db'); const lifecycle = deps.lifecycle || require('./lifecycle'); const audit = deps.audit || require('./audit').audit;
  if (String(reason || '').trim().length < 5) { const e = new Error('Give a short reason for retracting.'); e.status = 400; throw e; }
  return db.tx(async (c) => {
    const rec = (await c.query('SELECT id,title,organization,published_at FROM recruitments WHERE id=$1 FOR UPDATE', [recruitmentId])).rows[0];
    if (!rec || !rec.published_at) { const e = new Error('Not a published recruitment.'); e.status = 404; throw e; }
    await lifecycle.transition(recruitmentId, 'ARCHIVED', { type: 'human', name: user.email }, `Retracted: ${reason}`, c);
    await c.query(`INSERT INTO feed_events(kind,recruitment_id,dedupe_key,title,organization,payload) VALUES ('RETRACTED',$1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [recruitmentId, `RETRACTED:${recruitmentId}:${Date.now()}`, rec.title, rec.organization, JSON.stringify({ reason })]);
    await audit(`human:${user.email}`, 'AUTO_PUBLISH_RETRACTED', 'recruitment', recruitmentId, { reason }, c);
    return { ok: true, recruitment_id: recruitmentId, lifecycle: 'ARCHIVED' };
  });
}

module.exports = { POLICY, CFG, evaluate, classify, summarize, tryAutoPublish, listAwaitingAudit, confirm, retract };
