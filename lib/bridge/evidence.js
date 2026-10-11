'use strict';
// Evidence aggregation.
//
// Every input becomes zero or more evidence items:
//   { skill, level 0..1, weight, verified, kind, detail, at? }
// "verified" means TESTED (Campus aptitude answers, tracked competency, graded interview, mock test).
// Resume mentions and self-declared levels are CLAIMS: they carry low weight and can never make a skill
// look "verified". This mirrors Campus's own rule (digitalTwinRepo.syncResumeMatch) that resume evidence
// never overwrites tested competency.
const T = require('./taxonomy');

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// ---- Campus aptitude ------------------------------------------------------------------------------
const APT_ORDER = ['data_interp', 'reasoning', 'english', 'quant', 'it_programming'];
function aptitudeSkill(group, topic) {
  const text = `${group || ''} ${topic || ''}`;
  for (const id of APT_ORDER) {
    const re = T.SKILLS[id].campus && T.SKILLS[id].campus.aptitude;
    if (re && re.test(text)) return id;
  }
  return null;
}

// rows: [{ group, topic, attempted, correct }] (counts, already aggregated per topic)
function fromAptitude(rows, at) {
  const per = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const skill = aptitudeSkill(r.group, r.topic);
    const attempted = Math.max(0, Number(r.attempted) || 0);
    const correct = Math.min(attempted, Math.max(0, Number(r.correct) || 0));
    if (!skill || !attempted) continue;
    const cur = per.get(skill) || { attempted: 0, correct: 0, topics: [] };
    cur.attempted += attempted; cur.correct += correct;
    cur.topics.push({ topic: r.topic || r.group || 'Topic', attempted, correct, accuracy: round(correct / attempted, 2) });
    per.set(skill, cur);
  }
  const items = []; const breakdown = {};
  for (const [skill, v] of per) {
    // Beta(1.5,1.5) prior: 3/3 correct is ~0.75, not 1.0; 90/100 is ~0.89.
    const level = (v.correct + 1.5) / (v.attempted + 3);
    items.push({
      skill, level: clamp01(level), weight: Math.min(v.attempted, 120) / 12, verified: true, kind: 'campus_aptitude', at,
      detail: `${v.correct} of ${v.attempted} Campus aptitude questions correct across ${v.topics.length} topic${v.topics.length === 1 ? '' : 's'}`,
    });
    breakdown[skill] = v.topics.sort((a, b) => b.attempted - a.attempted).slice(0, 12);
  }
  return { items, breakdown };
}

// ---- Campus digital-twin competencies ------------------------------------------------------------
function competencySkills(c) {
  const cat = String(c.category || '');
  const name = String(c.skillName || c.name || '');
  const hits = [];
  for (const id of T.IDS) {
    const m = T.SKILLS[id].campus || {};
    if (m.competencyCategories && (m.competencyCategories.includes(cat) || m.competencyCategories.includes(name))) hits.push(id);
    else if (m.competency && m.competency.test(`${cat} ${name}`)) hits.push(id);
  }
  return hits;
}
function fromCompetencies(list, at) {
  const items = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (c.pKnow == null || !Number.isFinite(Number(c.pKnow))) continue;
    const base = clamp01(Number(c.pKnow));
    const n = Math.max(0, Number(c.questionsAnswered) || 0);
    const weight = 4 + Math.min(n, 30) / 5;
    for (const skill of competencySkills(c)) {
      items.push({ skill, level: base, weight, verified: true, kind: 'campus_competency', at: c.lastPracticedAt || at,
        detail: `${c.skillName || c.category}: ${(base * 100).toFixed(0)}% mastery from ${n} adaptive question${n === 1 ? '' : 's'}${c.masteryStatus ? ` (${c.masteryStatus})` : ''}` });
      for (const [implied, factor] of Object.entries(T.IMPLIES[skill] || {})) {
        items.push({ skill: implied, level: clamp01(base * factor), weight: weight * 0.4, verified: false, kind: 'campus_inferred', at: c.lastPracticedAt || at,
          detail: `Inferred from tested ${T.label(skill)} (${(factor * 100).toFixed(0)}% transfer)` });
      }
    }
  }
  return items;
}

