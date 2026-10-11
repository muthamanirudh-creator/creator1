'use strict';
// v2.7 upgrade tests: structure preservation (tab order), next-action engine, circuit breaker, observability, LLM resilience.
// Synthetic data only. No network, no database.
const assert = require('assert'); const fs = require('fs'); const path = require('path'); const http = require('http');
const { nextActions, missingProfile } = require('./lib/advanced/nextactions');
const { createAdvancedApi } = require('./lib/advanced');
const resilience = require('./lib/resilience'); const obs = require('./lib/observability'); const llm = require('./lib/llm');
let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { fail++; failures.push(name + ': ' + e.message); console.log('  FAIL', name, '\n      ', e.message); } };

const TODAY = '2026-10-10', NOW = new Date('2026-10-10T06:00:00Z');
const job = (id, closeInDays, o = {}) => {
  const d = new Date(Date.parse(TODAY + 'T00:00:00Z') + closeInDays * 864e5).toISOString().slice(0, 10);
  return { id, title: id.toUpperCase(), organization: 'Org', lifecycle: 'PUBLISHED', verification: { status: o.unverified ? 'UNVERIFIED' : 'VERIFIED' },
    dates: { application_open: '2026-09-01T10:00:00+05:30', application_close: d + 'T23:59:00+05:30' },
    education: { accepted: ['bachelor'], or_higher: true, label: 'Bachelor', fields: ['any'] },
    age: { min: 18, max: 30, cutoff_date: '2026-01-01', relaxation: { SC: 5, OBC: 3 } }, domicile: { type: 'ALL_INDIA' }, fee: { general: '₹100' }, selection: ['CBT'], field_sources: {} };
};
const FULL = { dob: '1999-03-15', category: 'General', education: { level: 'bachelor', status: 'completed', field: 'science' }, domicileState: 'Telangana' };

