'use strict';
// Government jobs do not publish "required skills". Bridge therefore derives them, and is explicit
// about HOW each one was derived:
//
//   STATED    – the notification itself says so (required subjects, an explicit `skills` list on the
//               record) or the requirement comes from a VERIFIED exam syllabus version.
//   INFERRED  – a rule maps the selection process / education field / domain to a skill
//               (e.g. "Typing test" -> typing). Always labelled, never presented as an official fact.
//
// Eligibility (education, age, domicile…) is NOT decided here; the deterministic engine in
// lib/eligibility.js stays the only authority on that.
const T = require('./taxonomy');

const ENTRY_LEVELS = new Set(['8th', '10th', '12th', 'iti']);
const RANK = { '8th': 8, '10th': 10, iti: 11, '12th': 12, diploma: 14, bachelor: 15, master: 17, phd: 20 };

function levelClass(job) {
  const acc = (job.education && job.education.accepted) || [];
  const top = Math.max(...acc.map((a) => RANK[a] || 0), 0);
  if (!top) return 'ENTRY';
  if (job.education && job.education.or_higher && acc.every((a) => ENTRY_LEVELS.has(a))) return 'ENTRY';
  if (acc.every((a) => ENTRY_LEVELS.has(a))) return 'ENTRY';
  if (top >= 17) return 'ADVANCED';
  return 'GRADUATE';
}
const CORE_TARGET = { ENTRY: 0.6, GRADUATE: 0.7, ADVANCED: 0.7 };

// ---- exam family linking ------------------------------------------------------------------------
const EXAM_TITLE_RULES = [
  { re: /combined graduate|\bcgl\b/i, code: 'SSC-CGL' },
  { re: /higher secondary|\bchsl\b/i, code: 'SSC-CHSL' },
  { re: /probationary officer|\bbank\s*po\b|\bpo\b/i, code: 'BANK-PO' },
];
function examFor(job, exams) {
  if (!Array.isArray(exams) || !exams.length) return null;
  const explicit = job.exam_code && exams.filter((e) => e.code === job.exam_code);
  const pool = explicit && explicit.length ? explicit : (() => {
    const rule = EXAM_TITLE_RULES.find((r) => r.re.test(`${job.title || ''}`));
    return rule ? exams.filter((e) => e.code === rule.code) : [];
  })();
  if (!pool.length) return null;
  return [...pool].sort((a, b) => (b.recruitment_year || 0) - (a.recruitment_year || 0))[0];
}

