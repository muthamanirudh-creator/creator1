'use strict';
// Advanced Strategy Suite API. Stateless: the browser sends its profile and gets analysis back; nothing is stored,
// so it works signed-out and in every runtime. Mirrors lib/bridge/api.js (handlers return {status, body}).
const C = require('./common');
const { evaluate } = require('../eligibility');
const age = require('./age'), planner = require('./planner'), rank = require('./rank'), overlap = require('./overlap');
const studyplan = require('./studyplan'), analytics = require('./analytics'), whatif = require('./whatif'), nextactions = require('./nextactions');

const ok = (body) => ({ status: 200, body: { engine: C.ENGINE_VERSION, generated_at: new Date().toISOString(), ...body } });
const bad = (msg, status = 400) => ({ status, body: { error: msg } });
const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
function profileOf(b) {
  const p = b && b.profile; if (p == null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) return null;
  const o = C.normProfile(p);
  if (o.dob != null && !isYMD(o.dob)) return null;
  return o;
}
function createAdvancedApi({ jobs, exams, syllabus, now = () => new Date() }) {
  async function ctx(b) {
    const profile = profileOf(b); if (profile === null) return { err: bad('Profile is invalid. Date of birth must be YYYY-MM-DD.') };
    const n = now(); const list = await jobs(n);
    return { profile, now: n, jobs: list, today: C.todayYMD(n) };
  }
  const openJobs = (c, onlyEligible) => c.jobs.filter((j) => planner.lifecycle(j, c.today) !== 'CLOSED' && (!onlyEligible || evaluate(j, c.profile).overall !== 'NOT_ELIGIBLE'));
  async function examBundle(codes) {
    const all = await exams(); const out = [];
    for (const e of all) { if (codes && !codes.includes(e.code) && !codes.includes(e.version_id)) continue; const nodes = await syllabus(e.version_id); out.push({ id: e.version_id, code: e.code, name: e.name, pattern: e.pattern, nodes: (nodes || []).map((x) => ({ id: x.id, code: x.code, title: x.title })) }); }
    return out;
  }
  async function meta() { return ok({ modules: ['runway', 'planner', 'rank', 'overlap', 'portfolio', 'study-plan', 'analytics', 'whatif', 'brief', 'next-actions'], default_weights: rank.DEFAULT_WEIGHTS, concepts: Object.keys(overlap.CONCEPTS), limits: { attempts: 5000, topics: 200, jobs: 100 } }); }
  async function runway(b) { const c = await ctx(b); if (c.err) return c.err; if (!c.profile.dob) return bad('Date of birth is needed for the age runway.'); return ok(age.runway(c.jobs, c.profile, c.now)); }
  async function plan(b) {
    const c = await ctx(b); if (c.err) return c.err;
    const ids = Array.isArray(b.job_ids) ? b.job_ids.slice(0, 100) : null;
    const pick = ids ? c.jobs.filter((j) => ids.includes(j.id)) : openJobs(c, true);
    const events = planner.buildEvents(pick, c.today);
    return ok({ today: c.today, jobs_considered: pick.length, events, conflicts: planner.conflicts(events, b.options || {}), weekly: planner.weekly(events, c.today, 12), budget: planner.budget(pick.filter((j) => planner.lifecycle(j, c.today) !== 'CLOSED'), c.profile) });
  }
  async function rankH(b) { const c = await ctx(b); if (c.err) return c.err; const w = b.weights && typeof b.weights === 'object' ? b.weights : {}; return ok(rank.rankJobs(c.jobs, c.profile, { now: c.now, weights: w })); }
  async function overlapH(b) {
    const codes = Array.isArray(b.exams) && b.exams.length ? b.exams.slice(0, 12) : null; const list = await examBundle(codes);
    if (list.length < 2) return bad('Choose at least two verified exams to compare.');
    return ok(overlap.compare(list));
  }
  async function portfolio(b) {
    const c = await ctx(b); if (c.err) return c.err;
    const wh = C.clamp(Number(b.weekly_hours) || 10, 1, 100), hpt = C.clamp(Number(b.hours_per_topic) || 12, 1, 80);
    const ranked = rank.rankJobs(c.jobs, c.profile, { now: c.now, weights: b.weights || {}, skipSensitivity: true }).rows;
    const bundle = await examBundle(null); const byCode = new Map(bundle.map((e) => [e.code, e]));
    return ok(overlap.portfolio({ ranked, jobsById: new Map(c.jobs.map((j) => [j.id, j])), examsByCode: byCode, weeklyHours: wh, hoursPerTopic: hpt, now: c.now }));
  }
  async function studyPlanH(b) {
    if (!isYMD(b.exam_date)) return bad('exam_date must be YYYY-MM-DD.');
    if (b.start_date != null && !isYMD(b.start_date)) return bad('start_date must be YYYY-MM-DD.');
    if (!Array.isArray(b.topics) || b.topics.length > 200) return bad('Provide 1-200 topics.');
    const out = studyplan.plan(b, now()); return out.error ? bad(out.error) : ok(out);
  }
  async function sm2H(b) { if (b.quality == null || !Number.isFinite(+b.quality)) return bad('quality (0-5) is required.'); const s = studyplan.sm2(b.state || {}, b.quality); return ok({ state: s, next_due: C.addDays(C.todayYMD(now()), s.interval) }); }
  async function analyticsH(b) {
    if (!Array.isArray(b.attempts) || !b.attempts.length) return bad('Provide attempts: [{topic, correct, seconds}].');
    if (b.attempts.length > 5000) return bad('Too many attempts (max 5000).');
    return ok(analytics.analyse(b));
  }
  async function whatifH(b) { const c = await ctx(b); if (c.err) return c.err; const sc = Array.isArray(b.scenarios) ? b.scenarios.filter((s) => s && typeof s === 'object' && s.patch && typeof s.patch === 'object').slice(0, 8) : null; return ok(whatif.run(c.jobs, c.profile, sc)); }
  async function brief(b) {
    const c = await ctx(b); if (c.err) return c.err;
    const ranked = rank.rankJobs(c.jobs, c.profile, { now: c.now, weights: b.weights || {} });
    const live = ranked.rows.filter((r) => !r.blocked);
    const pool = openJobs(c, true); const ev = planner.buildEvents(pool, c.today); const conf = planner.conflicts(ev, {});
    const rw = c.profile.dob ? age.runway(c.jobs, c.profile, c.now) : null;
    const closing = pool.filter((j) => { const d = C.closeDate(j); return d && C.daysBetween(c.today, d) <= 7; }).map((j) => ({ job_id: j.id, title: j.title, closes: C.closeDate(j), in_days: C.daysBetween(c.today, C.closeDate(j)) })).sort((x, y) => x.in_days - y.in_days);
    return ok({ today: c.today, profile_ready: !!(c.profile.education && c.profile.education.level && c.profile.dob), kpis: { open_and_possible: live.length, tier_a: live.filter((r) => r.tier === 'A').length, closing_in_7_days: closing.length, conflicts: conf.filter((x) => x.severity !== 'LOW').length, last_chance_age_windows: rw ? rw.summary.last_chance.length : 0 }, top: live.slice(0, 5), closing_soon: closing, conflicts: conf.slice(0, 6), age: rw ? { summary: rw.summary } : null, budget: planner.budget(pool, c.profile) });
  }
  async function nextActionsH(b) {
    const c = await ctx(b); if (c.err) return c.err;
    if (b.attempts != null && !Array.isArray(b.attempts)) return bad('attempts must be an array.');
    if (Array.isArray(b.attempts) && b.attempts.length > 5000) return bad('Too many attempts (max 5000).');
    if (b.applications != null && !Array.isArray(b.applications)) return bad('applications must be an array.');
    if (b.revision_states != null && (typeof b.revision_states !== 'object' || Array.isArray(b.revision_states))) return bad('revision_states must be an object keyed by topic.');
    return ok(nextactions.nextActions(b, { jobs: c.jobs, today: c.today }));
  }
  return { meta, nextActions: nextActionsH, runway, planner: plan, rank: rankH, overlap: overlapH, portfolio, studyPlan: studyPlanH, sm2: sm2H, analytics: analyticsH, whatif: whatifH, brief };
}
module.exports = { createAdvancedApi };
