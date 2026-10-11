// Behavioral tests for Phase 5 pure logic (lib/study.js). SQL/routes are not executed here (needs PostgreSQL).
const assert = require('assert');
const S = require('./lib/study');
let pass = 0, fail = 0; const q = []; const t = (n, f) => q.push([n, f]);
const throwsStatus = (fn, status = 400) => { try { fn(); } catch (e) { assert.strictEqual(e.status, status, e.message); return; } assert.fail('expected throw'); };
const Q = (o = {}) => ({ id: 'q1', text: 'What is 2+2?', answer: 'B', origin: 'EDITORIAL', explanation: 'Because 4', ...o });

// ---- question labelling & validation ----
t('valid editorial/AI/PYQ set passes', () => assert(S.validateQuestions([Q(), Q({ id: 'q2', origin: 'AI_GENERATED' }), Q({ id: 'q3', origin: 'PREVIOUS_YEAR', source_ref: 'SSC 2023 Shift 1', legal_basis: 'OFFICIAL_PUBLIC' })]).ok));
t('missing origin is rejected', () => assert(!S.validateQuestions([Q({ origin: undefined })]).ok));
t('unknown origin is rejected', () => assert(!S.validateQuestions([Q({ origin: 'OFFICIAL' })]).ok));
t('previous-year question without legal_basis is rejected', () => assert(!S.validateQuestions([Q({ origin: 'PREVIOUS_YEAR', source_ref: 'x' })]).ok));
t('previous-year question without source_ref is rejected', () => assert(!S.validateQuestions([Q({ origin: 'PREVIOUS_YEAR', legal_basis: 'LICENSED' })]).ok));
t('invalid legal basis is rejected', () => assert(!S.validateQuestions([Q({ origin: 'PREVIOUS_YEAR', source_ref: 'x', legal_basis: 'SCRAPED' })]).ok));
t('duplicate ids / missing answer / empty text / empty list rejected', () => { assert(!S.validateQuestions([Q(), Q()]).ok); assert(!S.validateQuestions([Q({ answer: '' })]).ok); assert(!S.validateQuestions([Q({ text: ' ' })]).ok); assert(!S.validateQuestions([]).ok); assert(!S.validateQuestions(null).ok); assert(!S.validateQuestions([null]).ok); });
t('public questions never contain the answer key, explanation or legal basis', () => { const p = S.publicQuestions([Q({ legal_basis: 'LICENSED' })])[0]; assert(!('answer' in p) && !('explanation' in p) && !('legal_basis' in p)); assert(!JSON.stringify(p).includes('Because 4')); });
t('AI-generated questions are clearly labelled and flagged', () => { const p = S.publicQuestions([Q({ origin: 'AI_GENERATED' })])[0]; assert(/AI-generated/.test(p.label)); assert.strictEqual(p.ai_generated, true); });
t('previous-year label cites its source; editorial is not flagged AI', () => { const a = S.publicQuestions([Q({ origin: 'PREVIOUS_YEAR', source_ref: 'SSC 2023' })])[0]; assert(a.label.includes('SSC 2023')); assert.strictEqual(S.publicQuestions([Q()])[0].ai_generated, false); });
t('legacy question with no origin is never presented as official', () => { const p = S.publicQuestions([Q({ origin: undefined })])[0]; assert(/not recorded/.test(p.label)); assert(!/Previous-year/.test(p.label)); });
t('publicQuestions tolerates non-array', () => assert.deepStrictEqual(S.publicQuestions(null), []));

