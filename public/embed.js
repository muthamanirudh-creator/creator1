/* Embedded mode: GovCareer AI shown as the "GovCareer AI" sub-tab of the Campus Portal's
 * "Roadmaps & Govt Jobs" tab. Activated only by ?embed=campus, and only when the page is framed
 * by the same origin. Standalone GovCareer is unchanged. Loaded synchronously in <head> so the
 * campus theme applies before first paint. */
(function () {
  'use strict';
  var embedded = false;
  try { embedded = /[?&]embed=campus(&|$)/.test(location.search) && window.parent !== window && !!window.parent.document; } catch (e) { embedded = false; }
  if (!embedded) return;
  var root = document.documentElement;
  root.classList.add('gc-embed');
  window.GC_EMBEDDED = true;

  // Never leave the sub-tab. Any link to the Campus portal (Bridge's "Open Campus", practice links, login) would
  // otherwise load Campus inside this frame or open a new browser tab. The parent Campus page handles it in-app.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var u; try { u = new URL(a.getAttribute('href'), location.href); } catch (x) { return; }
    if (u.origin !== location.origin || !/^\/campus(\/|$)/.test(u.pathname)) return;
    e.preventDefault(); e.stopPropagation();
    try { window.parent.postMessage({ type: 'govcareer-embed-nav', path: u.pathname + u.search + u.hash, label: (a.textContent || '').trim().slice(0, 160) }, location.origin); } catch (x) {}
  }, true);

  // Follow the Campus theme (html.dark-mode) live. Same origin, so reading the parent is permitted.
  function syncTheme() {
    var dark = false;
    try { dark = window.parent.document.documentElement.classList.contains('dark-mode'); } catch (e) {}
    root.classList.toggle('gc-dark', dark);
    if (document.body) document.body.classList.toggle('dark', dark);
  }
  syncTheme();
  document.addEventListener('DOMContentLoaded', function () {
    syncTheme();
    try { new MutationObserver(syncTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
    // The embedded copy follows the Campus theme; its own toggle would fight it.
    var t = document.getElementById('theme-toggle'); if (t) t.hidden = true;
    // Report content height so the Campus page can size the frame (no nested scrollbars).
    var last = 0;
    function report() {
      var h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      if (Math.abs(h - last) < 2) return; last = h;
      try { window.parent.postMessage({ type: 'govcareer-embed-height', height: h }, location.origin); } catch (e) {}
    }
    if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report); setInterval(report, 1500); report();
  });
})();
