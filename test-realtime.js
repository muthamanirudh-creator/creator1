// Real-time hub: delivery, private events, resume after reconnect, and change detection by the monitor.
const assert = require('assert');
const rt = require('./lib/realtime');
const mk = () => { const r = { out: '', writeHead() {}, write(s) { r.out += s; return true; } }; return r; };
const req = (h = {}, query = {}) => ({ headers: h, query, on() {} });
const events = (r) => [...r.out.matchAll(/event: (\S+)\ndata: (.*)\n/g)].map(m => [m[1], JSON.parse(m[2])]);
let n = 0; const ok = (name) => { n++; console.log('  ok  ', name); };
(async () => {
  const a = mk(), b = mk(); rt.subscribe(req(), a, { accountId: 1 }); rt.subscribe(req(), b, { accountId: 2 });
  rt.publish('jobs.changed', { total: 3 }); rt.publish('alert', { x: 1 }, { accountId: 1 });
  assert(events(a).some(e => e[0] === 'jobs.changed') && events(b).some(e => e[0] === 'jobs.changed')); ok('public events reach everyone');
  assert(events(a).some(e => e[0] === 'alert') && !events(b).some(e => e[0] === 'alert')); ok('private events reach only their account');
  const lastId = Number(/id: (\d+)\nevent: jobs.changed/.exec(a.out)[1]);
  rt.publish('jobs.changed', { total: 4 });
  const c = mk(); rt.subscribe(req({ 'last-event-id': String(lastId) }), c, { accountId: 2 });
  const got = events(c).filter(e => e[0] === 'jobs.changed'); assert.strictEqual(got.length, 1); assert.strictEqual(got[0][1].total, 4); ok('reconnect with Last-Event-ID replays only what was missed');
  let jobs = [{ id: 'a', deadline: { status: 'OPEN', closes_exact: '2099-01-01' }, lifecycle: 'PUBLISHED' }];
  const d = mk(); rt.subscribe(req(), d, {});
  const stop = rt.start({ getJobs: async () => jobs, pulseMs: 40 });
  await new Promise(r => setTimeout(r, 120));
  assert(events(d).some(e => e[0] === 'pulse' && e[1].total === 1)); ok('monitor emits pulses with real counts');
  assert(!events(d).some(e => e[0] === 'jobs.changed' && e[1].total === 1 && e[1].open === 1), 'no change yet');
  jobs = [...jobs, { id: 'b', deadline: { status: 'CLOSING_SOON', closes_exact: '2099-01-02' }, lifecycle: 'PUBLISHED' }];
  await new Promise(r => setTimeout(r, 120));
  assert(events(d).some(e => e[0] === 'jobs.changed' && e[1].total === 2 && e[1].closing_soon === 1)); ok('monitor emits jobs.changed only when the published set changes');
  stop(); console.log(`\nReal-time: ${n} passed`); process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
