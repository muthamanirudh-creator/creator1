'use strict';
// Real-browser check of the Bridge UI. Usage:
//   node standalone.js &            (or any runtime on BASE)
//   BASE=http://localhost:3000 node scripts/bridge-browser-check.js
// Needs Playwright (npm i -D playwright && npx playwright install chromium). Not part of `npm test` because it
// needs a browser; `node test-bridge.js` covers the same API paths without one.
const BASE = process.env.BASE || 'http://localhost:3000';
const SHOT = process.env.SHOTS || '';
(async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  const errs = []; p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  const ok = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
  await p.goto(BASE + '/'); await p.waitForSelector('.nav-btn[data-view=bridge]');
  await p.evaluate(() => localStorage.setItem('govcareer.profile.v2', JSON.stringify({ education: { level: 'bachelor', status: 'completed', field: 'engineering' }, dob: '2000-05-10', state: 'Telangana', category: 'OBC' })));
  await p.click('.nav-btn[data-view=bridge]');
  await p.waitForSelector('.br-match', { timeout: 10000 });
  ok(await p.locator('.br-match').count() >= 5, 'matches render');
  await p.fill('#br-resume-text', 'B.Tech in Electronics (pursuing)\nSkills: Python, SQL, MS Excel, embedded systems, typing 38 wpm\nPresentation at national symposium.');
  await p.click('[data-act=parse]'); await p.waitForSelector('.br-chips');
  ok(await p.locator('.br-chips label').count() >= 4, 'resume skills listed as claims');
  ok(/Nothing is applied until you confirm/.test(await p.locator('#br-resume').innerText()), 'education suggestion needs confirmation');
  await p.waitForTimeout(800);
  await p.click('.br-match [data-act=toggle]'); await p.waitForSelector('.br-detail .br-table', { timeout: 8000 });
  ok(await p.locator('.br-detail .br-table tbody tr').count() >= 2, 'explanation table renders');
  if (SHOT) await p.screenshot({ path: `${SHOT}/bridge-matches.png` });
  await p.click('#br-tab-gaps'); await p.waitForSelector('.br-gap');
  ok(await p.locator('.br-gap').count() >= 1, 'skill gaps render');
  if (SHOT) await p.screenshot({ path: `${SHOT}/bridge-gaps.png` });
  await p.click('.br-gap [data-act=whatif-skill]'); await p.waitForSelector('.br-whatif'); await p.waitForTimeout(900);
  ok(await p.locator('#br-panel .br-table tbody tr').count() >= 1, 'what-if movements render');
  await p.click('#br-tab-skills'); await p.waitForSelector('.br-skillbar');
  ok(await p.locator('.br-skillbar').count() >= 3, 'skill profile renders');
  await p.click('#br-tab-history');
  ok(/Sign in to save progress/.test(await p.locator('#br-panel').innerText()), 'history asks for sign-in when signed out');
  ok(/Demo runtime|Sign in/.test(await p.locator('#br-campus').innerText()), 'campus card explains availability');
  ok(!errs.length, 'no page or console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
