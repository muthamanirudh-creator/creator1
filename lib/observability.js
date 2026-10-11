'use strict';
// Request metrics, request IDs and structured logging. snapshot() keeps its original fields and adds latency
// percentiles, per-route stats and provider circuit state. Logs never include bodies, headers, tokens or query strings.
const crypto = require('crypto');
const resilience = require('./resilience');

const metrics = { requests: 0, errors: 0, latencyMs: 0, startedAt: Date.now() };
const routes = new Map();            // "GET /api/jobs/:id" -> { n, errors, lat[] }
const recent = [];                    // rolling window of latencies for global percentiles
const MAX_ROUTES = 200, WINDOW = 1000;

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
function requestId(req) { const h = req.headers && req.headers['x-request-id']; return SAFE_ID.test(String(h || '')) ? String(h) : crypto.randomUUID(); }
// Collapse ids so route cardinality stays bounded and no identifiers are stored.
function routeKey(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id').replace(/\/\d+/g, '/:id').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|\.|$)/g, '/:token');
  return `${req.method} ${path.slice(0, 120)}`;
}
function pct(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; }

function middleware(req, res, next) {
  const t = Date.now(); const id = requestId(req); req.id = id; res.setHeader('X-Request-Id', id); metrics.requests++;
  res.on('finish', () => {
    const ms = Date.now() - t; metrics.latencyMs += ms; if (res.statusCode >= 500) metrics.errors++;
    recent.push(ms); if (recent.length > WINDOW) recent.shift();
    const k = routeKey(req); let r = routes.get(k);
    if (!r) { if (routes.size >= MAX_ROUTES) return; r = { n: 0, errors: 0, lat: [] }; routes.set(k, r); }
    r.n++; if (res.statusCode >= 500) r.errors++; r.lat.push(ms); if (r.lat.length > 100) r.lat.shift();
    if (process.env.LOG_REQUESTS === '1' || res.statusCode >= 500) log(res.statusCode >= 500 ? 'error' : 'info', 'request', { id, route: k, status: res.statusCode, ms });
  });
  next();
}
function log(level, msg, fields = {}) {
  if (process.env.NODE_ENV === 'test' && process.env.LOG_REQUESTS !== '1') return;
  const safe = {}; for (const [k, v] of Object.entries(fields)) { if (/pass|token|secret|authorization|cookie|email|key/i.test(k)) continue; safe[k] = typeof v === 'string' ? v.slice(0, 300) : v; }
  (level === 'error' ? console.error : console.log)(JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe }));
}
function snapshot() {
  const uptime = (Date.now() - metrics.startedAt) / 1000;
  const top = [...routes.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25).map(([route, r]) => ({ route, requests: r.n, errors: r.errors, p50_ms: pct(r.lat, 50), p95_ms: pct(r.lat, 95) }));
  return { ...metrics, uptimeSeconds: uptime, avgLatencyMs: metrics.requests ? metrics.latencyMs / metrics.requests : 0, errorRate: metrics.requests ? metrics.errors / metrics.requests : 0,
    latency: { p50_ms: pct(recent, 50), p95_ms: pct(recent, 95), p99_ms: pct(recent, 99), window: recent.length }, routes: top, providers: resilience.snapshot() };
}
module.exports = { middleware, snapshot, log, requestId, routeKey };
