'use strict';
// Bridge tests. No database, no browser and no npm packages needed:
//   * pure engine rules (taxonomy, resume parser, evidence, requirements, matcher)
//   * the two-sided Campus link with a fake Prisma
//   * the API handlers with a fake store / fake Campus client
//   * the real standalone runtime over HTTP
//   * static wiring checks (routes, migration, proxy prefix, UI, service worker)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const T = require('./lib/bridge/taxonomy');
const { parseResume } = require('./lib/bridge/resumeParser');
const E = require('./lib/bridge/evidence');
const R = require('./lib/bridge/requirements');
const M = require('./lib/bridge/matcher');
const S = require('./lib/bridge/service');
const SA = require('./lib/bridge/serviceAuth');
const { createApi } = require('./lib/bridge/api');
const campusClient = require('./lib/bridge/campusClient');
const source = require('./campus/backend/src/services/bridgeSource');
const { buildJobs } = require('./data/jobs');
const runtime = require('./lib/runtime');

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const NOW = new Date();
const jobs = buildJobs(NOW).filter((j) => j.lifecycle !== 'REVIEW_REQUIRED' && j.verification && j.verification.status === 'VERIFIED');
const exams = runtime.exams();
const syl = Object.fromEntries(exams.map((e) => [e.version_id, runtime.syllabus(e.version_id)]));
const grad = { education: { level: 'bachelor', status: 'completed', field: 'engineering' }, dob: '2000-05-10', state: 'Telangana', category: 'OBC' };
const job = (id) => jobs.find((j) => j.id === id);
const match = (extra = {}) => M.matchJobs({ jobs, profile: grad, skills: {}, now: NOW, exams, syllabusByVersion: syl, ...extra });

const campusExport = (over = {}) => ({
  schema: 'bridge-source/1', generated_at: NOW.toISOString(),
  user: { id: 'u-1', name: 'Asha', email: 'asha@campus.test', role: 'STUDENT' },
  aptitude: { stats: { attempted: 140, correct: 110 }, topics: [
    { group: 'Arithmetical Ability', topic: 'Percentage', attempted: 80, correct: 66 },
    { group: 'Arithmetical Ability', topic: 'Time and Work', attempted: 40, correct: 30 },
    { group: 'Logical Reasoning', topic: 'Syllogism', attempted: 30, correct: 26 },
    { group: 'Verbal Ability', topic: 'Synonyms', attempted: 25, correct: 18 },
  ] },
  competencies: [{ skillName: 'Python', category: 'Python', pKnow: 0.85, questionsAnswered: 25, masteryStatus: 'Approaching Mastery' }],
  results: [{ type: 'INTERVIEW', topic: 'Software Engineer', summaryScore: 72, createdAt: NOW.toISOString() }],
  resume_skills: ['Python', 'SQL'], ...over,
});

