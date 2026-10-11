// v2.10.0 - Domain guard. A recruitment source is only as trustworthy as its domain, so every source is checked
// BEFORE it is contacted and again whenever it fails to answer:
//  - https only, public host (lib/sourcePolicy.isSafeUrl) and an official domain (gov.in / nic.in / curated PSU list)
//  - never a look-alike from another country (Pakistan's Punjab commission is ppsc.gop.pk, not ours)
//  - the portal URL must belong to the stated official_domain
//  - a state source must not sit on another state's sub-domain (e.g. Punjab filed under *.up.nic.in)
//  - known stale / wrong domains are corrected to the current one (DOMAIN_FIXES) and sent back for re-verification
const net = require('net');
const policy = require('./sourcePolicy');
const { DOMAIN_FIXES, FOREIGN_LOOKALIKE_SUFFIXES, STATE_TAGS, NATIONAL_SOURCES } = require('./nationalSources');

const normHost = (h) => String(h || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
const inDomain = (host, d) => host === d || host.endsWith(`.${d}`);
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch (_) { return ''; } };

function foreignLookalike(host) {
  host = normHost(host);
  return FOREIGN_LOOKALIKE_SUFFIXES.find((s) => host === s.slice(1) || host.endsWith(s)) || null;
}

// Returns the other state whose tag appears as a sub-domain of the host, if it differs from the claimed state.
function crossStateTag(host, state) {
  host = normHost(host);
  const m = /(?:^|\.)([a-z]+)\.(?:gov|nic)\.in$/.exec(host);
  if (!m) return null;
  const tag = m[1];
  const owner = Object.keys(STATE_TAGS).find((s) => STATE_TAGS[s].includes(tag));
  if (!owner || owner === state) return null;
  return owner;
}

function canonicalFor(sourceId) {
  const row = NATIONAL_SOURCES.find((s) => s.source_id === sourceId);
  return row ? { official_domain: row.official_domain, portal_url: row.portal_url } : null;
}

// Pure check of one source row. Returns { ok, problems:[{code,detail}], fix? }.
function check(source) {
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });
  const domain = normHost(source.official_domain);
  const portalHost = hostOf(source.portal_url);

  if (!domain) add('NO_DOMAIN', 'official_domain is empty');
  if (net.isIP(domain)) add('IP_ADDRESS', 'an IP address is not an official domain');
  const fl = foreignLookalike(domain) || foreignLookalike(portalHost);
  if (fl) add('FOREIGN_LOOKALIKE', `${domain || portalHost} belongs to another country (${fl}); never used`);
  if (!policy.isSafeUrl(source.portal_url)) add('UNSAFE_URL', 'portal_url must be https and a public host');
  if (domain && !policy.isOfficialDomain(domain)) add('NOT_OFFICIAL_DOMAIN', `${domain} is not a gov.in / nic.in / curated official domain`);
  if (domain && portalHost && !inDomain(portalHost, domain)) add('PORTAL_OUTSIDE_DOMAIN', `portal host ${portalHost} is outside ${domain}`);

  const stale = DOMAIN_FIXES[source.source_id];
  if (stale && (stale.stale.includes(domain) || stale.stale.includes(portalHost))) add('STALE_DOMAIN', `${domain} is a stale or wrong domain for ${source.source_id}`);

  if (source.state && source.state !== 'All India') {
    const other = crossStateTag(domain, source.state);
    if (other) add('WRONG_STATE', `${domain} looks like a ${other} site but the source is filed under ${source.state}`);
  }
  const out = { ok: problems.length === 0, problems };
  if (stale && problems.some((p) => p.code === 'STALE_DOMAIN' || p.code === 'FOREIGN_LOOKALIKE')) out.fix = { ...stale.fix };
  return out;
}

