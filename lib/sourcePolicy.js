// Source discovery policy: decides, by evidence, whether a candidate recruitment source may be trusted.
// A source is auto-verified only when ALL of these hold: https, an official government/PSU domain, a public (non-private)
// address, the portal answers with HTML/XML, and the page itself talks about recruitment. Nothing is trusted because a
// search result said so. Anything that fails stays PENDING_VERIFICATION and the reason is recorded.
const net = require('net');
const NS = require('./nationalSources');   // v2.10.0: national registry data (no circular dependency; pure data)

const OFFICIAL_SUFFIXES = ['.gov.in', '.nic.in'];
// Curated official recruiters whose domains do not end in gov.in / nic.in (banks, regulators, PSUs, exam bodies).
const OFFICIAL_EXACT = ['ibps.in', 'sbi.co.in', 'rbi.org.in', 'licindia.in', 'nabard.org', 'ongcindia.com', 'ntpc.co.in', 'powergrid.in', 'iocl.com', 'bhel.com', 'gailonline.com', 'coalindia.in', 'sail.co.in', 'hal-india.co.in', 'bel-india.in', 'npcilcareers.co.in'];
const KEYWORDS = /recruit|vacanc|notification|career|advertis|appointment|employment|examination/i;

const extraDomains = () => String(process.env.OFFICIAL_DOMAIN_EXTRA || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const inDomain = (host, d) => host === d || host.endsWith(`.${d}`);

// Real recruiters, additive to the six already in lib/registry.js. Seeded PENDING; auto-verification decides.
// Liveness of each URL is checked at run time and reported through source health, never assumed.
const EXTRA_SOURCES = [
  { source_id: 'ncs', organization: 'National Career Service (Ministry of Labour & Employment)', department: 'Central employment portal', official_domain: 'ncs.gov.in', portal_url: 'https://www.ncs.gov.in/', state: 'All India' },
  { source_id: 'rrb-apply', organization: 'Railway Recruitment Boards (common application portal)', department: 'Railways', official_domain: 'rrbapply.gov.in', portal_url: 'https://www.rrbapply.gov.in/', state: 'All India' },
  { source_id: 'indian-railways', organization: 'Ministry of Railways', department: 'Railways', official_domain: 'indianrailways.gov.in', portal_url: 'https://indianrailways.gov.in/', state: 'All India' },
  { source_id: 'rbi', organization: 'Reserve Bank of India', department: 'Banking regulator', official_domain: 'rbi.org.in', portal_url: 'https://opportunities.rbi.org.in/', state: 'All India' },
  { source_id: 'drdo', organization: 'Defence Research & Development Organisation', department: 'Defence', official_domain: 'drdo.gov.in', portal_url: 'https://www.drdo.gov.in/', state: 'All India' },
  { source_id: 'isro', organization: 'Indian Space Research Organisation', department: 'Space', official_domain: 'isro.gov.in', portal_url: 'https://www.isro.gov.in/', state: 'All India' },
  { source_id: 'join-indian-army', organization: 'Indian Army', department: 'Defence', official_domain: 'joinindianarmy.nic.in', portal_url: 'https://joinindianarmy.nic.in/', state: 'All India' },
  { source_id: 'epfo', organization: 'Employees\' Provident Fund Organisation', department: 'Labour', official_domain: 'epfindia.gov.in', portal_url: 'https://www.epfindia.gov.in/', state: 'All India' },
  { source_id: 'ongc', organization: 'Oil and Natural Gas Corporation', department: 'PSU', official_domain: 'ongcindia.com', portal_url: 'https://ongcindia.com/', state: 'All India' },
  { source_id: 'ntpc', organization: 'NTPC Limited', department: 'PSU', official_domain: 'ntpc.co.in', portal_url: 'https://www.ntpc.co.in/', state: 'All India' },
  { source_id: 'powergrid', organization: 'Power Grid Corporation of India', department: 'PSU', official_domain: 'powergrid.in', portal_url: 'https://www.powergrid.in/', state: 'All India' },
  { source_id: 'iocl', organization: 'Indian Oil Corporation', department: 'PSU', official_domain: 'iocl.com', portal_url: 'https://iocl.com/', state: 'All India' },
  { source_id: 'kvs', organization: 'Kendriya Vidyalaya Sangathan', department: 'Education', official_domain: 'kvsangathan.nic.in', portal_url: 'https://kvsangathan.nic.in/', state: 'All India' },
  { source_id: 'mha', organization: 'Ministry of Home Affairs', department: 'Home affairs / paramilitary', official_domain: 'mha.gov.in', portal_url: 'https://www.mha.gov.in/', state: 'All India' },
];

function isOfficialDomain(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || net.isIP(host)) return false;
  if (NS.FOREIGN_LOOKALIKE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) return false;   // v2.10.0: never another country's look-alike
  if (OFFICIAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return OFFICIAL_EXACT.concat(NS.EXTRA_OFFICIAL_EXACT, extraDomains()).some((d) => inDomain(host, d));
}

// SSRF guard: refuse loopback, link-local, private and metadata addresses and non-https schemes.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80'); }
  return false;
}
function isSafeUrl(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');   // URL() keeps the brackets of an IPv6 literal
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return false;
  if (net.isIP(h) && isPrivateIp(h)) return false;
  return !u.username && !u.password;
}

