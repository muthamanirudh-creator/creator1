/* GovCareer AI - dynamic overview metrics (additive).
   Single owner of the four Overview cards so they never flash a misleading "0".
   Everything shown is computed from the running app: published records (/api/search + live pulse),
   the official-source monitor (/api/autolive/status) and the notice feed (/api/feed). Nothing is invented.
   - While data is loading the card shows a shimmer, not a number.
   - Verified count > 0  -> shown as before.
   - Verified count = 0  -> the card switches to what the app really knows: notices detected on official
     portals (verification pending), else portals monitored live, else a live-monitoring state. */
(function () {
  'use strict';
  const q = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString('en-IN');
  const S = { verified: null, closing: null, exams: null, detected: null, srcOnline: null, srcTotal: null, monitored: null, sourcesSettled: false };

  function card(id, value, label, loading) {
    const el = q(id); if (!el) return;
    const lab = el.parentElement && el.parentElement.querySelector('span');
    el.classList.toggle('gcm-skel', !!loading);
    if (loading) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
    el.textContent = loading ? '' : String(value);
    if (lab && label) lab.textContent = label;
  }

  function render() {
    // 1) Opportunities
    if (S.verified === null) card('#metric-jobs', '', 'verified opportunities', true);
    else if (S.verified > 0) card('#metric-jobs', fmt(S.verified), 'verified opportunities');
    else if (S.detected > 0) card('#metric-jobs', fmt(S.detected), 'new notices detected · verification in progress');
    else if (S.srcTotal > 0) card('#metric-jobs', S.srcOnline + '/' + S.srcTotal, 'official portals monitored live');
    else if (S.monitored > 0) card('#metric-jobs', fmt(S.monitored), 'official sources monitored live');
    else if (!S.sourcesSettled) card('#metric-jobs', '', 'checking official sources…', true);
    else card('#metric-jobs', 'Live', 'watching official portals for new notices');

    // 2) Deadlines
    if (S.verified === null) card('#metric-deadlines', '', 'deadlines to watch', true);
    else if (S.closing > 0) card('#metric-deadlines', fmt(S.closing), 'deadlines to watch');
    else if (S.verified > 0) card('#metric-deadlines', 'None', 'closing soon · all clear');
    else card('#metric-deadlines', 'Auto', 'deadline tracking starts with the first notice');

    // 3) Exam versions
    if (S.exams === null) card('#metric-exams', '', 'verified exam versions', true);
    else if (S.exams > 0) card('#metric-exams', fmt(S.exams), 'verified exam versions');
    else card('#metric-exams', '—', 'exam versions syncing');
  }

  function set(patch) {
    if (!patch) return;
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v === undefined) continue;
      S[k] = (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? v : (v === null ? null : S[k]);
    }
    render();
  }

  // Live source monitor + notice feed. Works in both runtimes (PostgreSQL and resilient demo).
  async function getJson(url) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 9000);
    try { const r = await fetch(url, { cache: 'no-store', signal: c.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
    finally { clearTimeout(t); }
  }
  async function refreshSources() {
    const [st, fd] = await Promise.allSettled([getJson('/api/autolive/status'), getJson('/api/feed?limit=100')]);
    const patch = { sourcesSettled: true };
    if (st.status === 'fulfilled' && st.value) {
      const v = st.value;
      if (v.sources && typeof v.sources === 'object' && !Array.isArray(v.sources) && Number(v.sources.monitored) >= 0) {
        patch.monitored = Number(v.sources.monitored || 0);
        patch.srcOnline = Number(v.sources.online || 0); patch.srcTotal = patch.monitored;
      } else if (v.live && Array.isArray(v.live.sources) && v.live.sources.length) {
        patch.srcTotal = v.live.sources.length;
        patch.srcOnline = v.live.sources.filter((x) => x && x.status === 'ONLINE').length;
      }
    }
    if (fd.status === 'fulfilled' && fd.value && Array.isArray(fd.value.events)) {
      const seen = new Set();
      fd.value.events.forEach((e) => { if (e && e.kind === 'DETECTED_UNVERIFIED') seen.add(e.recruitment_id || e.title); });
      patch.detected = seen.size;
    }
    set(patch);
  }

  function start() {
    render();
    refreshSources().catch(() => set({ sourcesSettled: true }));
    setInterval(() => { if (!document.hidden) refreshSources().catch(() => {}); }, 60000);
    window.addEventListener('gc:feed', () => setTimeout(() => refreshSources().catch(() => {}), 500));
    // Safety net: if the overview request never settles (offline / blocked), stop shimmering after 12s.
    setTimeout(() => { if (S.verified === null) set({ verified: 0 }); if (S.exams === null) set({ exams: 0 }); }, 12000);
  }
  window.GCMetrics = { set, render, refreshSources, state: S };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
