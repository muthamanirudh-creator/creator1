// Source registry: an ALLOWLIST. Nothing outside this table is ever crawled.
const db = require('./db');
const { audit } = require('./audit');

const HEALTH = ['ONLINE', 'DEGRADED', 'TEMPORARILY_UNAVAILABLE', 'BLOCKED', 'PARSER_ERROR', 'CONTENT_CHANGED'];

// Real official portals are seeded PENDING_VERIFICATION with crawling OFF.
// A person must confirm each domain/URL, then enable crawling from the admin dashboard.
const SEED = [
  { source_id: 'upsc', organization: 'Union Public Service Commission', department: 'Central recruitment', official_domain: 'upsc.gov.in', portal_url: 'https://upsc.gov.in/', source_type: 'OFFICIAL_PORTAL', state: 'All India', crawler: 'index-links' },
  { source_id: 'ssc', organization: 'Staff Selection Commission', department: 'Central recruitment', official_domain: 'ssc.gov.in', portal_url: 'https://ssc.gov.in/', source_type: 'OFFICIAL_PORTAL', state: 'All India', crawler: 'index-links' },
  { source_id: 'ibps', organization: 'Institute of Banking Personnel Selection', department: 'Banking', official_domain: 'ibps.in', portal_url: 'https://www.ibps.in/', source_type: 'OFFICIAL_PORTAL', state: 'All India', crawler: 'index-links' },
  { source_id: 'sbi-careers', organization: 'State Bank of India', department: 'Banking', official_domain: 'sbi.co.in', portal_url: 'https://sbi.co.in/web/careers', source_type: 'OFFICIAL_PORTAL', state: 'All India', crawler: 'index-links' },
  { source_id: 'appsc', organization: 'Andhra Pradesh Public Service Commission', department: 'State recruitment', official_domain: 'psc.ap.gov.in', portal_url: 'https://psc.ap.gov.in/', source_type: 'OFFICIAL_PORTAL', state: 'Andhra Pradesh', crawler: 'index-links' },
  { source_id: 'tgpsc', organization: 'Telangana State Public Service Commission', department: 'State recruitment', official_domain: 'tgpsc.gov.in', portal_url: 'https://www.tgpsc.gov.in/', source_type: 'OFFICIAL_PORTAL', state: 'Telangana', crawler: 'index-links' },
  // Fictional sources used by the demo and the tests.
  { source_id: 'demo-psc', organization: 'Demo State Public Service Commission', department: 'State recruitment', official_domain: 'psc.example.gov.in', portal_url: 'https://psc.example.gov.in/', source_type: 'DEMO', state: 'Telangana', crawler: 'index-links', verification_status: 'VERIFIED' },
  { source_id: 'manual-upload', organization: 'Manual upload by reviewer', department: null, official_domain: 'manual.invalid', portal_url: 'https://manual.invalid/', source_type: 'MANUAL_UPLOAD', state: 'All India', crawler: 'none', verification_status: 'VERIFIED' },
];

async function seedRegistry() {
  for (const s of SEED) {
    await db.query(`INSERT INTO sources(source_id,organization,department,official_domain,portal_url,source_type,state,crawler,verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (source_id) DO NOTHING`,
      [s.source_id, s.organization, s.department, s.official_domain, s.portal_url, s.source_type, s.state, s.crawler, s.verification_status || 'PENDING_VERIFICATION']);
  }
}

const listSources = async () => (await db.query('SELECT * FROM sources ORDER BY source_id')).rows;
const getSource = async (id) => (await db.query('SELECT * FROM sources WHERE source_id=$1', [id])).rows[0];
const registryDomains = async () => (await db.query("SELECT official_domain FROM sources WHERE source_type <> 'MANUAL_UPLOAD' AND verification_status <> 'SUSPENDED'")).rows.map((r) => r.official_domain);

// Only a person can verify a source or switch crawling on.
async function setVerification(sourceId, status, actor) {
  await db.query('UPDATE sources SET verification_status=$2, crawl_enabled = CASE WHEN $2 = \'VERIFIED\' THEN crawl_enabled ELSE FALSE END WHERE source_id=$1', [sourceId, status]);
  await audit(`human:${actor}`, 'SOURCE_VERIFICATION', 'source', sourceId, { status });
}
async function setCrawling(sourceId, enabled, actor) {
  const s = await getSource(sourceId);
  if (enabled && s.verification_status !== 'VERIFIED') { const e = new Error('Verify the source before enabling crawling.'); e.status = 400; throw e; }
  await db.query('UPDATE sources SET crawl_enabled=$2 WHERE source_id=$1', [sourceId, enabled]);
  await audit(`human:${actor}`, 'SOURCE_CRAWLING', 'source', sourceId, { enabled });
}

async function recordHealth(sourceId, health, { error = null, success = false, indexHash, links, etag, lastModified } = {}) {
  if (!HEALTH.includes(health)) throw new Error(`Unknown health ${health}`);
  // Five failures in a row start a cool-down (5, 10, 20 ... capped at 360 minutes) so a broken site is not hammered.
  await db.query(`UPDATE sources SET health=$2, last_error=$3,
    last_success_at = CASE WHEN $4 THEN now() ELSE last_success_at END,
    last_failure_at = CASE WHEN $4 THEN last_failure_at ELSE now() END,
    last_checked_at = now(),
    consecutive_failures = CASE WHEN $4 THEN 0 ELSE consecutive_failures + 1 END,
    cooldown_until = CASE WHEN $4 THEN NULL WHEN consecutive_failures + 1 >= 5 THEN now() + (LEAST(360, 5 * POWER(2, consecutive_failures + 1 - 5))::int::text || ' minutes')::interval ELSE cooldown_until END,
    etag = COALESCE($7, etag), last_modified = COALESCE($8, last_modified),
    last_index_hash = COALESCE($5, last_index_hash), last_links = COALESCE($6::jsonb, last_links) WHERE source_id=$1`,
    [sourceId, health, error, success, indexHash || null, links ? JSON.stringify(links) : null, etag || null, lastModified || null]);
}

module.exports = { HEALTH, SEED, seedRegistry, listSources, getSource, registryDomains, setVerification, setCrawling, recordHealth };
