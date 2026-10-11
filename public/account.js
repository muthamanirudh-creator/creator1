/* GovCareer AI — Account UI (additive module).
 * Works on top of app.js without modifying it:
 *  - adds the Bearer token to /api/account/* requests (so the existing tracker starts working when signed in)
 *  - sign in / register with explicit consent, sign out
 *  - watchlist, saved searches (alert on/off), alerts inbox, application tracker with status editing
 *  - preferences, calendar feed, data export, consent withdrawal, account deletion
 * In the zero-dependency standalone runtime there are no real accounts; the module detects this and
 * says so instead of pretending. */
(function () {
  'use strict';
  const TOKEN_KEY = 'govcareer.citizen.token.v1';
  const STATUSES = ['SAVED', 'PLANNED', 'APPLIED', 'ADMIT_CARD', 'EXAM_DONE', 'RESULT_AWAITED', 'SELECTED', 'NOT_SELECTED', 'WITHDRAWN'];
  const STATUS_LABEL = { SAVED: 'Saved', PLANNED: 'Planning to apply', APPLIED: 'Applied', ADMIT_CARD: 'Admit card received', EXAM_DONE: 'Exam done', RESULT_AWAITED: 'Result awaited', SELECTED: 'Selected', NOT_SELECTED: 'Not selected', WITHDRAWN: 'Withdrawn' };
  const q = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (typeof window.showToast === 'function' ? window.showToast(m) : console.log(m));
  const fmt = (s) => { if (!s) return ''; const d = new Date(s); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };

  let token = null; try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  let user = null;
  let mode = 'unknown'; // 'accounts' | 'demo' | 'unknown'
  const setToken = (t) => { token = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

  // Attach the bearer token to account calls made by the existing app.js api() helper.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (token && /^\/api\/account(\/|$)/.test(new URL(url, location.origin).pathname)) {
        const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
        if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
        init = { ...init, headers };
      }
    } catch { /* fall through with the original request */ }
    return nativeFetch(input, init);
  };

  async function call(url, opts = {}) {
    const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) };
    const r = await fetch(url, { ...opts, headers });
    let d = {}; try { d = await r.json(); } catch { /* empty body */ }
    if (r.status === 401 && token) { setToken(null); user = null; renderAll(); }
    if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status });
    return d;
  }

  // ---------- session ----------
  async function detect() {
    try {
      const me = await call('/api/account/me');
      user = me; mode = me && me.id ? 'accounts' : 'demo';
    } catch (e) {
      if (e.status === 401) mode = 'accounts';       // real accounts, just not signed in here yet
      else if (e.status === 404 || e.status === 405) mode = 'demo';       // standalone: no account system
      else mode = 'unknown';
      user = null;
      if (mode === 'accounts') { try { await ssoSignIn(false); } catch (x) { if (x.status === 503) mode = 'demo'; } }  // silent: uses the Campus session
    }
    renderAll();
  }

  // ---------- header button + dialog ----------
  function mountHeader() {
    const actions = q('.header-actions'); if (!actions || q('#account-btn')) return;
    const b = document.createElement('button');
    b.id = 'account-btn'; b.type = 'button'; b.className = 'profile-pill account-pill'; b.textContent = 'Sign in';
    b.onclick = () => (user ? (window.nav ? window.nav('tools') : null) : openAuth('login'));
    actions.insertBefore(b, actions.firstChild);
  }

  // One login for the whole app: the Campus sign-in. GovCareer never shows its own password form.
  const EMBEDDED = document.documentElement.classList.contains('gc-embed'); // shown as a sub-tab inside the Campus portal
  function campusLoginUrl() { return '/campus/?next=' + encodeURIComponent(location.pathname + location.search); }
  function dialog() {
    let d = q('#auth-dialog');
    if (d) return d;
    d = document.createElement('div'); d.id = 'auth-dialog'; d.className = 'modal-backdrop'; d.hidden = true;
    d.innerHTML = `<div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <button class="close" id="auth-close" aria-label="Close">Close</button>
      <h2 id="auth-title">Use GovCareer with your Campus account</h2>
      <p class="fine" id="auth-sub">You are signed in once, through Campus. GovCareer will create your tracker, alerts and watchlist under the same email.</p>
      <label class="check"><input id="auth-consent" type="checkbox"> I agree to the privacy policy: my data is used only to provide alerts, tracking and eligibility help, and I can export or delete it at any time.</label>
      <div id="auth-error" class="auth-error" role="alert" aria-live="assertive"></div>
      <button class="primary-btn" id="auth-continue" type="button">Continue</button>
      <p class="fine">GovCareer AI is an independent service and is not affiliated with any government body.</p>
    </div>`;
    document.body.appendChild(d);
    q('#auth-close', d).onclick = closeAuth;
    d.addEventListener('click', (e) => { if (e.target === d) closeAuth(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !d.hidden) closeAuth(); });
    q('#auth-continue', d).onclick = async () => {
      const err = q('#auth-error', d);
      if (!q('#auth-consent', d).checked) { err.textContent = 'Please accept the privacy policy to continue.'; return; }
      err.textContent = '';
      try { await ssoSignIn(true); closeAuth(); } catch (ex) { err.textContent = ex.message; }
    };
    return d;
  }
  function closeAuth() { dialog().hidden = true; }
  // Kept under the old name because other modules call it: it now means "go to the single login".
  function openAuth() {
    if (mode === 'demo') { toast('Accounts need the PostgreSQL runtime. Your tracker works locally on this device.'); return; }
    if (EMBEDDED) { // already inside the Campus portal: reuse its session, never navigate the frame
      ssoSignIn(false).catch((ex) => toast(ex && ex.message ? ex.message : 'Could not use your Campus session — reload the Campus portal and try again.'));
      return;
    }
    location.href = campusLoginUrl();
  }
  // Exchange the Campus session for a GovCareer session. First time only: asks for explicit consent.
  async function ssoSignIn(consent) {
    const r = await call('/api/account/sso', { method: 'POST', body: JSON.stringify(consent ? { consent: true } : {}) });
    if (r.needsConsent) { const d = dialog(); d.hidden = false; return null; }
    setToken(r.token); user = r.user; mode = 'accounts';
    { const dlg = q('#auth-dialog'); if (dlg) dlg.hidden = true; }
    renderAll(); await loadAll(); if (typeof window.loadTools === 'function') window.loadTools();
    if (window.GovLive && window.GovLive.reconnect) window.GovLive.reconnect();
    toast('Signed in with your Campus account.');
    return r;
  }

  async function signOut() {
    try { await call('/api/account/logout', { method: 'POST', body: '{}' }); } catch { /* token may already be invalid */ }
    setToken(null); user = null; renderAll();
    if (EMBEDDED) { toast('Signed out of GovCareer AI. Use the Campus menu to sign out of the portal.'); return; } // keep the Campus session and stay in the sub-tab
    try { await nativeFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* campus may be offline */ }
    location.href = '/campus/';
  }

  // ---------- My Tools dashboard ----------
  function mountDashboard() {
    const view = q('#view-tools'); if (!view || q('#account-dashboard')) return;
    const wrap = document.createElement('section'); wrap.id = 'account-dashboard'; wrap.className = 'acct';
    view.insertBefore(wrap, q('.tool-grid', view));
  }

  const state = { watch: [], searches: [], alerts: [], apps: [], prefs: null };

  async function loadAll() {
    if (!user) return;
    const get = async (u, d) => { try { return await call(u); } catch { return d; } };
    const [watch, searches, alerts, apps, prefs] = await Promise.all([
      get('/api/account/watchlist', []), get('/api/account/searches', []), get('/api/account/alerts', []),
      get('/api/account/applications', []), get('/api/account/preferences', null)]);
    Object.assign(state, { watch, searches, alerts, apps, prefs });
    renderDashboard();
  }

  function renderAll() {
    const b = q('#account-btn');
    if (b) b.textContent = user ? (user.name || user.email || 'Account').split(' ')[0] : 'Sign in';
    renderDashboard();
  }

  function renderDashboard() {
    const el = q('#account-dashboard'); if (!el) return;
    if (!user) {
      el.innerHTML = `<div class="acct-signed-out"><div><h3>${mode === 'demo' ? 'Demo mode' : 'Sign in once with Campus to unlock your cockpit'}</h3>
        <p>${mode === 'demo' ? 'Real accounts need the PostgreSQL runtime. Local tracking below still works on this device.' : 'Watch opportunities, save searches with alerts, track every application stage and get a private deadline calendar.'}</p></div>
        ${mode === 'demo' ? '' : '<div class="acct-actions"><button class="primary-btn" id="acct-login">Sign in</button></div>'}</div>`;
      const l = q('#acct-login'); if (l) l.onclick = () => openAuth();
      return;
    }
    const upcoming = state.apps.filter((a) => !['SELECTED', 'NOT_SELECTED', 'WITHDRAWN'].includes(a.status)).length;
    el.innerHTML = `
      <div class="acct-head"><div><div class="eyebrow">SIGNED IN</div><h3>${esc(user.name || user.email)}</h3><p class="muted">${esc(user.email || '')}</p></div>
        <div class="acct-stats"><span><strong>${state.watch.length}</strong> watching</span><span><strong>${state.searches.length}</strong> saved searches</span><span><strong>${upcoming}</strong> active applications</span><span><strong>${state.alerts.length}</strong> alerts</span></div>
        <button class="ghost-btn" id="acct-signout">Sign out</button></div>
      <div class="acct-grid">
        <article class="tool-card"><h3>Tracker</h3><p>Move each application through its stages.</p><div id="acct-apps" class="mini-list">${appsHtml()}</div></article>
        <article class="tool-card"><h3>Watchlist</h3><p>Opportunities you follow for updates.</p><div id="acct-watch" class="mini-list">${watchHtml()}</div></article>
        <article class="tool-card"><h3>Saved searches</h3><p>Turn alerts on to hear about new matches.</p><div id="acct-searches" class="mini-list">${searchesHtml()}</div><button class="secondary-btn" id="acct-save-search">Save current search</button></article>
        <article class="tool-card"><h3>Alerts inbox</h3><p>Deadline, amendment and match notices.</p><div id="acct-alerts" class="mini-list">${alertsHtml()}</div></article>
        <article class="tool-card wide"><h3>Preferences &amp; privacy</h3>
          <div class="acct-pref"><label class="check"><input type="checkbox" id="pref-voice" ${state.prefs?.voice_enabled ? 'checked' : ''}> Enable voice features</label>
          <div class="acct-actions"><button class="secondary-btn" id="acct-export">Download my data</button><button class="secondary-btn" id="acct-withdraw">Withdraw consent</button><button class="danger-btn" id="acct-delete">Delete account</button></div></div>
          <p class="fine">Export includes everything stored about you. Deleting removes your account and all linked data permanently.</p></article>
      </div>`;
    wireDashboard();
  }

  const empty = (t) => `<div class="muted">${t}</div>`;
  function appsHtml() {
    if (!state.apps.length) return empty('Nothing tracked yet. Open an opportunity and choose “Track this opportunity”.');
    return state.apps.map((a) => `<div class="mini-item" data-app="${esc(a.recruitment_id)}"><strong>${esc(a.title)}</strong>
      <div class="acct-row"><select aria-label="Status for ${esc(a.title)}" class="app-status">${STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
      <input class="app-no" placeholder="Application no." value="${esc(a.application_number || '')}" aria-label="Application number" maxlength="60"></div>
      <input class="app-notes" placeholder="Notes" value="${esc(a.notes || '')}" aria-label="Notes" maxlength="300">
      <span class="muted">Updated ${esc(fmt(a.updated_at))}</span></div>`).join('');
  }
  function watchHtml() {
    if (!state.watch.length) return empty('Not watching anything yet.');
    return state.watch.map((w) => `<div class="mini-item acct-row" data-id="${esc(w.recruitment_id)}"><button class="text-btn open-job">${esc(w.title)}</button><button class="text-btn unwatch" aria-label="Stop watching ${esc(w.title)}">Remove</button></div>`).join('');
  }
  function searchesHtml() {
    if (!state.searches.length) return empty('No saved searches.');
    return state.searches.map((s) => `<div class="mini-item acct-row" data-sid="${esc(s.id)}"><span><strong>${esc(s.name)}</strong><br><span class="muted">${esc(s.query || Object.keys(s.filters || {}).join(', ') || 'All opportunities')}</span></span>
      <span><label class="check"><input type="checkbox" class="ss-enabled" ${s.enabled ? 'checked' : ''}> Alerts</label><button class="text-btn ss-del" aria-label="Delete saved search ${esc(s.name)}">Delete</button></span></div>`).join('');
  }
  function alertsHtml() {
    if (!state.alerts.length) return empty('No alerts yet. They appear when a watched or saved item changes.');
    return state.alerts.slice(0, 12).map((a) => `<div class="mini-item"><strong>${esc(String(a.event_type || '').replace(/_/g, ' '))}</strong><br><span class="muted">${esc(a.payload?.title || a.payload?.message || a.recruitment_id || '')} · ${esc(fmt(a.created_at))}</span></div>`).join('');
  }

  function wireDashboard() {
    q('#acct-signout').onclick = signOut;
    const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await loadAll(); } catch (e) { toast(e.message); } };
    document.querySelectorAll('#acct-apps [data-app]').forEach((row) => {
      const id = row.dataset.app, save = () => act(() => call(`/api/account/applications/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status: q('.app-status', row).value, application_number: q('.app-no', row).value.trim() || null, notes: q('.app-notes', row).value.trim() || null, applied_at: q('.app-status', row).value === 'APPLIED' ? new Date().toISOString() : undefined }) }), 'Tracker updated');
      q('.app-status', row).onchange = save; q('.app-no', row).onchange = save; q('.app-notes', row).onchange = save;
    });
    document.querySelectorAll('#acct-watch [data-id]').forEach((row) => {
      q('.open-job', row).onclick = () => { if (typeof window.openJob === 'function') window.openJob(row.dataset.id); };
      q('.unwatch', row).onclick = () => act(() => call(`/api/account/watchlist/${encodeURIComponent(row.dataset.id)}`, { method: 'DELETE' }), 'Removed from watchlist');
    });
    document.querySelectorAll('#acct-searches [data-sid]').forEach((row) => {
      q('.ss-enabled', row).onchange = (e) => act(() => call(`/api/account/searches/${row.dataset.sid}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }), e.target.checked ? 'Alerts on' : 'Alerts off');
      q('.ss-del', row).onclick = () => act(() => call(`/api/account/searches/${row.dataset.sid}`, { method: 'DELETE' }), 'Saved search deleted');
    });
    q('#acct-save-search').onclick = () => {
      const text = (q('#q') && q('#q').value || '').trim();
      const name = (prompt('Name this search', text || 'My search') || '').trim(); if (!name) return;
      act(() => call('/api/account/searches', { method: 'POST', body: JSON.stringify({ name, query: text || null, filters: text ? undefined : {} }) }), 'Search saved');
    };
    q('#pref-voice').onchange = (e) => act(() => call('/api/account/preferences', { method: 'PUT', body: JSON.stringify({ language: state.prefs?.language || localStorage.getItem('govcareer.language.v2') || 'en', voice_enabled: e.target.checked }) }), 'Preferences saved');
    q('#acct-export').onclick = async () => {
      try { const d = await call('/api/account/export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'govcareer-my-data.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
      catch (e) { toast(e.message); }
    };
    q('#acct-withdraw').onclick = async () => {
      if (!confirm('Withdraw consent? Your account will be deactivated and you will be signed out.')) return;
      try { await call('/api/account/consent/withdraw', { method: 'POST', body: '{}' }); setToken(null); user = null; renderAll(); toast('Consent withdrawn. Your account is deactivated.'); } catch (e) { toast(e.message); }
    };
    q('#acct-delete').onclick = async () => {
      if (!confirm('Permanently delete your account and all data? This cannot be undone.')) return;
      try { await call('/api/account', { method: 'DELETE' }); setToken(null); user = null; renderAll(); toast('Account deleted.'); } catch (e) { toast(e.message); }
    };
  }

  // ---------- job drawer: Watch + server-side Track ----------
  let currentJobId = null;
  function enhanceDrawer() {
    const body = q('#d-body'); if (!body) return;
    // Record which job is open without depending on app.js internals.
    if (typeof window.openJob === 'function' && !window.openJob.__acct) {
      const orig = window.openJob;
      window.openJob = function (id, ...rest) { currentJobId = id; return orig.call(this, id, ...rest); };
      window.openJob.__acct = true;
    }
    new MutationObserver(() => {
      const trackBtn = q('#track-job', body); if (!trackBtn || q('#watch-job', body)) return;
      const jobIdNow = () => currentJobId || (typeof lastJobId !== 'undefined' ? lastJobId : null);
      const w = document.createElement('button'); w.id = 'watch-job'; w.type = 'button'; w.className = 'secondary-btn'; w.textContent = 'Watch for updates';
      trackBtn.parentElement.insertBefore(w, trackBtn.nextSibling);
      const isWatched = () => state.watch.some((x) => x.recruitment_id === jobIdNow());
      const paint = () => { w.textContent = isWatched() ? 'Watching ✓' : 'Watch for updates'; };
      paint();
      w.onclick = async () => {
        if (!user) { if (mode === 'demo') { toast('Watchlists need the PostgreSQL runtime. Use Track for local tracking.'); return; } openAuth('login'); return; }
        const jobId = jobIdNow();
        try {
          if (isWatched()) await call(`/api/account/watchlist/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
          else await call(`/api/account/watchlist/${encodeURIComponent(jobId)}`, { method: 'POST', body: '{}' });
          await loadAll(); paint(); toast(isWatched() ? 'Watching this opportunity' : 'Stopped watching');
        } catch (e) { toast(e.message); }
      };
      // When signed in, mirror "Track" into the account tracker too (the local tracker keeps working).
      trackBtn.addEventListener('click', async () => {
        const jobId = jobIdNow();
        if (!user || !jobId) return;
        try { await call(`/api/account/applications/${encodeURIComponent(jobId)}`, { method: 'PUT', body: JSON.stringify({ status: 'SAVED' }) }); await loadAll(); } catch { /* local tracker already saved it */ }
      });
    }).observe(body, { childList: true, subtree: true });
  }

  function init() { mountHeader(); mountDashboard(); enhanceDrawer(); detect().then(loadAll); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.GovCareerAccount = { openAuth, signOut, refresh: loadAll, get user() { return user; }, get mode() { return mode; } };
})();
