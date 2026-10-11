// Allowlist crawler: registry sources only, robots.txt respected, per-domain rate limit, official-domain links only.
const crypto = require('crypto');
const registry = require('./registry');
const { MAX_BYTES } = require('./docpipeline');

const UA = `GovCareerBot/0.1 (independent information service; contact: ${process.env.CRAWLER_CONTACT || 'set CRAWLER_CONTACT'})`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const inDomain = (host, d) => host === d || host.endsWith(`.${d}`);

function parseRobots(txt, agent = 'govcareerbot') {
  const groups = []; let cur = null;
  for (const raw of String(txt || '').split('\n')) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const [k, ...rest] = line.split(':'); const v = rest.join(':').trim(); const key = k.toLowerCase();
    if (key === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push([key, v]);
    else if (cur && key === 'crawl-delay') cur.delay = parseFloat(v);
  }
  const g = groups.find((x) => x.agents.some((a) => a !== '*' && agent.includes(a))) || groups.find((x) => x.agents.includes('*')) || { rules: [] };
  return { rules: g.rules, delayMs: g.delay ? g.delay * 1000 : 0 };
}
function robotsAllows(parsed, pathname) {
  let best = null;
  for (const [kind, p] of parsed.rules) { if (!p) continue; if (pathname.startsWith(p.replace(/\*$/, ''))) { if (!best || p.length > best.p.length) best = { kind, p }; } }
  return !best || best.kind === 'allow';
}

const parseSitemap = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => ({ url: m[1], title: m[1].split('/').pop() }));
const parseRss = (xml) => [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => ({ url: (/<link>\s*([^<\s]+)\s*<\/link>/i.exec(m[1]) || [])[1], title: ((/<title>\s*(?:<!\[CDATA\[)?([^<\]]+)/i.exec(m[1]) || [])[1] || '').trim() })).filter((x) => x.url);
function parseIndexLinks(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = new URL(m[1], base).toString(); } catch { continue; }
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (/\.pdf($|\?)/i.test(url) || /recruit|notification|advertisement|advt|vacanc|bharti|bharthi|corrigendum|short[- ]?notice|apply[- ]?online|online[- ]?application|walk[- ]?in|engagement|openings?|भर्ती|विज्ञापन|अधिसूचना|ਭਰਤੀ|ਇਸ਼ਤਿਹਾਰ|నోటిఫికేషన్|அறிவிப்பு|വിജ്ഞാപനം/i.test(`${url} ${title}`)) out.push({ url, title });
  }
  return out;
}

const lastRequest = new Map();
async function polite(host, intervalMs, sleep, now) {
  const wait = (lastRequest.get(host) || 0) + intervalMs - now();
  if (wait > 0) await sleep(wait);
  lastRequest.set(host, now());
}

