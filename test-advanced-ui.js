'use strict';
// Real index.html + app.js + advanced.js in jsdom against the standalone runtime. Skips if jsdom is not installed.
const fs = require('fs'), path = require('path'), assert = require('assert'), { spawn } = require('child_process');
let JSDOM, VirtualConsole; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch { /* optional */ }
if (!JSDOM) { console.log('Advanced UI: skipped (jsdom not installed: npm i -D jsdom)'); process.exit(0); }
const pub = path.join(__dirname, 'public'); const port = 4800 + Math.floor(Math.random() * 150), BASE = 'http://127.0.0.1:' + port;
let pass = 0, fail = 0; const failures = [];
const t = async (n, f) => { try { await f(); pass++; } catch (e) { fail++; failures.push(n + ': ' + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const child = spawn(process.execPath, ['standalone.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(150); } }
  try {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
    const errors = [];
    const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: (() => { const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(e.message)); return vc; })(),
      beforeParse(w) { w.fetch = (u, o = {}) => fetch(new URL(typeof u === 'string' ? u : u.url, BASE).href, o); w.Headers = Headers; w.AbortController = AbortController; w.CSS = w.CSS || {}; w.CSS.escape = w.CSS.escape || ((s) => String(s)); w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }); w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {}; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.HTMLAnchorElement.prototype.click = function () { w.__downloaded = this.download; }; w.print = () => { w.__printed = true; }; w.Image = class { set src(v) { setTimeout(() => (this.onerror && this.onerror()), 5); } }; } });
    const w = dom.window, d = w.document, $ = (s) => d.querySelector(s), $$ = (s) => [...d.querySelectorAll(s)];
    w.localStorage.setItem('govcareer.profile.v2', JSON.stringify({ dob: '2001-04-12', category: 'OBC', state: 'Telangana', education: { level: 'bachelor', status: 'completed', field: 'engineering' } }));
    w.eval(fs.readFileSync(path.join(pub, 'app.js'), 'utf8')); w.eval(fs.readFileSync(path.join(pub, 'advanced.js'), 'utf8')); d.dispatchEvent(new w.Event('DOMContentLoaded'));
    const until = async (fn, ms = 4000, label = '') => { const s = Date.now(); while (Date.now() - s < ms) { try { const v = fn(); if (v) return v; } catch { /* retry */ } await sleep(40); } throw new Error('timeout waiting for UI ' + label + ' | panel: ' + ($('#adv-panel') ? $('#adv-panel').textContent.slice(0, 160) : '') + ' | deck: ' + ($('#deck-wrap') ? $('#deck-wrap').textContent.slice(0, 200) : '')); };
    const tab = async (k) => { $(`#adv-tabs [data-tab="${k}"]`).click(); await sleep(60); await until(() => !$('#adv-panel .loading-panel')); };

    await t('Strategy nav button opens the view and draws all tabs', async () => {
      $('[data-view="advanced"]').click(); await until(() => $$('#adv-tabs button').length === 9);
      assert.ok($('#view-advanced').classList.contains('active')); assert.strictEqual($('#adv-tabs [aria-selected="true"]').dataset.tab, 'brief');
    });
    await t('Brief shows KPIs, ranked picks, and exports a calendar file', async () => {
      await until(() => $('#adv-panel .br-summary')); assert.ok($$('#adv-panel .br-stat').length >= 5); assert.ok($('#adv-panel').textContent.includes('Best next moves'));
      $('[data-adv="ics"]').click(); await until(() => w.__downloaded); assert.strictEqual(w.__downloaded, 'govcareer-deadlines.ics');
      $('[data-adv="print"]').click(); assert.ok(w.__printed);
    });
    await t('Decision matrix: sliders reweight and persist', async () => {
      await tab('rank'); const before = $$('#adv-panel .br-match strong')[0].textContent; const s = $('[data-weight="cost"]'); assert.ok(s);
      s.value = '100'; s.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(700); await until(() => !$('#adv-panel .loading-panel'));
      assert.strictEqual(JSON.parse(w.localStorage.getItem('govcareer.advanced.v1')).weights.cost, 100); assert.ok(before.length > 0);
      $('[data-adv="reset-weights"]').click(); await sleep(300); await until(() => !$('#adv-panel .loading-panel')); assert.strictEqual(JSON.parse(w.localStorage.getItem('govcareer.advanced.v1')).weights, null);
    });
    await t('Deadlines, Age runway, What-if and Portfolio render real content', async () => {
      await tab('timeline'); assert.ok($('#adv-panel').textContent.includes('Conflict radar')); assert.ok($$('#adv-panel .br-match').length >= 1);
      await tab('age'); assert.ok($$('#adv-panel .br-match').length >= 5, 'age rows'); assert.ok(/pass the limit on/.test($('#adv-panel').textContent));
      await tab('whatif'); assert.ok($$('#adv-panel .br-match').length >= 2);
      await tab('portfolio'); assert.ok($('#adv-panel').textContent.includes('Target portfolio')); assert.ok($('#adv-panel').textContent.includes('Syllabus overlap'));
    });
    await t('Study planner builds a plan, escapes HTML, and feeds the revision deck', async () => {
      await tab('study'); const exam = new Date(Date.now() + 70 * 864e5).toISOString().slice(0, 10);
      $('#st-exam').value = exam; $('#st-topics').value = 'Quant <img src=x onerror=alert(1)>, 1, 2\nEnglish, 4, 1\nReasoning, 2, 1';
      $('[data-adv="st-run"]').click(); await until(() => $('#st-out .br-summary')); assert.ok($('#st-out').textContent.includes('Hours by topic')); assert.strictEqual($('#st-out img'), null, 'topic title must be escaped');
      assert.ok($$('#st-days .br-match').length >= 5);
      $('[data-adv="deck-add"]').click(); await until(() => /3 card/.test($('#deck-wrap').textContent)); assert.ok($$('#deck-wrap [data-adv="rate"]').length >= 6);
      $('[data-adv="rate"][data-q="4"]').click(); await until(() => /2 card|due today/.test($('#deck-wrap').textContent) && $$('#deck-wrap [data-adv="rate"]').length >= 6 && /\(2 due today\)/.test($('#deck-wrap').textContent));
      const deck = JSON.parse(w.localStorage.getItem('govcareer.advanced.v1')).deck; assert.ok(deck.some((c) => c.interval === 1 && c.reps === 1));
    });
    await t('Study planner rejects a past exam date with a visible error', async () => {
      $('#st-exam').value = '2020-01-01'; $('[data-adv="st-run"]').click(); await until(() => $('#st-out [role="alert"]'));
    });
    await t('Mock analytics works from sample data and shows advice', async () => {
      await tab('mock'); $('[data-adv="mk-sample"]').click(); $('#mk-target').value = '12'; $('#mk-tests').value = '5, 7, 9';
      $('[data-adv="mk-run"]').click(); await until(() => $('#mk-out .br-summary')); const txt = $('#mk-out').textContent;
      assert.ok(/Break-even accuracy/.test(txt) && /Quantitative Aptitude/.test(txt) && /Trend over 3 tests/.test(txt));
    });
    await t('Photo checker validates limits locally and reports an unreadable file', async () => {
      await tab('docs'); const inp = $('#doc-file'); assert.ok(inp && $$('[data-spec]').length === 7);
      const f = new w.File(['not an image'], 'bad.jpg', { type: 'image/jpeg' }); Object.defineProperty(inp, 'files', { value: [f], configurable: true });
      inp.dispatchEvent(new w.Event('change', { bubbles: true })); await until(() => $('#doc-out [role="alert"]') || $('#doc-out table'), 3000);
    });
    await t('No script errors were raised by the module', () => { assert.deepStrictEqual(errors, []); });
  } finally { child.kill(); }
  console.log(`Advanced UI: ${pass} passed, ${fail} failed`);
  if (fail) failures.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fail ? 1 : 0); // jsdom timers (SSE reconnect, reminders) would otherwise keep the process alive
})();