// Map a syllabus node to up to two skills by keyword score (title hits count double).
function skillsForNode(node) {
  const title = String(node.title || '').toLowerCase();
  const text = `${title} ${String(node.description || '').toLowerCase()}`;
  const scored = [];
  for (const id of T.IDS) {
    const kws = T.SKILLS[id].syllabus || [];
    let s = 0;
    for (const k of kws) { if (title.includes(k)) s += 2; else if (text.includes(k)) s += 1; }
    if (s > 0) scored.push([id, s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  if (!scored.length) return [];
  const out = [[scored[0][0], 1]];
  if (scored[1] && scored[1][1] >= 1 && scored[1][1] * 2 >= scored[0][1]) out.push([scored[1][0], 0.5]);
  return out;
}

// ---- accumulator --------------------------------------------------------------------------------
function makeAcc() {
  const map = new Map();
  return {
    add(skill, weight, target, kind, basis, rationale, source) {
      if (!T.isSkill(skill)) return;
      const cur = map.get(skill) || { skill, weight: 0, target: 0, kind: 'INFERRED', bases: [], rationale: [], source: null };
      cur.weight = Math.max(cur.weight, weight) + (cur.weight ? Math.min(weight, cur.weight) * 0.25 : 0);
      cur.target = Math.max(cur.target, target);
      if (kind === 'STATED') cur.kind = 'STATED';
      if (!cur.bases.includes(basis)) cur.bases.push(basis);
      if (rationale && !cur.rationale.includes(rationale)) cur.rationale.push(rationale);
      if (source && !cur.source) cur.source = source;
      map.set(skill, cur);
    },
    list: () => [...map.values()],
  };
}

const ENGINEERING_TITLE = [
  [/electric/i, 'eng_electrical'], [/mechanic|fitter|machinist/i, 'eng_mechanical'], [/civil|survey/i, 'eng_civil'],
  [/electronic|signal|communication|telecom|instrument/i, 'eng_electronics'],
];

function deriveRequirements(job, opts = {}) {
  const acc = makeAcc();
  const checkpoints = [];
  const notes = [];
  const cls = levelClass(job);
  const target = CORE_TARGET[cls];
  const title = `${job.title || ''} ${job.summary || ''} ${(job.education && job.education.label) || ''}`;
  const fs = job.field_sources || {};
  const stages = Array.isArray(job.selection) ? job.selection : [];
  const stageText = stages.join(' | ');

  // 1) Explicit skills on the record (future admin-curated field) -------------------------------
  if (Array.isArray(job.skills)) {
    for (const s of job.skills) {
      const id = typeof s === 'string' ? s : s && s.skill;
      acc.add(id, (s && s.weight) || 1, (s && s.target) || target, 'STATED', 'RECORD', 'Listed on the verified recruitment record.', null);
    }
  }

  // 2) Verified syllabus ---------------------------------------------------------------------------
  const exam = examFor(job, opts.exams);
  let examInfo = null;
  if (exam && Array.isArray(opts.syllabusNodes) && opts.syllabusNodes.length) {
    examInfo = { version_id: exam.version_id || exam.id, code: exam.code, name: exam.name, syllabus_version: exam.syllabus_version };
    const per = 1 / opts.syllabusNodes.length;
    for (const n of opts.syllabusNodes) {
      for (const [id, share] of skillsForNode(n)) {
        acc.add(id, per * share, target, 'STATED', 'VERIFIED_SYLLABUS', `Section “${n.title}” of the verified ${exam.code} syllabus (${exam.syllabus_version}).`, { doc: exam.syllabus_version, section: n.code, page: n.source_page || null });
      }
    }
    notes.push('Syllabus sections are weighted equally because the verified record does not publish section-wise marks.');
  } else if (exam) {
    examInfo = { version_id: exam.version_id || exam.id, code: exam.code, name: exam.name, syllabus_version: exam.syllabus_version };
  }
  const hasSyllabusSkills = acc.list().some((r) => r.bases.includes('VERIFIED_SYLLABUS'));

  // 3) Selection process --------------------------------------------------------------------------
  const isSteno = /stenograph/i.test(title);
  for (const st of stages) {
    const s = String(st);
    if (/typing/i.test(s)) {
      acc.add('typing', 0.9, 0.7, 'INFERRED', 'SELECTION_STAGE', `Selection process includes “${s}”.`);
      acc.add('computer_basics', 0.4, 0.5, 'INFERRED', 'SELECTION_STAGE', `“${s}” is done on a computer.`);
    }
    if (/skill test/i.test(s)) {
      if (isSteno) {
        acc.add('stenography', 0.9, 0.7, 'INFERRED', 'SELECTION_STAGE', `“${s}” for a stenographer post normally tests shorthand transcription.`);
        acc.add('typing', 0.6, 0.7, 'INFERRED', 'SELECTION_STAGE', 'Transcription is typed on a computer.');
      } else acc.add('computer_basics', 0.6, 0.6, 'INFERRED', 'SELECTION_STAGE', `“${s}” – the notification defines the exact skill; computer proficiency is the usual one.`);
    }
    if (/physical|efficiency test|measurement/i.test(s)) {
      checkpoints.push({ key: 'physical', label: 'Physical standards', detail: 'The notification lists physical measurements or tests. Bridge does not assess these.' });
      acc.add('physical_fitness', 1, 1, 'INFERRED', 'SELECTION_STAGE', `Selection process includes “${s}”.`);
    }
    if (/medical/i.test(s)) checkpoints.push({ key: 'medical', label: 'Medical examination', detail: 'A medical examination is part of selection.' });
    if (/document verification/i.test(s)) checkpoints.push({ key: 'documents', label: 'Document verification', detail: 'Keep original certificates ready (education, category, domicile as applicable).' });
    if (/interview|selection board|personality|presentation/i.test(s)) acc.add('interview_skills', 0.7, 0.65, 'INFERRED', 'SELECTION_STAGE', `Selection process includes “${s}”.`);
    if (/merit/i.test(s)) notes.push('Selection is merit-based on the notified marks; there is no separate written exam to prepare for.');
    if (/shortlisting/i.test(s) && job.domain === 'research') acc.add('science_research', 0.8, 0.65, 'INFERRED', 'SELECTION_STAGE', 'Shortlisting is on the research profile.');
  }
  const hasExamStage = stages.some((s) => /computer[- ]based|\bcbt\b|written|preliminary|prelim|main exam|\btier\b|\bexam/i.test(String(s)));
  if (hasExamStage && !hasSyllabusSkills) {
    const core = job.domain === 'police'
      ? [['reasoning', 0.3], ['gk', 0.3], ['quant', 0.2], ['english', 0.2]]
      : [['quant', 0.3], ['reasoning', 0.3], ['english', 0.2], ['gk', 0.2]];
    for (const [id, w] of core) acc.add(id, w, target, 'INFERRED', 'SELECTION_STAGE', 'A written / computer-based test is part of selection; the typical sections for this level are assumed until the syllabus is verified.');
    if (job.domain === 'banking') acc.add('data_interp', 0.2, target, 'INFERRED', 'DOMAIN', 'Banking examinations usually include data interpretation.');
  }
  if (job.domain === 'police' && stages.some((s) => /written/i.test(String(s)))) acc.add('legal_awareness', 0.2, 0.5, 'INFERRED', 'DOMAIN', 'Police recruitment tests usually include basic legal awareness.');

  // 4) Education field ---------------------------------------------------------------------------
  const fields = (job.education && job.education.fields) || [];
  if (fields.includes('engineering')) {
    const named = ENGINEERING_TITLE.filter(([re]) => re.test(title)).map(([, id]) => id);
    if (named.length) named.forEach((id) => acc.add(id, 0.8, 0.65, 'INFERRED', 'EDUCATION_FIELD', 'The post requires an engineering qualification in the discipline named in the title.'));
    else acc.add('eng_core', 0.8, 0.65, 'INFERRED', 'EDUCATION_FIELD', 'The post requires an engineering qualification; the specific discipline is not named in the verified record.', fs.field || null);
  }
  if (fields.includes('computer_applications')) {
    acc.add('it_programming', 0.6, 0.6, 'INFERRED', 'EDUCATION_FIELD', 'Computer-applications qualification.');
    acc.add('it_data', 0.4, 0.6, 'INFERRED', 'EDUCATION_FIELD', 'Computer-applications qualification.');
  }
  if (fields.includes('science') && !fields.includes('engineering')) acc.add('science_research', 0.5, 0.6, 'INFERRED', 'EDUCATION_FIELD', 'Science qualification.');
  if (fields.includes('commerce')) acc.add('banking_finance', 0.6, 0.6, 'INFERRED', 'EDUCATION_FIELD', 'Commerce qualification.');
  if (fields.includes('law')) acc.add('legal_awareness', 0.8, 0.7, 'INFERRED', 'EDUCATION_FIELD', 'Law qualification.');

  // 5) Domain --------------------------------------------------------------------------------------
  switch (job.domain) {
    case 'banking':
      acc.add('banking_finance', 0.5, 0.6, 'INFERRED', 'DOMAIN', 'Banking recruitment tests banking and economy awareness.');
      acc.add('computer_basics', 0.3, 0.6, 'INFERRED', 'DOMAIN', 'Banking roles are computer-based.');
      break;
    case 'defence':
      acc.add('interview_skills', 1, 0.7, 'INFERRED', 'DOMAIN', 'Defence selection boards assess personality and communication.');
      break;
    case 'research':
      acc.add('science_research', 1, 0.7, 'INFERRED', 'DOMAIN', 'Research appointments are made on research capability.');
      acc.add('stats', 0.4, 0.6, 'INFERRED', 'DOMAIN', 'Research roles typically need statistical analysis.');
      acc.add('descriptive_writing', 0.3, 0.6, 'INFERRED', 'DOMAIN', 'Research roles involve scientific writing and presentation.');
      break;
    case 'postal':
      acc.add('computer_basics', 0.4, 0.5, 'INFERRED', 'DOMAIN', 'Postal delivery now uses a mobile / computer application.');
      break;
    case 'state-services':
      acc.add('computer_basics', 0.3, 0.5, 'INFERRED', 'DOMAIN', 'Clerical state-service roles are computer-based.');
      break;
    default: break;
  }

  // 6) Subjects named in the notification --------------------------------------------------------
  const subjects = (job.education && job.education.subjects) || [];
  for (const sub of subjects) {
    const src = fs.subjects || null;
    if (/math/i.test(sub)) acc.add('quant', 0.5, 0.5, 'STATED', 'SUBJECTS', 'The notification requires Mathematics at the stated stage.', src);
    if (/english/i.test(sub)) acc.add('english', 0.5, 0.5, 'STATED', 'SUBJECTS', 'The notification requires English at the stated stage.', src);
  }

  // 7) Normalise scored weights --------------------------------------------------------------------
  const all = acc.list();
  const scored = all.filter((r) => !T.SKILLS[r.skill].selfCheck);
  const total = scored.reduce((s, r) => s + r.weight, 0) || 1;
  const requirements = scored.map((r) => ({
    skill: r.skill, label: T.label(r.skill), group: T.SKILLS[r.skill].group,
    weight: Math.round((r.weight / total) * 1000) / 1000,
    target: Math.min(0.95, r.target),
    kind: r.kind, basis: r.bases, rationale: r.rationale.join(' '), source: r.source,
  })).sort((a, b) => b.weight - a.weight);

  if (!requirements.length) notes.push('No skill-based selection stage could be identified; this post is decided mainly on eligibility and the notified criteria.');
  else if (!requirements.some((r) => r.kind === 'STATED')) notes.push('Every skill requirement here is inferred from the selection process. Confirm the exam sections in the official notification.');

  // Unique checkpoints
  const seen = new Set();
  const cps = checkpoints.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
  return { requirements, checkpoints: cps, exam: examInfo, notes, level_class: cls };
}

module.exports = { deriveRequirements, examFor, skillsForNode, levelClass };
