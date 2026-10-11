'use strict';
// Study planner with spaced revision (SM-2 intervals) and mock-test slots. Deterministic: same input, same plan.
const C = require('./common');

function sm2(state = {}, quality) {
  const q = C.clamp(Math.round(Number(quality)), 0, 5);
  let { ease = 2.5, interval = 0, reps = 0 } = state;
  if (q < 3) { reps = 0; interval = 1; }
  else { reps += 1; interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease); }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { ease: Math.round(ease * 100) / 100, interval, reps, quality: q };
}
function plan(input, now) {
  const today = C.todayYMD(now), start = input.start_date && input.start_date >= today ? input.start_date : today;
  const exam = input.exam_date; const hpd = C.clamp(Number(input.hours_per_day) || 2, 0.5, 14);
  const finalDays = C.clamp(Number.isFinite(+input.final_revision_days) ? +input.final_revision_days : 3, 0, 14);
  const mockEvery = C.clamp(Number(input.mock_every_days) || 7, 0, 60), rest = Number.isInteger(input.rest_weekday) ? input.rest_weekday : null;
  const topics = (input.topics || []).map((t, i) => ({ id: t.id ?? `t${i + 1}`, title: String(t.title || `Topic ${i + 1}`).slice(0, 120), confidence: C.clamp(Number(t.confidence ?? 2), 0, 5), weight: Math.max(0.1, Number(t.weight ?? 1)) }));
  if (!exam || exam <= start) return { error: 'Exam date must be after the start date.' };
  if (!topics.length) return { error: 'Add at least one topic.' };
  const lastStudy = C.addDays(exam, -1), finalStart = C.addDays(exam, -finalDays);
  const days = [];
  for (let d = start; d <= lastStudy; d = C.addDays(d, 1)) { const wd = new Date(C.ymdToUTC(d)).getUTCDay(); days.push({ date: d, rest: rest !== null && wd === rest, final: d >= finalStart, blocks: [] }); }
  const study = days.filter((d) => !d.rest);
  const need = Object.fromEntries(topics.map((t) => [t.id, t.weight * (6 - t.confidence)])); const needSum = Object.values(need).reduce((a, b) => a + b, 0);
  const learnPool = study.filter((d) => !d.final); const learnHours = learnPool.length * hpd * 0.7; // 30% kept for revision/mocks
  const target = Object.fromEntries(topics.map((t) => [t.id, C.round1((need[t.id] / needSum) * learnHours)]));
  const remaining = { ...target }; const firstDone = {}; const revisions = [];
  const BLOCK = 1; let mocks = 0, lastMock = C.addDays(start, -(Number.isFinite(mockEvery) ? mockEvery : 7) + 3); // first mock about 3 days in
  for (const d of days) {
    if (d.rest) continue;
    let budget = hpd;
    if (mockEvery && !d.final && C.daysBetween(lastMock, d.date) >= mockEvery && budget >= 2) { d.blocks.push({ type: 'mock', title: 'Full mock test + analysis', hours: Math.min(3, budget) }); budget -= Math.min(3, budget); mocks++; lastMock = d.date; }
    const due = revisions.filter((r) => r.date <= d.date && !r.done).sort((a, b) => a.date.localeCompare(b.date));
    for (const r of due) { const h = Math.min(0.5, budget); if (h <= 0 || (budget < hpd * 0.15 && !d.final)) break; d.blocks.push({ type: 'revise', topic_id: r.id, title: r.title, hours: h, interval_day: r.step }); budget -= h; r.done = true; }
    if (d.final) { // consolidation: cycle weakest topics first
      const order = [...topics].sort((a, b) => a.confidence - b.confidence); let i = 0;
      while (budget >= 0.5 && order.length) { const t = order[i++ % order.length]; d.blocks.push({ type: 'revise', topic_id: t.id, title: t.title, hours: 0.5, interval_day: 'final' }); budget -= 0.5; }
    } else {
      let guard = 0;
      while (budget > 0.01 && guard++ < 50) {
        const t = topics.filter((x) => remaining[x.id] > 0.01).sort((a, b) => remaining[b.id] - remaining[a.id])[0]; if (!t) break;
        const h = Math.min(BLOCK, budget, remaining[t.id]); const last = d.blocks[d.blocks.length - 1];
        if (last && last.type === 'learn' && last.topic_id === t.id) last.hours = C.round1(last.hours + h); else d.blocks.push({ type: 'learn', topic_id: t.id, title: t.title, hours: C.round1(h) });
        remaining[t.id] -= h; budget -= h;
        if (remaining[t.id] <= 0.01 && !firstDone[t.id]) { firstDone[t.id] = d.date; let st = { ease: 2.5, interval: 0, reps: 0 }; let at = d.date; for (let n = 0; n < 4; n++) { st = sm2(st, 4); at = C.addDays(at, st.interval); if (at < finalStart) revisions.push({ id: t.id, title: t.title, date: at, step: `+${st.interval}d`, done: false }); } }
      }
    }
    d.total_hours = C.round1(d.blocks.reduce((s, b) => s + b.hours, 0));
  }
  const totalHours = C.round1(days.reduce((s, d) => s + (d.total_hours || 0), 0));
  const unplaced = Object.entries(remaining).filter(([, v]) => v > 0.2).map(([id, v]) => ({ topic_id: id, hours_unplaced: C.round1(v) }));
  const warnings = [];
  if (unplaced.length) warnings.push('Not all learning hours fit before the final revision window; raise hours/day, move the start date earlier, or drop low-weight topics.');
  if (study.length < 14) warnings.push('Fewer than 14 study days remain: treat this as a revision plan, not first-time coverage.');
  return { exam_date: exam, start_date: start, study_days: study.length, rest_days: days.length - study.length, final_revision_from: finalDays ? finalStart : null, mocks_planned: mocks, total_hours: totalHours, topic_hours: topics.map((t) => ({ topic_id: t.id, title: t.title, planned: target[t.id], confidence: t.confidence })), unplaced, warnings, days: days.filter((d) => d.blocks.length || d.rest), method: 'Learning hours are split in proportion to weight x (6 - confidence). Revisions follow SM-2 style intervals (1, 6, then ease-scaled days) and are capped before the final window.' };
}
module.exports = { sm2, plan };
