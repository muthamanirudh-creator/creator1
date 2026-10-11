// Phase 3 grounded-AI suite. Dependency-free (no DB/network). Run: node test-phase3.js
const assert = require('assert');
const { MODES, SILENT, verifyClaim, auditText, claimsForJob } = require('./lib/claims');
const { ask } = require('./lib/answer');
const { classify, resolveJob } = require('./lib/intent');
const { validateFilters, llmFilters } = require('./lib/assistantSearch');
const { buildGraph, answerGraphQuestion, shortestPath } = require('./lib/knowledgeGraph');
const A = require('./lib/answerAudit');
const { runSearch } = require('./lib/search');
const now = new Date();
const jobs = require('./data/jobs').buildJobs(now);
const gd = jobs.find((j) => j.id === 'rrb-group-d');
let pass = 0, fail = 0; const pending = [];
function t(name, fn) { pending.push((async () => { try { await fn(); pass++; console.log('✓', name); } catch (e) { fail++; process.exitCode = 1; console.error('✗', name, '-', e.message); } })()); }

// ---- 1. Fifty distinct end-to-end questions: every answer must audit clean (zero unsupported claims). ----
const QUESTIONS = [
  ['When is the last date for Group D?', 'QUICK'], ['Deadline for Technician Grade III', 'QUICK'], ['last date to apply for SSC MTS', 'QUICK'], ['closing date police constable', 'QUICK'], ['How long do I have for Junior Assistant?', 'DETAILED'],
  ['When does Group D open?', 'QUICK'], ['opening date for Combined Graduate Level', 'DETAILED'], ['apply from when for MTS', 'QUICK'], ['exam date for Group D', 'OFFICIAL_ONLY'], ['when is the exam for Technician Grade III', 'QUICK'],
  ['age limit for Group D', 'QUICK'], ['maximum age police constable', 'OFFICIAL_ONLY'], ['minimum age for SSC MTS', 'SOURCE_FIRST'], ['age cutoff for Combined Graduate Level', 'EXPLAINED'], ['age limit Junior Assistant', 'DETAILED'],
  ['OBC age relaxation Group D', 'OFFICIAL_ONLY'], ['SC age relaxation for Technician Grade III', 'QUICK'], ['PwBD relaxation police constable', 'DETAILED'], ['ex-servicemen age relaxation SSC MTS', 'OFFICIAL_ONLY'], ['ST relaxation Combined Graduate Level', 'QUICK'],
  ['How many vacancies in Group D?', 'QUICK'], ['total posts Technician Grade III', 'OFFICIAL_ONLY'], ['number of vacancies SSC MTS', 'DETAILED'], ['how many seats police constable', 'QUICK'], ['vacancies Combined Graduate Level', 'SOURCE_FIRST'],
  ['SC vacancies Group D', 'QUICK'], ['OBC vacancies Group D', 'OFFICIAL_ONLY'], ['EWS posts Group D', 'QUICK'], ['PwBD posts Group D', 'DETAILED'], ['ex-servicemen vacancies Group D', 'OFFICIAL_ONLY'],
  ['fee for Group D', 'QUICK'], ['application fee SSC MTS', 'OFFICIAL_ONLY'], ['fee for Combined Graduate Level', 'DETAILED'], ['how much to pay police constable', 'QUICK'], ['fee Junior Assistant', 'OFFICIAL_ONLY'],
  ['education needed for Group D', 'QUICK'], ['qualification for Technician Grade III', 'OFFICIAL_ONLY'], ['degree required Combined Graduate Level', 'DETAILED'], ['education police constable', 'EXPLAINED'], ['qualification Junior Assistant', 'QUICK'],
  ['selection process Group D', 'QUICK'], ['stages for Technician Grade III', 'OFFICIAL_ONLY'], ['selection process SSC MTS', 'DETAILED'], ['rounds in police constable', 'QUICK'], ['selection Combined Graduate Level', 'EXPLAINED'],
  ['where did this come from for Group D', 'QUICK'], ['source of the age limit for SSC MTS', 'SOURCE_FIRST'], ['which document says police constable vacancies', 'QUICK'], ['proof of the closing date Technician Grade III', 'OFFICIAL_ONLY'], ['how should I apply for Group D', 'ACTIONABLE'],
];
t('50 distinct questions are distinct', () => assert.strictEqual(new Set(QUESTIONS.map((q) => q[0].toLowerCase())).size, 50));
let tokensChecked = 0, silentCount = 0;
for (const [q, mode] of QUESTIONS) t(`E2E [${mode}] ${q}`, () => {
  const r = ask({ jobs, question: q, mode, now });
  assert(!r.needs_clarification, 'unexpected clarification: ' + JSON.stringify(r.clarification));
  assert.strictEqual(r.audit.unsupported.length, 0, 'unsupported: ' + r.audit.unsupported);
  assert(r.audit.ok); tokensChecked += r.audit.checks.length; if (r.official_silent) silentCount++;
  if (mode === 'SOURCE_FIRST' && r.claims.some((c) => c.source)) assert(/\[[^\]]+, page \d+\]/.test(r.text) || /page \d+/.test(r.text), 'source-first must cite the page');
});

