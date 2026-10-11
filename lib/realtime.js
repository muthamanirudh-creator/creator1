// Real-time hub (Server-Sent Events). Everything pushed here is computed from published records or from
// live checks of official portals - nothing is invented. Clients get: pulse (live clock + counts),
// jobs.changed (published set or a deadline status changed), source.changed (portal went up/down),
// and per-account events (alerts) via publish(type, data, {accountId}).
const crypto = require('crypto');
const clients = new Set();
const ring = []; let seq = 0;
const RING = 100;

function frame(ev) { return `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`; }
function publish(type, data = {}, { accountId = null } = {}) {
  const ev = { id: ++seq, type, data: { ...data, at: new Date().toISOString() }, accountId };
  ring.push(ev); if (ring.length > RING) ring.shift();
  for (const c of clients) if (!ev.accountId || String(ev.accountId) === String(c.accountId)) { try { c.res.write(frame(ev)); } catch (_) { clients.delete(c); } }
  return ev;
}
function subscribe(req, res, { accountId = null } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, accountId }; clients.add(c);
  const last = Number((req.headers && req.headers['last-event-id']) || (req.query && req.query.since) || 0);
  for (const ev of ring) if (ev.id > last && (!ev.accountId || String(ev.accountId) === String(accountId))) res.write(frame(ev));
  res.write(frame({ id: ++seq, type: 'hello', data: { clients: clients.size, server_time: new Date().toISOString(), account: !!accountId } }));
  req.on('close', () => clients.delete(c));
}
// Monitor: a cheap snapshot every few seconds; emits only when something actually changed.
function start({ getJobs, checkSources, pollAlerts, pollFeed, pulseMs = 15000, feedMs = 5000, sourceMs = 120000 }) {
  let jobsHash = '', lastSources = new Map(), timers = [];
  const snap = async () => {
    try {
      const jobs = await getJobs(new Date());
      const open = jobs.filter(j => j.deadline?.status !== 'CLOSED');
      const sig = crypto.createHash('sha1').update(JSON.stringify(jobs.map(j => [j.id, j.deadline?.status, j.deadline?.closes_exact, j.lifecycle]))).digest('hex');
      const closing = open.filter(j => j.deadline?.status === 'CLOSING_SOON').map(j => ({ id: j.id, title: j.title, closes: j.deadline.closes_exact }));
      if (jobsHash && sig !== jobsHash) publish('jobs.changed', { total: jobs.length, open: open.length, closing_soon: closing.length });
      jobsHash = sig;
      publish('pulse', { clients: clients.size, total: jobs.length, open: open.length, closing_soon: closing.length, closing: closing.slice(0, 5) });
    } catch (e) { publish('pulse', { error: 'snapshot_failed' }); }
  };
  const src = async () => {
    try {
      const checks = await checkSources();
      for (const s of checks) {
        const prev = lastSources.get(s.source_id);
        if (prev !== s.status) { if (prev) publish('source.changed', { source_id: s.source_id, name: s.name, from: prev, to: s.status, latency_ms: s.latency_ms }); lastSources.set(s.source_id, s.status); }
      }
      publish('sources', { online: checks.filter(s => s.status === 'ONLINE').length, total: checks.length, items: checks.map(s => ({ source_id: s.source_id, name: s.name, status: s.status, latency_ms: s.latency_ms, links: (s.links || []).slice(0, 2).map(l => ({ title: String(l.title || '').slice(0, 140), url: l.url })) })) });
    } catch (_) {}
  };
  if (pollAlerts) timers.push(setInterval(async () => { if (!clients.size) return; try { for (const a of await pollAlerts()) publish('alert', a.data, { accountId: a.accountId }); } catch (_) {} }, 8000));
  // Feed events (new notification, deadline extended, amended, detected) are written by the worker; poll the table so they
  // reach every open browser within seconds regardless of which process wrote them. Primed once at start so history is not replayed.
  if (pollFeed) {
    pollFeed().catch(() => {});
    timers.push(setInterval(async () => {
      if (!clients.size) return;
      try { const evs = await pollFeed(); for (const e of evs) publish(e.type, e.data); if (evs.length) publish('jobs.changed', { reason: 'feed', count: evs.length }); } catch (_) {}
    }, feedMs));
  }
  snap(); timers.push(setInterval(snap, pulseMs)); timers.push(setInterval(() => publish('ping', {}), 20000));
  if (checkSources) { setTimeout(src, 1500); timers.push(setInterval(src, sourceMs)); }
  timers.forEach(t => t.unref && t.unref());
  return () => timers.forEach(clearInterval);
}
module.exports = { publish, subscribe, start, clientCount: () => clients.size };
