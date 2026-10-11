'use strict';
// Circuit breaker + latency tracking for external providers (LLM, notification, crawler fetches).
// After `threshold` consecutive failures the circuit opens for `cooldownMs`; one probe is then allowed (half-open).
// Failures are surfaced to callers, never replaced with fabricated output.
const stats = new Map();

function get(name, opts = {}) {
  if (!stats.has(name)) stats.set(name, { name, state: 'CLOSED', failures: 0, openedAt: 0, calls: 0, ok: 0, errors: 0, shortCircuited: 0, lat: [], lastError: null, threshold: opts.threshold || 3, cooldownMs: opts.cooldownMs || 30000 });
  const s = stats.get(name); if (opts.threshold) s.threshold = opts.threshold; if (opts.cooldownMs) s.cooldownMs = opts.cooldownMs; return s;
}
function canCall(name, now = Date.now()) {
  const s = get(name);
  if (s.state === 'OPEN') { if (now - s.openedAt >= s.cooldownMs) { s.state = 'HALF_OPEN'; return true; } return false; }
  return true;
}
function record(name, ok, ms, err, now = Date.now()) {
  const s = get(name); s.calls++;
  if (Number.isFinite(ms)) { s.lat.push(ms); if (s.lat.length > 200) s.lat.shift(); }
  if (ok) { s.ok++; s.failures = 0; s.state = 'CLOSED'; s.lastError = null; return; }
  s.errors++; s.failures++; s.lastError = String(err && err.message ? err.message : err).slice(0, 200);
  if (s.state === 'HALF_OPEN' || s.failures >= s.threshold) { s.state = 'OPEN'; s.openedAt = now; }
}
// Runs fn under the breaker. Throws an Error with code CIRCUIT_OPEN when the provider is being skipped.
async function guarded(name, fn, opts = {}) {
  if (!canCall(name)) { const s = get(name); s.shortCircuited++; const e = new Error(`${name} temporarily unavailable (circuit open after repeated failures)`); e.code = 'CIRCUIT_OPEN'; throw e; }
  get(name, opts); const t = Date.now();
  try { const v = await fn(); record(name, true, Date.now() - t); return v; } catch (e) { record(name, false, Date.now() - t, e); throw e; }
}
function pct(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)]; }
function snapshot() {
  return [...stats.values()].map((s) => ({ provider: s.name, state: s.state, calls: s.calls, ok: s.ok, errors: s.errors, short_circuited: s.shortCircuited,
    p50_ms: pct(s.lat, 50), p95_ms: pct(s.lat, 95), last_error: s.lastError }));
}
function reset() { stats.clear(); }
module.exports = { guarded, canCall, record, snapshot, reset, get };