// Bring the database in line with the national registry:
//  1. insert every registry row that is missing (PENDING_VERIFICATION; crawling stays OFF until evidence verifies it)
//  2. correct stale / wrong domains (audit-logged, sent back to PENDING_VERIFICATION so the new domain is verified by evidence)
//  3. apply crawl tiers, but only to rows that still hold a default interval, so an admin's own value is never overwritten
//  4. record each row's domain status for the admin view and the public coverage report
async function reconcile({ db, audit, nationalSources = NATIONAL_SOURCES, tierMinutes = require('./nationalSources').tierMinutes, env = process.env } = {}) {
  const out = { inserted: [], corrected: [], tiered: 0, flagged: [] };
  for (const s of nationalSources) {
    const r = await db.query(`INSERT INTO sources(source_id,organization,department,official_domain,portal_url,source_type,state,crawler,verification_status,priority_tier,region,crawl_frequency_minutes)
      VALUES ($1,$2,$3,$4,$5,'OFFICIAL_PORTAL',$6,'index-links','PENDING_VERIFICATION',$7,$6,$8) ON CONFLICT (source_id) DO NOTHING RETURNING source_id`,
      [s.source_id, s.organization, s.department, s.official_domain, s.portal_url, s.state, s.tier, tierMinutes(s.tier, env)]);
    if (r.rows && r.rows.length) out.inserted.push(s.source_id);
  }
  const rows = (await db.query('SELECT source_id, official_domain, portal_url, state, verification_status, source_type FROM sources')).rows;
  for (const row of rows) {
    if (row.source_type === 'DEMO' || row.source_type === 'MANUAL_UPLOAD') continue;   // placeholders are not real recruiters
    const verdict = check(row);
    if (verdict.fix) {
      const old = row.official_domain;
      await db.query(`UPDATE sources SET official_domain=$2, portal_url=$3, verification_status='PENDING_VERIFICATION', crawl_enabled=FALSE, auto_verified=FALSE,
        domain_status='CORRECTED', domain_note=$4, consecutive_failures=0, cooldown_until=NULL, etag=NULL, last_modified=NULL WHERE source_id=$1`,
        [row.source_id, verdict.fix.official_domain, verdict.fix.portal_url, `Corrected from ${old} on ${new Date().toISOString().slice(0, 10)}; must be re-verified`]);
      if (audit) await audit('policy:domain-guard', 'SOURCE_DOMAIN_CORRECTED', 'source', row.source_id, { from: old, to: verdict.fix.official_domain });
      out.corrected.push({ source_id: row.source_id, from: old, to: verdict.fix.official_domain });
    } else if (!verdict.ok) {
      const note = verdict.problems.map((p) => `${p.code}: ${p.detail}`).join('; ').slice(0, 300);
      await db.query(`UPDATE sources SET domain_status='REVIEW', domain_note=$2, crawl_enabled=FALSE WHERE source_id=$1 AND source_type NOT IN ('DEMO','MANUAL_UPLOAD')`, [row.source_id, note]);
      out.flagged.push({ source_id: row.source_id, problems: verdict.problems });
    } else {
      await db.query(`UPDATE sources SET domain_status = CASE WHEN domain_status IN ('CORRECTED') THEN domain_status ELSE 'OK' END, domain_note = CASE WHEN domain_status='REVIEW' THEN NULL ELSE domain_note END WHERE source_id=$1 AND source_type NOT IN ('DEMO','MANUAL_UPLOAD')`, [row.source_id]);
    }
  }
  // Tiers: only for rows still on a default interval (30 = v2.8.2 default, 360 = v1 default), so admin edits survive.
  for (const s of nationalSources) {
    const r = await db.query('UPDATE sources SET priority_tier=$2, crawl_frequency_minutes=$3 WHERE source_id=$1 AND crawl_frequency_minutes IN (30,360)', [s.source_id, s.tier, tierMinutes(s.tier, env)]);
    out.tiered += r.rowCount || 0;
  }
  return out;
}

// A portal that repeatedly fails DNS / connection is probably a wrong domain. Flag it so a person looks, instead of retrying forever.
async function flagUnreachable({ db, threshold = 8 } = {}) {
  const r = await db.query(`UPDATE sources SET domain_status='REVIEW', domain_note=COALESCE(domain_note,'') || CASE WHEN domain_note IS NULL OR domain_note='' THEN '' ELSE '; ' END || 'Unreachable ' || consecutive_failures || ' times in a row: check the domain'
    WHERE consecutive_failures >= $1 AND domain_status <> 'REVIEW' AND source_type NOT IN ('DEMO','MANUAL_UPLOAD') RETURNING source_id`, [threshold]);
  return (r.rows || []).map((x) => x.source_id);
}

module.exports = { normHost, hostOf, foreignLookalike, crossStateTag, canonicalFor, check, reconcile, flagUnreachable };
