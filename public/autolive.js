/* GovCareer AI - "Latest from official sources" feed (additive, Overview). Real data only: /api/feed and /api/autolive/status.
 * Shows what the automatic monitor found, how fresh it is, and whether each item is verified. Nothing here is invented. */
(function () {
  'use strict';
  const q = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (_) { return ''; } };
  const KIND = { NEW_NOTIFICATION: ['NEW', 'is-new'], DEADLINE_EXTENDED: ['DEADLINE EXTENDED', 'is-ext'], AMENDED: ['AMENDED', 'is-amd'], DETECTED_UNVERIFIED: ['DETECTED · NOT VERIFIED', 'is-det'], RETRACTED: ['WITHDRAWN', 'is-ret'] };
  let events = [], status = null, error = '', loading = true, timer = null;

  function ago(iso) { const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); if (!isFinite(s)) return 'unknown'; if (s < 90) return 'just now'; if (s < 5400) return Math.round(s / 60) + ' min ago'; if (s < 129600) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }
  function host() {
    let sec = q('#auto-feed'); if (sec) return sec;
    const anchor = q('.live-panel') || q('#deadline-radar'); if (!anchor || !anchor.parentNode) return null;
    sec = document.createElement('section'); sec.id = 'auto-feed'; sec.className = 'auto-feed'; sec.setAttribute('aria-label', 'Latest from official sources');
    anchor.parentNode.insertBefore(sec, anchor); return sec;
  }
  function fresh() {
    if (!status) return '';
    if (status.mode === 'DEMO') return '<p class="muted">Demo mode: PostgreSQL is not connected, so notices are only detected as links on official portals. They are not read, verified or published automatically.</p>';
    const f = status.freshness || {}, s = status.sources || {};
    const last = f.last_successful_check ? `last successful check ${ago(f.last_successful_check)}` : 'no successful check yet';
    return `<p class="muted">Monitoring ${esc(s.monitored)} official source${s.monitored === 1 ? '' : 's'} (${esc(s.online)} responding) about every ${esc(f.interval_minutes || '30')} min · ${esc(last)}. ${s.pending_verification ? esc(s.pending_verification) + ' awaiting verification. ' : ''}This is scheduled monitoring, not instant detection.</p>`;
  }
  function card(e) {
    const p = e.payload || {}, k = KIND[e.kind] || [e.kind, ''], verified = p.verified !== false;
    const doc = safeUrl(p.document_url || p.official_url), app = safeUrl(p.application_link), src = safeUrl(p.source_url);
    const facts = [p.vacancies != null ? esc(p.vacancies) + ' vacancies' : null, p.application_close ? 'last date ' + esc(p.application_close) : null, p.eligibility && p.eligibility.education ? esc(p.eligibility.education) : null].filter(Boolean).join(' · ');
    const ch = (p.changes || []).slice(0, 3).map((c) => `<li>${esc(c.label)}: ${esc(c.from)} → ${esc(c.to)}${c.delta ? ' (' + esc(c.delta) + ')' : ''}</li>`).join('');
    return `<article class="af-card"><div class="af-top"><span class="af-badge ${k[1]}">${esc(k[0])}</span><time datetime="${esc(e.created_at)}">${esc(ago(e.created_at))}</time></div>
      <h3>${esc(e.title || 'Untitled notice')}</h3><p class="muted">${esc(e.organization || 'Organisation not stated')}${facts ? ' · ' + facts : ''}</p>${ch ? `<ul class="af-changes">${ch}</ul>` : ''}
      <p class="af-note">${verified ? (p.level === 'HUMAN_CONFIRMED' ? 'Read from the official document and confirmed by a reviewer.' : 'Read automatically from the official document; every key field is cited. Confirm on the official notice before applying.') : 'Detected on an official site but not yet verified. Open the official document and check every detail.'}</p>
      <div class="af-actions">${e.recruitment_id && verified && typeof window.openJob === 'function' ? `<button type="button" class="mini-btn" data-job="${esc(e.recruitment_id)}">Open details</button>` : ''}${doc ? `<a class="mini-btn" href="${esc(doc)}" target="_blank" rel="noopener noreferrer">Official document</a>` : ''}${app ? `<a class="mini-btn" href="${esc(app)}" target="_blank" rel="noopener noreferrer">Apply (official)</a>` : ''}${src ? `<a class="mini-btn" href="${esc(src)}" target="_blank" rel="noopener noreferrer">Source page</a>` : ''}</div></article>`;
  }
  function draw() {
    const sec = host(); if (!sec) return;
    let body;
    if (loading) body = '<div class="skeleton-card"></div>';
    else if (error) body = `<div class="af-empty" role="alert">${esc(error)} <button type="button" class="mini-btn" id="af-retry">Retry</button></div>`;
    else if (!events.length) body = `<div class="af-empty">No new notifications since monitoring began. When an official source publishes one it appears here automatically.</div>`;
    else body = `<div class="af-grid">${events.filter((e) => e.kind !== 'RETRACTED').map(card).join('')}</div>`;
    sec.innerHTML = `<div class="panel-title"><span>LATEST FROM OFFICIAL SOURCES</span><button id="af-refresh" class="mini-btn" type="button">Refresh</button></div>${fresh()}${body}`;
    const r = q('#af-refresh', sec); if (r) r.onclick = load; const rt = q('#af-retry', sec); if (rt) rt.onclick = load;
    sec.querySelectorAll('[data-job]').forEach((b) => { b.onclick = () => window.openJob(b.dataset.job); });
  }
  async function load() {
    try {
      const [f, s] = await Promise.all([fetch('/api/feed?limit=12', { cache: 'no-store' }), fetch('/api/autolive/status', { cache: 'no-store' })]);
      if (!f.ok) throw new Error('The feed is temporarily unavailable.');
      events = (await f.json()).events || []; status = s.ok ? await s.json() : null; error = '';
    } catch (e) { error = e.message || 'Could not load the feed.'; }
    loading = false; draw();
  }
  function start() { draw(); load(); timer = setInterval(() => { if (!document.hidden) load(); }, 60000); window.addEventListener('gc:feed', () => setTimeout(load, 400)); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.GovAutoLive = { reload: load };
})();
