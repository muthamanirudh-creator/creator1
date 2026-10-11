// Database-free detector for demo / standalone mode. With no PostgreSQL there is no ingestion pipeline, so the honest
// minimum is: remember which official links each portal showed, and report links that appear AFTER the first look as
// "detected, not extracted, not verified". The first look of each portal is only a baseline (never reported as new).
const seen = new Set(); const primed = new Set(); const events = []; let seq = 0;
function observe(checks, now = new Date()) {
  const fresh = [];
  for (const c of checks || []) {
    if (!c || c.status !== 'ONLINE' || !Array.isArray(c.links)) continue;
    const first = !primed.has(c.source_id);
    for (const l of c.links) {
      const key = `${c.source_id}|${l.url}`; if (seen.has(key)) continue; seen.add(key);
      if (first) continue;
      const ev = { id: ++seq, kind: 'DETECTED_UNVERIFIED', recruitment_id: null, title: String(l.title || l.url).slice(0, 200), organization: c.name, created_at: now.toISOString(),
        payload: { verified: false, detected_only: true, official_url: l.url, document_url: l.url, source_name: c.name, source_id: c.source_id } };
      events.push(ev); fresh.push(ev);
    }
    primed.add(c.source_id);
  }
  while (events.length > 200) events.shift();
  return fresh;
}
const recent = ({ since = 0, limit = 30 } = {}) => events.filter((e) => e.id > since).slice(-limit).reverse();
const maxId = () => seq;
const reset = () => { seen.clear(); primed.clear(); events.length = 0; seq = 0; };
module.exports = { observe, recent, maxId, reset };