// ---- Campus saved results -------------------------------------------------------------------------
function fromResults(list, at) {
  const items = [];
  for (const r of Array.isArray(list) ? list : []) {
    const score = Number(r.summaryScore);
    const when = r.createdAt || at;
    if (['INTERVIEW', 'MIRROR_MENTOR'].includes(r.type) && Number.isFinite(score)) {
      items.push({ skill: 'interview_skills', level: clamp01(score / 100), weight: 3, verified: true, kind: 'campus_result', at: when,
        detail: `${r.type === 'INTERVIEW' ? 'AI mock interview' : 'MirrorMentor session'}${r.topic ? ` (${r.topic})` : ''}: ${score.toFixed(0)}/100` });
    }
    if (r.type === 'QUIZ' && Number.isFinite(score) && r.topic) {
      for (const id of T.IDS) {
        if (T.COMPILED[id].some(({ re }) => re.test(r.topic))) {
          items.push({ skill: id, level: clamp01(score / 100), weight: 2, verified: true, kind: 'campus_result', at: when, detail: `Campus quiz “${r.topic}”: ${score.toFixed(0)}/100` });
        }
      }
    }
  }
  return items;
}

// Skills the student listed in a Campus resume analysis (payload shapes vary, so read defensively).
function resumeSkillNames(results) {
  const names = new Set();
  for (const r of Array.isArray(results) ? results : []) {
    if (r.type !== 'RESUME_ANALYSIS' || !r.payload || typeof r.payload !== 'object') continue;
    for (const key of ['skills', 'resumeSkills', 'matchedSkills', 'matched_skills', 'skillsFound']) {
      const v = r.payload[key];
      if (Array.isArray(v)) v.forEach((x) => { const s = typeof x === 'string' ? x : x && (x.skill || x.name); if (s) names.add(String(s).slice(0, 60)); });
    }
  }
  return [...names].slice(0, 80);
}
function fromSkillNames(names, kind, detail) {
  const text = (names || []).join(' | ');
  const items = [];
  for (const id of T.IDS) {
    const hit = T.COMPILED[id].find(({ re }) => re.test(text));
    if (hit) items.push({ skill: id, level: 0.5, weight: 1, verified: false, kind, detail: `${detail}: “${hit.alias}”` });
  }
  return items;
}

// ---- resume parse / self report -------------------------------------------------------------------
function fromResume(parsed) {
  if (!parsed || !Array.isArray(parsed.skills)) return [];
  const items = parsed.skills.map((s) => ({
    skill: s.skill, level: s.skill === 'typing' && parsed.typing_wpm ? T.typingLevel(parsed.typing_wpm) : s.level_hint,
    weight: 1, verified: false, kind: 'resume', detail: `Mentioned in your resume (${(s.terms || []).slice(0, 3).join(', ')})`,
  })).filter((i) => i.level != null && T.isSkill(i.skill));
  return items;
}
function fromSelf(self) {
  const items = [];
  for (const [skill, v] of Object.entries(self || {})) {
    if (!T.isSkill(skill)) continue;
    const level = typeof v === 'number' ? clamp01(v) : T.SELF_LEVELS[v];
    if (level == null) continue;
    items.push({ skill, level, weight: 2, verified: false, kind: 'self', detail: `Self-declared: ${typeof v === 'string' ? v : `${Math.round(level * 100)}%`}` });
  }
  return items;
}
function fromTyping(wpm) {
  const level = T.typingLevel(wpm);
  return level == null ? [] : [{ skill: 'typing', level, weight: 3, verified: false, kind: 'self', detail: `Self-reported typing speed: ${wpm} wpm` }];
}

