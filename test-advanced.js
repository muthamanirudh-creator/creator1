'use strict';
// Advanced Strategy Suite tests: engines (fixed clock, synthetic jobs), API validation, and the standalone HTTP runtime.
const assert = require('assert'); const http = require('http'); const { spawn } = require('child_process');
const { evaluate } = require('./lib/eligibility');
const age = require('./lib/advanced/age'), planner = require('./lib/advanced/planner'), rank = require('./lib/advanced/rank');
const overlap = require('./lib/advanced/overlap'), sp = require('./lib/advanced/studyplan'), an = require('./lib/advanced/analytics');
const { createAdvancedApi } = require('./lib/advanced'); const runtime = require('./lib/runtime');
let pass = 0, fail = 0; const failures = [];
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; failures.push(name + ': ' + e.message); } };
const NOW = new Date('2026-10-04T06:00:00Z');
const mk = (id, o = {}) => ({ id, title: id.toUpperCase(), organization: 'Org', lifecycle: 'PUBLISHED', verification: { status: 'VERIFIED' },
  dates: { application_open: '2026-09-01T10:00:00+05:30', application_close: '2026-10-20T23:59:00+05:30', exam_date: '2026-12-20', ...(o.dates || {}) },
  education: { accepted: ['bachelor'], or_higher: true, label: 'Bachelor', fields: ['any'] },
  age: { min: 18, max: 30, cutoff_date: '2026-01-01', relaxation: { SC: 5, ST: 5, OBC: 3, EWS: 0, PwBD: 10, ExServicemen: 3 }, ...(o.age || {}) },
  domicile: { type: 'ALL_INDIA' }, fee: o.fee === undefined ? { general: '₹500', reserved: '₹250' } : o.fee,
  vacancies: o.vacancies || { total: 1000, breakdown: { UR: 500, SC: 150, ST: 75, OBC: 200, EWS: 75 }, pwbd: 40, ex_servicemen: 100 }, selection: ['CBT'], field_sources: {}, ...(o.top || {}) });
const P = { dob: '1999-03-15', category: 'General', education: { level: 'bachelor', status: 'completed', field: 'science' }, state: 'Telangana' };