// ---- scoring ----
const qs = [Q({ id: 1, answer: 'A' }), Q({ id: 2, answer: 'B' }), Q({ id: 3, answer: 'C' }), Q({ id: 4, answer: 'D' })];
t('basic scoring: correct / wrong / unanswered', () => { const r = S.scoreAttempt(qs, { 1: 'A', 2: 'X' }); assert.deepStrictEqual([r.correct, r.wrong, r.unanswered, r.total, r.score], [1, 1, 2, 4, 25]); });
t('REGRESSION: unanswered question with a missing answer key is not counted correct', () => { const r = S.scoreAttempt([{ id: 1, text: 'x' }, Q({ id: 2, answer: 'B' })], {}); assert.strictEqual(r.correct, 0); assert.strictEqual(r.unkeyed, 1); assert.strictEqual(r.total, 1); });
t('REGRESSION: empty-string answer key is unkeyed, not matched by blank submission', () => { const r = S.scoreAttempt([{ id: 1, answer: '' }], { 1: '' }); assert.strictEqual(r.correct, 0); assert.strictEqual(r.total, 0); });
t('numeric vs string answers compare equal ("2" vs 2)', () => assert.strictEqual(S.scoreAttempt([Q({ id: 1, answer: 2 })], { 1: '2' }).correct, 1));
t('negative marking applies to wrong answers only', () => { const r = S.scoreAttempt(qs, { 1: 'A', 2: 'X', 3: 'Y' }, { negative_marking: 0.25 }); assert.strictEqual(r.marks, 0.5); assert.strictEqual(r.score, 12.5); });
t('invalid negative_marking values are ignored', () => { for (const v of [-1, 2, 'abc', null]) assert.strictEqual(S.scoreAttempt(qs, { 1: 'X' }, { negative_marking: v }).negative_marking, 0); });
t('answers null / array / string do not crash', () => { for (const a of [null, undefined, [], 'abc', 5]) assert.strictEqual(S.scoreAttempt(qs, a).correct, 0); });
t('review reveals correct answers only after attempt and includes labels', () => { const r = S.scoreAttempt([Q({ id: 1, answer: 'A', origin: 'AI_GENERATED' })], { 1: 'B' }); assert.strictEqual(r.review[0].correct_answer, 'A'); assert.strictEqual(r.review[0].result, 'WRONG'); assert(/AI-generated/.test(r.review[0].label)); });
t('no questions -> score 0, no divide-by-zero', () => { const r = S.scoreAttempt([], {}); assert.strictEqual(r.score, 0); assert(Number.isFinite(r.score)); });

// ---- progress parsing ----
t('progress accepts 0..100 and maps status', () => { assert.deepStrictEqual(S.parseProgress(0), { pct: 0, status: 'NOT_STARTED' }); assert.deepStrictEqual(S.parseProgress('40'), { pct: 40, status: 'IN_PROGRESS' }); assert.deepStrictEqual(S.parseProgress(100), { pct: 100, status: 'MASTERED' }); assert.strictEqual(S.parseProgress(50.4).pct, 50); });
t('REGRESSION: non-numeric / NaN / out-of-range progress is a 400, not a DB crash or silent clamp', () => { for (const v of ['abc', NaN, -5, 150, true, null, undefined, '', Infinity, {}, [], '1e3']) throwsStatus(() => S.parseProgress(v)); });

// ---- study plan ----
const N = (id, parent_id = null) => ({ id, parent_id });
const flat = (n) => Array.from({ length: n }, (_, i) => N(i + 1));
t('every remaining topic is scheduled exactly once', () => { const p = S.buildPlan(flat(10), '2026-10-01', '2026-10-03', 60); const all = p.flatMap((d) => d.topics); assert.strictEqual(all.length, 10); assert.strictEqual(new Set(all).size, 10); });
t('topics spread evenly (10 over 3 days = 4,3,3), not front-loaded', () => assert.deepStrictEqual(S.buildPlan(flat(10), '2026-10-01', '2026-10-03', 60).map((d) => d.topics.length), [4, 3, 3]));
t('REGRESSION: parent headings are not scheduled as work, only leaves', () => { const nodes = [N(1), N(2, 1), N(3, 1), N(4)]; const all = S.buildPlan(nodes, '2026-10-01', '2026-10-05', 60).flatMap((d) => d.topics); assert.deepStrictEqual(all.sort(), [2, 3, 4]); });
t('REGRESSION: mastered topics are skipped', () => { const all = S.buildPlan(flat(4), '2026-10-01', '2026-10-04', 60, { 1: 'MASTERED', 2: 'IN_PROGRESS' }).flatMap((d) => d.topics); assert.deepStrictEqual(all.sort(), [2, 3, 4]); });
t('plan dates are consecutive and inside the window', () => { const p = S.buildPlan(flat(3), '2026-10-30', '2026-11-02', 60); assert.deepStrictEqual(p.map((d) => d.date), ['2026-10-30', '2026-10-31', '2026-11-01']); });
t('same-day plan works', () => assert.strictEqual(S.buildPlan(flat(2), '2026-10-03', '2026-10-03', 60).length, 1));
t('end before start -> 400', () => throwsStatus(() => S.buildPlan(flat(1), '2026-10-05', '2026-10-01', 60)));
t('REGRESSION: impossible calendar dates (2026-02-31) and bad formats -> 400 (JS used to roll them over)', () => { for (const d of ['2026-02-31', '2026-13-01', '10/03/2026', 'abc', '', null, 20261003]) throwsStatus(() => S.buildPlan(flat(1), d, '2026-12-01', 60)); });
t('REGRESSION: plan longer than a year is refused (was unbounded)', () => throwsStatus(() => S.buildPlan(flat(1), '2026-01-01', '2036-01-01', 60)));
t('daily minutes must be a sane number', () => { for (const m of [NaN, 0, 5, -30, 1000, Infinity]) throwsStatus(() => S.buildPlan(flat(1), '2026-10-01', '2026-10-02', m)); });
t('empty syllabus / everything mastered -> empty plan with explicit warning', () => { const p = S.buildPlan(flat(2), '2026-10-01', '2026-10-02', 60, { 1: 'MASTERED', 2: 'MASTERED' }); assert.deepStrictEqual(p, []); assert(S.planWarnings(p, 60).length === 1); });
t('overloaded plan warns about too little time per topic', () => { const p = S.buildPlan(flat(30), '2026-10-01', '2026-10-01', 30); assert(S.planWarnings(p, 30)[0].includes('under 10 minutes')); });
t('leap day is accepted, non-leap rejected', () => { S.parseDate('2028-02-29', 'd'); throwsStatus(() => S.parseDate('2027-02-29', 'd')); });

