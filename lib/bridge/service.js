'use strict';
// Bridge analysis pipeline: sanitised input + evidence -> skill profile -> job matches -> gap analysis.
// Pure and synchronous apart from what callers hand in, so server.js, standalone.js and the tests share it.
const { LEVEL_LABEL, FIELD_LABEL } = require('../eligibility');
const { STATES } = require('../search');
const T = require('./taxonomy');
const E = require('./evidence');
const M = require('./matcher');
const { parseResume } = require('./resumeParser');
const { skillsForNode } = require('./requirements');

const CATEGORIES = ['General', 'EWS', 'OBC', 'SC', 'ST'];
const MAX_RESUME_CHARS = 100000;
const bad = (m) => Object.assign(new Error(m), { status: 400 });

function sanitizeProfile(raw, now = new Date()) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const e = p.education && typeof p.education === 'object' ? p.education : null;
  if (e && Object.prototype.hasOwnProperty.call(LEVEL_LABEL, e.level)) {
    out.education = { level: e.level, status: e.status === 'final_year' ? 'final_year' : 'completed' };
    if (e.field && Object.prototype.hasOwnProperty.call(FIELD_LABEL, e.field)) out.education.field = e.field;
  }
  if (typeof p.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.dob)) {
    const y = Number(p.dob.slice(0, 4));
    if (y >= 1940 && y <= now.getUTCFullYear() - 5 && !Number.isNaN(Date.parse(p.dob))) out.dob = p.dob;
  }
  if (typeof p.state === 'string' && STATES.includes(p.state)) out.state = p.state;
  if (CATEGORIES.includes(p.category)) out.category = p.category;
  if (p.pwbd === true) out.pwbd = true;
  if (p.exServiceman === true || p.exServicemen === true) out.exServiceman = true;
  if (typeof p.domicileState === 'string' && (p.domicileState === 'none' || STATES.includes(p.domicileState))) out.domicileState = p.domicileState;
  if (p.experienceYears != null && p.experienceYears !== '' && Number.isFinite(Number(p.experienceYears))) out.experienceYears = Math.max(0, Math.min(50, Number(p.experienceYears)));
  if (Array.isArray(p.subjects)) out.subjects = p.subjects.filter((s) => typeof s === 'string').slice(0, 10).map((s) => s.slice(0, 40));
  if (p.subjectsKnown === true) out.subjectsKnown = true;
  return out;
}

function sanitizeSelf(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!T.isSkill(k) || T.SKILLS[k].selfCheck) continue;
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(T.SELF_LEVELS, v)) { if (v !== 'none') out[k] = v; }
    else if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) out[k] = v;
  }
  return out;
}

function sanitizeClaims(raw) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw.slice(0, 40) : []) {
    if (!c || !T.isSkill(c.skill)) continue;
    const lvl = Number(c.level_hint);
    out.push({ skill: c.skill, level_hint: Number.isFinite(lvl) ? Math.max(0.2, Math.min(0.7, lvl)) : 0.5, terms: Array.isArray(c.terms) ? c.terms.slice(0, 4).map((t) => String(t).slice(0, 30)) : [] });
  }
  return out;
}

function sanitizeRaise(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (T.isSkill(k) && !T.SKILLS[k].selfCheck && Number.isFinite(Number(v))) out[k] = Math.max(0, Math.min(0.95, Number(v)));
  }
  return out;
}

function sanitizeInput(body, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.resume_text != null && typeof b.resume_text !== 'string') throw bad('resume_text must be text.');
  const wpm = b.typing_wpm == null || b.typing_wpm === '' ? null : Number(b.typing_wpm);
  if (wpm != null && (!Number.isFinite(wpm) || wpm < 5 || wpm > 200)) throw bad('typing_wpm must be between 5 and 200.');
  const mins = b.daily_minutes == null ? null : Number(b.daily_minutes);
  if (mins != null && (!Number.isFinite(mins) || mins < 15 || mins > 480)) throw bad('daily_minutes must be between 15 and 480.');
  return {
    profile: sanitizeProfile(b.profile, now),
    self: sanitizeSelf(b.self),
    typing_wpm: wpm == null ? null : Math.round(wpm),
    daily_minutes: mins == null ? null : Math.round(mins),
    resume_text: b.resume_text ? b.resume_text.slice(0, MAX_RESUME_CHARS) : '',
    resume_claims: sanitizeClaims(b.resume_claims),
    resume_exclude: (Array.isArray(b.resume_exclude) ? b.resume_exclude : []).filter((x) => T.isSkill(x)).slice(0, 40),
    raise: sanitizeRaise(b.raise),
    include_closed: b.include_closed === true,
  };
}