// ---- GovCareer study hub --------------------------------------------------------------------------
// progress: [{ code, title, description, progress_pct }]  – syllabus_progress joined to nodes.
// Studying is evidence of PREPARATION, not mastery, so it is capped and unverified.
function fromSyllabusProgress(rows, nodeSkills) {
  const items = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const pct = clamp01((Number(r.progress_pct) || 0) / 100);
    if (!pct) continue;
    for (const [skill, share] of (nodeSkills(r) || [])) {
      items.push({ skill, level: pct * 0.8, weight: 2 * share, verified: false, kind: 'govcareer_syllabus', detail: `Exam Lab progress on “${r.title}”: ${(pct * 100).toFixed(0)}%` });
    }
  }
  return items;
}
// reviews: [{ label:'Verified syllabus: CGL-QA', result:'CORRECT'|'WRONG'|'UNANSWERED' }]
function fromMockReviews(reviews, skillForLabel) {
  const per = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (r.result === 'UNANSWERED') continue;
    for (const [skill] of (skillForLabel(r.label) || [])) {
      const cur = per.get(skill) || { n: 0, ok: 0 };
      cur.n++; if (r.result === 'CORRECT') cur.ok++;
      per.set(skill, cur);
    }
  }
  return [...per].map(([skill, v]) => ({ skill, level: clamp01((v.ok + 1.5) / (v.n + 3)), weight: Math.min(v.n, 40) / 8, verified: true, kind: 'govcareer_mock',
    detail: `${v.ok} of ${v.n} answered mock-test questions correct in Exam Lab` }));
}

// ---- aggregation ----------------------------------------------------------------------------------
const KIND_LABEL = {
  campus_aptitude: 'Campus aptitude', campus_competency: 'Campus digital twin', campus_result: 'Campus result', campus_inferred: 'Inferred from Campus',
  govcareer_mock: 'Exam Lab mock tests', govcareer_syllabus: 'Exam Lab progress', resume: 'Resume', self: 'Self-declared',
};

function aggregate(items) {
  const bySkill = new Map();
  for (const it of items) {
    if (!T.isSkill(it.skill) || it.level == null || !Number.isFinite(it.level)) continue;
    if (!bySkill.has(it.skill)) bySkill.set(it.skill, []);
    bySkill.get(it.skill).push(it);
  }
  const skills = {};
  for (const [id, list] of bySkill) {
    const tested = list.filter((i) => i.verified);
    const claims = list.filter((i) => !i.verified);
    const wT = tested.reduce((s, i) => s + i.weight, 0);
    const wC = claims.reduce((s, i) => s + i.weight, 0);
    let level;
    if (wT > 0) {
      const lt = tested.reduce((s, i) => s + i.level * i.weight, 0) / wT;
      // Claims only nudge tested evidence slightly, and only when there is little of it.
      const lc = wC ? claims.reduce((s, i) => s + i.level * i.weight, 0) / wC : lt;
      const claimShare = Math.min(0.25, wC / (wT + wC)) * (wT < 4 ? 1 : 0.4);
      level = lt * (1 - claimShare) + lc * claimShare;
    } else level = claims.reduce((s, i) => s + i.level * i.weight, 0) / (wC || 1);
    const confidence = 1 - Math.exp(-(wT + wC * 0.5) / 8);
    skills[id] = {
      skill: id, label: T.label(id), group: T.SKILLS[id].group,
      level: round(level), confidence: round(confidence, 2), verified: wT >= 3, tested: wT > 0, claimed: wC > 0,
      sources: list.map((i) => ({ kind: i.kind, source: KIND_LABEL[i.kind] || i.kind, verified: !!i.verified, level: round(i.level, 2), detail: i.detail, at: i.at || null }))
        .sort((a, b) => Number(b.verified) - Number(a.verified)).slice(0, 8),
    };
  }
  return skills;
}

// Merge several named evidence batches into one profile + provenance summary.
function buildSkillProfile(batches) {
  const all = [];
  const sources = {};
  const breakdown = {};
  for (const [name, b] of Object.entries(batches || {})) {
    if (!b) continue;
    const items = Array.isArray(b) ? b : b.items || [];
    if (b.breakdown) Object.assign(breakdown, b.breakdown);
    sources[name] = { items: items.length };
    all.push(...items);
  }
  const skills = aggregate(all);
  const list = Object.values(skills);
  return {
    skills, breakdown, sources,
    summary: {
      skills_known: list.length,
      skills_verified: list.filter((s) => s.verified).length,
      skills_claimed_only: list.filter((s) => !s.tested).length,
    },
  };
}

module.exports = {
  aptitudeSkill, fromAptitude, fromCompetencies, fromResults, resumeSkillNames, fromSkillNames, fromResume, fromSelf, fromTyping,
  fromSyllabusProgress, fromMockReviews, aggregate, buildSkillProfile, KIND_LABEL,
};
