'use strict';
// Career Fit transparency (v2.9.0): show exactly how a score was made, what is missing, and whether recommendations help.
// A bridge/fit score is a RANKING AID computed from stated weights. It is not a probability of selection.
const { WEIGHTS } = require('../bridge/matcher');
const { wilson } = require('./evaluation');
const r1 = (n) => Math.round(n * 10) / 10;

// m = one row of matchJobs().matches. Components are recomputed from the same inputs and weights and must sum to bridge_score.
function explainMatch(m) {
  const eligMap = { MATCH: 1, PARTIAL_MATCH: 0.75, CONDITIONALLY_ELIGIBLE: 0.6, UNKNOWN: 0.5, INSUFFICIENT_EVIDENCE: 0.5, NOT_ELIGIBLE: 0 };
  const ev = eligMap[m.eligibility.overall] ?? 0.5;
  let parts;
  if (m.fit) {
    const w = m.text_affinity == null ? { fit: WEIGHTS.fit + WEIGHTS.affinity, elig: WEIGHTS.elig, feas: WEIGHTS.feas, affinity: 0 } : WEIGHTS;
    parts = [
      { name: 'Skill fit', input: m.fit.score / 100, weight: w.fit, note: `Skills cover about ${m.fit.score}% of what the selection stages test (range ${m.fit.low}–${m.fit.high}% given evidence confidence).` },
      { name: 'Eligibility', input: ev, weight: w.elig, note: m.eligibility.summary },
      { name: 'Time to prepare', input: m.readiness.feasibility, weight: w.feas, note: `${m.readiness.hours_needed} study hours needed, ${m.readiness.days_available} days available at ${m.readiness.daily_minutes} min/day.` },
      ...(w.affinity ? [{ name: 'Resume text similarity', input: m.text_affinity, weight: w.affinity, note: 'Relative to the other jobs shown: the best-matching job scores 1.' }] : []),
    ];
  } else parts = [{ name: 'Eligibility', input: ev, weight: 0.7, note: m.eligibility.summary }, { name: 'Time to prepare', input: m.readiness.feasibility, weight: 0.3, note: 'No skill requirements could be derived for this post.' }];
  const components = parts.map((p) => ({ ...p, points: r1(100 * p.weight * p.input) }));
  const gaps = ((m.fit && m.fit.coverage) || []).filter((c) => c.status !== 'MET').map((c) => ({ skill: c.label, status: c.status, your_level: c.level, target: c.target, evidence: c.status === 'UNKNOWN' ? 'No evidence of this skill in your profile; it is assumed low, not zero.' : (c.evidence || []).join('; ') || 'self-reported', hours: ((m.readiness.per_skill_hours || []).find((x) => x.label === c.label) || {}).hours || 0 }));
  return {
    job_id: m.id, score: m.bridge_score, formula: components.map((c) => `${Math.round(c.weight * 100)}% × ${c.name}`).join(' + '), components,
    components_sum: r1(components.reduce((x, c) => x + c.points, 0)), skill_gaps: gaps,
    not_a_probability: 'This number ranks jobs for you. It does not estimate your chance of selection.',
    would_change_if: [...(m.eligibility.asks || []).map((a) => `Answering "${a.prompt}" would settle eligibility.`), ...gaps.slice(0, 3).map((g) => `Raising ${g.skill} to the target would add to skill fit.`)],
    basis: m.requirements_basis === 'STATED' ? 'Skill requirements come from the notification/syllabus.' : 'Skill requirements are INFERRED from the post type; they are not stated by the notification.',
  };
}

// Do recommendations help? events: [{ action_code, outcome }] outcome: APPLIED | SAVED | IGNORED | DISMISSED. Honest about small samples.
function measureRecommendations(events) {
  const by = new Map();
  for (const e of events) { const b = by.get(e.action_code) || by.set(e.action_code, { action_code: e.action_code, shown: 0, acted: 0, dismissed: 0 }).get(e.action_code); b.shown++; if (['APPLIED', 'SAVED'].includes(e.outcome)) b.acted++; if (e.outcome === 'DISMISSED') b.dismissed++; }
  return [...by.values()].map((b) => { const w = wilson(b.acted, b.shown); return { ...b, act_rate: b.shown ? Math.round((b.acted / b.shown) * 1000) / 10 : null, ci95: [Math.round(w.lower * 1000) / 10, Math.round(w.upper * 1000) / 10], enough_data: b.shown >= 30, note: b.shown < 30 ? 'Too few recommendations to draw a conclusion.' : null }; });
}
module.exports = { explainMatch, measureRecommendations };