async function fetchChecked(url, source, env, robots, extraHeaders = {}) {
  // Follows at most 3 redirects. Every hop is re-validated: same official domain (allowlist), https only (an upgrade from
  // http is fine, a downgrade is refused), robots.txt for the same host, and the per-host rate limit. A redirect that leaves
  // the official domain is refused, never followed.
  let cur = url; const first = new URL(url).hostname.toLowerCase();
  for (let hop = 0; hop <= 3; hop++) {
    const u = new URL(cur);
    if (!['https:', 'http:'].includes(u.protocol) || (hop > 0 && u.protocol === 'http:')) { const e = new Error(`Refusing ${u.protocol} redirect target`); e.code = 'NOT_ALLOWLISTED'; throw e; }
    if (!inDomain(u.hostname.toLowerCase(), source.official_domain)) { const e = new Error(`${u.hostname} is not on the allowlist for ${source.source_id}`); e.code = 'NOT_ALLOWLISTED'; throw e; }
    if (robots && u.hostname.toLowerCase() === first && !robotsAllows(robots, u.pathname)) { const e = new Error('Disallowed by robots.txt'); e.code = 'ROBOTS'; throw e; }
    await polite(u.hostname, Math.max(source.min_request_interval_ms, robots ? robots.delayMs : 0), env.sleep, env.now);
    const res = await env.fetch(cur, { headers: { 'user-agent': UA, ...(hop === 0 ? extraHeaders : {}) }, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    if (!loc) return res;
    try { cur = new URL(loc, cur).toString(); } catch (_) { return res; }
  }
  const e = new Error('Too many redirects'); e.code = 'TOO_MANY_REDIRECTS'; throw e;
}

// env: { fetch, sleep, now } injectable for tests
async function crawlSource(source, env = {}) {
  env = { fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), ...env };
  if (!source.crawl_enabled || source.verification_status !== 'VERIFIED') return { skipped: 'Source is not verified and enabled for crawling.' };
  // Circuit breaker: after repeated failures the source rests until cooldown_until (set by registry.recordHealth).
  if (source.cooldown_until && new Date(source.cooldown_until).getTime() > env.now()) return { health: source.health, links: [], fresh: [], cooldown: true, until: source.cooldown_until };
  const started = env.now();
  try {
    const origin = new URL(source.portal_url).origin;
    let robots = null;
    try { const rr = await fetchChecked(`${origin}/robots.txt`, source, env, null); if (rr.ok) robots = parseRobots(await rr.text()); } catch (e) { if (e.code === 'NOT_ALLOWLISTED') throw e; }
    if (robots && !robotsAllows(robots, new URL(source.portal_url).pathname)) {
      await registry.recordHealth(source.source_id, 'BLOCKED', { error: 'robots.txt disallows the recruitment page' });
      return { health: 'BLOCKED', links: [] };
    }
    // Conditional request: if the portal supports ETag / Last-Modified and nothing changed, it answers 304 and we do no work.
    const cond = {}; if (source.etag) cond['if-none-match'] = source.etag; if (source.last_modified) cond['if-modified-since'] = source.last_modified;
    const res = await fetchChecked(source.portal_url, source, env, robots, cond);
    const hdr = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
    if (res.status === 304) {
      await registry.recordHealth(source.source_id, 'ONLINE', { success: true });
      return { health: 'ONLINE', links: source.last_links || [], fresh: [], rejected: [], notModified: true };
    }
    if (res.status === 403 || res.status === 429) { await registry.recordHealth(source.source_id, 'BLOCKED', { error: `HTTP ${res.status}` }); return { health: 'BLOCKED', links: [] }; }
    if (res.status >= 500) { await registry.recordHealth(source.source_id, 'TEMPORARILY_UNAVAILABLE', { error: `HTTP ${res.status}` }); return { health: 'TEMPORARILY_UNAVAILABLE', links: [] }; }
    if (!res.ok) { await registry.recordHealth(source.source_id, 'DEGRADED', { error: `HTTP ${res.status}` }); return { health: 'DEGRADED', links: [] }; }
    const body = await res.text();
    const elapsed = env.now() - started;
    let found;
    try {
      if (source.crawler === 'rss') found = parseRss(body); else if (source.crawler === 'sitemap') found = parseSitemap(body); else found = parseIndexLinks(body, source.portal_url);
    } catch (e) { await registry.recordHealth(source.source_id, 'PARSER_ERROR', { error: e.message }); return { health: 'PARSER_ERROR', links: [] }; }

    const links = []; const rejected = [];
    for (const f of found) { let h; try { h = new URL(f.url).hostname.toLowerCase(); } catch { continue; } (inDomain(h, source.official_domain) ? links : rejected).push(f); }
    const prev = source.last_links || [];
    const prevUrls = new Set(prev.map((l) => l.url));
    const fresh = links.filter((l) => !prevUrls.has(l.url));
    const indexHash = sha(JSON.stringify(links.map((l) => l.url).sort()));
    let health = elapsed > 5000 ? 'DEGRADED' : 'ONLINE';
    if (!links.length && prev.length) health = 'PARSER_ERROR';          // the page used to yield links and no longer does
    else if (prev.length && links.length && !links.some((l) => prevUrls.has(l.url)) && source.last_index_hash !== indexHash) health = 'CONTENT_CHANGED'; // wholly different link set
    await registry.recordHealth(source.source_id, health, { success: health !== 'PARSER_ERROR', indexHash, links, etag: hdr('etag'), lastModified: hdr('last-modified'), error: health === 'PARSER_ERROR' ? 'No recruitment links found on a page that previously had some' : null });
    return { health, links, fresh, rejected };
  } catch (e) {
    const blocked = e.code === 'ROBOTS';
    await registry.recordHealth(source.source_id, blocked ? 'BLOCKED' : 'TEMPORARILY_UNAVAILABLE', { error: e.message });
    return { health: blocked ? 'BLOCKED' : 'TEMPORARILY_UNAVAILABLE', links: [], error: e.message };
  }
}

// Download a single document found on a registered source. Same allowlist, robots and rate-limit rules.
async function downloadDocument(url, source, env = {}) {
  env = { fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), ...env };
  const origin = new URL(source.portal_url).origin; let robots = null;
  try { const rr = await fetchChecked(`${origin}/robots.txt`, source, env, null); if (rr.ok) robots = parseRobots(await rr.text()); } catch (e) { if (e.code === 'NOT_ALLOWLISTED') throw e; }
  const res = await fetchChecked(url, source, env, robots);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Document is larger than 25 MB');
  return buf;
}

module.exports = { crawlSource, downloadDocument, parseRobots, robotsAllows, parseSitemap, parseRss, parseIndexLinks, UA };
