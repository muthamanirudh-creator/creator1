'use strict';
// Bridge skill taxonomy.
//
// One shared vocabulary that three different worlds are mapped into:
//   1. Campus evidence   (aptitude topics, digital-twin competencies, interview/quiz results)
//   2. Resume / self-declared skills
//   3. Government-job requirements (derived in requirements.js)
//
// Levels are always 0..1. `hours` is a rough, deliberately conservative "zero to exam-ready" study
// budget used only for the readiness/feasibility estimate; it is never presented as a fact.

const GROUPS = { EXAM: 'Exam aptitude', TECH: 'Technical / domain', SOFT: 'Communication', CHECK: 'Self-check' };

// aliases: resume / free-text terms (lower-case; matched on word boundaries by resumeParser)
// syllabus: keywords used to link a skill to Exam Lab syllabus node titles
// campus:   how Campus data maps in (aptitude regexes are tested against "<group> <topic>")
const SKILLS = {
  quant: {
    label: 'Quantitative aptitude', group: 'EXAM', hours: 120,
    aliases: ['quantitative aptitude', 'quantitative', 'arithmetic', 'mathematics', 'maths', 'numerical ability', 'aptitude'],
    syllabus: ['quantitative', 'arithmetic', 'numerical', 'mathematics'],
    campus: { aptitude: /arithmetical|percentage|profit|interest|ratio|average|ages|time and|trains|boats|pipes|h\.c\.f|simplification|square roots|partnership|chain rule|alligation|area|probability|number system|decimal|surds|logarithm|volume|permutation|stocks|discount|races|clocks/i },
    practice: 'Arithmetical Ability (Campus aptitude bank)',
  },
  reasoning: {
    label: 'Logical reasoning', group: 'EXAM', hours: 90,
    aliases: ['logical reasoning', 'reasoning', 'analytical reasoning', 'puzzles', 'logical thinking', 'general intelligence'],
    syllabus: ['reasoning', 'intelligence', 'logical'],
    campus: { aptitude: /logical|reasoning|alphabet|coding|decoding|blood relation|direction sense|ranking|syllogism|series|classification|inserting the missing|deduction|statement/i },
    practice: 'Logical Reasoning (Campus aptitude bank)',
  },
  english: {
    label: 'English language', group: 'EXAM', hours: 90,
    aliases: ['english', 'english language', 'grammar', 'vocabulary', 'comprehension', 'ielts', 'toefl', 'verbal ability'],
    syllabus: ['english', 'language', 'comprehension', 'verbal'],
    campus: { aptitude: /verbal|synonym|antonym|idiom|one word|sentence|spotting errors|para jumble|analogy/i },
    practice: 'Verbal Ability (Campus aptitude bank)',
  },
  gk: {
    label: 'General awareness', group: 'EXAM', hours: 100,
    aliases: ['general awareness', 'general knowledge', 'current affairs', 'polity', 'indian history', 'geography', 'economy awareness', 'banking awareness'],
    syllabus: ['awareness', 'general knowledge', 'current'],
    campus: {},
    practice: 'Daily current-affairs notes and the verified syllabus topics in Exam Lab',
  },
  data_interp: {
    label: 'Data interpretation', group: 'EXAM', hours: 60,
    aliases: ['data interpretation', 'data analysis', 'charts and graphs', 'tabulation'],
    syllabus: ['data interpretation'],
    campus: { aptitude: /tabulation|pie chart|bar graph|line graph|data interpretation/i },
    practice: 'Tabulation and Pie Chart topics (Campus aptitude bank)',
  },
  descriptive_writing: {
    label: 'Descriptive writing', group: 'SOFT', hours: 40,
    aliases: ['essay writing', 'report writing', 'technical writing', 'content writing', 'drafting', 'letter writing', 'precis'],
    syllabus: ['descriptive', 'essay', 'letter'],
    campus: {}, practice: 'Timed essay and letter drafts; use the Campus resume and mirror-mentor tools for feedback',
  },
  interview_skills: {
    label: 'Interview & presentation', group: 'SOFT', hours: 30,
    aliases: ['interview', 'presentation', 'public speaking', 'communication skills', 'leadership', 'team lead', 'debate'],
    syllabus: ['interview', 'personality'],
    campus: { competency: /communication|confidence|problem solving|star|interview|presentation/i, resultTypes: ['INTERVIEW', 'MIRROR_MENTOR'] },
    practice: 'AI Mock Interview and MirrorMentor in the Campus portal',
  },
  typing: {
    label: 'Typing speed', group: 'SOFT', hours: 30,
    aliases: ['typing', 'typing speed', 'wpm', 'data entry', 'keyboarding'],
    syllabus: ['typing'],
    campus: {}, practice: 'Daily 20-minute typing drills; track words per minute',
  },
  stenography: {
    label: 'Stenography', group: 'SOFT', hours: 150,
    aliases: ['stenography', 'shorthand', 'steno', 'dictation'],
    syllabus: ['steno', 'shorthand'],
    campus: {}, practice: 'Shorthand dictation practice at the notified speed',
  },
  computer_basics: {
    label: 'Computer proficiency', group: 'TECH', hours: 40,
    aliases: ['ms office', 'microsoft office', 'ms word', 'ms excel', 'excel', 'powerpoint', 'computer fundamentals', 'computer basics', 'ccc', 'dca', 'o level', 'internet', 'email'],
    syllabus: ['computer'],
    campus: {}, practice: 'Office suite basics, file handling and internet safety',
  },
  it_programming: {
    label: 'Programming & software', group: 'TECH', hours: 200,
    aliases: ['python', 'java', 'c++', 'c programming', 'javascript', 'typescript', 'node.js', 'react', 'html', 'css', 'programming', 'software development', 'data structures', 'algorithms', 'dsa', 'oop', 'git', 'coding'],
    syllabus: ['programming', 'software', 'computer science', 'information technology'],
    campus: { aptitude: /dsa|algorithm|complexity|array|stack|queue|recursion|linked list|sorting|searching|dynamic programming|greedy|graph|hashing|bit manipulation/i, competencyCategories: ['Data Structures', 'Algorithms', 'Python', 'OOP', 'Web Development', 'Operating Systems'] },
    practice: 'DSA, Python and Web Development practice in the Campus portal',
  },
  it_data: {
    label: 'Databases & analytics', group: 'TECH', hours: 120,
    aliases: ['sql', 'mysql', 'postgresql', 'mongodb', 'oracle', 'power bi', 'tableau', 'pandas', 'numpy', 'data science', 'machine learning', 'database', 'dbms', 'etl'],
    syllabus: ['database', 'data', 'analytics'],
    campus: { competencyCategories: ['SQL'] },
    practice: 'SQL practice and the Digital Twin diagnostic in the Campus portal',
  },
  it_networks_security: {
    label: 'Networks & security', group: 'TECH', hours: 140,
    aliases: ['networking', 'computer networks', 'cybersecurity', 'cyber security', 'linux', 'firewall', 'penetration testing', 'ccna', 'owasp', 'information security', 'network security', 'siem'],
    syllabus: ['network', 'security', 'cyber'],
    campus: { competencyCategories: ['Networks'] },
    practice: 'Networks diagnostic in the Campus portal; CCNA-style fundamentals',
  },
  eng_core: {
    label: 'Engineering fundamentals', group: 'TECH', hours: 220,
    aliases: ['engineering', 'b.tech', 'btech', 'b.e.', 'engineering mathematics', 'engineering drawing', 'maintenance', 'iti trade'],
    syllabus: ['engineering', 'technical'],
    campus: {}, practice: 'Core subjects of your discipline, as listed in the notification syllabus',
  },
  eng_electrical: {
    label: 'Electrical engineering', group: 'TECH', hours: 220,
    aliases: ['electrical', 'electrical engineering', 'circuit analysis', 'power systems', 'transformers', 'plc', 'electrical machines', 'switchgear', 'wiring'],
    syllabus: ['electrical'], campus: {}, practice: 'Electrical machines, circuits and power systems',
  },
  eng_mechanical: {
    label: 'Mechanical engineering', group: 'TECH', hours: 220,
    aliases: ['mechanical', 'mechanical engineering', 'thermodynamics', 'fluid mechanics', 'cad', 'solidworks', 'manufacturing', 'machine design', 'welding', 'fitter'],
    syllabus: ['mechanical'], campus: {}, practice: 'Thermodynamics, strength of materials and manufacturing',
  },
  eng_civil: {
    label: 'Civil engineering', group: 'TECH', hours: 220,
    aliases: ['civil', 'civil engineering', 'surveying', 'structural analysis', 'concrete', 'staad', 'autocad', 'construction'],
    syllabus: ['civil'], campus: {}, practice: 'Structures, surveying and construction materials',
  },
  eng_electronics: {
    label: 'Electronics & communication', group: 'TECH', hours: 220,
    aliases: ['electronics', 'embedded', 'vlsi', 'microcontroller', 'arduino', 'signal processing', 'communication systems', 'iot', 'instrumentation'],
    syllabus: ['electronics', 'communication'], campus: {}, practice: 'Analog/digital electronics and communication systems',
  },
  science_research: {
    label: 'Research methods', group: 'TECH', hours: 160,
    aliases: ['research', 'publications', 'thesis', 'laboratory', 'experimental design', 'research methodology', 'spectroscopy', 'peer reviewed', 'literature review'],
    syllabus: ['research', 'science'], campus: {}, practice: 'Research design and scientific writing',
  },
  stats: {
    label: 'Statistics', group: 'TECH', hours: 90,
    aliases: ['statistics', 'regression', 'hypothesis testing', 'probability', 'statistical analysis', 'anova'],
    syllabus: ['statistics'], campus: {}, practice: 'Descriptive and inferential statistics fundamentals',
  },
  banking_finance: {
    label: 'Banking & finance', group: 'TECH', hours: 90,
    aliases: ['banking', 'accounting', 'finance', 'tally', 'gst', 'taxation', 'financial analysis', 'economics', 'bookkeeping', 'audit'],
    syllabus: ['banking', 'economy', 'finance'], campus: {}, practice: 'Banking awareness, basic accounting and economy',
  },
  legal_awareness: {
    label: 'Legal & constitutional awareness', group: 'TECH', hours: 70,
    aliases: ['law', 'ipc', 'crpc', 'legal', 'constitution', 'indian penal code', 'criminal procedure'],
    syllabus: ['law', 'legal', 'constitution', 'polity'], campus: {}, practice: 'Constitution, criminal law basics',
  },
  physical_fitness: {
    label: 'Physical standards', group: 'CHECK', hours: 0, selfCheck: true,
    aliases: [], syllabus: [], campus: {}, practice: 'Check the exact measurements and events in the notification',
  },
};

