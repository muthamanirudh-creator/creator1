'use strict';
// Mock-test analytics: per-topic accuracy with Wilson intervals, negative-marking-aware attempt advice, pace, trend.
const C = require('./common');

function wilson(k, n, z = 1.96) {
  if (!n) return { low: 0, high: 1 };
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}
function linreg(ys) {
  const n = ys.length; if (n < 2) return null;
  const xs = ys.map((_, i) => i), mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0), sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const slope = sxy / sxx; return { slope, intercept: my - slope * mx };
}
function analyse(input) {
  const attempts = input.attempts || [];
  const right = Number.isFinite(+input.marks_correct) ? +input.marks_correct : 1;
  const wrong = Number.isFinite(+input.marks_wrong) ? Math.abs(+input.marks_wrong) : 0.25;
  const breakEven = right + wrong > 0 ? wrong / (right + wrong) : 0;   // attempt is worth it above this accuracy
  const per = new Map();
  for (const a of attempts) {
    const t = String(a.topic || 'Unlabelled').slice(0, 80); if (!per.has(t)) per.set(t, { topic: t, total: 0, attempted: 0, correct: 0, seconds: 0, timed: 0 });
    const r = per.get(t); r.total++;
    if (a.correct === true || a.correct === false) { r.attempted++; if (a.correct) r.correct++; }
    if (Number.isFinite(+a.seconds) && +a.seconds >= 0) { r.seconds += +a.seconds; r.timed++; }
  }
  const topics = [...per.values()].map((r) => {
    const acc = r.attempted ? r.correct / r.attempted : null, w = wilson(r.correct, r.attempted);
    let advice = 'NOT_ENOUGH_DATA';
    if (r.attempted >= 5) advice = w.low > breakEven ? 'ATTEMPT_CONFIDENTLY' : acc > breakEven ? 'ATTEMPT_SELECTIVELY' : 'AVOID_GUESSING_AND_REVISE';
    return { topic: r.topic, questions: r.total, attempted: r.attempted, skipped: r.total - r.attempted, correct: r.correct, accuracy_pct: acc == null ? null : C.round1(acc * 100), accuracy_95ci_pct: r.attempted ? [C.round1(w.low * 100), C.round1(w.high * 100)] : null, net_marks: C.round1(r.correct * right - (r.attempted - r.correct) * wrong), avg_seconds: r.timed ? C.round1(r.seconds / r.timed) : null, advice };
  }).sort((a, b) => (a.accuracy_pct ?? 101) - (b.accuracy_pct ?? 101));
  const att = topics.reduce((s, t) => s + t.attempted, 0), cor = topics.reduce((s, t) => s + t.correct, 0), tot = topics.reduce((s, t) => s + t.questions, 0);
  const net = C.round1(cor * right - (att - cor) * wrong);
  const w = wilson(cor, att);
  const overall = { questions: tot, attempted: att, correct: cor, accuracy_pct: att ? C.round1((cor / att) * 100) : null, accuracy_95ci_pct: att ? [C.round1(w.low * 100), C.round1(w.high * 100)] : null, net_marks: net, break_even_accuracy_pct: C.round1(breakEven * 100), avg_seconds: (() => { const s = topics.filter((t) => t.avg_seconds != null); const n = s.reduce((x, t) => x + t.attempted, 0); return n ? C.round1(s.reduce((x, t) => x + t.avg_seconds * t.attempted, 0) / n) : null; })() };
  let pace = null;
  if (input.total_time_minutes && tot) { const budget = (input.total_time_minutes * 60) / tot; pace = { budget_seconds_per_question: C.round1(budget), your_avg_seconds: overall.avg_seconds, verdict: overall.avg_seconds == null ? 'UNKNOWN' : overall.avg_seconds > budget * 1.15 ? 'TOO_SLOW' : overall.avg_seconds < budget * 0.6 ? 'VERY_FAST_CHECK_ACCURACY' : 'ON_PACE' }; }
  let trend = null;
  const tests = (input.tests || []).filter((t) => Number.isFinite(+t.score)).map((t) => ({ name: t.name || '', score: +t.score, max: +t.max || null }));
  if (tests.length >= 2) {
    const reg = linreg(tests.map((t) => t.score)); trend = { points: tests.length, slope_per_test: C.round1(reg.slope), direction: reg.slope > 0.5 ? 'IMPROVING' : reg.slope < -0.5 ? 'DECLINING' : 'FLAT' };
    if (Number.isFinite(+input.target_score) && reg.slope > 0.05) { const lastFit = reg.intercept + reg.slope * (tests.length - 1); trend.tests_to_target = lastFit >= input.target_score ? 0 : Math.ceil((input.target_score - lastFit) / reg.slope); trend.caveat = 'Straight-line extrapolation from your own tests; difficulty varies between tests.'; }
  }
  const gap = Number.isFinite(+input.target_score) ? C.round1(+input.target_score - net) : null;
  return { overall, topics, weakest: topics.filter((t) => t.accuracy_pct != null).slice(0, 3).map((t) => t.topic), pace, trend, target_gap: gap, marking: { correct: right, wrong: -wrong }, note: 'Cut-offs are set by each exam each year; supply your own target. Intervals widen with few questions, so small samples are marked NOT_ENOUGH_DATA.' };
}
module.exports = { analyse, wilson };
