// Pure alert planning (no DB, no clock). Decides WHICH alerts should exist; the store decides whether they are new.
// Guarantees: one DEADLINE_CHANGED alert per (account, recruitment, published version) with every changed date in it;
// one NEW_MATCH alert per (account, recruitment); never for unverified changes; never for jobs published before the
// saved search existed (no flood when a search is created).
const DATE_FIELD = /^dates(\.|$)/;

// The same eligibility rules the SQL applies, re-checked in code so they are testable and cannot be bypassed by a query edit.
function eligibleDeadlineRow(r, now = new Date(), lookbackDays = 30) {
  if (!DATE_FIELD.test(r.field)) return false;
  if (r.supported !== true) return false;                                   // no page+quote evidence -> never alert
  if (r.account_active === false) return false;                              // consent withdrawn
  if (r.published_version == null || Number(r.to_version) > Number(r.published_version)) return false; // still in review
  const det = Date.parse(r.detected_at), w = Date.parse(r.watch_created_at);
  if (Number.isNaN(det) || Number.isNaN(w) || det < w) return false;         // happened before the user watched
  if (det < now.getTime() - lookbackDays * 86400000) return false;
  return true;
}

function planDeadlineAlerts(rows, { now = new Date(), lookbackDays = 30 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    if (!eligibleDeadlineRow(r, now, lookbackDays)) continue;
    const k = `${r.account_id}|${r.recruitment_id}|${r.to_version}`;
    if (!groups.has(k)) groups.set(k, { accountId: r.account_id, recruitmentId: r.recruitment_id, version: String(r.to_version), title: r.title, changes: [] });
    groups.get(k).changes.push({ field: r.field, label: r.label || r.field, from: r.from_value, to: r.to_value });
  }
  return [...groups.values()].map((g) => ({
    accountId: g.accountId, recruitmentId: g.recruitmentId, eventType: 'DEADLINE_CHANGED',
    dedupeKey: `DEADLINE_CHANGED:${g.recruitmentId}:${g.version}`,
    // field/from/to mirror the first change so existing clients keep working; `changes` carries all of them.
    payload: { version: g.version, title: g.title, field: g.changes[0].field, from: g.changes[0].from, to: g.changes[0].to, changes: g.changes },
  }));
}

function publishedAt(job) { const v = job && job.verification && job.verification.verified_at; const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; }

function planMatchAlerts({ searches, jobs, runSearch, now = new Date() }) {
  const seen = new Set(); const out = [];
  for (const s of searches) {
    const since = s.created_at ? Date.parse(s.created_at) : NaN;
    for (const j of runSearch(jobs, s.filters || {}, {}, now)) {
      const pub = publishedAt(j);
      if (pub === null || Number.isNaN(since) || pub < since) continue; // cannot prove it is new -> stay silent
      const dedupeKey = `NEW_MATCH:${j.id}:1`; const k = `${s.account_id}|${dedupeKey}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ accountId: s.account_id, recruitmentId: j.id, eventType: 'NEW_MATCH', dedupeKey, payload: { version: '1', title: j.title, search_id: s.id, search_name: s.name } });
    }
  }
  return out;
}

module.exports = { eligibleDeadlineRow, planDeadlineAlerts, planMatchAlerts, DATE_FIELD };