const IDS = Object.keys(SKILLS);
const label = (id) => (SKILLS[id] ? SKILLS[id].label : id);
const isSkill = (id) => Object.prototype.hasOwnProperty.call(SKILLS, id);

// A tested technical skill is reasonable (but weaker) evidence of general computer proficiency.
const IMPLIES = {
  it_programming: { computer_basics: 0.7 },
  it_data: { computer_basics: 0.7 },
  it_networks_security: { computer_basics: 0.7 },
  data_interp: { quant: 0.6 },
};

// Self-declared proficiency labels the UI offers. Always treated as unverified.
const SELF_LEVELS = { none: 0, basic: 0.35, working: 0.6, strong: 0.8 };

// Words per minute -> typing level against the commonly notified 30–35 wpm English / 25 wpm Hindi floor.
function typingLevel(wpm) {
  const n = Number(wpm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.min(1, n / 45));
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Word-boundary-safe matcher that still works for terms like "c++", "node.js" and "b.tech".
function aliasRegex(alias) {
  const body = esc(alias).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9+#])${body}(?![a-z0-9+#])`, 'i');
}
const COMPILED = Object.fromEntries(IDS.map((id) => [id, SKILLS[id].aliases.map((a) => ({ alias: a, re: aliasRegex(a) }))]));

module.exports = { GROUPS, SKILLS, IDS, label, isSkill, IMPLIES, SELF_LEVELS, typingLevel, COMPILED, aliasRegex };