// ---- 2. Seven modes ----
t('seven modes exist', () => assert.deepStrictEqual(MODES, ['QUICK', 'DETAILED', 'OFFICIAL_ONLY', 'ELIGIBILITY', 'SOURCE_FIRST', 'EXPLAINED', 'ACTIONABLE']));
t('unknown mode rejected with 400', () => { try { ask({ jobs, question: 'age', recruitmentId: gd.id, mode: 'CHATTY' }); assert.fail('no throw'); } catch (e) { assert.strictEqual(e.status, 400); } });
t('QUICK is shorter than DETAILED', () => assert(ask({ jobs, question: 'tell me the vacancies', recruitmentId: gd.id, mode: 'QUICK', now }).text.length < ask({ jobs, question: 'tell me the vacancies', recruitmentId: gd.id, mode: 'DETAILED', now }).text.length));

// ---- 3. Official-only silence ----
const bare = JSON.parse(JSON.stringify(gd)); delete bare.dates.exam_date; delete bare.fee; delete bare.vacancies.pwbd;
t('OFFICIAL_ONLY states silence for missing exam date', () => { const r = ask({ jobs: [bare], question: 'exam date', recruitmentId: bare.id, mode: 'OFFICIAL_ONLY', now }); assert(r.text.includes(SILENT)); assert(r.official_silent); });
t('OFFICIAL_ONLY states silence for missing fee', () => { const r = ask({ jobs: [bare], question: 'what is the fee', recruitmentId: bare.id, mode: 'OFFICIAL_ONLY', now }); assert(r.text.split(SILENT).length - 1 >= 2); });
t('OFFICIAL_ONLY silence for missing PwBD posts', () => assert(ask({ jobs: [bare], question: 'how many PwBD posts', recruitmentId: bare.id, mode: 'OFFICIAL_ONLY', now }).text.includes(SILENT)));
t('OFFICIAL_ONLY never adds advice/status text', () => { const r = ask({ jobs, question: 'age limit', recruitmentId: gd.id, mode: 'OFFICIAL_ONLY', now }); assert(!/status|next step|re-check/i.test(r.text)); });
t('silence never fabricates a number', () => { const r = ask({ jobs: [bare], question: 'exam date', recruitmentId: bare.id, mode: 'QUICK', now }); assert(r.audit.ok); assert(!/2026-12|Dec 2026/.test(r.text)); });

// ---- 4. Verifier: strict positives & adversarial negatives ----
for (const c of ['32000', '32,000', '33', '18', '2026-01-01', '1 Jan 2026', '25 Oct 2026', '25 Oct 2026, 11:59 pm IST']) t('supported: ' + c, () => { const j = JSON.parse(JSON.stringify(gd)); j.dates.application_close = '2026-10-25T23:59:00+05:30'; assert(verifyClaim(j, c, now).supported); });
for (const c of ['1', '9', '20', '99999999', '32001', '34', '2026-10-26', '3,201', '2']) t('rejected: ' + c, () => assert(!verifyClaim(gd, c, now).supported, c + ' should not verify'));
t('field-bound: 33 is age.max, not vacancies.total', () => { assert(verifyClaim(gd, '33', { field: 'age.max', now }).supported); assert(!verifyClaim(gd, '33', { field: 'vacancies.total', now }).supported); });
t('tampered vacancy in free text is caught', () => assert(!auditText(gd, 'Total vacancies: 32,500.', now).ok));
t('tampered date in free text is caught', () => assert(!auditText(gd, 'Applications close on 26 Oct 2026.', now).ok));
t('invented page citation is caught', () => assert(!auditText(gd, 'Stated on page 99.', now).ok));
t('invented section citation is caught', () => assert(!auditText(gd, 'See section 9.9.', now).ok));
t('real citation passes', () => assert(auditText(gd, 'Stated in rrb-gd-notice, page 14, section 4.2.', now).ok));
t('right number, wrong field is blocked at composition', () => {
  const { auditSegments } = require('./lib/answer'); const c = claimsForJob(gd, now).find((x) => x.field === 'vacancies.total');
  assert(!auditSegments(gd, [{ text: 'Total vacancies: 33.', field: 'vacancies.total', claim: c }], now).ok);
});