// campus: bridge-source/1 export | null.  gov: { progress, reviews } | null.
function buildEvidence({ input, campus, gov, syllabusByVersion = {} }) {
  const nodesFlat = Object.values(syllabusByVersion).flat();
  const skillForLabel = (label) => {
    const text = String(label || '');
    const n = nodesFlat.find((x) => x.code && text.includes(x.code));
    return n ? skillsForNode(n) : [];
  };
  const parsed = input.resume_text ? parseResume(input.resume_text) : null;
  const exclude = new Set(input.resume_exclude || []);
  const claims = (parsed && parsed.ok ? parsed.skills : input.resume_claims).filter((c) => !exclude.has(c.skill));
  const batches = {
    resume: E.fromResume({ skills: claims, typing_wpm: parsed && parsed.typing_wpm }),
    self: [...E.fromSelf(input.self), ...E.fromTyping(input.typing_wpm)],
  };
  if (campus) {
    const at = campus.generated_at;
    const apt = E.fromAptitude(((campus.aptitude && campus.aptitude.topics) || []), at);
    batches.campus_aptitude = apt;
    batches.campus_competencies = E.fromCompetencies(campus.competencies || [], at);
    batches.campus_results = E.fromResults(campus.results || [], at);
    batches.campus_resume = E.fromSkillNames(campus.resume_skills || [], 'resume', 'Skill listed in your Campus resume analysis');
  }
  if (gov) {
    batches.govcareer_progress = E.fromSyllabusProgress(gov.progress || [], (r) => skillsForNode(r));
    batches.govcareer_mock = E.fromMockReviews(gov.reviews || [], skillForLabel);
  }
  return { batches, parsed };
}

function applyRaise(skills, raise) {
  const out = { ...skills };
  for (const [id, lvl] of Object.entries(raise || {})) {
    const cur = out[id];
    out[id] = { skill: id, label: T.label(id), group: T.SKILLS[id].group, level: Math.max(cur ? cur.level : 0, lvl), confidence: 1, verified: false, tested: false, claimed: true, what_if: true,
      sources: [{ kind: 'what_if', source: 'What-if', verified: false, level: lvl, detail: `Hypothetical: ${Math.round(lvl * 100)}% ${T.label(id)}` }] };
  }
  return out;
}

function runAnalysis({ input, jobs, exams, syllabusByVersion, campus, gov, now = new Date(), dailyMinutes }) {
  const { batches, parsed } = buildEvidence({ input, campus, gov, syllabusByVersion });
  const profile = E.buildSkillProfile(batches);
  const minutes = dailyMinutes || input.daily_minutes || 120;
  const base = M.matchJobs({ jobs, profile: input.profile, skills: profile.skills, resumeText: input.resume_text, now, exams, syllabusByVersion, options: { dailyMinutes: minutes, includeClosed: input.include_closed } });
  const out = { profile, parsed_resume: parsed, result: base, gap: M.gapAnalysis(base, profile.skills, syllabusByVersion, { dailyMinutes: minutes }), daily_minutes: minutes };
  if (input.raise && Object.keys(input.raise).length) {
    const raised = applyRaise(profile.skills, input.raise);
    const after = M.matchJobs({ jobs, profile: input.profile, skills: raised, resumeText: input.resume_text, now, exams, syllabusByVersion, options: { dailyMinutes: minutes, includeClosed: input.include_closed } });
    out.what_if = { raise: input.raise, movements: M.diffMatches(base, after), after_summary: after.summary, after_matches: after.matches.slice(0, 8).map((m) => ({ id: m.id, title: m.title, bridge_score: m.bridge_score, fit: m.fit && m.fit.score, action: m.action })) };
  }
  return out;
}

module.exports = { sanitizeInput, sanitizeProfile, sanitizeSelf, sanitizeClaims, sanitizeRaise, buildEvidence, applyRaise, runAnalysis, MAX_RESUME_CHARS };