(async () => {
  console.log('Structure preservation');
  await t('top-level navigation order is unchanged and has no Research tab', () => {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    const nav = html.slice(html.indexOf('<nav class="top-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="top-nav"')));
    const views = [...nav.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(views, ['overview', 'opportunities', 'exams', 'career', 'bridge', 'advanced', 'tools']);
    assert.ok(!/research/i.test(nav), 'Research tab must stay removed');
    assert.ok(nav.indexOf('Campus AI Portal') > nav.indexOf('data-view="tools"'), 'Campus link keeps its position after My Tools');
  });
  await t('Advanced module keeps every original sub-tab (new content lives inside Brief)', () => {
    const js = fs.readFileSync(path.join(__dirname, 'public/advanced.js'), 'utf8');
    const line = js.split('\n').find((l) => l.includes('const TABS = ['));
    for (const k of ['brief', 'rank', 'timeline', 'age', 'study', 'mock', 'whatif', 'portfolio', 'docs']) assert.ok(line.includes(`['${k}'`), 'missing sub-tab ' + k);
  });
  await t('Striver A2Z shows the </> glyph in the existing Coding subtab, no new tab', () => {
    const js = fs.readFileSync(path.join(__dirname, 'campus/frontend/app-runtime.js'), 'utf8');
    assert.strictEqual((js.match(/data-striver-glyph/g) || []).length, 2);
    assert.ok(js.includes("setCodingView('striverA2Z')"));
  });

  console.log('Next-action engine');
  await t('closing-soon eligible job is the top action, with evidence and HIGH confidence when data is complete', () => {
    const r = nextActions({ profile: FULL }, { jobs: [job('a', 3), job('b', 12)], today: TODAY });
    assert.strictEqual(r.actions[0].id, 'deadline:a'); assert.strictEqual(r.actions[0].confidence, 'HIGH');
    assert.ok(/3 days/.test(r.actions[0].why) && r.actions[0].evidence.length >= 2);
  });
  await t('jobs the user is NOT eligible for are never suggested', () => {
    const r = nextActions({ profile: { ...FULL, dob: '1980-01-01' } }, { jobs: [job('old', 2)], today: TODAY });
    assert.ok(!r.actions.some((a) => a.id === 'deadline:old'));
  });
  await t('missing profile data is listed, lowers confidence and is never defaulted', () => {
    const r = nextActions({ profile: { education: { level: 'bachelor' } } }, { jobs: [job('a', 3)], today: TODAY });
    assert.deepStrictEqual(r.missing_profile_fields.map((m) => m.field), ['dob', 'category', 'domicileState']);
    assert.ok(r.actions.some((a) => a.type === 'PROFILE'));
    assert.notStrictEqual(r.actions.find((a) => a.id === 'deadline:a').confidence, 'HIGH');
  });
  await t('unverified record is flagged LOW confidence with a caveat', () => {
    const r = nextActions({ profile: FULL }, { jobs: [job('u', 2, { unverified: true })], today: TODAY });
    const a = r.actions.find((x) => x.id === 'deadline:u'); assert.strictEqual(a.confidence, 'LOW'); assert.ok(/not verified/i.test(a.caveats[0]));
  });
  await t('sample/demo records are never presented as real or verified', () => {
    const r = nextActions({ profile: FULL }, { jobs: [{ ...job('demo', 2), sample: true }], today: TODAY });
    const a = r.actions.find((x) => x.id === 'deadline:demo'); assert.strictEqual(a.confidence, 'LOW');
    assert.ok(/SAMPLE/.test(a.evidence[0]) && /not a real vacancy/.test(a.caveats[0]) && !/verified record/.test(a.evidence[0]));
  });
  await t('already-applied jobs (from tracker) are not re-suggested; boundary day 14 included, 15 excluded, closed excluded', () => {
    const jobs = [job('done', 2), job('d14', 14), job('d15', 15), job('closed', -1)];
    const r = nextActions({ profile: FULL, applications: [{ job_id: 'done', status: 'applied' }] }, { jobs, today: TODAY });
    const ids = r.actions.map((a) => a.id);
    assert.ok(!ids.includes('deadline:done') && ids.includes('deadline:d14') && !ids.includes('deadline:d15') && !ids.includes('deadline:closed'));
  });
  await t('weak topic needs >=5 attempts; thin topics ask for more data instead of claiming weakness', () => {
    const at = [];
    for (let i = 0; i < 10; i++) at.push({ topic: 'Percentages', correct: i < 2 });
    for (let i = 0; i < 3; i++) at.push({ topic: 'Algebra', correct: false });
    const r = nextActions({ profile: FULL, attempts: at }, { jobs: [], today: TODAY });
    assert.ok(r.actions.some((a) => a.id === 'weak:Percentages'));
    assert.ok(!r.actions.some((a) => a.id === 'weak:Algebra'));
    assert.ok(r.actions.some((a) => a.id === 'data:Algebra'));
  });
  await t('overdue spaced-revision states produce a revision action; future ones do not', () => {
    const r = nextActions({ profile: FULL, revision_states: { Polity: { due: '2026-10-01' }, Maths: { due: '2026-10-20' } } }, { jobs: [], today: TODAY });
    const a = r.actions.find((x) => x.id === 'revision:due'); assert.ok(a && /Polity \(9d overdue\)/.test(a.why) && !/Maths/.test(a.why)); assert.strictEqual(a.urgency, 'HIGH');
  });
  await t('empty input yields no invented actions and says so', () => {
    const r = nextActions({}, { jobs: [], today: TODAY });
    assert.strictEqual(r.actions.length, 0); assert.ok(r.notes.some((n) => /Nothing urgent/.test(n))); assert.ok(/not predictions/.test(r.disclaimer));
  });
  await t('output is deterministic and respects limit', () => {
    const jobs = [job('a', 3), job('b', 4), job('c', 5), job('d', 6)];
    const x = nextActions({ profile: FULL, limit: 2 }, { jobs, today: TODAY }), y = nextActions({ profile: FULL, limit: 2 }, { jobs, today: TODAY });
    assert.deepStrictEqual(x, y); assert.strictEqual(x.actions.length, 2); assert.strictEqual(x.total_candidates, 4);
  });
  await t('API validates input types and lists the module in meta', async () => {
    const api = createAdvancedApi({ jobs: async () => [job('a', 3)], exams: async () => [], syllabus: async () => [], now: () => NOW });
    assert.strictEqual((await api.nextActions({ profile: FULL, attempts: 'x' })).status, 400);
    assert.strictEqual((await api.nextActions({ profile: FULL, applications: {} })).status, 400);
    assert.strictEqual((await api.nextActions({ profile: FULL, revision_states: [] })).status, 400);
    assert.strictEqual((await api.nextActions({ profile: { dob: 'nope' } })).status, 400);
    const ok = await api.nextActions({ profile: FULL }); assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.actions[0].id, 'deadline:a');
    assert.ok((await api.meta()).body.modules.includes('next-actions'));
  });

  console.log('Circuit breaker');
  await t('opens after threshold failures, short-circuits, half-opens after cooldown, closes on success', async () => {
    resilience.reset(); const name = 'p1'; resilience.get(name, { threshold: 2, cooldownMs: 50 });
    const bad = () => Promise.reject(new Error('boom'));
    await assert.rejects(resilience.guarded(name, bad)); await assert.rejects(resilience.guarded(name, bad));
    await assert.rejects(resilience.guarded(name, async () => 'never'), (e) => e.code === 'CIRCUIT_OPEN');
    assert.strictEqual(resilience.snapshot()[0].state, 'OPEN'); assert.strictEqual(resilience.snapshot()[0].short_circuited, 1);
    await new Promise((r) => setTimeout(r, 70));
    assert.strictEqual(await resilience.guarded(name, async () => 'fine'), 'fine'); assert.strictEqual(resilience.snapshot()[0].state, 'CLOSED');
  });
  await t('a failed half-open probe re-opens the circuit immediately', async () => {
    resilience.reset(); resilience.get('p2', { threshold: 1, cooldownMs: 30 });
    await assert.rejects(resilience.guarded('p2', () => Promise.reject(new Error('x'))));
    await new Promise((r) => setTimeout(r, 40));
    await assert.rejects(resilience.guarded('p2', () => Promise.reject(new Error('y'))));
    assert.strictEqual(resilience.canCall('p2'), false);
  });
  await t('LLM gateway: a failing provider is skipped once open, the next provider answers, no fake output is produced', async () => {
    resilience.reset(); resilience.get('llm:groq', { threshold: 1, cooldownMs: 60000 });
    let groqCalls = 0;
    const providers = { groq: { available: () => true, model: () => 'm', call: async () => { groqCalls++; throw new Error('Groq HTTP 500'); } },
      gemini: { available: () => true, model: () => 'g', call: async () => JSON.stringify({ fields: { title: { value: 'X', page: 1, quote: 'X' } } }) } };
    const a = await llm.proposeFields([{ page_number: 1, text: 'X' }], { order: ['groq', 'gemini'], providers });
    assert.strictEqual(a.provider, 'gemini'); assert.strictEqual(groqCalls, 1);
    const b = await llm.proposeFields([{ page_number: 1, text: 'X' }], { order: ['groq', 'gemini'], providers });
    assert.strictEqual(groqCalls, 1, 'open circuit must not call groq again'); assert.strictEqual(b.attempts[0].skipped, 'circuit_open');
  });
  await t('LLM gateway: malformed JSON from every provider returns an error, never invented fields', async () => {
    resilience.reset();
    const providers = { a: { available: () => true, model: () => 'a', call: async () => 'not json {' }, b: { available: () => true, model: () => 'b', call: async () => '{"nofields":1}' } };
    const r = await llm.proposeFields([{ page_number: 1, text: 'X' }], { order: ['a', 'b'], providers });
    assert.ok(r.error && !r.fields && r.attempts.length === 2 && r.attempts.every((x) => !x.ok));
  });

  console.log('Observability');
  await t('route keys collapse ids and tokens; request ids are validated, echoed and never reflect unsafe input', () => {
    assert.strictEqual(obs.routeKey({ method: 'GET', originalUrl: '/api/jobs/123?email=a@b.c' }), 'GET /api/jobs/:id');
    assert.strictEqual(obs.routeKey({ method: 'GET', originalUrl: '/api/calendar/abcdefghijklmnopqrstuvwxyz0123.ics' }), 'GET /api/calendar/:token.ics');
    assert.strictEqual(obs.requestId({ headers: { 'x-request-id': 'req-12345678' } }), 'req-12345678');
    const bad = obs.requestId({ headers: { 'x-request-id': '<script>alert(1)</script>' } }); assert.ok(/^[0-9a-f-]{36}$/.test(bad));
  });
  await t('middleware sets X-Request-Id and snapshot reports percentiles, routes and provider state', async () => {
    resilience.reset(); await resilience.guarded('demo', async () => 1);
    const srv = http.createServer((req, res) => obs.middleware(req, res, () => res.end('ok')));
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    const res = await new Promise((resolve) => http.get({ port, path: '/api/jobs/77?x=1', headers: { 'x-request-id': 'trace-abcdef12' } }, resolve));
    res.resume(); await new Promise((r) => res.on('end', r)); await new Promise((r) => setTimeout(r, 20)); srv.close();
    assert.strictEqual(res.headers['x-request-id'], 'trace-abcdef12');
    const s = obs.snapshot(); assert.ok(s.requests >= 1 && s.latency.p95_ms != null && s.routes.some((r) => r.route === 'GET /api/jobs/:id') && s.providers.some((p) => p.provider === 'demo'));
    assert.ok(!JSON.stringify(s).includes('x=1'), 'query strings must not be stored');
  });
  await t('structured logs drop credential-like and personal fields', () => {
    const lines = []; const orig = console.log; console.log = (l) => lines.push(l); const env = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { obs.log('info', 'x', { id: 'a', password: 'p', authToken: 't', email: 'e@x.y', apiKey: 'k', ok: 1 }); } finally { console.log = orig; process.env.NODE_ENV = env; }
    const j = JSON.parse(lines[0]); assert.deepStrictEqual(Object.keys(j).sort(), ['id', 'level', 'msg', 'ok', 't']);
  });

  console.log(`\nUpgrade tests: ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.join('\n')); process.exit(1); }
})();