// Pure verdict from what was observed. Returns { ok, checks:[{name,ok,detail}], reason }.
function judge(source, observed) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  let host = ''; try { host = new URL(source.portal_url).hostname.toLowerCase(); } catch (_) {}
  add('https and public address', isSafeUrl(source.portal_url), source.portal_url);
  add('official government / PSU domain', isOfficialDomain(host) && inDomain(host, String(source.official_domain || '').toLowerCase()), host);
  if (observed) {
    add('portal answered', observed.status >= 200 && observed.status < 300, `HTTP ${observed.status}`);
    add('HTML or XML content', /html|xml/i.test(observed.contentType || ''), observed.contentType || 'unknown');
    add('page mentions recruitment', KEYWORDS.test(observed.body || ''), 'keyword scan of the page');
  }
  const bad = checks.find((c) => !c.ok);
  return { ok: !bad, checks, reason: bad ? `${bad.name}: ${bad.detail}` : null };
}

async function observe(source, { fetch = globalThis.fetch, timeoutMs = 8000, contact = process.env.CRAWLER_CONTACT } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(source.portal_url, { signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': `GovCareerBot/1.0 (independent information service${contact ? `; contact: ${contact}` : ''})` } });
    if (r.status >= 300 && r.status < 400) {
      // One same-domain redirect is normal (http->https, www). Anything leaving the domain is not followed.
      const loc = r.headers && r.headers.get && r.headers.get('location');
      let next = null; try { next = loc ? new URL(loc, source.portal_url) : null; } catch (_) {}
      if (!next || !isSafeUrl(next.href) || !inDomain(next.hostname.toLowerCase(), String(source.official_domain).toLowerCase())) return { status: r.status, contentType: '', body: '' };
      const r2 = await fetch(next.href, { signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': 'GovCareerBot/1.0' } });
      return { status: r2.status, contentType: (r2.headers && r2.headers.get && r2.headers.get('content-type')) || '', body: r2.ok ? (await r2.text()).slice(0, 400000) : '' };
    }
    return { status: r.status, contentType: (r.headers && r.headers.get && r.headers.get('content-type')) || '', body: r.ok ? (await r.text()).slice(0, 400000) : '' };
  } finally { clearTimeout(t); }
}

// db is injected (lib/db) so the decision logic stays testable.
async function seedExtra(db) {
  for (const s of EXTRA_SOURCES) {
    await db.query(`INSERT INTO sources(source_id,organization,department,official_domain,portal_url,source_type,state,crawler,verification_status)
      VALUES ($1,$2,$3,$4,$5,'OFFICIAL_PORTAL',$6,'index-links','PENDING_VERIFICATION') ON CONFLICT (source_id) DO NOTHING`,
      [s.source_id, s.organization, s.department, s.official_domain, s.portal_url, s.state]);
  }
}

// Verifies every pending OFFICIAL_PORTAL / OFFICIAL_RSS source that passes the policy and switches crawling on.
// A source that fails is left PENDING with the reason stored; it is retried on a later run (it may be a temporary outage).
async function autoVerifyPending({ db, audit, fetch, now = () => new Date() } = {}) {
  const rows = (await db.query(`SELECT * FROM sources WHERE verification_status='PENDING_VERIFICATION' AND source_type IN ('OFFICIAL_PORTAL','OFFICIAL_RSS','OFFICIAL_SITEMAP','OFFICIAL_API')`)).rows;
  const out = { checked: rows.length, verified: [], left_pending: [] };
  for (const s of rows) {
    let verdict;
    const pre = judge(s, null);
    if (!pre.ok) verdict = pre;            // do not even contact a host that fails the static policy
    else { try { verdict = judge(s, await observe(s, { fetch })); } catch (e) { verdict = { ok: false, checks: pre.checks, reason: `portal unreachable: ${e.name === 'AbortError' ? 'timeout' : e.message}` }; } }
    if (verdict.ok) {
      await db.query(`UPDATE sources SET verification_status='VERIFIED', crawl_enabled=TRUE, auto_verified=TRUE, auto_verify_note=$2 WHERE source_id=$1 AND verification_status='PENDING_VERIFICATION'`, [s.source_id, `Auto-verified ${now().toISOString()}: ${verdict.checks.map((c) => c.name).join('; ')}`]);
      await audit('policy:auto-verify', 'SOURCE_AUTO_VERIFIED', 'source', s.source_id, { checks: verdict.checks });
      out.verified.push(s.source_id);
    } else {
      await db.query(`UPDATE sources SET auto_verify_note=$2 WHERE source_id=$1`, [s.source_id, `Not verified ${now().toISOString()}: ${verdict.reason}`.slice(0, 300)]);
      out.left_pending.push({ source_id: s.source_id, reason: verdict.reason });
    }
  }
  return out;
}

module.exports = { OFFICIAL_SUFFIXES, OFFICIAL_EXACT, EXTRA_SOURCES, isOfficialDomain, isPrivateIp, isSafeUrl, judge, observe, seedExtra, autoVerifyPending };
