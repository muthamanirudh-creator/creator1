// Data access for recruitments, documents, versions. Also maps DB rows to the public job shape that Phase 1 APIs return.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { buildJobs } = require('../data/jobs');
const runtime = require('./runtime');

const STORAGE = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const EXT = { 'application/pdf': '.pdf', 'text/html': '.html', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' };

function saveFile(sha, mime, buf) {
  fs.mkdirSync(STORAGE, { recursive: true });
  const p = path.join(STORAGE, sha + (EXT[mime] || '.bin'));
  if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
  return p;
}

// Sample (fictional) Phase 1 jobs live in the database too, flagged is_sample. Re-seeded on boot so dates stay relative to today.
async function seedSampleJobs(now = new Date()) {
  for (const j of buildJobs(now)) {
    const published = j.lifecycle !== 'REVIEW_REQUIRED' && j.verification.status === 'VERIFIED';
    await db.query(`INSERT INTO recruitments(id,title,organization,lifecycle,published_version,data,is_sample,verification,published_at)
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8)
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, title=EXCLUDED.title, organization=EXCLUDED.organization, verification=EXCLUDED.verification, updated_at=now()
      WHERE recruitments.is_sample`,
      [j.id, j.title, j.organization, j.lifecycle, published ? 1 : null, j, j.verification, published ? j.verification.verified_at : null]);
  }
}

const PUBLIC_LC = ['PUBLISHED', 'UPDATED', 'APPLICATION_CLOSED', 'EXAM_PHASE', 'RESULT_PHASE'];
const FS_MAP = { education: 'education', field: 'education', age: 'age.max', experience: 'experience_years', domicile: 'domicile', physical: 'physical', vacancies: 'vacancies.total', dates: 'dates.application_close' };

async function toPublicJob(row) {
  if (row.is_sample) return row.data; // fictional demo records already carry their own shape
  const docs = (await db.query('SELECT id,title,kind,url,issued_on FROM documents WHERE recruitment_id=$1 AND id IN (SELECT document_id FROM recruitment_versions WHERE recruitment_id=$1 AND version_no<=$2 AND status IN (\'APPROVED\',\'SUPERSEDED\')) ORDER BY id', [row.id, row.published_version])).rows;
  const ver = (await db.query('SELECT lineage FROM recruitment_versions WHERE recruitment_id=$1 AND version_no=$2', [row.id, row.published_version])).rows[0];
  const lin = ver ? ver.lineage : {};
  const titleOf = new Map(docs.map((d) => [d.id, `doc-${d.id}`]));
  const field_sources = {};
  for (const [k, lk] of Object.entries(FS_MAP)) { const l = lin[lk]; if (l && l.page_number) field_sources[k] = { doc: titleOf.get(l.document_id) || `doc-${l.document_id}`, document_id: l.document_id, page: l.page_number, section: l.section || '—' }; }
  const changes = (await db.query('SELECT * FROM change_events WHERE recruitment_id=$1 AND supported AND to_version<=$2 ORDER BY detected_at', [row.id, row.published_version])).rows;
  const history = changes.map((c) => ({ date: c.detected_at.toISOString().slice(0, 10), field: c.label, from: c.from_value, to: c.to_value, delta: c.delta || 'changed', source: c.source || '' }));
  const pending = (await db.query("SELECT 1 FROM review_items WHERE recruitment_id=$1 AND status='OPEN' LIMIT 1", [row.id])).rowCount > 0;
  return {
    ...row.data, id: row.id, lifecycle: PUBLIC_LC.includes(row.lifecycle) ? row.lifecycle : 'PUBLISHED', sample: false,
    // Human-reviewed by default. A record the auto-publish policy released carries its own honest label (level AUTO_EXTRACTED)
    // until a reviewer confirms it; the UI shows that label and the confidence.
    verification: row.verification && row.verification.level
      ? { status: 'VERIFIED', level: row.verification.level, verified_at: row.verification.verified_at || row.published_at.toISOString(), method: row.verification.method, confidence: row.verification.confidence, awaiting_human_audit: !!row.verification.awaiting_human_audit }
      : { status: 'VERIFIED', level: 'HUMAN_REVIEWED', verified_at: row.published_at.toISOString(), method: 'Human review of extracted fields, with page-level source lineage' },
    auto_extracted: !!(row.verification && row.verification.level === 'AUTO_EXTRACTED'),
    sources: docs.map((d) => ({ id: `doc-${d.id}`, name: d.title, type: d.kind === 'ORIGINAL' ? 'OFFICIAL_NOTIFICATION' : d.kind, url: `/api/documents/${d.id}/file`, issuer: row.organization })),
    field_sources, history, pending_update: pending,
  };
}

async function publishedJobs() {
  if (runtime.isDemo()) return runtime.jobs();
  const rows = (await db.query("SELECT * FROM recruitments WHERE published_at IS NOT NULL AND data IS NOT NULL AND lifecycle <> 'ARCHIVED' ORDER BY id")).rows;
  return Promise.all(rows.map(toPublicJob));
}

const getRecruitment = async (id, c = db) => (await c.query('SELECT * FROM recruitments WHERE id=$1', [id])).rows[0];
const latestVersionNo = async (id, c = db) => (await c.query('SELECT COALESCE(MAX(version_no),0) n FROM recruitment_versions WHERE recruitment_id=$1', [id])).rows[0].n;
const getPages = async (docId) => (await db.query('SELECT page_number,text,method,ocr_confidence,columns,tables FROM document_pages WHERE document_id=$1 ORDER BY page_number', [docId])).rows;
const findDocBySha = async (sha) => (await db.query('SELECT * FROM documents WHERE sha256=$1 ORDER BY id LIMIT 1', [sha])).rows[0];
const findRecruitmentByUrl = async (url) => url ? (await db.query('SELECT recruitment_id FROM documents WHERE url=$1 AND recruitment_id IS NOT NULL ORDER BY id DESC LIMIT 1', [url])).rows[0] : null;
const dedupeCorpus = async () => (await db.query("SELECT r.id, COALESCE(r.data, (SELECT v.data FROM recruitment_versions v WHERE v.recruitment_id=r.id ORDER BY v.version_no DESC LIMIT 1)) AS data FROM recruitments r")).rows;

module.exports = { STORAGE, saveFile, seedSampleJobs, publishedJobs, toPublicJob, getRecruitment, latestVersionNo, getPages, findDocBySha, findRecruitmentByUrl, dedupeCorpus, PUBLIC_LC };