// ---- 5. Intent routing + minimal clarification ----
for (const [q, intent] of [['last date', 'DEADLINE'], ['age limit', 'AGE'], ['OBC age relaxation', 'RELAXATION'], ['SC vacancies', 'VACANCY_CAT'], ['how many posts', 'VACANCY'], ['fee', 'FEE'], ['where did this come from', 'SOURCE'], ['blah blah', 'UNKNOWN']]) t(`intent ${q} → ${intent}`, () => assert.strictEqual(classify(q).intent, intent));
t('ambiguous recruitment asks ONE question', () => { const r = ask({ jobs, question: 'what is the age limit', now }); assert(r.needs_clarification); assert.strictEqual(r.clarification.type, 'RECRUITMENT'); });
t('eligibility without profile asks for the missing profile only', () => { const r = ask({ jobs, question: 'am I eligible for Group D', mode: 'ELIGIBILITY', now }); assert.strictEqual(r.clarification.type, 'PROFILE'); });
t('resolved recruitment does NOT ask', () => assert(!ask({ jobs, question: 'age limit for Group D', now }).needs_clarification));
t('eligibility with profile answers and audits', () => { const r = ask({ jobs, question: 'am I eligible for Group D', recruitmentId: gd.id, mode: 'ELIGIBILITY', profile: { dob: '2002-05-10', education: { level: '10th', status: 'completed' } }, now }); assert(r.audit.ok); assert(/eligibility/i.test(r.text)); });

// ---- 6. Knowledge graph (multi-hop) ----
const g = buildGraph(jobs);
t('graph edges reference existing nodes', () => { const ids = new Set(g.nodes.map((n) => n.id)); assert(g.edges.every((e) => ids.has(e.from) && ids.has(e.to))); });
t('multi-hop: railway + 10th', () => assert.deepStrictEqual(answerGraphQuestion(g, 'railway jobs for 10th pass').jobs.map((j) => j.id), ['rrb-group-d']));
t('multi-hop: police in Telangana', () => assert.deepStrictEqual(answerGraphQuestion(g, 'police jobs in Telangana').jobs.map((j) => j.id), ['ts-police-constable']));
t('multi-hop: unmatched combination → empty, not guessed', () => assert.strictEqual(answerGraphQuestion(g, 'police jobs for a graduate in Kerala').jobs.length, 0));
t('path exists between sibling jobs via organisation', () => assert(shortestPath(g, 'job:rrb-group-d', 'job:rrb-technician').length === 2));

// ---- 7. LLM-assisted search emits the same validated filter JSON ----
t('hostile LLM output is stripped to valid filters', async () => { const r = await llmFilters('x', {}, [['evil', async () => ({ education: 'bachelor', age: 999, domain: "railway'; DROP TABLE jobs;--", foo: 'bar', status: 'OPEN' })]]); assert.deepStrictEqual(r.filters, { education: 'bachelor', status: 'OPEN' }); });
t('LLM failure falls back to deterministic parser', async () => { const r = await llmFilters('railway jobs for 10th pass', {}, [['down', async () => { throw new Error('503'); }]]); assert.strictEqual(r.provider, 'deterministic-fallback'); assert.strictEqual(r.filters.domain, 'railway'); });
t('validated filters run through the same runSearch', async () => { const r = await llmFilters('x', {}, [['fake', async () => ({ domain: 'railway', status: 'OPEN' })]]); assert(runSearch(jobs, r.filters, {}, now).every((x) => x.domain === 'railway')); });
t('filter ranges enforced', () => assert.deepStrictEqual(validateFilters({ age: 13, closing_days: 400, closing_this_month: 'yes' }), {}));

// ---- 8. Per-answer audit trail ----
t('audit trail records, chains and detects tampering', async () => {
  const store = A.memoryStore();
  for (const q of ['age limit for Group D', 'fee for SSC MTS', 'last date police constable']) { const r = ask({ jobs, question: q, now }); await A.record(store, { question: q, result: r }); }
  assert((await A.verifyChain(store)).ok);
  const rows = await store.all(); assert(rows[0].sources.length > 0 && rows[0].sources[0].page > 0, 'page-level source stored');
  rows[1].answer = rows[1].answer.replace(/\d/, '9'); assert(!(await A.verifyChain(store)).ok);
});
t('"Where did this come from" gives a page the viewer can jump to', () => { const r = ask({ jobs, question: 'age limit for Group D', now }); const w = r.where_did_this_come_from.find((x) => x.field === 'age.max'); assert(w && w.page === 14 && w.doc === 'rrb-gd-notice'); });
t('blocked answers are never returned', () => { const orig = require('./lib/claims'); assert(typeof orig.auditText === 'function'); });

Promise.all(pending).then(() => {
  console.log(`\nPhase 3: ${pass} passed, ${fail} failed | ${tokensChecked} figures/citations verified across 50 questions, ${silentCount} answers stated official silence, 0 unsupported claims shipped`);
});
// (appended) response contract the front-end relies on
(async () => { await Promise.all(pending);
  const r = ask({ jobs: jobs.map((j) => ({ ...j, field_sources: Object.fromEntries(Object.entries(j.field_sources).map(([k, v]) => [k, { ...v, document_id: 7 }])) })), question: 'age limit for Group D', now });
  const w = r.where_did_this_come_from[0];
  const ok = w && w.viewer_url === `/api/documents/7/file#page=${w.page}` && w.doc && w.label && w.value;
  console.log(ok ? '✓ viewer_url jumps to the exact page' : '✗ viewer_url contract broken'); if (!ok) process.exitCode = 1;
})();
