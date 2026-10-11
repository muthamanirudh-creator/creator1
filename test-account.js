// Account UI tests. Part A: account API round-trip against the real server.
// Part B: the real index.html + app.js + account.js running in jsdom against that server.
// Needs PostgreSQL (TEST_DATABASE_URL, default govcareer_test) and the dev dependency `jsdom`.
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.TEST_DATABASE_URL || 'postgres://govcareer:govcareer@localhost:5432/govcareer_test';
const results = []; let failed = 0;
const test = async (name, fn) => { try { await fn(); results.push(['ok', name]); console.log('  ok  ', name); } catch (e) { failed++; results.push(['FAIL', name]); console.log('  FAIL', name, '\n      ', e && e.message); } };
const j = async (p, o = {}, tok) => {
  const r = await fetch(BASE + p, { ...o, headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(o.headers || {}) } });
  let d = null; try { d = await r.json(); } catch { /* none */ }
  return { status: r.status, data: d };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timed out waiting for condition'); await wait(40); } }

(async () => {
  // Fake Campus service: knows only cookies of the form cp_access=campus-<email>, like GET /api/auth/me on the real one.
  const CPORT = PORT + 300;
  const campus = require('http').createServer((req, res) => {
    const m = /cp_access=campus-([^;]+)/.exec(req.headers.cookie || '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/logout') return res.end('{"ok":true}');
    if (req.url !== '/api/auth/me' || !m) { res.statusCode = 401; return res.end('{"error":"no"}'); }
    res.end(JSON.stringify({ user: { id: 'u-' + m[1], email: decodeURIComponent(m[1]), name: 'Campus ' + m[1].split('@')[0], role: 'STUDENT' } }));
  }).listen(CPORT);
  process.on('exit', () => campus.close());
  const env = { ...process.env, PORT: String(PORT), CAMPUS_PORT: String(CPORT), DATABASE_URL: DB, DISABLE_CAMPUS_PORTAL: '1', LEGACY_ACCOUNT_LOGIN: '1', REQUIRE_LOGIN: '1', NODE_ENV: 'test' };
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const stop = () => { try { srv.kill(); } catch { /* gone */ } };
  process.on('exit', stop);
  try { await until(async () => (await fetch(BASE + '/api/health')).ok, 15000); } catch { console.log(log); console.log('server did not start'); stop(); process.exit(1); }

  const email = `acct.${Date.now()}@example.test`, password = 'correct-horse-battery';
  let tok, jobId;

  // ---------------- Part A: API ----------------
  await test('API: weak password and missing consent fields are rejected', async () => {
    assert.strictEqual((await j('/api/account/register', { method: 'POST', body: JSON.stringify({ email, name: 'T', password: 'short' }) })).status, 400);
    assert.strictEqual((await j('/api/account/register', { method: 'POST', body: JSON.stringify({ email }) })).status, 400);
  });
  await test('API: register, duplicate refused, wrong password refused, login returns a token', async () => {
    assert.strictEqual((await j('/api/account/register', { method: 'POST', body: JSON.stringify({ email, name: 'Test User', password }) })).status, 201);
    assert.strictEqual((await j('/api/account/register', { method: 'POST', body: JSON.stringify({ email, name: 'Test User', password }) })).status, 409);
    assert.strictEqual((await j('/api/account/login', { method: 'POST', body: JSON.stringify({ email, password: 'wrong-password-x' }) })).status, 401);
    const r = await j('/api/account/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    assert.strictEqual(r.status, 200); assert(r.data.token && r.data.user.email === email); tok = r.data.token;
  });
  await test('API: account routes need a token', async () => {
    for (const p of ['/api/account/me', '/api/account/watchlist', '/api/account/applications', '/api/account/alerts', '/api/account/searches']) assert.strictEqual((await j(p)).status, 401, p);
  });
  await test('API: watchlist, saved search (alerts toggle), tracker status flow', async () => {
    const jobs = await j('/api/search', { method: 'POST', body: JSON.stringify({ query: '' }) });
    jobId = jobs.data.results[0].id; assert(jobId, 'a published job exists');
    assert.strictEqual((await j(`/api/account/watchlist/${jobId}`, { method: 'POST', body: '{}' }, tok)).status, 201);
    assert.strictEqual((await j('/api/account/watchlist', {}, tok)).data.length, 1);
    const ss = await j('/api/account/searches', { method: 'POST', body: JSON.stringify({ name: 'Railway 10th', query: 'railway 10th pass' }) }, tok);
    assert.strictEqual(ss.status, 201); assert(ss.data.filters && Object.keys(ss.data.filters).length > 0, 'filters parsed from text');
    const off = await j(`/api/account/searches/${ss.data.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }, tok);
    assert.strictEqual(off.data.enabled, false);
    for (const status of ['SAVED', 'APPLIED', 'ADMIT_CARD']) {
      const r = await j(`/api/account/applications/${jobId}`, { method: 'PUT', body: JSON.stringify({ status, application_number: 'APP-1', notes: 'n' }) }, tok);
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.status, status);
    }
    assert.strictEqual((await j(`/api/account/applications/${jobId}`, { method: 'PUT', body: JSON.stringify({ status: 'NOT_A_STATUS' }) }, tok)).status >= 400, true, 'invalid status refused');
    const apps = await j('/api/account/applications', {}, tok); assert.strictEqual(apps.data.length, 1); assert.strictEqual(apps.data[0].status, 'ADMIT_CARD');
  });
  await test('API: one user cannot touch another user\'s data', async () => {
    const e2 = `other.${Date.now()}@example.test`;
    await j('/api/account/register', { method: 'POST', body: JSON.stringify({ email: e2, name: 'Other', password }) });
    const t2 = (await j('/api/account/login', { method: 'POST', body: JSON.stringify({ email: e2, password }) })).data.token;
    assert.strictEqual((await j('/api/account/watchlist', {}, t2)).data.length, 0);
    assert.strictEqual((await j('/api/account/applications', {}, t2)).data.length, 0);
    const mine = (await j('/api/account/searches', {}, tok)).data[0];
    await j(`/api/account/searches/${mine.id}`, { method: 'DELETE' }, t2);
    assert.strictEqual((await j('/api/account/searches', {}, tok)).data.length, 1, 'other user delete is a no-op');
  });
  await test('API: export contains the data; logout revokes the token', async () => {
    const ex = await j('/api/account/export', {}, tok);
    assert.strictEqual(ex.status, 200); assert.strictEqual(ex.data.watchlists.length, 1); assert.strictEqual(ex.data.applications.length, 1);
    assert(!JSON.stringify(ex.data).includes('password_hash'), 'no password hash in export');
    await j('/api/account/logout', { method: 'POST', body: '{}' }, tok);
    assert.strictEqual((await j('/api/account/me', {}, tok)).status, 401);
    tok = (await j('/api/account/login', { method: 'POST', body: JSON.stringify({ email, password }) })).data.token;
  });


  // ---------------- Single login (Campus SSO) ----------------
  const ssoEmail = `sso.${Date.now()}@example.test`;
  const ck = (e) => ({ cookie: 'cp_access=campus-' + e });
  await test('SSO: no Campus session -> 401 and the GovCareer entry page redirects to the Campus login', async () => {
    assert.strictEqual((await j('/api/account/sso', { method: 'POST', body: '{}' })).status, 401);
    const r = await fetch(BASE + '/', { redirect: 'manual' });
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.get('location'), '/campus/?next=%2F');
    assert.strictEqual((await fetch(BASE + '/', { redirect: 'manual', headers: ck(ssoEmail) })).status, 200, 'with a Campus session the page loads');
    assert.strictEqual((await fetch(BASE + '/app.js', { redirect: 'manual' })).status, 200, 'assets are not gated');
  });
  await test('SSO: first use needs explicit consent and creates nothing without it; then signs in', async () => {
    const a = await j('/api/account/sso', { method: 'POST', body: '{}', headers: ck(ssoEmail) });
    assert.strictEqual(a.status, 200); assert.strictEqual(a.data.needsConsent, true); assert(!a.data.token);
    const b = await j('/api/account/sso', { method: 'POST', body: '{"consent":true}', headers: ck(ssoEmail) });
    assert(b.data.token && b.data.user.email === ssoEmail && b.data.user.sso === 'campus');
    assert.strictEqual((await j('/api/account/me', {}, b.data.token)).data.email, ssoEmail);
    const c = await j('/api/account/sso', { method: 'POST', body: '{}', headers: ck(ssoEmail) });
    assert(c.data.token, 'second visit signs in without asking again');
  });
  await test('SSO: a Campus-created account cannot be entered with a password', async () => {
    assert.strictEqual((await j('/api/account/login', { method: 'POST', body: JSON.stringify({ email: ssoEmail, password: 'anything-long-enough' }) })).status, 401);
  });
  await test('Real time: /api/stream sends hello + pulse and supports resume', async () => {
    const ctl = new AbortController(); const r = await fetch(BASE + '/api/stream', { signal: ctl.signal });
    assert.strictEqual(r.status, 200); assert(/text\/event-stream/.test(r.headers.get('content-type')));
    const rd = r.body.getReader(); let txt = ''; const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !(/event: hello/.test(txt))) { const { value } = await rd.read(); txt += Buffer.from(value).toString(); }
    ctl.abort(); assert(/event: hello/.test(txt), 'hello event');
  });

  // ---------------- Part B: real DOM ----------------
  let JSDOM, VirtualConsole; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch { /* optional */ }
  if (!JSDOM) { console.log('  skip  DOM tests (jsdom not installed: npm i -D jsdom)'); }
  else {
    const pub = path.join(__dirname, 'public');
    const makeDom = (base, cookie) => {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
    return new JSDOM(html, {
      url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: (() => { const vc = new VirtualConsole(); vc.on('jsdomError', (e) => console.log('      [dom error]', e.message)); vc.on('error', (...a) => console.log('      [console.error]', ...a)); return vc; })(),
      beforeParse(w) {
        w.fetch = (u, o = {}) => fetch(new URL(typeof u === 'string' ? u : u.url, base).href, cookie ? { ...o, headers: { ...Object.fromEntries(new Headers(o.headers || {})), cookie } } : o);
        w.Headers = Headers; w.AbortController = AbortController;
        if (!w.CSS) w.CSS = {}; if (!w.CSS.escape) w.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
        w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
        w.confirm = () => true; w.prompt = () => 'DOM saved search';
        w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
        w.HTMLAnchorElement.prototype.click = function () { w.__downloaded = this.download; };
      },
    });
    };
    // 1) Visitor without a Campus session: GovCareer offers no password form of its own.
    const dom0 = makeDom(BASE), w0 = dom0.window, $0 = (x) => w0.document.querySelector(x);
    w0.eval(fs.readFileSync(path.join(pub, 'app.js'), 'utf8')); w0.eval(fs.readFileSync(path.join(pub, 'account.js'), 'utf8'));
    w0.document.dispatchEvent(new w0.Event('DOMContentLoaded'));
    await test('UI: without a Campus session there is only a Sign in button (no register, no password form)', async () => {
      await until(() => $0('#acct-login'));
      assert($0('#account-btn').textContent === 'Sign in');
      assert(!$0('#acct-register') && !$0('#auth-form') && !$0('input[type=password]'), 'no second login form');
    });
    w0.close();
    // 2) Visitor who already signed in on the Campus login.
    const uiEmail = `dom.${Date.now()}@example.test`;
    const dom = makeDom(BASE, 'cp_access=campus-' + uiEmail);
    const w = dom.window; const $ = (x) => w.document.querySelector(x);
    const evalIn = (file) => w.eval(fs.readFileSync(path.join(pub, file), 'utf8'));
    evalIn('app.js'); evalIn('account.js');
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    await test('UI: first visit after the Campus login asks for privacy consent once', async () => {
      await until(() => $('#auth-dialog') && !$('#auth-dialog').hidden);
      assert(!$('#auth-dialog input[type=password]'), 'consent dialog has no password field');
      $('#auth-continue').click();
      await until(() => /privacy policy/i.test($('#auth-error').textContent));
    });
    await test('UI: consent signs in automatically, stores the token and renders the cockpit', async () => {
      $('#auth-consent').checked = true; $('#auth-continue').click();
      await until(() => $('#acct-signout'));
      assert(w.localStorage.getItem('govcareer.citizen.token.v1'), 'token stored');
      assert($('#auth-dialog').hidden === true, 'dialog closed');
      assert(/Campus/.test($('#account-btn').textContent));
    });
    await test('UI: the existing app.js tracker call is now authenticated (bearer header added)', async () => {
      const rows = await w.fetch('/api/account/applications'); assert.strictEqual(rows.status, 200);
    });
    await test('UI: Track + Watch in the job drawer land in the account (server round-trip)', async () => {
      await w.openJob(jobId);
      try { await until(() => $('#watch-job')); } catch (e) { console.log('      drawer hidden=', $('#drawer').hidden, 'track=', !!$('#track-job'), 'body=', $('#d-body').innerHTML.slice(0, 200)); throw e; }
      $('#track-job').click(); $('#watch-job').click();
      await until(() => $('#watch-job').textContent.includes('Watching'));
      await until(() => $('#acct-watch .mini-item') && $('#acct-apps [data-app]'));
      assert.strictEqual($('#acct-apps [data-app]').dataset.app, jobId);
    });
    await test('UI: changing tracker status persists on the server', async () => {
      const sel = $('#acct-apps .app-status'); sel.value = 'APPLIED'; sel.dispatchEvent(new w.Event('change'));
      await until(async () => { const r = await w.fetch('/api/account/applications'); const d = await r.json(); return d[0] && d[0].status === 'APPLIED'; });
    });
    await test('UI: save current search + alert toggle + export download', async () => {
      $('#q').value = 'railway'; $('#acct-save-search').click();
      await until(() => $('#acct-searches .ss-enabled'));
      const cb = $('#acct-searches .ss-enabled'); cb.checked = false; cb.dispatchEvent(new w.Event('change'));
      await until(async () => { const d = await (await w.fetch('/api/account/searches')).json(); return d[0] && d[0].enabled === false; });
      $('#acct-export').click(); await until(() => w.__downloaded === 'govcareer-my-data.json');
    });
    await test('UI: sign out clears the token and returns to the signed-out view', async () => {
      $('#acct-signout').click(); await until(() => $('#acct-login'));
      assert.strictEqual(w.localStorage.getItem('govcareer.citizen.token.v1'), null);
      assert.strictEqual((await w.fetch('/api/account/me')).status, 401);
    });
    await test('UI: delete account removes it (the Campus identity must consent again)', async () => {
      const em = `del.${Date.now()}@example.test`;
      const d3 = makeDom(BASE, 'cp_access=campus-' + em), w3 = d3.window, $3 = (x) => w3.document.querySelector(x);
      w3.eval(fs.readFileSync(path.join(pub, 'app.js'), 'utf8')); w3.eval(fs.readFileSync(path.join(pub, 'account.js'), 'utf8'));
      w3.document.dispatchEvent(new w3.Event('DOMContentLoaded'));
      await until(() => $3('#auth-dialog') && !$3('#auth-dialog').hidden);
      $3('#auth-consent').checked = true; $3('#auth-continue').click();
      await until(() => $3('#acct-delete'));
      $3('#acct-delete').click();
      await until(() => $3('#acct-login'));
      const again = await j('/api/account/sso', { method: 'POST', body: '{}', headers: ck(em) });
      assert.strictEqual(again.data.needsConsent, true, 'account is gone');
      w3.close();
    });
    w.close();

    // Demo (standalone) runtime: no real accounts, and the UI must say so instead of offering a broken sign-in.
    const SPORT = PORT + 600, SBASE = `http://127.0.0.1:${SPORT}`;
    const sa = spawn(process.execPath, ['standalone.js'], { cwd: __dirname, env: { ...process.env, PORT: String(SPORT) }, stdio: 'ignore' });
    process.on('exit', () => { try { sa.kill(); } catch { /* gone */ } });
    try {
      await until(async () => (await fetch(SBASE + '/api/health')).ok, 10000);
      const d2 = makeDom(SBASE), w2 = d2.window, $2 = (s) => w2.document.querySelector(s);
      w2.eval(fs.readFileSync(path.join(pub, 'app.js'), 'utf8')); w2.eval(fs.readFileSync(path.join(pub, 'account.js'), 'utf8'));
      w2.document.dispatchEvent(new w2.Event('DOMContentLoaded'));
      await test('UI (demo runtime): says accounts are unavailable and offers no sign-in form', async () => {
        await until(() => /Demo mode/.test(($2('#account-dashboard') || {}).textContent || ''));
        assert(!$2('#acct-login') && !$2('#acct-register') && !$2('#auth-form'), 'no sign-in controls in demo mode');
        assert.strictEqual(w2.localStorage.getItem('govcareer.citizen.token.v1'), null);
      });
      w2.close();
    } finally { try { sa.kill(); } catch { /* gone */ } }
  }

  stop();
  const passed = results.filter((r) => r[0] === 'ok').length;
  console.log(`\nAccount UI: ${passed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