// ---- tutor ----
const V = { id: 1, name: 'SSC CGL', recruitment_year: 2026, syllabus_version: 'v2' };
const nodes = [
  { id: 1, parent_id: null, code: 'QA', title: 'Quantitative Aptitude', description: 'Arithmetic and algebra', sort_order: 1, source_page: 4, source_ref: 'Annex A' },
  { id: 2, parent_id: 1, code: 'QA.1', title: 'Percentage', description: null, sort_order: 1, source_page: 4, source_ref: 'Annex A' },
  { id: 3, parent_id: 1, code: 'QA.2', title: 'Percentage Change', description: null, sort_order: 2, source_page: null, source_ref: null },
  { id: 4, parent_id: null, code: 'GA', title: 'General Awareness', description: 'Current events', sort_order: 2, source_page: 6, source_ref: 'Annex A' },
];
const old = { id: 9, recruitment_year: 2022, syllabus_version: 'v1', nodes: [{ id: 90, parent_id: null, code: 'CA', title: 'Computer Awareness', description: 'OLD-2022-ONLY SCOPE', sort_order: 1, source_page: 3, source_ref: 'x' }] };
const ask = (o) => S.tutorAnswer({ version: V, nodes, otherVersions: [old], ...o });
t('answers from the pinned version with page citations', () => { const r = ask({ topic: 'Quantitative Aptitude', question: 'what is covered?' }); assert.strictEqual(r.status, 'ANSWERED'); assert(r.answer.includes('2026') && r.answer.includes('v2')); assert(r.answer.includes('Arithmetic and algebra')); assert.strictEqual(r.citations[0].page, 4); assert.strictEqual(r.exam_version.syllabus_version, 'v2'); });
t('lists subtopics with their own citations', () => { const r = ask({ topic: 'QA', question: '' }); assert(r.answer.includes('Percentage; Percentage Change')); assert.strictEqual(r.citations.length, 3); });
t('missing page numbers are disclosed, not invented', () => { const r = ask({ topic: 'Quantitative Aptitude' }); assert(r.answer.includes('not recorded')); assert.strictEqual(r.citations.find((c) => c.code === 'QA.2').page, null); assert.strictEqual(r.citations.find((c) => c.code === 'QA.2').page_recorded, false); });
t('topic found from the question text; longest title wins', () => { const r = ask({ topic: '', question: 'explain percentage change please' }); assert.strictEqual(r.citations[0].code, 'QA.2'); });
t('REGRESSION: topic only in another year is reported as such and never answered from that year', () => { const r = ask({ topic: 'Computer Awareness' }); assert.strictEqual(r.status, 'NOT_IN_THIS_VERSION'); assert(r.answer.includes('2022')); assert(!r.answer.includes('OLD-2022-ONLY SCOPE')); assert.deepStrictEqual(r.citations, []); });
t('unknown topic -> NOT_IN_SYLLABUS with no citations', () => { const r = ask({ topic: 'Quantum Chromodynamics', question: '' }); assert.strictEqual(r.status, 'NOT_IN_SYLLABUS'); assert.deepStrictEqual(r.citations, []); });
t('no topic and no match -> not answered (no guess)', () => assert.strictEqual(ask({ topic: '', question: 'hello' }).status, 'NOT_IN_SYLLABUS'));
t('answer text never carries the old prompt-leak sentence', () => assert(!/tutor response must be generated/i.test(ask({ topic: 'General Awareness' }).answer)));
t('states it does not teach the subject', () => assert(/does not teach/.test(ask({ topic: 'General Awareness' }).scope_notice)));
t('short titles (<3 chars) cannot match by substring accident', () => assert.strictEqual(S.findNode([{ id: 1, title: 'GK', code: 'X' }], '', 'what is gkx-related'), null));

(async () => { for (const [n, f] of q) { try { await f(); pass++; console.log('✓', n); } catch (e) { fail++; console.log('✗', n, '-', e.message); } } console.log(`\nPhase 5 behavior: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
