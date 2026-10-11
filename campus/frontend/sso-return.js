/* Single login return: GovCareer sends people to this Campus login with ?next=/path.
 * As soon as the Campus session exists (password, Face ID, fingerprint or an already-valid session),
 * go back to GovCareer. Only same-site relative paths are honoured (no open redirect). Additive only. */
(function () {
  'use strict';
  var m = /[?&]next=([^&]+)/.exec(location.search); if (!m) return;
  var next; try { next = decodeURIComponent(m[1]); } catch (e) { return; }
  if (next.charAt(0) !== '/' || next.charAt(1) === '/' || next.charAt(1) === '\\' || /^\/campus(\/|$)/.test(next)) return;
  var done = false, started = Date.now();
  function go() { if (done) return; done = true; location.replace(next); }
  function check() {
    if (done || Date.now() - started > 15 * 60 * 1000) return;
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { if (r.ok) go(); }).catch(function () {});
  }
  var nativeFetch = window.fetch;
  window.fetch = function (input) {
    var p = nativeFetch.apply(this, arguments);
    try {
      var u = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (/\/api\/(portal-auth\/(login|face-login|fingerprint-login|register)|auth\/(login|register))/.test(u)) p.then(function (r) { if (r && r.ok) setTimeout(go, 700); }, function () {});
    } catch (e) {}
    return p;
  };
  check(); setInterval(check, 2500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
})();