(async () => {
  await t('ex-servicemen alias now relaxes age in the main engine', () => {
    const j = mk('a', { age: { max: 30 } }); const p = { ...P, dob: '1993-06-01' }; // 32y at cutoff
    assert.strictEqual(evaluate(j, p).rows.find((r) => r.key === 'age').result, 'NOT_ELIGIBLE');
    assert.strictEqual(evaluate(j, { ...p, exServiceman: true }).rows.find((r) => r.key === 'age').result, 'MATCH');
    assert.strictEqual(evaluate(j, { ...p, exServicemen: true }).rows.find((r) => r.key === 'age').result, 'MATCH');
  });
  await t('runway: ages-out date matches eligibility rule', () => {
    const r = age.runwayFor(mk('a'), P, NOW); // 26y9m at cutoff, limit 30 -> 31st birthday = 2030-03-15
    assert.strictEqual(r.status, 'ELIGIBLE_BY_AGE'); assert.strictEqual(r.ages_out_on, '2030-03-15'); assert.strictEqual(r.last_eligible_cutoff, '2030-03-14');
    assert.strictEqual(evaluate(mk('a', { age: { cutoff_date: '2030-03-14' } }), P).rows.find((x) => x.key === 'age').result, 'MATCH');
    assert.strictEqual(evaluate(mk('a', { age: { cutoff_date: '2030-03-15' } }), P).rows.find((x) => x.key === 'age').result, 'NOT_ELIGIBLE');
  });
  await t('runway: relaxation, over-age and too-young', () => {
    assert.strictEqual(age.runwayFor(mk('a'), { ...P, dob: '1993-06-01' }, NOW).status, 'OVER_AGE');
    const obc = age.runwayFor(mk('a'), { ...P, dob: '1993-06-01', category: 'OBC' }, NOW); assert.strictEqual(obc.status, 'ELIGIBLE_BY_AGE'); assert.strictEqual(obc.your_upper_limit, 33);
    const young = age.runwayFor(mk('a'), { ...P, dob: '2010-01-01' }, NOW); assert.strictEqual(young.status, 'TOO_YOUNG'); assert.strictEqual(young.becomes_eligible_on, '2028-01-01');
    assert.strictEqual(age.runwayFor(mk('a'), {}, NOW), null);
  });
  await t('runway: last-chance flag when margin under 180 days', () => {
    const r = age.runwayFor(mk('a'), { ...P, dob: '1995-12-01' }, NOW); // 30y at cutoff, turns 31 on 2026-12-01
    assert.strictEqual(r.urgency, 'LAST_CHANCE_WINDOW');
  });
  await t('planner: same-day exam, close exams, crunch, past events dropped', () => {
    const jobs = [mk('a', { dates: { exam_date: '2026-12-20', application_close: '2026-10-10T23:59:00+05:30' } }), mk('b', { dates: { exam_date: '2026-12-20', application_close: '2026-10-12T23:59:00+05:30' } }), mk('c', { dates: { exam_date: '2026-12-22', application_close: '2026-10-13T23:59:00+05:30' } }), mk('old', { dates: { application_open: '2026-01-01T10:00:00+05:30', application_close: '2026-02-01T23:59:00+05:30', exam_date: '2026-03-01' } })];
    const ev = planner.buildEvents(jobs, '2026-10-04'); assert.ok(!ev.some((e) => e.job_id === 'old'));
    const c = planner.conflicts(ev); assert.ok(c.some((x) => x.kind === 'EXAM_SAME_DAY' && x.severity === 'HIGH'));
    assert.ok(c.some((x) => x.kind === 'EXAM_CLOSE')); assert.ok(c.some((x) => x.kind === 'DEADLINE_CRUNCH'));
    assert.deepStrictEqual(ev.map((e) => e.date), [...ev.map((e) => e.date)].sort());
  });
  await t('budget: unknown fee is never counted as zero; reserved column used', () => {
    const b = planner.budget([mk('a'), mk('b', { fee: null }), mk('c', { fee: { general: 'No fee', reserved: 'No fee' } })], { category: 'SC' });
    assert.strictEqual(b.total_known, 250); assert.strictEqual(b.unknown_count, 1);
  });
  await t('rank: blocked jobs excluded, weights respected, missing criteria renormalised', () => {
    const jobs = [mk('good'), mk('closed', { dates: { application_close: '2026-09-01T23:59:00+05:30' } }), mk('old', { age: { max: 20 } }), mk('noexam', { dates: { exam_date: null } })];
    jobs[3].dates.exam_date = undefined;
    const r = rank.rankJobs(jobs, P, { now: NOW }); const by = Object.fromEntries(r.rows.map((x) => [x.job_id, x]));
    assert.strictEqual(by.closed.blocked, true); assert.strictEqual(by.old.blocked, true); assert.strictEqual(by.old.score, 0); assert.strictEqual(by.old.rank, null);
    assert.ok(by.noexam.criteria.prep_time.excluded); const share = Object.values(by.noexam.criteria).filter((c) => !c.excluded).reduce((s, c) => s + c.weight_share, 0); assert.ok(Math.abs(share - 100) < 0.6, 'shares ' + share);
    const onlyCost = rank.rankJobs([mk('cheap', { fee: { general: 'No fee', reserved: 'No fee' } }), mk('dear', { fee: { general: '₹900', reserved: '₹900' } })], P, { now: NOW, weights: { eligibility: 0, time_to_apply: 0, prep_time: 0, seats: 0, age_comfort: 0, cost: 100 }, skipSensitivity: true });
    assert.strictEqual(onlyCost.rows[0].job_id, 'cheap');
  });
  await t('rank: seats use only categories that apply to the profile', () => {
    const j = mk('a'); assert.strictEqual(rank.seatsFor(j, { category: 'General' }).seats, 500);
    assert.strictEqual(rank.seatsFor(j, { category: 'SC' }).seats, 650); assert.strictEqual(rank.seatsFor(j, { category: 'SC', pwbd: true }).seats, 690);
  });
  await t('overlap: shared concepts across verified syllabi', () => {
    const ex = runtime.exams().map((e) => ({ id: e.version_id, code: e.code, name: e.name, nodes: runtime.syllabus(e.version_id).map((n) => ({ id: n.id, code: n.code, title: n.title })) }));
    const o = overlap.compare(ex); const cgl = o.pairs.find((p) => p.a === 'SSC-CGL' && p.b === 'SSC-CHSL'); assert.strictEqual(cgl.matched_topics, 4);
    const po = o.pairs.find((p) => p.b === 'BANK-PO' && p.a === 'SSC-CGL'); assert.strictEqual(po.matched_topics, 4); assert.ok(o.caveat);
    assert.ok(overlap.conceptOf('General/Economy Awareness').includes('awareness'));
  });
  await t('portfolio: earliest-deadline feasibility and reuse of shared topics', async () => {
    const jobs = [mk('ssc-combined-graduate', { dates: { exam_date: '2027-02-01', application_close: '2026-11-22T23:59:00+05:30' } }), mk('bank-po', { dates: { exam_date: '2026-12-23', application_close: '2026-11-07T23:59:00+05:30' } })];
    const api = createAdvancedApi({ jobs: async () => jobs, exams: async () => runtime.exams(), syllabus: async (id) => runtime.syllabus(id), now: () => NOW });
    const big = (await api.portfolio({ profile: P, weekly_hours: 30 })).body; assert.strictEqual(big.targets.length, 2);
    const first = big.targets[0]; assert.strictEqual(first.job_id, 'bank-po'); assert.ok(first.marginal_prep_hours > 0, 'earliest exam must pay for its own topics');
    assert.strictEqual(big.targets[1].marginal_prep_hours, 0); assert.strictEqual(big.targets[1].shared_topics_saved, 4);
    const small = (await api.portfolio({ profile: P, weekly_hours: 3 })).body; assert.ok(small.not_feasible.length >= 1 && /prep hours/.test(small.not_feasible[0].reason));
  });
  await t('sm2: reset on lapse, 1-6-ease progression, ease floor', () => {
    let s = sp.sm2({}, 4); assert.strictEqual(s.interval, 1); s = sp.sm2(s, 4); assert.strictEqual(s.interval, 6); s = sp.sm2(s, 4); assert.strictEqual(s.interval, 15);
    assert.strictEqual(sp.sm2(s, 1).interval, 1); assert.strictEqual(sp.sm2(s, 1).reps, 0);
    let e = { ease: 1.3, interval: 6, reps: 3 }; for (let i = 0; i < 5; i++) e = sp.sm2(e, 0); assert.ok(e.ease >= 1.3);
  });
  await t('study plan: respects daily hours, rest day, final window, deterministic', () => {
    const input = { exam_date: '2026-12-01', hours_per_day: 3, rest_weekday: 0, mock_every_days: 7, final_revision_days: 3, topics: [{ title: 'Quant', confidence: 1, weight: 2 }, { title: 'English', confidence: 4 }, { title: 'Reasoning', confidence: 2 }] };
    const a = sp.plan(input, NOW), b = sp.plan(input, NOW); assert.deepStrictEqual(a, b);
    for (const d of a.days) { assert.ok(d.total_hours === undefined || d.total_hours <= 3.01, d.date + ' ' + d.total_hours); if (d.rest) assert.strictEqual(d.blocks.length, 0); }
    assert.ok(a.days.filter((d) => d.final).every((d) => d.blocks.every((x) => x.type === 'revise'))); assert.ok(a.mocks_planned >= 6);
    const q = a.topic_hours.find((x) => x.title === 'Quant').planned, e = a.topic_hours.find((x) => x.title === 'English').planned; assert.ok(q > e * 2, 'weak+heavy topic gets far more time');
    assert.ok(a.days.some((d) => d.blocks.some((x) => x.type === 'revise' && x.interval_day !== 'final')));
    assert.ok(a.days[a.days.length - 1].date < '2026-12-01');
    assert.ok(sp.plan({ ...input, exam_date: '2026-10-04' }, NOW).error); assert.ok(sp.plan({ ...input, topics: [] }, NOW).error);
    assert.ok(sp.plan({ ...input, exam_date: '2026-10-10' }, NOW).warnings.length >= 1);
  });
  await t('analytics: wilson interval, break-even, advice, trend', () => {
    const w = an.wilson(8, 10); assert.ok(w.low > 0.4 && w.low < 0.5 && w.high > 0.9 && w.high < 1);
    const attempts = [...Array(10).fill(0).map((_, i) => ({ topic: 'Quant', correct: i < 9, seconds: 40 })), ...Array(10).fill(0).map((_, i) => ({ topic: 'GK', correct: i < 2, seconds: 20 })), { topic: 'Rare', correct: true }];
    const r = an.analyse({ attempts, marks_wrong: 0.5, marks_correct: 2, total_time_minutes: 12, target_score: 40, tests: [{ score: 10 }, { score: 20 }, { score: 30 }] });
    assert.strictEqual(r.overall.break_even_accuracy_pct, 20); assert.strictEqual(r.topics[0].topic, 'GK');
    assert.strictEqual(r.topics.find((x) => x.topic === 'Quant').advice, 'ATTEMPT_CONFIDENTLY'); assert.strictEqual(r.topics.find((x) => x.topic === 'Rare').advice, 'NOT_ENOUGH_DATA');
    assert.strictEqual(r.trend.direction, 'IMPROVING'); assert.strictEqual(r.trend.tests_to_target, 1); assert.strictEqual(r.pace.verdict, 'ON_PACE');
    assert.strictEqual(r.overall.net_marks, (9 + 2 + 1) * 2 - (1 + 8) * 0.5);
  });
  await t('what-if: ageing one year closes a job at the limit; qualification opens one', async () => {
    const jobs = [mk('edge', { age: { max: 26 } }), mk('masters', { top: { education: { accepted: ['master'], or_higher: true, label: 'Master', fields: ['any'] } } })];
    const api = createAdvancedApi({ jobs: async () => jobs, exams: async () => [], syllabus: async () => [], now: () => NOW });
    const out = (await api.whatif({ profile: P })).body; const older = out.scenarios.find((s) => /older/.test(s.label)); assert.ok(older.closes.some((c) => c.job_id === 'edge'));
    const next = out.scenarios.find((s) => /next level/.test(s.label)); assert.ok(next.opens.some((o) => o.job_id === 'masters'));
  });
  await t('API validation and brief shape', async () => {
    const api = createAdvancedApi({ jobs: async () => [mk('a')], exams: async () => runtime.exams(), syllabus: async (id) => runtime.syllabus(id), now: () => NOW });
    assert.strictEqual((await api.runway({ profile: { dob: 'nope' } })).status, 400); assert.strictEqual((await api.runway({ profile: [] })).status, 400); assert.strictEqual((await api.runway({})).status, 400);
    assert.strictEqual((await api.studyPlan({ exam_date: 'x', topics: [] })).status, 400); assert.strictEqual((await api.analytics({ attempts: [] })).status, 400);
    assert.strictEqual((await api.analytics({ attempts: new Array(5001).fill({ topic: 'a', correct: true }) })).status, 400); assert.strictEqual((await api.sm2({})).status, 400);
    assert.strictEqual((await api.overlap({ exams: ['SSC-CGL'] })).status, 400);
    const b = (await api.brief({ profile: P })).body; assert.ok(b.kpis && Array.isArray(b.top) && b.engine);
    assert.ok(!JSON.stringify(b).includes('NaN'));
  });
  await t('demo corpus: every module returns without error for a realistic profile', async () => {
    const { buildJobs } = require('./data/jobs'); const api = createAdvancedApi({ jobs: async (n) => buildJobs(n).filter((j) => j.verification.status === 'VERIFIED'), exams: async () => runtime.exams(), syllabus: async (id) => runtime.syllabus(id) });
    const body = { profile: { dob: '2001-04-12', category: 'OBC', state: 'Telangana', education: { level: 'bachelor', status: 'completed', field: 'engineering' } } };
    for (const n of ['brief', 'runway', 'planner', 'rank', 'portfolio', 'whatif']) { const r = await api[n](body); assert.strictEqual(r.status, 200, n); assert.ok(!JSON.stringify(r.body).includes('NaN'), n + ' NaN'); }
    assert.strictEqual((await api.overlap({})).status, 200);
  });

  // ---- real HTTP against the zero-dependency runtime ----
  await t('standalone HTTP: endpoints, validation, malformed JSON', async () => {
    const port = 4300 + Math.floor(Math.random() * 400); const child = spawn(process.execPath, ['standalone.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    const call = (method, path, data, raw) => new Promise((res, rej) => { const r = http.request({ port, path, method, headers: { 'content-type': 'application/json' } }, (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { try { res({ s: resp.statusCode, b: JSON.parse(b) }); } catch (e) { res({ s: resp.statusCode, b }); } }); }); r.on('error', rej); if (data !== undefined) r.write(raw ? data : JSON.stringify(data)); r.end(); });
    try {
      for (let i = 0; i < 40; i++) { try { await call('GET', '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const m = await call('GET', '/api/advanced/meta'); assert.strictEqual(m.s, 200); assert.ok(m.b.modules.includes('study-plan'));
      const prof = { dob: '2001-04-12', category: 'OBC', education: { level: 'bachelor', status: 'completed' } };
      for (const n of ['brief', 'runway', 'planner', 'rank', 'portfolio', 'whatif', 'overlap']) { const r = await call('POST', '/api/advanced/' + n, { profile: prof }); assert.strictEqual(r.s, 200, n + ' -> ' + r.s); }
      const spr = await call('POST', '/api/advanced/study-plan', { exam_date: '2027-03-01', topics: [{ title: 'A' }, { title: 'B', confidence: 5 }] }); assert.strictEqual(spr.s, 200); assert.ok(spr.b.days.length > 10);
      assert.strictEqual((await call('POST', '/api/advanced/runway', { profile: { dob: 'zzz' } })).s, 400);
      assert.strictEqual((await call('POST', '/api/advanced/brief', '{bad json', true)).s, 400);
      assert.strictEqual((await call('GET', '/api/advanced/nope')).s, 404);
    } finally { child.kill(); }
  });

  console.log(`Advanced suite: ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
})();
