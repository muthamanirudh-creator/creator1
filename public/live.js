/* GovCareer AI - real-time layer (additive). One Server-Sent-Events stream (/api/stream) drives:
 *  - a "Live" status pill with seconds-since-update and automatic reconnect (back-off, resumes missed events)
 *  - headline counts, a ticking deadline countdown, and the official-source monitor, with no per-visitor polling
 *  - automatic refresh of search results/overview when the published set or a deadline status changes
 *  - private alert pushes for the signed-in person
 * Every value shown comes from published records or live portal checks; nothing is simulated. */
(function () {
  'use strict';
  const q = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (typeof window.showToast === 'function' ? window.showToast(m) : null);
  const TOKEN_KEY = 'govcareer.citizen.token.v1';
  let es = null, retry = 1000, lastAt = 0, closing = [], connected = false, refreshT = null;

  function pill() {
    let p = q('#live-pill'); if (p) return p;
    const actions = q('.header-actions'); if (!actions) return null;
    p = document.createElement('span'); p.id = 'live-pill'; p.className = 'live-pill is-off'; p.setAttribute('role', 'status'); p.setAttribute('aria-live', 'polite');
    p.innerHTML = '<i class="live-dot" aria-hidden="true"></i><b>Connecting</b><small></small>';
    actions.insertBefore(p, actions.firstChild); return p;
  }
  function setState(on, text) {
    connected = on; const p = pill(); if (!p) return;
    p.classList.toggle('is-off', !on); q('b', p).textContent = text || (on ? 'Live' : 'Reconnecting');
  }
  function age() {
    const p = pill(); if (!p || !lastAt) return;
    const s = Math.max(0, Math.round((Date.now() - lastAt) / 1000));
    q('small', p).textContent = connected ? (s < 2 ? 'just now' : s + 's ago') : '';
  }
  function setMetric(id, v) { const el = q(id); if (el && v != null) el.textContent = Number(v).toLocaleString('en-IN'); }

  // ---- deadline ticker (counts down every second from the exact close time) ----
  function ticker() {
    let box = q('#live-ticker'); if (box) return box;
    const radar = q('#deadline-radar'); if (!radar || !radar.parentNode) return null;
    box = document.createElement('section'); box.id = 'live-ticker'; box.className = 'live-ticker'; box.hidden = true;
    box.innerHTML = '<div class="panel-title"><span>CLOSING SOON, LIVE COUNTDOWN</span></div><div id="live-ticker-rows"></div>';
    radar.parentNode.insertBefore(box, radar.nextSibling); return box;
  }
  function left(iso) {
    const ms = new Date(iso).getTime() - Date.now(); if (!isFinite(ms)) return '';
    if (ms <= 0) return 'closed';
    const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
    const pad = (n) => String(n).padStart(2, '0');
    return (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function drawTicker() {
    const box = ticker(); if (!box) return;
    box.hidden = !closing.length; const rows = q('#live-ticker-rows', box); if (!rows) return;
    if (!rows.children.length || rows.dataset.n !== String(closing.length) + closing.map((c) => c.id).join()) {
      rows.dataset.n = String(closing.length) + closing.map((c) => c.id).join();
      rows.innerHTML = closing.map((c) => `<button type="button" class="tick-row" data-id="${esc(c.id)}"><span>${esc(c.title)}</span><time data-closes="${esc(c.closes)}"></time></button>`).join('');
      rows.querySelectorAll('.tick-row').forEach((b) => { b.onclick = () => { if (typeof window.openJob === 'function') window.openJob(b.dataset.id); }; });
    }
    rows.querySelectorAll('time').forEach((t) => { t.textContent = left(t.dataset.closes); });
  }

  // ---- official source monitor from the stream ----
  function drawSources(d) {
    const box = q('#live-sources'); if (!box) return;
    box.innerHTML = (d.items || []).map((x) => `<article class="live-source"><strong><span class="dot"></span>${esc(x.name)}</strong><span class="muted">${esc(x.status)} · ${esc(x.latency_ms)} ms</span>${(x.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a>`).join('') || '<span class="muted">No matching recruitment links detected on this check.</span>'}</article>`).join('') || '<span class="muted">No source results.</span>';
    const h = q('#system-health'); if (h) h.textContent = 'LIVE · ' + d.online + '/' + d.total + ' official portals responding';
  }

  function refreshData() {
    clearTimeout(refreshT);
    refreshT = setTimeout(() => { try { if (typeof window.loadOverview === 'function') window.loadOverview(); if (typeof window.search === 'function') window.search(); } catch (_) {} }, 400);
  }

  // Feed events written by the automatic monitor (new notice, extension, amendment, detected-not-verified, withdrawn).
  function announce(label, d) {
    toast(label + ': ' + String(d.title || '').slice(0, 120));
    try { window.dispatchEvent(new CustomEvent('gc:feed', { detail: d })); } catch (_) {}
    refreshData();
  }
  const on = {
    hello() { setState(true); },
    'job.new'(d) { announce('New official notification', d); },
    'deadline.extended'(d) { announce('Deadline extended', d); },
    'job.amended'(d) { announce('Notification amended', d); },
    'job.detected'(d) { announce('Detected on an official site (not yet verified)', d); },
    'job.retracted'(d) { announce('Notification withdrawn', d); },
    pulse(d) {
      if (d.error) return; lastAt = Date.now();
      if (window.GCMetrics) window.GCMetrics.set({ verified: Number(d.total), closing: Number(d.closing_soon) }); else { setMetric('#metric-jobs', d.total); setMetric('#metric-deadlines', d.closing_soon); }
      const sys = q('#metric-system'); if (sys) sys.textContent = 'LIVE';
      closing = d.closing || []; drawTicker(); age();
    },
    sources(d) { lastAt = Date.now(); drawSources(d); if (window.GCMetrics && d.total > 0) window.GCMetrics.set({ srcOnline: Number(d.online), srcTotal: Number(d.total), sourcesSettled: true }); },
    'source.changed'(d) { toast(d.name + ' is now ' + String(d.to).toLowerCase().replace('_', ' ')); },
    'jobs.changed'() { toast('Recruitment data just updated. Refreshing your results.'); refreshData(); },
    alert(d) {
      const t = (d.payload && (d.payload.title || d.payload.message)) || String(d.event_type || 'alert').replace(/_/g, ' ').toLowerCase();
      toast('New alert: ' + t);
      if (window.GovCareerAccount && window.GovCareerAccount.refresh) window.GovCareerAccount.refresh();
    },
  };

  function connect() {
    if (es) { try { es.close(); } catch (_) {} es = null; }
    if (!('EventSource' in window)) { setState(false, 'Live unavailable'); return; }
    let token = ''; try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
    es = new EventSource('/api/stream' + (token ? '?token=' + encodeURIComponent(token) : ''));
    es.onopen = () => { retry = 1000; setState(true); };
    es.onerror = () => {
      setState(false); try { es.close(); } catch (_) {} es = null;
      setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);   // exponential back-off, capped
    };
    Object.keys(on).forEach((k) => es.addEventListener(k, (e) => { try { on[k](JSON.parse(e.data)); } catch (_) {} }));
  }

  function start() {
    pill(); connect();
    // The stream replaces the per-visitor 60 s portal polling that app.js starts.
    setInterval(() => { if (connected && window.__liveTimer) { clearInterval(window.__liveTimer); window.__liveTimer = null; } }, 5000);
    setInterval(() => { drawTicker(); age(); }, 1000);
    const rb = q('#live-refresh'); if (rb) rb.addEventListener('click', () => { refreshData(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !connected) { retry = 1000; connect(); } });
    window.addEventListener('online', () => { retry = 1000; connect(); });
  }
  window.GovLive = { reconnect: () => { retry = 1000; connect(); }, get connected() { return connected; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