// ---------------------------------------------------------------- taxonomy & parser
test('taxonomy: every skill has a label, group and a safe alias matcher', () => {
  for (const id of T.IDS) { assert(T.SKILLS[id].label && T.GROUPS[T.SKILLS[id].group], id); }
  assert(T.aliasRegex('c++').test('Skills: C++, Java'));
  assert(T.aliasRegex('node.js').test('uses node.js daily'));
  assert(!T.aliasRegex('sql').test('mysqlx'));
  assert(T.aliasRegex('data structures').test('Data   Structures'));
});
test('resume parser: finds skills as claims, never DOB/category/domicile', () => {
  const r = parseResume('Ravi Kumar\nDOB: 01-01-1999  Category: SC  Domicile: Telangana\nB.Tech in Electronics (pursuing)\nSkills: Python, SQL, MS Excel, typing speed 42 wpm');
  assert(r.ok && r.skills.some((s) => s.skill === 'it_programming'));
  assert.strictEqual(r.typing_wpm, 42);
  const dump = JSON.stringify(r);
  assert(!/1999|Telangana|"SC"/.test(dump.replace(/"evidence":"[^"]*"/g, '')), 'no personal eligibility fields extracted');
  assert(r.education_suggestion && r.education_suggestion.needs_confirmation === true);
  assert.strictEqual(r.education_suggestion.status, 'final_year');
});
test('resume parser: everyday words are not mistaken for degrees', () => {
  const r = parseResume('We should be happy to meet. Please be on time, ma is nice, bring documents and everything needed for the day.');
  assert.strictEqual(r.education_suggestion, null);
});
test('resume parser: too-short input is rejected, long input is truncated with a warning', () => {
  assert.strictEqual(parseResume('hi').ok, false);
  const long = parseResume('python '.repeat(30000));
  assert(long.ok && long.warnings.some((w) => /first/.test(w)));
});

// ---------------------------------------------------------------- evidence
test('evidence: aptitude uses a prior so 3/3 is not treated as mastery', () => {
  const small = E.aggregate(E.fromAptitude([{ group: 'Arithmetical Ability', topic: 'Percentage', attempted: 3, correct: 3 }]).items).quant;
  const big = E.aggregate(E.fromAptitude([{ group: 'Arithmetical Ability', topic: 'Percentage', attempted: 100, correct: 90 }]).items).quant;
  assert(small.level < 0.8 && big.level > 0.85, `${small.level} ${big.level}`);
  assert(small.confidence < big.confidence);
});
test('evidence: resume and self claims can never be reported as verified', () => {
  const skills = E.aggregate([...E.fromResume({ skills: [{ skill: 'quant', level_hint: 0.7, terms: ['maths'] }] }), ...E.fromSelf({ quant: 'strong' })]);
  assert.strictEqual(skills.quant.verified, false);
  assert.strictEqual(skills.quant.tested, false);
});
test('evidence: a strong resume claim cannot overwrite weak tested evidence', () => {
  const tested = E.fromAptitude([{ group: 'Arithmetical Ability', topic: 'Percentage', attempted: 60, correct: 12 }]).items;
  const claim = E.fromSelf({ quant: 'strong' });
  const s = E.aggregate([...tested, ...claim]).quant;
  assert(s.level < 0.4, `level stayed low: ${s.level}`);
  assert.strictEqual(s.verified, true);
});
test('evidence: tested programming implies computer proficiency but only as unverified inference', () => {
  const s = E.aggregate(E.fromCompetencies([{ skillName: 'Python', category: 'Python', pKnow: 0.9, questionsAnswered: 20 }]));
  assert(s.it_programming.verified && s.computer_basics && !s.computer_basics.verified);
});
test('evidence: Campus results map to interview skills; unrelated types are ignored', () => {
  const items = E.fromResults([{ type: 'INTERVIEW', summaryScore: 80 }, { type: 'ROADMAP', summaryScore: 99 }]);
  assert.strictEqual(items.length, 1); assert.strictEqual(items[0].skill, 'interview_skills');
});
test('evidence: syllabus progress is unverified preparation; mock answers are verified', () => {
  const prog = E.fromSyllabusProgress([{ title: 'Quantitative Aptitude', description: 'Arithmetic', progress_pct: 80 }], (r) => R.skillsForNode(r));
  assert(prog.length && prog.every((i) => i.verified === false));
  const mock = E.fromMockReviews([{ label: 'Verified syllabus: CGL-QA', result: 'CORRECT' }, { label: 'Verified syllabus: CGL-QA', result: 'WRONG' }, { label: 'x', result: 'UNANSWERED' }], (l) => (/CGL-QA/.test(l) ? [['quant', 1]] : []));
  assert(mock.length === 1 && mock[0].verified === true);
});

// ---------------------------------------------------------------- requirements
test('requirements: verified syllabus makes requirements STATED', () => {
  const ex = exams.find((e) => e.code === 'SSC-CGL');
  const r = R.deriveRequirements(job('ssc-combined-graduate'), { exams, syllabusNodes: syl[ex.version_id] });
  assert(r.requirements.length >= 4 && r.requirements.every((x) => x.kind === 'STATED'));
  assert(Math.abs(r.requirements.reduce((s, x) => s + x.weight, 0) - 1) < 0.02);
  assert(r.exam && r.exam.code === 'SSC-CGL');
});
test('requirements: typing test and steno are INFERRED and labelled', () => {
  const steno = R.deriveRequirements(job('ssc-stenographer'), {});
  const kinds = Object.fromEntries(steno.requirements.map((x) => [x.skill, x.kind]));
  assert.strictEqual(kinds.stenography, 'INFERRED'); assert.strictEqual(kinds.typing, 'INFERRED');
  const ja = R.deriveRequirements(job('ts-junior-assistant'), {});
  assert(ja.requirements.some((x) => x.skill === 'typing'));
});
test('requirements: physical standards are a checkpoint, never a scored skill', () => {
  const r = R.deriveRequirements(job('rrb-group-d'), {});
  assert(r.checkpoints.some((c) => c.key === 'physical'));
  assert(!r.requirements.some((x) => x.skill === 'physical_fitness'));
});
test('requirements: required subjects in the notification are STATED', () => {
  const r = R.deriveRequirements(job('postal-gds'), {});
  assert(r.requirements.some((x) => x.skill === 'quant' && x.kind === 'STATED'));
  assert(r.requirements.some((x) => x.skill === 'english' && x.kind === 'STATED'));
});
test('requirements: merit-based posts say so instead of inventing exam sections', () => {
  const r = R.deriveRequirements(job('postal-gds'), {});
  assert(r.notes.some((n) => /merit/i.test(n)));
});

// ---------------------------------------------------------------- matcher
test('matcher: eligibility is a hard gate — strong skills never make a not-eligible post a match', () => {
  const strong = Object.fromEntries(T.IDS.map((id) => [id, { skill: id, label: id, group: 'EXAM', level: 0.95, confidence: 1, verified: true, tested: true, sources: [] }]));
  const r = match({ skills: strong });
  const ra = r.not_eligible.find((m) => m.id === 'research-associate');
  assert(ra, 'research associate is not eligible for a bachelor');
  assert(!r.matches.some((m) => m.id === 'research-associate'));
  assert.strictEqual(ra.action.code, 'NOT_ELIGIBLE');
});
test('matcher: closed applications are excluded from matches', () => {
  const r = match();
  assert(!r.matches.some((m) => m.deadline.status === 'CLOSED'));
});
test('matcher: unverified draft recruitments are never considered', () => {
  const all = buildJobs(NOW);
  const r = M.matchJobs({ jobs: all.filter((j) => j.lifecycle !== 'REVIEW_REQUIRED'), profile: grad, skills: {}, now: NOW, exams, syllabusByVersion: syl });
  assert(![...r.matches, ...r.not_eligible, ...r.closed].some((m) => m.id === 'draft-unverified'));
});
test('matcher: both spellings of the ex-serviceman flag reach the eligibility engine', () => {
  assert.strictEqual(M.normaliseProfile({ exServiceman: true }).exServicemen, true);
});
test('matcher: more evidence never lowers a job score (monotonic)', () => {
  const low = E.aggregate(E.fromSelf({ quant: 'basic', reasoning: 'basic', english: 'basic' }));
  const high = E.aggregate(E.fromSelf({ quant: 'strong', reasoning: 'strong', english: 'strong' }));
  const a = match({ skills: low }), b = match({ skills: high });
  for (const m of a.matches) { const n = b.matches.find((x) => x.id === m.id); assert(n.fit.score >= m.fit.score - 1e-9, m.id); }
});
test('matcher: low confidence widens the plausible range; tested evidence narrows it', () => {
  const claim = E.aggregate(E.fromSelf({ quant: 'working', reasoning: 'working', english: 'working' }));
  const tested = E.aggregate(E.fromAptitude([
    { group: 'Arithmetical Ability', topic: 'Percentage', attempted: 120, correct: 84 }, { group: 'Logical Reasoning', topic: 'Syllogism', attempted: 120, correct: 84 }, { group: 'Verbal Ability', topic: 'Synonyms', attempted: 120, correct: 84 }]).items);
  const w = (sk) => { const m = match({ skills: sk }).matches.find((x) => x.id === 'ssc-mts'); return m.fit.high - m.fit.low; };
  assert(w(claim) > w(tested), `${w(claim)} vs ${w(tested)}`);
});
test('matcher: no evidence is not the same as zero — unknown skills use a stated prior', () => {
  const r = match();
  const m = r.matches.find((x) => x.id === 'ssc-mts');
  assert(m.fit.coverage.every((c) => c.level === null && c.status === 'UNKNOWN'));
  assert(m.fit.score > 0 && m.fit.score < 60);
});
test('matcher: readiness uses the notified exam date; assumed window is labelled', () => {
  const r = match({ skills: {} });
  const withDate = r.matches.find((x) => x.id === 'rrb-group-d');
  assert.strictEqual(withDate.readiness.window_basis, 'EXAM_DATE');
  const noDate = r.matches.find((x) => !job(x.id).dates.exam_date);
  assert(noDate, 'demo data has a post without an exam date');
  assert.strictEqual(noDate.readiness.window_basis, 'ASSUMED_AFTER_CLOSE'); assert(/assumed/i.test(noDate.readiness.window_note));
});
test('matcher: less study time never improves feasibility', () => {
  const a = match({ options: { dailyMinutes: 30 } }), b = match({ options: { dailyMinutes: 240 } });
  for (const m of a.matches) assert(b.matches.find((x) => x.id === m.id).readiness.feasibility >= m.readiness.feasibility);
});
test('matcher: unknown eligibility is surfaced as profile asks, not guessed', () => {
  const r = M.matchJobs({ jobs, profile: {}, skills: {}, now: NOW, exams, syllabusByVersion: syl });
  assert(r.matches.every((m) => m.eligibility.overall === 'UNKNOWN' ? m.action.code === 'COMPLETE_PROFILE' || m.deadline.status === 'UPCOMING' : true));
  assert(r.profile_asks.length > 0 && r.summary.eligibility_complete === false);
});
test('matcher: text affinity ranks relevant resume text higher and is relative', () => {
  const a = M.tfidfAffinity('Electrical engineering diploma with transformers, power systems and switchgear maintenance experience in a substation.', ['Technician Grade III railway electrical engineering maintenance', 'Gramin Dak Sevak postal delivery mathematics english']);
  assert(a[0] > a[1] && Math.max(...a) === 1);
  assert.strictEqual(M.tfidfAffinity('short', ['x']), null);
});
test('gap analysis: ranks by impact per study hour and lists concrete actions', () => {
  const prof = E.buildSkillProfile({ aptitude: E.fromAptitude(campusExport().aptitude.topics) });
  const r = match({ skills: prof.skills });
  const g = M.gapAnalysis(r, prof.skills, syl);
  assert(g.skills.length >= 1);
  for (let i = 1; i < g.skills.length; i++) assert(g.skills[i - 1].impact_per_50h >= g.skills[i].impact_per_50h);
  assert(g.skills.every((s) => s.actions.length >= 1));
  assert(g.plan.blocks.every((b) => b.minutes_per_day >= 15));
});
test('what-if: raising a skill only moves scores upward', () => {
  const base = { profile: grad, jobs, exams, syllabusByVersion: syl, campus: null, gov: null, now: NOW };
  const out = S.runAnalysis({ ...base, input: S.sanitizeInput({ profile: grad, self: { quant: 'basic' }, raise: { gk: 0.8 } }, NOW) });
  assert(out.what_if && out.what_if.movements.length >= 1);
  assert(out.what_if.movements.every((m) => (m.delta == null ? true : m.delta >= -1e-9)));
});
test('explainJob: separates strengths from gaps and says when a resume barely matters', () => {
  const r = match({ skills: E.aggregate(E.fromSelf({ typing: 'strong' })), includeClosed: true });
  const m = r.matches.find((x) => x.id === 'ts-junior-assistant');
  const x = M.explainJob ? require('./lib/bridge/matcher').explainJob(m, { skills: {}, syllabusByVersion: syl }) : null;
  assert(x.gaps.length >= 1 && x.resume && /official form|resume/i.test(x.resume.note));
});

// ---------------------------------------------------------------- input sanitising
test('sanitize: invalid profile fields are dropped, valid ones kept', () => {
  const p = S.sanitizeProfile({ education: { level: 'wizard' }, dob: '1850-01-01', state: 'Atlantis', category: 'ZZ', experienceYears: 999 }, NOW);
  assert(!p.education && !p.dob && !p.state && !p.category);
  assert.strictEqual(p.experienceYears, 50);
  const q = S.sanitizeProfile(grad, NOW);
  assert.deepStrictEqual(q.education, grad.education); assert.strictEqual(q.dob, grad.dob);
});
test('sanitize: bad numbers and types are rejected with a 400', () => {
  assert.throws(() => S.sanitizeInput({ daily_minutes: 5 }), (e) => e.status === 400);
  assert.throws(() => S.sanitizeInput({ typing_wpm: 'fast' }), (e) => e.status === 400);
  assert.throws(() => S.sanitizeInput({ resume_text: { a: 1 } }), (e) => e.status === 400);
});
test('sanitize: unknown skills, selfCheck skills and out-of-range values are ignored', () => {
  assert.deepStrictEqual(S.sanitizeSelf({ quant: 'strong', hacker: 'strong', physical_fitness: 'strong', english: 'galactic', gk: 2 }), { quant: 'strong' });
  assert.deepStrictEqual(S.sanitizeRaise({ gk: 5, nope: 0.4, quant: -1 }), { gk: 0.95, quant: 0 });
});
test('resume_exclude removes unticked claims from the evidence', () => {
  const input = S.sanitizeInput({ resume_text: 'Skills: Python, SQL, MS Excel, typing 40 wpm and plenty of other words here', resume_exclude: ['it_programming'] }, NOW);
  const { batches } = S.buildEvidence({ input, campus: null, gov: null });
  assert(!batches.resume.some((i) => i.skill === 'it_programming') && batches.resume.some((i) => i.skill === 'it_data'));
});

// ---------------------------------------------------------------- service signature
const SECRET = 'a'.repeat(40);
test('serviceAuth: valid signature passes; tampering with any bound field fails', () => {
  const parts = { method: 'POST', path: '/api/bridge-source/link', accountId: '12', userId: 'u-1', body: '{"consent_version":"v1"}' };
  const h = SA.headersFor(SECRET, parts);
  assert(SA.verify(SECRET, parts, h).ok);
  for (const k of [['accountId', '13'], ['userId', 'u-2'], ['path', '/api/bridge-source/profile'], ['method', 'GET'], ['body', '{"consent_version":"v2"}']]) {
    const r = SA.verify(SECRET, { ...parts, [k[0]]: k[1] }, h); assert(!r.ok && r.code === 'BRIDGE_BAD_SIGNATURE', k[0]);
  }
  assert(!SA.verify('b'.repeat(40), parts, h).ok);
});
test('serviceAuth: stale timestamps, missing signature and short secrets are refused', () => {
  const parts = { method: 'GET', path: '/p', accountId: '1', userId: 'u', body: '' };
  const h = SA.headersFor(SECRET, parts);
  assert.strictEqual(SA.verify(SECRET, parts, h, Date.now() + 10 * 60 * 1000).code, 'BRIDGE_STALE');
  assert.strictEqual(SA.verify(SECRET, parts, { ...h, 'x-bridge-signature': '' }).ok, false);
  assert.strictEqual(SA.verify('short', parts, h).code, 'BRIDGE_NOT_CONFIGURED');
  assert.strictEqual(SA.verify('', parts, h).code, 'BRIDGE_NOT_CONFIGURED');
});
test('campus client: cookie parsing and unverified subject decode', () => {
  assert.strictEqual(campusClient.cookieValue('a=1; cp_access=abc.def.ghi; b=2', 'cp_access'), 'abc.def.ghi');
  assert.strictEqual(campusClient.cookieValue('a=1', 'cp_access'), null);
  const tok = 'x.' + Buffer.from(JSON.stringify({ sub: 'u-9' })).toString('base64url') + '.y';
  assert.strictEqual(campusClient.subjectOf(tok), 'u-9');
  assert.strictEqual(campusClient.subjectOf('garbage'), null);
});

// ---------------------------------------------------------------- Campus side with a fake Prisma
function fakePrisma() {
  const kv = new Map(); let id = 1;
  const users = { 'u-1': { id: 'u-1', name: 'Asha', email: 'asha@campus.test', role: 'STUDENT', branch: 'ECE', graduationYear: 2026, passwordHash: 'SECRET-HASH', faceDescriptor: [1, 2, 3], fingerprintCredentialId: 'fp-1' }, 'u-2': { id: 'u-2', name: 'Bo', email: 'bo@campus.test', role: 'STUDENT' } };
  const k = (w) => `${w.scope}|${w.key}|${w.ownerId}`;
  return {
    portalKV: {
      findFirst: async ({ where }) => kv.get(k(where)) || null,
      upsert: async ({ where, update, create }) => { const key = k(where.scope_key_ownerId); const cur = kv.get(key); if (cur) { cur.value = update.value; return cur; } const row = { id: id++, value: create.value }; kv.set(key, row); return row; },
      update: async ({ where, data }) => { for (const r of kv.values()) if (r.id === where.id) { r.value = data.value; return r; } },
    },
    user: { findUnique: async ({ where }) => users[where.id] || null },
    aptitudeAttempt: { groupBy: async ({ where }) => (where.correct ? [{ qGroup: 'Logical Reasoning', topic: 'Syllogism', _count: { _all: 20 } }] : [{ qGroup: 'Logical Reasoning', topic: 'Syllogism', _count: { _all: 30 } }]) },
    studentCompetency: { findMany: async () => [{ skill: { name: 'Python', category: 'Python' }, pKnow: 0.8, level: 'Advanced', masteryStatus: 'Approaching Mastery', questionsAnswered: 12, lastPracticedAt: null }] },
    result: { findMany: async () => [{ type: 'RESUME_ANALYSIS', topic: null, summaryScore: 70, createdAt: NOW, payload: { skills: ['Python', { name: 'SQL' }], secretTranscript: 'DO-NOT-LEAK' } }, { type: 'INTERVIEW', topic: 'SDE', summaryScore: 66, createdAt: NOW, payload: { transcript: 'DO-NOT-LEAK' } }] },
  };
}
test('campus source: no data is released before the student links, and consent_version is required', async () => {
  const prisma = fakePrisma();
  assert.strictEqual((await source.profile({ prisma, userId: 'u-1', accountId: '5' })).status, 403);
  assert.strictEqual((await source.link({ prisma, userId: 'u-1', accountId: '5', body: {} })).status, 400);
  assert.strictEqual((await source.link({ prisma, userId: 'u-1', accountId: 'abc', body: { consent_version: 'v1' } })).status, 400);
});
test('campus source: link, export minimal profile, then revoke stops the flow', async () => {
  const prisma = fakePrisma();
  const l = await source.link({ prisma, userId: 'u-1', accountId: '5', body: { consent_version: '2026-10' } });
  assert.strictEqual(l.status, 201); assert.strictEqual(l.body.campus_user.id, 'u-1');
  const p = await source.profile({ prisma, userId: 'u-1', accountId: '5' });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.body.schema, 'bridge-source/1');
  assert.deepStrictEqual(p.body.resume_skills.sort(), ['Python', 'SQL']);
  const dump = JSON.stringify(p.body);
  for (const leak of ['SECRET-HASH', 'faceDescriptor', 'fp-1', 'DO-NOT-LEAK', 'passwordHash', 'fingerprint']) assert(!dump.includes(leak), 'must not export ' + leak);
  assert.strictEqual(p.body.aptitude.topics[0].correct, 20);
  const u = await source.unlink({ prisma, userId: 'u-1' });
  assert.strictEqual(u.body.linked, false);
  assert.strictEqual((await source.profile({ prisma, userId: 'u-1', accountId: '5' })).status, 403);
});
test('campus source: a different GovCareer account cannot read, and cannot steal an active link', async () => {
  const prisma = fakePrisma();
  await source.link({ prisma, userId: 'u-1', accountId: '5', body: { consent_version: 'v' } });
  const mismatch = await source.profile({ prisma, userId: 'u-1', accountId: '6' });
  assert.strictEqual(mismatch.status, 403); assert.strictEqual(mismatch.body.code, 'BRIDGE_ACCOUNT_MISMATCH');
  const steal = await source.link({ prisma, userId: 'u-1', accountId: '6', body: { consent_version: 'v' } });
  assert.strictEqual(steal.status, 409); assert.strictEqual(steal.body.code, 'CAMPUS_ALREADY_LINKED');
  await source.unlink({ prisma, userId: 'u-1' });
  assert.strictEqual((await source.link({ prisma, userId: 'u-1', accountId: '6', body: { consent_version: 'v' } })).status, 201);
});
test('campus source: service signature is bound to the authenticated Campus user', () => {
  const parts = { method: 'GET', path: '/api/bridge-source/profile', accountId: '5', userId: 'u-1', body: '' };
  const h = SA.headersFor(SECRET, parts);
  assert(source.checkService({ secret: SECRET, ...parts, body: null, headers: h }).ok);
  assert(!source.checkService({ secret: SECRET, ...parts, userId: 'u-2', body: null, headers: h }).ok, 'token of another student with a copied signature');
  assert(!source.checkService({ secret: '', ...parts, body: null, headers: h }).ok, 'unconfigured secret refuses everything');
});

// ---------------------------------------------------------------- API handlers with fakes
function fakeStore() {
  const s = { link: null, settings: { self_skills: {}, typing_wpm: null, daily_minutes: 120, resume_claims: [], updated_at: null }, cache: null, snaps: [], failSave: null };
  return Object.assign(s, {
    getLink: async () => s.link,
    saveLink: async (id, v) => { if (s.failSave) throw s.failSave; s.link = { account_id: id, campus_user_id: v.campusUserId, campus_email: v.email, campus_name: v.name, consent_version: v.consentVersion, linked_at: new Date(), revoked_at: null }; return s.link; },
    revokeLink: async () => { if (s.link) s.link.revoked_at = new Date(); s.cache = null; },
    getSettings: async () => s.settings, putSettings: async (_id, v) => { s.settings = { ...v, updated_at: new Date() }; return s.settings; },
    getCampusCache: async () => s.cache, putCampusCache: async (_id, ev) => { s.cache = { evidence: ev, fetched_at: new Date() }; },
    saveSnapshot: async (_id, summary, top) => { s.snaps.push({ id: s.snaps.length + 1, summary, top, created_at: new Date() }); },
    listSnapshots: async () => s.snaps,
    govcareerEvidence: async () => ({ progress: [{ code: 'CGL-QA', title: 'Quantitative Aptitude', description: 'Arithmetic', progress_pct: 50 }], reviews: [{ label: 'Verified syllabus: CGL-QA', result: 'CORRECT' }, { label: 'Verified syllabus: CGL-QA', result: 'CORRECT' }, { label: 'Verified syllabus: CGL-QA', result: 'WRONG' }] }),
  });
}
function fakeCampus(script) {
  const calls = [];
  return Object.assign({ calls, classify: campusClient.classify,
    link: async (a) => { calls.push(['link', a]); return script.link ? script.link(a) : { status: 201, body: { campus_user: { id: 'u-1', name: 'Asha', email: 'asha@campus.test' } } }; },
    unlink: async (a) => { calls.push(['unlink', a]); return script.unlink ? script.unlink(a) : { status: 200, body: { linked: false } }; },
    profile: async (a) => { calls.push(['profile', a]); return script.profile ? script.profile(a) : { status: 200, body: campusExport() }; } });
}
const mkApi = (store, campus) => createApi({ jobs: () => jobs, exams: () => exams, syllabus: (id) => syl[id] || [], store, campus, consentVersion: () => '2026-10', audit: async () => {}, privacyEvent: async () => {}, now: () => NOW });
const acct = { id: '5', email: 'a@b.test', name: 'Asha' };

test('api: demo runtime (no store) analyses resume + self-assessment and says accounts are required for Campus', async () => {
  const api = mkApi(null, null);
  const r = await api.analyze({ body: { profile: grad, self: { english: 'working' }, resume_text: 'Skills: Python, SQL, MS Excel, typing speed 38 wpm. Presentation at symposium.' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.mode, 'DEMO'); assert.strictEqual(r.body.sources.campus.state, 'ACCOUNT_REQUIRED');
  assert.strictEqual(r.body.sources.resume.stored, false);
  assert(r.body.result.matches.length > 3);
  assert.strictEqual((await api.link({ account: acct, body: { consent: true }, cookies: '' })).status, 503);
});
test('api: invalid input is a 400 and nothing is analysed', async () => {
  const api = mkApi(null, null);
  await assert.rejects(() => api.analyze({ body: { daily_minutes: 1 } }), (e) => e.status === 400);
  assert.strictEqual((await api.parseResume({ body: {} })).status, 400);
  assert.strictEqual((await api.explain({ params: { id: 'nope' }, body: {} })).status, 404);
});
test('api: link requires explicit consent and a Campus session', async () => {
  const store = fakeStore(); const campus = fakeCampus({});
  const api = mkApi(store, campus);
  assert.strictEqual((await api.link({ account: acct, body: {}, cookies: 'cp_access=t' })).body.code, 'CONSENT_REQUIRED');
  assert.strictEqual(campus.calls.length, 0, 'Campus is not contacted without consent');
  const noSession = fakeCampus({ link: async () => ({ status: 401, body: { code: 'CAMPUS_SESSION_REQUIRED' } }) });
  const r = await mkApi(fakeStore(), noSession).link({ account: acct, body: { consent: true }, cookies: '' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'CAMPUS_SESSION_REQUIRED');
});
test('api: link, live Campus evidence becomes TESTED skills, cache is written', async () => {
  const store = fakeStore(); const campus = fakeCampus({}); const api = mkApi(store, campus);
  const l = await api.link({ account: acct, body: { consent: true }, cookies: 'cp_access=tok' });
  assert.strictEqual(l.status, 200); assert.strictEqual(l.body.linked, true);
  assert.deepStrictEqual(campus.calls[0][1], { token: 'tok', accountId: '5', consentVersion: '2026-10' });
  const r = await api.analyze({ account: acct, body: { profile: grad }, cookies: 'cp_access=tok' });
  assert.strictEqual(r.body.sources.campus.state, 'LIVE');
  assert(r.body.skills.quant.tested && r.body.skills.reasoning.tested && r.body.skills.it_programming.verified);
  assert(store.cache, 'cache stored');
  assert(r.body.sources.govcareer.mock_questions_answered === 3, 'Exam Lab evidence included');
});
test('api: expired Campus session falls back to the cached export and says so', async () => {
  const store = fakeStore(); store.link = { account_id: '5', campus_user_id: 'u-1', consent_version: 'v', linked_at: new Date(), revoked_at: null };
  store.cache = { evidence: campusExport(), fetched_at: new Date(Date.now() - 36e5) };
  const campus = fakeCampus({ profile: async () => ({ status: 401, body: { code: 'TOKEN_EXPIRED' } }) });
  const r = await mkApi(store, campus).analyze({ account: acct, body: { profile: grad }, cookies: '' });
  assert.strictEqual(r.body.sources.campus.state, 'CACHED'); assert.strictEqual(r.body.sources.campus.reason, 'CAMPUS_SESSION_REQUIRED');
  assert(r.body.skills.quant.tested);
});
test('api: no cache and no session reports UNAVAILABLE instead of inventing data', async () => {
  const store = fakeStore(); store.link = { account_id: '5', campus_user_id: 'u-1', consent_version: 'v', linked_at: new Date(), revoked_at: null };
  store.govcareerEvidence = async () => ({ progress: [], reviews: [] });
  const campus = fakeCampus({ profile: async () => ({ status: 503, body: {} }) });
  const r = await mkApi(store, campus).analyze({ account: acct, body: { profile: grad, self: { gk: 'basic' } }, cookies: '' });
  assert.strictEqual(r.body.sources.campus.state, 'UNAVAILABLE'); assert(!r.body.skills.quant && !r.body.skills.reasoning, 'nothing invented');
});
test('api: a revocation made on the Campus side is honoured by GovCareer immediately', async () => {
  const store = fakeStore(); store.link = { account_id: '5', campus_user_id: 'u-1', consent_version: 'v', linked_at: new Date(), revoked_at: null };
  store.cache = { evidence: campusExport(), fetched_at: new Date() };
  store.govcareerEvidence = async () => ({ progress: [], reviews: [] });
  const campus = fakeCampus({ profile: async () => ({ status: 403, body: { code: 'BRIDGE_NOT_LINKED', error: 'revoked' } }) });
  const r = await mkApi(store, campus).analyze({ account: acct, body: { profile: grad }, cookies: 'cp_access=t' });
  assert.strictEqual(r.body.sources.campus.state, 'REVOKED_BY_CAMPUS'); assert(store.link.revoked_at && store.cache === null);
  assert(!r.body.skills.reasoning && !r.body.skills.it_programming, 'revoked data is not used');
});
test('api: if saving the link fails after Campus agreed, Campus is rolled back', async () => {
  const store = fakeStore(); store.failSave = Object.assign(new Error('dup'), { code: '23505' });
  const campus = fakeCampus({}); const api = mkApi(store, campus);
  const r = await api.link({ account: acct, body: { consent: true }, cookies: 'cp_access=t' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'CAMPUS_ALREADY_LINKED');
  assert(campus.calls.some((c) => c[0] === 'unlink'));
});
test('api: unlink deletes the cache even when the Campus session is gone', async () => {
  const store = fakeStore(); store.link = { account_id: '5', campus_user_id: 'u-1', consent_version: 'v', linked_at: new Date(), revoked_at: null }; store.cache = { evidence: campusExport(), fetched_at: new Date() };
  const campus = fakeCampus({});
  const r = await mkApi(store, campus).unlink({ account: acct, cookies: '' });
  assert.strictEqual(r.body.linked, false); assert.strictEqual(r.body.campus_revoked, false); assert(/Unlink GovCareer/.test(r.body.note));
  assert(store.link.revoked_at && store.cache === null);
  const r2 = await mkApi(store, campus).unlink({ account: acct, cookies: 'cp_access=t' });
  assert.strictEqual(r2.body.campus_revoked, true);
});
test('api: saved settings are merged under live input; resume text is never stored', async () => {
  const store = fakeStore(); const api = mkApi(store, null);
  await api.putSettings({ account: acct, body: { self: { english: 'strong' }, typing_wpm: 40, daily_minutes: 90, resume_claims: [{ skill: 'it_data', level_hint: 0.5, terms: ['sql'] }], resume_text: 'MUST NOT BE STORED' } });
  assert(!JSON.stringify(store.settings).includes('MUST NOT'));
  const r = await api.analyze({ account: acct, body: { profile: grad, self: { english: 'basic' } }, cookies: '' });
  assert.strictEqual(r.body.skills.english.sources[0].detail.includes('basic'), true, 'live input overrides saved');
  assert(r.body.skills.typing && r.body.skills.it_data, 'saved typing and claims used');
  assert.strictEqual(r.body.daily_minutes, 90);
});
test('api: snapshots are saved only on request and listed back', async () => {
  const store = fakeStore(); const api = mkApi(store, null);
  await api.analyze({ account: acct, body: { profile: grad }, cookies: '' });
  assert.strictEqual(store.snaps.length, 0);
  const r = await api.analyze({ account: acct, body: { profile: grad, save_snapshot: true }, cookies: '' });
  assert.strictEqual(r.body.snapshot_saved, true); assert.strictEqual(store.snaps.length, 1);
  const h = await api.history({ account: acct, query: {} }); assert.strictEqual(h.body.snapshots.length, 1);
});
test('api: export covers every Bridge table', async () => {
  const store = fakeStore(); const out = await mkApi(store, null).exportData('5');
  assert.deepStrictEqual(Object.keys(out).sort(), ['campus_cache', 'link', 'settings', 'snapshots']);
});

// ---------------------------------------------------------------- real standalone runtime over HTTP
test('http: standalone runtime serves Bridge, validates input and keeps accounts unavailable', async () => {
  const port = 3600 + Math.floor(Math.random() * 300);
  const srv = spawn(process.execPath, ['standalone.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 150)); }
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const meta = await (await fetch(base + '/api/bridge/meta')).json();
    assert.strictEqual(meta.mode, 'DEMO'); assert(meta.skills.length >= 20);
    const a = await post('/api/bridge/analyze', { profile: grad, resume_text: 'B.Tech Electronics; Python, SQL, MS Excel; typing speed 38 wpm; presentation at symposium.' });
    const d = await a.json(); assert.strictEqual(a.status, 200); assert(d.result.matches.length > 3);
    assert.strictEqual((await post('/api/bridge/analyze', { daily_minutes: 2 })).status, 400);
    assert.strictEqual((await post('/api/bridge/jobs/nope/explain', {})).status, 404);
    const ex = await (await post('/api/bridge/jobs/ssc-mts/explain', { profile: grad })).json(); assert(ex.job.gaps.length >= 1);
    assert.strictEqual((await fetch(base + '/api/account/bridge/link')).status, 404, 'no accounts in standalone');
    const html = await (await fetch(base + '/')).text(); assert(html.includes('view-bridge') && html.includes('bridge.js'));
  } finally { srv.kill(); }
});


// ---------------------------------------------------------------- client <-> real Campus route file over HTTP
// Express and Prisma are not installed in CI-less environments, so they are stubbed; the Campus route module
// (src/routes/bridgeSource.js), the signing code and the GovCareer client are the real ones.
test('integration: GovCareer client -> real Campus route handlers over HTTP (signatures, binding, revocation)', async () => {
  const http = require('http');
  const Module = require('module');
  const routesFile = path.join(__dirname, 'campus/backend/src/routes/bridgeSource.js');
  const prisma = fakePrisma();
  const handlers = [];
  const stubs = {
    express: { Router: () => { const r = { use() {}, _h: handlers }; for (const m of ['get', 'post', 'delete']) r[m] = (p, ...fns) => handlers.push({ method: m.toUpperCase(), path: p, fns }); return r; } },
    '../db': prisma,
    '../middleware/auth': { requireAuth: () => {} },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (parent && parent.filename === routesFile && stubs[request]) return stubs[request]; return origLoad.apply(this, arguments); };
  process.env.BRIDGE_SERVICE_SECRET = SECRET;
  delete require.cache[routesFile];
  try { require(routesFile); } finally { Module._load = origLoad; }

  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      let sub = null; try { sub = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString()).sub; } catch { /* none */ }
      if (!sub) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"auth"}'); }
      const h = handlers.find((x) => x.method === req.method && '/api/bridge-source' + x.path === req.url.split('?')[0]);
      if (!h) { res.writeHead(404); return res.end('{}'); }
      const rq = { method: req.method, originalUrl: req.url, headers: req.headers, get: (n) => req.headers[n.toLowerCase()], user: { sub }, body: raw ? JSON.parse(raw) : {} };
      const rs = { _s: 200, status(c) { this._s = c; return this; }, json(b) { res.writeHead(this._s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); } };
      let i = 0; const next = async () => { const fn = h.fns[i++]; if (fn) await fn(rq, rs, next); };
      await next();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CAMPUS_HOST = '127.0.0.1'; process.env.CAMPUS_PORT = String(server.address().port); delete process.env.DISABLE_CAMPUS_PORTAL;
  const tok = (sub) => 'h.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.s';
  try {
    assert.strictEqual((await campusClient.profile({ token: tok('u-1'), accountId: '5' })).status, 403, 'not linked yet');
    const l = await campusClient.link({ token: tok('u-1'), accountId: '5', consentVersion: '2026-10' });
    assert.strictEqual(l.status, 201, JSON.stringify(l.body)); assert.strictEqual(l.body.campus_user.email, 'asha@campus.test');
    const p = await campusClient.profile({ token: tok('u-1'), accountId: '5' });
    assert.strictEqual(p.status, 200); assert.strictEqual(p.body.schema, 'bridge-source/1');
    assert.strictEqual((await campusClient.profile({ token: tok('u-1'), accountId: '6' })).body.code, 'BRIDGE_ACCOUNT_MISMATCH');
    // A browser holding only the student's token (no server secret) cannot link or read.
    const forged = await fetch(`http://127.0.0.1:${server.address().port}/api/bridge-source/profile`, { headers: { authorization: 'Bearer ' + tok('u-1'), 'x-bridge-account': '5' } });
    assert.strictEqual(forged.status, 403);
    // A valid signature replayed with another student's token is refused.
    const parts = { method: 'GET', path: '/api/bridge-source/profile', accountId: '5', userId: 'u-1', body: '' };
    const replay = await fetch(`http://127.0.0.1:${server.address().port}/api/bridge-source/profile`, { headers: { authorization: 'Bearer ' + tok('u-2'), 'x-bridge-account': '5', ...SA.headersFor(SECRET, parts) } });
    assert.strictEqual(replay.status, 403);
    assert.strictEqual((await campusClient.unlink({ token: tok('u-1') })).status, 200);
    assert.strictEqual((await campusClient.profile({ token: tok('u-1'), accountId: '5' })).body.code, 'BRIDGE_NOT_LINKED');
    assert.strictEqual((await campusClient.profile({ token: null, accountId: '5' })).body.code, 'CAMPUS_SESSION_REQUIRED');
  } finally { server.close(); delete process.env.CAMPUS_HOST; delete process.env.CAMPUS_PORT; }
});

// ---------------------------------------------------------------- wiring
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
test('wiring: server routes, proxy prefix, signing secret and lifecycle hooks exist', () => {
  const sv = read('server.js');
  for (const r of ["'/api/bridge/meta'", "'/api/bridge/analyze'", "'/api/account/bridge/link'", "'/api/account/bridge/settings'", "'/api/account/bridge/history'", "'/api/account/bridge/analyze'"]) assert(sv.includes(r), r);
  assert(sv.includes("'/api/bridge-source'"), 'proxied to Campus');
  assert(/BRIDGE_SERVICE_SECRET: process\.env\.BRIDGE_SERVICE_SECRET/.test(sv), 'secret reaches the Campus child');
  assert(sv.includes('bridgeApi.exportData(id)') && sv.includes('bridgeStore.revokeLink(req.citizen.id)') && sv.includes('bridgeApi.unlink({account:req.citizen'), 'export / withdraw / delete hooks');
  assert(read('campus/backend/server.js').includes("app.use('/api/bridge-source', bridgeSourceRoutes)"));
});
test('wiring: Campus bridge routes never accept a bare student token for link/profile', () => {
  const r = read('campus/backend/src/routes/bridgeSource.js');
  assert(/router\.post\('\/link', requireService/.test(r) && /router\.get\('\/profile', requireService/.test(r));
  assert(/router\.delete\('\/link', async/.test(r), 'revocation needs no signature');
});
test('wiring: migration is account-scoped, cascades and enforces one active link per Campus student', () => {
  const m = read('db/migrations/008_bridge.sql');
  for (const t of ['bridge_links', 'bridge_settings', 'bridge_campus_cache', 'bridge_snapshots']) assert(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}[\\s\\S]*?ON DELETE CASCADE`).test(m), t);
  assert(/CREATE UNIQUE INDEX[^;]*campus_user_id\)\s*WHERE revoked_at IS NULL/.test(m));
});
test('wiring: UI is CSP-safe (no inline handlers), accessible and cached by the service worker', () => {
  const js = read('public/bridge.js'), html = read('public/index.html'), sw = read('public/sw.js');
  assert(!/\son(click|change|input|load)=/.test(js), 'no inline handlers in generated markup');
  for (const id of ['view-bridge', 'br-run', 'br-panel', 'br-banner']) assert(html.includes(`id="${id}"`), id);
  assert(html.includes('role="tablist"') && html.includes('role="tabpanel"') && html.includes('aria-live'));
  assert(sw.includes('/bridge.js') && sw.includes('/bridge.css') && /govcareer-shell-v(1|2)\d/.test(sw));
  assert(!/localStorage\.setItem\([^)]*resume/i.test(js), 'resume text is not persisted in the browser');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { failed++; console.log('  FAIL', name, '\n      ', e && (e.stack || e.message)); }
  }
  console.log(`\nBridge: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
