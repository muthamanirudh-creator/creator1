/* GovCareer AI v2.10.0 - "Instant alerts" panel and India coverage (additive; sits above "Latest from official sources").
 * Real data only: /api/push/config, /api/national/coverage. Notifications come from the server when an official source has a new notice.
 * Nothing here invents a notice. CSP-safe: no inline handlers. */
(function () {
  'use strict';
  const q = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'gc-push-prefs';
  let cfg = null, cov = null, sub = null, busy = false, msg = '', err = '';
  let prefs = { states: [], include_central: true, include_unverified: false };

  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const loadPrefs = () => { try { const p = JSON.parse(localStorage.getItem(KEY) || 'null'); if (p && typeof p === 'object') prefs = { states: Array.isArray(p.states) ? p.states : [], include_central: p.include_central !== false, include_unverified: p.include_unverified === true }; } catch (_) {} };
  const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {} };
  const b64ToU8 = (b64) => { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };

  function host() {
    let sec = q('#national-alerts'); if (sec) return sec;
    const anchor = q('#auto-feed') || q('.live-panel') || q('#deadline-radar'); if (!anchor || !anchor.parentNode) return null;
    sec = document.createElement('section'); sec.id = 'national-alerts'; sec.className = 'na-panel'; sec.setAttribute('aria-label', 'Instant alerts for official notices across India');
    anchor.parentNode.insertBefore(sec, anchor); return sec;
  }

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`); return j;
  }
  async function registration() { return navigator.serviceWorker.ready; }
  async function currentSub() { if (!supported()) return null; try { const reg = await registration(); return await reg.pushManager.getSubscription(); } catch (_) { return null; } }

  async function enable() {
    busy = true; msg = ''; err = ''; draw();
    try {
      if (!supported()) throw new Error('This browser does not support push notifications. You will still see new notices here and can use the Atom feed.');
      if (!cfg || !cfg.supported || !cfg.publicKey) throw new Error('Alerts are not available on this server yet (it needs the database). See the runtime guide.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings, then try again.');
      const reg = await registration();
      sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.publicKey) });
      await post('/api/push/subscribe', { subscription: sub.toJSON(), ...prefs, lang: (document.documentElement.lang || 'en').slice(0, 2) });
      savePrefs(); msg = 'Alerts are on. You will be notified when an official source publishes a new notice, extends a deadline or amends a notice.';
    } catch (e) { err = e.message || 'Could not turn alerts on.'; }
    busy = false; draw();
  }
  async function update() {
    busy = true; msg = ''; err = ''; draw();
    try { if (!sub) throw new Error('Turn alerts on first.'); await post('/api/push/preferences', { endpoint: sub.endpoint, ...prefs }); savePrefs(); msg = 'Choices saved.'; }
    catch (e) { err = e.message; }
    busy = false; draw();
  }
  async function disable() {
    busy = true; msg = ''; err = ''; draw();
    try { if (sub) { const ep = sub.endpoint; await sub.unsubscribe(); try { await post('/api/push/unsubscribe', { endpoint: ep }); } catch (_) {} sub = null; } msg = 'Alerts are off on this device.'; }
    catch (e) { err = e.message; }
    busy = false; draw();
  }
  async function test() {
    busy = true; msg = ''; err = ''; draw();
    try { if (!sub) throw new Error('Turn alerts on first.'); await post('/api/push/test', { endpoint: sub.endpoint }); msg = 'Test sent. It should appear in a few seconds.'; }
    catch (e) { err = e.message; }
    busy = false; draw();
  }

  function coverageLine() {
    if (!cov) return '';
    const total = (cov.states || []).length, watched = total - (cov.states_without_a_watched_source || []).length;
    const missing = (cov.states_without_a_watched_source || []);
    const demo = cov.mode === 'DEMO' ? ' Demo mode: nothing is watched until the database is connected.' : '';
    return `<p class="muted na-cov">Official sources are being watched for <strong>${esc(watched)} of ${esc(total)}</strong> States and Union Territories, plus central recruiters.${demo}${missing.length && cov.mode !== 'DEMO' ? ` Not yet watched (waiting for a source to be verified): ${esc(missing.slice(0, 12).join(', '))}${missing.length > 12 ? '…' : ''}.` : ''}</p>`;
  }

  function stateBoxes() {
    const list = (cfg && cfg.states) || (cov && (cov.states || []).map((s) => s.state)) || [];
    return list.map((s) => `<label class="na-chk"><input type="checkbox" data-state="${esc(s)}"${prefs.states.includes(s) ? ' checked' : ''}> ${esc(s)}</label>`).join('');
  }

  function draw() {
    const sec = host(); if (!sec) return;
    const on = !!sub, perm = supported() ? Notification.permission : 'unsupported';
    const all = prefs.states.length === 0;
    const status = !supported() ? 'Not supported in this browser. New notices still appear below, and you can use the Atom feed.'
      : perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.'
      : on ? 'On for this device.' : 'Off.';
    sec.innerHTML = `<div class="panel-title"><span>INSTANT ALERTS · ALL INDIA</span><span class="na-state ${on ? 'is-on' : ''}">${esc(on ? 'ON' : 'OFF')}</span></div>
      <p class="muted">Get a phone or browser notification when an official recruiter publishes a new notice, extends a deadline or amends one. ${esc(status)}</p>
      <div class="na-opts">
        <label class="na-chk"><input type="checkbox" id="na-all"${all ? ' checked' : ''}> Every State and Union Territory</label>
        <details class="na-states"${all ? '' : ' open'}><summary>Choose States / UTs</summary><div class="na-grid">${stateBoxes()}</div></details>
        <label class="na-chk"><input type="checkbox" id="na-central"${prefs.include_central ? ' checked' : ''}> Central recruiters (UPSC, SSC, Railways, banks, defence, PSUs)</label>
        <label class="na-chk"><input type="checkbox" id="na-unver"${prefs.include_unverified ? ' checked' : ''}> Also tell me about items detected but not yet verified (clearly labelled)</label>
      </div>
      <div class="na-actions">
        ${on ? `<button type="button" class="mini-btn" id="na-save"${busy ? ' disabled' : ''}>Save choices</button><button type="button" class="mini-btn" id="na-test"${busy ? ' disabled' : ''}>Send test</button><button type="button" class="mini-btn" id="na-off"${busy ? ' disabled' : ''}>Turn off</button>`
              : `<button type="button" class="btn" id="na-on"${busy || !supported() ? ' disabled' : ''}>${busy ? 'Working…' : 'Turn on alerts'}</button>`}
        <a class="mini-btn" href="/api/feed.atom" target="_blank" rel="noopener">Atom feed</a>
      </div>
      <div class="na-msg" role="status" aria-live="polite">${msg ? `<span class="na-ok">${esc(msg)}</span>` : ''}${err ? `<span class="na-err">${esc(err)}</span>` : ''}</div>
      <p class="muted na-note">Alerts are sent after an official source is checked (every 5 to 20 minutes) and its notice has been read, so they are fast but not instant to the second. Always confirm on the official notice before applying.</p>
      ${coverageLine()}`;
    const g = (id) => q(id, sec);
    const allBox = g('#na-all'); if (allBox) allBox.onchange = () => { if (allBox.checked) prefs.states = []; draw(); };
    sec.querySelectorAll('[data-state]').forEach((c) => { c.onchange = () => { const s = c.dataset.state; prefs.states = c.checked ? [...new Set([...prefs.states, s])] : prefs.states.filter((x) => x !== s); draw(); }; });
    const cen = g('#na-central'); if (cen) cen.onchange = () => { prefs.include_central = cen.checked; };
    const un = g('#na-unver'); if (un) un.onchange = () => { prefs.include_unverified = un.checked; };
    const bOn = g('#na-on'); if (bOn) bOn.onclick = enable; const bS = g('#na-save'); if (bS) bS.onclick = update;
    const bT = g('#na-test'); if (bT) bT.onclick = test; const bOff = g('#na-off'); if (bOff) bOff.onclick = disable;
  }

  async function init() {
    loadPrefs(); draw();
    try { const [c, v] = await Promise.all([fetch('/api/push/config', { cache: 'no-store' }), fetch('/api/national/coverage', { cache: 'no-store' })]); cfg = c.ok ? await c.json() : null; cov = v.ok ? await v.json() : null; } catch (_) {}
    sub = await currentSub(); draw();
    if (/[?&]open=latest\b/.test(location.search)) { const f = q('#auto-feed'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'start' }); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.GovNational = { reload: init };
})();
