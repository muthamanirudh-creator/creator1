'use strict';
// Node-side LEXICAL engine: answers the Career Fit routes of the FastAPI AI/ML service when that service is asleep,
// unreachable, an older build, or still loading its transformer model.
//
//   GET  /match/engine         POST /match/role-fit     POST /match/resume-jd     POST /match/resume-jd/explain
//   GET  /rag/status           POST /rag/query          POST /rag/retrieve        GET  /rag/hybrid/status (empty)
//
// Honesty rules (same as the Python service): everything this file produces is labelled `fallback_mode: true`,
// `semantic: false`, `served_by: "node-fallback"` - it is NEVER presented as transformer/semantic matching.
// Skill matching = whole-word + alias matching over a curated vocabulary; "partial" = a closely related skill group
// (e.g. React -> JavaScript). RAG = BM25 over the resume passages + the career knowledge base, answered extractively
// (or written by Groq/Gemini when a key exists, then citation-checked). Data comes from ml_fallback_data.json, which is
// exported from ai-ml-service (parser.SKILL_VOCAB, skill_gap.ROLE_SKILLS/ALIASES, data/market_skills.json, rag_kb/*.md).

const DATA = require('./data/ml_fallback_data.json');

const STOP = new Set(('a an and are as at be by for from has have how i in is it its me my of on or our that the their this to was were what when which who will with you your do does did can could should would about into not no yes if than then so such too very just also more most other some any each both few over under again further once here there why while up down out off only own same s t'.split(' ')));

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round1 = (x) => Math.round((x + Number.EPSILON) * 10) / 10;
const round3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;
const tokens = (s) => (String(s || '').toLowerCase().match(/[a-z0-9+#.]+/g) || []).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t && !STOP.has(t) && t.length > 1);

// ---------------------------------------------------------------- skills ------------------------------------------
// canonical label -> extra spellings. Anything not listed is matched by its own label only.
const SYNONYMS = {
  'javascript': ['js', 'ecmascript', 'es6'], 'typescript': ['ts'], 'node.js': ['nodejs', 'node js', 'node'], 'react': ['react.js', 'reactjs', 'react js'],
  'next.js': ['nextjs', 'next js'], 'vue': ['vue.js', 'vuejs'], 'angular': ['angularjs'], 'express': ['express.js', 'expressjs'],
  'postgresql': ['postgres', 'psql'], 'mongodb': ['mongo'], 'mysql': ['my sql'], 'sql': ['structured query language'],
  'kubernetes': ['k8s'], 'docker': ['containers', 'containerization', 'dockerfile'], 'aws': ['amazon web services', 'ec2', 's3'], 'gcp': ['google cloud'],
  'azure': ['microsoft azure'], 'ci/cd': ['cicd', 'ci cd', 'continuous integration', 'continuous delivery', 'github actions', 'jenkins'],
  'machine learning': ['ml', 'scikit-learn', 'sklearn'], 'deep learning': ['dl', 'neural network', 'neural networks'],
  'nlp': ['natural language processing'], 'computer vision': ['cv', 'opencv'], 'rest api': ['rest apis', 'restful', 'rest', 'restful api', 'restful apis', 'api development'],
  'rest apis': ['rest api', 'restful', 'rest'], 'data structures': ['dsa', 'data structures and algorithms', 'data structures & algorithms'],
  'data structures & algorithms': ['dsa', 'data structures', 'algorithms'], 'algorithms': ['dsa'], 'oop': ['object oriented', 'object-oriented', 'oops'],
  'git': ['github', 'gitlab', 'version control'], 'power bi': ['powerbi'], 'excel': ['ms excel', 'microsoft excel', 'spreadsheets'],
  'data visualization': ['data visualisation', 'matplotlib', 'seaborn', 'dashboards'], 'statistics': ['statistical', 'hypothesis testing'],
  'html': ['html5'], 'css': ['css3', 'tailwind', 'bootstrap'], 'c++': ['cpp'], 'c#': ['csharp'], 'linux': ['ubuntu', 'unix'],
  'testing/unit testing': ['unit testing', 'unit tests', 'jest', 'pytest', 'junit', 'testing'], 'testing': ['unit testing', 'jest', 'pytest', 'junit'],
  'system design': ['low level design', 'high level design', 'hld', 'lld'], 'microservices': ['micro services', 'micro-services'],
  'networking': ['tcp/ip', 'computer networks', 'dns'], 'penetration testing': ['pentest', 'pen testing'], 'figma': [], 'terraform': ['iac', 'infrastructure as code'],
  'monitoring': ['prometheus', 'grafana'], 'a/b testing': ['ab testing', 'a b testing'], 'pandas': [], 'numpy': [], 'python': ['py'],
};
// Related-skill groups: owning one is partial evidence for the others (never "matched").
const RELATED = [
  ['javascript', 'typescript', 'node.js', 'react', 'next.js', 'vue', 'angular', 'express', 'html', 'css'],
  ['python', 'django', 'flask', 'fastapi', 'pandas', 'numpy', 'scikit-learn', 'machine learning'],
  ['sql', 'mysql', 'postgresql', 'sqlite', 'mongodb', 'redis', 'firebase', 'databases'],
  ['docker', 'kubernetes', 'ci/cd', 'terraform', 'aws', 'azure', 'gcp', 'linux', 'bash', 'jenkins'],
  ['machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow', 'statistics', 'data science'],
  ['java', 'spring boot', 'kotlin', 'oop'], ['data structures', 'algorithms', 'dsa', 'data structures & algorithms', 'system design'],
  ['rest api', 'rest apis', 'graphql', 'microservices', 'express', 'node.js'], ['excel', 'power bi', 'tableau', 'data visualization', 'sql', 'statistics'],
  ['git', 'github'], ['testing', 'testing/unit testing', 'ci/cd'],
];

let _vocab = null;
function vocabulary() {
  if (_vocab) return _vocab;
  const labels = new Map();                       // key -> display label
  // Composite market labels ("Docker/Kubernetes", "Python/Java for Automation") are requirement NAMES, not skills a resume
  // or job description lists; detecting them would invent skills. Their halves are matched separately (see reqTest).
  const KEEP_COMPOSITE = new Set(['ci/cd', 'testing/unit testing', 'data structures & algorithms', 'a/b testing', 'tcp/ip']);
  const add = (l) => {
    const t = String(l).trim(); const k = key(t);
    if (!k || k.length < 2 || labels.has(k)) return;
    if (/[\/&]|\bfor\b/i.test(t) && !KEEP_COMPOSITE.has(t.toLowerCase())) return;
    labels.set(k, t);
  };
  // Proper-cased sources first so the display label is "Docker" / "SQL", not "docker" / "sql".
  Object.values(DATA.role_skills || {}).forEach((a) => a.forEach(add));
  Object.values((DATA.market && DATA.market.roles) || {}).forEach((r) => (r.skills || []).forEach((s) => add(s.skill)));
  (DATA.archetypes || []).forEach((a) => (a.core_skills || []).forEach(add));
  const UP = new Set(['sql', 'aws', 'gcp', 'css', 'html', 'nlp', 'oop', 'llm', 'dsa', 'ci/cd', 'xml', 'cv', 'api', 'ui', 'ux']);
  const pretty = (l) => (UP.has(l) ? l.toUpperCase() : /^[a-z]/.test(l) && !/[.+#]/.test(l) ? l.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : l);
  (DATA.skill_vocab || []).forEach((l) => add(pretty(l)));
  Object.keys(SYNONYMS).forEach((l) => add(pretty(l)));
  _vocab = [...labels.entries()].map(([k, label]) => {
    const spellings = new Set([label.toLowerCase(), ...(SYNONYMS[label.toLowerCase()] || []), ...(SYNONYMS[k] || [])]);
    // "A & B", "A/B" labels: each half is also a spelling (e.g. "Testing/Unit Testing", "Data Structures & Algorithms").
    label.split(/\s*[\/&]\s*|\s+and\s+/i).forEach((p) => { if (p.trim().length > 2) spellings.add(p.trim().toLowerCase()); });
    const rx = [...spellings].filter(Boolean).sort((a, b) => b.length - a.length).map((s) => esc(s).replace(/\s+/g, '[\\s\\-]+'));
    return { key: k, label, re: new RegExp(`(?<![a-z0-9+#])(?:${rx.join('|')})(?![a-z0-9+#]|\\.[a-z0-9])`, 'i') };
  });
  return _vocab;
}
const canonLabel = (s) => { const k = key(s); const v = vocabulary().find((x) => x.key === k); return v ? v.label : String(s).trim(); };

function detectSkills(text, extra = []) {
  const found = new Map();
  const t = String(text || '');
  if (t.trim()) for (const v of vocabulary()) if (v.re.test(t)) found.set(v.key, v.label);
  for (const s of extra || []) { const l = String(s || '').trim(); if (l && l.length < 60) found.set(key(l), canonLabel(l)); }
  return [...found.values()];
}

// ---------------------------------------------------------------- roles -------------------------------------------
let _roles = null;
function roleCatalog() {
  if (_roles) return _roles;
  const cat = new Map();
  const entry = (name) => { const k = norm(name); if (!cat.has(k)) cat.set(k, { name: String(name).trim(), aliases: new Set(), skills: new Map() }); return cat.get(k); };
  const addSkill = (e, label, w) => { const k = key(label); if (k && (!e.skills.has(k) || w > e.skills.get(k).w)) e.skills.set(k, { label: canonLabel(label), w }); };
  for (const [role, info] of Object.entries((DATA.market && DATA.market.roles) || {})) {
    const e = entry(role); (info.aliases || []).forEach((a) => e.aliases.add(norm(a)));
    (info.skills || []).forEach((s) => addSkill(e, s.skill, Number(s.demand || 50) / 100));
  }
  for (const [role, skills] of Object.entries(DATA.role_skills || {})) {
    const e = entry(role.replace(/\b\w/g, (c) => c.toUpperCase())); skills.forEach((s, i) => addSkill(e, s, 0.85 - 0.02 * i));
  }
  for (const [alias, canon] of Object.entries(DATA.aliases || {})) entry(canon).aliases.add(norm(alias));
  for (const a of DATA.archetypes || []) {
    const e = entry(a.title); e.aliases.add(norm(String(a.id || '').replace(/-/g, ' ')));
    (a.core_skills || []).forEach((s, i) => addSkill(e, s, 0.8 - 0.02 * i));
  }
  _roles = [...cat.values()];
  return _roles;
}
function resolveRole(query) {
  const q = norm(query);
  const none = { role: null, method: 'none', similarity: 0, matched_name: null };
  if (!q) return none;
  const roles = roleCatalog();
  const whole = (needle, hay) => needle.length >= 3 && new RegExp(`(?<![a-z0-9])${esc(needle)}(?![a-z0-9])`).test(hay);
  let best = null, bestLen = 0;
  const byName = roles.find((r) => norm(r.name) === q);                       // an exact role NAME beats another role's alias
  if (byName) return { role: byName.name, method: 'exact', similarity: 1, matched_name: byName.name };
  const byAlias = roles.find((r) => r.aliases.has(q));
  if (byAlias) return { role: byAlias.name, method: 'alias', similarity: 1, matched_name: byAlias.name };
  for (const r of roles) {
    for (const n of [norm(r.name), ...r.aliases]) {
      if (!n) continue;
      if ((whole(n, q) || whole(q, n)) && n.length > bestLen) { best = r; bestLen = n.length; }
    }
  }
  if (best) return { role: best.name, method: 'alias', similarity: 0.9, matched_name: best.name };
  // token-overlap (Jaccard) over role names - deterministic and conservative
  const qt = new Set(tokens(q)); let score = 0;
  for (const r of roles) {
    const rt = new Set(tokens([r.name, ...r.aliases].join(' ')));
    const inter = [...qt].filter((t) => rt.has(t)).length;
    const j = inter / Math.max(1, new Set([...qt, ...rt]).size);
    if (inter >= 1 && j > score) { score = j; best = r; }
  }
  if (best && score >= 0.34) return { role: best.name, method: 'lexical', similarity: round3(score), matched_name: best.name };
  return none;
}
function roleRequirements(role, limit = 14) {
  const r = roleCatalog().find((x) => x.name === role);
  if (!r) return [];
  // The merged catalogue holds near-duplicates ("Bash" + "Bash/Scripting", "Monitoring" + "Monitoring (Prometheus/Grafana)"):
  // keep the first (highest-weight) and drop later ones that share a part with it.
  const seen = new Set(), out = [];
  for (const sk of [...r.skills.values()].sort((a, b) => b.w - a.w)) {
    const ks = reqParts(sk.label.replace(/\s*\(.*?\)\s*/g, ' ').trim()).map(key).filter(Boolean);
    if (ks.some((k) => seen.has(k))) continue;
    ks.forEach((k) => seen.add(k)); out.push(sk.label);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- passages ----------------------------------------
function splitPassages(text, max = 400) {
  const out = [];
  for (const block of String(text || '').replace(/\r/g, '').split(/\n+/)) {
    const b = block.replace(/^[\s\-\u2022*\u25AA\u25CF]+/, '').trim();
    if (b.length < 12) continue;
    if (b.length <= max) { out.push(b); continue; }
    let cur = '';
    for (const s of b.split(/(?<=[.!?])\s+/)) { if ((cur + ' ' + s).length > max && cur) { out.push(cur.trim()); cur = s; } else cur += ' ' + s; }
    if (cur.trim().length >= 12) out.push(cur.trim());
  }
  return out;
}

// ---------------------------------------------------------------- matching ----------------------------------------
function relatedOwned(skillKey, ownedKeys) {
  for (const g of RELATED) {
    const gk = g.map(key);
    if (gk.includes(skillKey)) { const hit = gk.find((k) => k !== skillKey && ownedKeys.has(k)); if (hit) return hit; }
  }
  return null;
}
// A requirement may be a composite label ("Docker/Kubernetes"): it is satisfied by ANY of its parts.
function reqParts(req) {
  const whole = key(req);
  if (vocabulary().some((x) => x.key === whole)) return [req];
  const parts = String(req).split(/\s*[\/&,]\s*|\s+and\s+|\s+or\s+/i).map((p) => p.replace(/\s+for\s+.*$/i, '').trim()).filter((p) => p.length > 1);
  return parts.length > 1 ? parts : [req];
}
function matchRequirements(requirements, detected, resumeText) {
  const owned = new Map(detected.map((s) => [key(s), s]));
  const passages = splitPassages(resumeText);
  const results = requirements.map((req) => {
    const parts = reqParts(req);
    let k = key(req), passage = null, ownedKey = null;
    for (const part of parts) {
      const pk = key(part); const v = vocabulary().find((x) => x.key === pk);
      const ps = passages.find((p) => (v ? v.re.test(p) : norm(p).includes(norm(part)))) || null;
      if (owned.has(pk) || ps) { k = pk; passage = ps; ownedKey = owned.has(pk) ? pk : null; break; }
    }
    if (ownedKey || passage) {
      return { skill: req, status: 'matched', match_type: 'exact', similarity: 1, confidence: 1, matched_with: owned.get(ownedKey || k) || req, passage,
        evidence: passage ? 'Named in your resume (keyword match).' : 'Listed in your skills.' };
    }
    const rel = parts.map((p) => relatedOwned(key(p), new Set(owned.keys()))).find(Boolean) || null;
    if (rel) return { skill: req, status: 'partial', match_type: 'related', similarity: 0.5, confidence: 0.5, matched_with: owned.get(rel), passage: null,
      evidence: `Related skill on your resume: ${owned.get(rel)} (transferable, not the same skill).`, closest_resume_skill: owned.get(rel) };
    return { skill: req, status: 'missing', match_type: 'missing', similarity: 0, confidence: 0, matched_with: null, passage: null, evidence: 'No mention found in your resume.', closest_resume_skill: null };
  });
  return { results, passages: passages.length, thresholds: { mode: 'keyword', related: 0.5 } };
}

const ENGINE_NOTE = 'Built-in keyword engine (the transformer AI/ML service is not answering). Results use exact skill names and related-skill groups, not meaning-based similarity.';
const engineInfo = () => ({ ready: true, state: 'ready', engine: 'node-lexical', model: 'node-lexical-bm25 (fallback)', device: 'node', dimension: null, fallback_mode: true, semantic: false,
  strict: false, mode: 'lexical-fallback', self_test: null, cache: { size: 0, hits: 0, misses: 0 }, error: ENGINE_NOTE, error_code: 'NODE_LEXICAL_FALLBACK', served_by: 'node-fallback' });

function docSimilarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const fa = new Map(), fb = new Map();
  ta.forEach((t) => fa.set(t, (fa.get(t) || 0) + 1)); tb.forEach((t) => fb.set(t, (fb.get(t) || 0) + 1));
  let dot = 0, na = 0, nb = 0;
  for (const [t, c] of fa) { const w = 1 + Math.log(c); na += w * w; if (fb.has(t)) dot += w * (1 + Math.log(fb.get(t))); }
  for (const c of fb.values()) { const w = 1 + Math.log(c); nb += w * w; }
  return dot / Math.sqrt(na * nb || 1);
}

// ---------------------------------------------------------------- routes ------------------------------------------
function roleFit(body) {
  const resumeText = String(body.resume_text || '').trim(), roleQuery = String(body.target_role || '').trim(), jd = String(body.jd_text || '').trim();
  const resolution = roleQuery ? resolveRole(roleQuery) : { role: null, method: 'none', similarity: 0, matched_name: null };
  let requirements, source;
  if (jd) { requirements = detectSkills(jd); source = 'job-description'; }
  else { requirements = roleRequirements(resolution.role, 14); source = requirements.length ? 'role-catalogue' : 'unresolved'; }
  const detected = detectSkills(resumeText, Array.isArray(body.current_skills) ? body.current_skills : []);
  const base = { target_role: roleQuery, resolved_role: resolution.role, role_resolution: resolution, requirements_source: source, served_by: 'node-fallback' };
  if (!requirements.length) {
    return { ...base, fit_pct: null, need: [], matched: [], partial: [], missing: [], skills: [], detected_skills: detected.slice(0, 40), matching_engine: engineInfo(),
      message: roleQuery ? `No known role matches \u201c${roleQuery}\u201d closely enough. Pick a nearby role, or paste a job description to match against.` : 'Enter a target role (or paste a job description) to see your live fit.' };
  }
  const outcome = matchRequirements(requirements, detected, resumeText);
  const r = outcome.results;
  const matched = r.filter((x) => x.status === 'matched').map((x) => x.skill), partial = r.filter((x) => x.status === 'partial').map((x) => x.skill), missing = r.filter((x) => x.status === 'missing').map((x) => x.skill);
  const credit = matched.length + r.filter((x) => x.status === 'partial').reduce((s, x) => s + x.confidence, 0);
  return { ...base, fit_pct: round1(100 * credit / Math.max(1, r.length)), need: requirements, matched, partial, missing,
    skills: r.map((x) => ({ skill: x.skill, status: x.status, match_type: x.match_type, similarity: x.similarity, matched_with: x.matched_with, passage: x.passage, evidence: x.evidence })),
    detected_skills: detected.slice(0, 40),
    document_similarity: resumeText && jd ? round1(100 * docSimilarity(resumeText, jd)) : null, jd_requirement_coverage: resumeText && jd ? round1(100 * credit / Math.max(1, r.length)) : null,
    matching_engine: { ...engineInfo(), thresholds: outcome.thresholds, resume_passages: outcome.passages } };
}

function resumeJd(body) {
  const resume = String(body.resume_text || ''), jd = String(body.jd_text || '');
  const sim = round1(100 * docSimilarity(resume, jd));
  const jdSkills = detectSkills(jd), have = detectSkills(resume);
  const m = matchRequirements(jdSkills, have, resume).results;
  const cov = jdSkills.length ? round1(100 * (m.filter((x) => x.status === 'matched').length + 0.5 * m.filter((x) => x.status === 'partial').length) / jdSkills.length) : null;
  return { semantic_similarity: sim, jd_requirement_coverage: cov, backend: 'node-lexical', embedding_engine: 'lexical-hash', engine: engineInfo(), confidence: 'low', fallback_mode: true, served_by: 'node-fallback' };
}
function resumeJdExplain(body) {
  const resume = String(body.resume_text || ''), jd = String(body.jd_text || '');
  const jdSkills = Array.isArray(body.jd_skills) && body.jd_skills.length ? body.jd_skills : detectSkills(jd);
  const have = detectSkills(resume, Array.isArray(body.resume_skills) ? body.resume_skills : []);
  const out = matchRequirements(jdSkills, have, resume).results;
  const item = (r) => ({ skill: r.skill, confidence: r.confidence, evidence: r.evidence, match_type: r.match_type, similarity: r.similarity, matched_with: r.matched_with, evidence_passage: r.passage, closest_resume_skill: r.closest_resume_skill || null });
  const matched = out.filter((r) => r.status === 'matched').map(item), partial = out.filter((r) => r.status === 'partial').map(item), missing = out.filter((r) => r.status === 'missing').map(item);
  const total = Math.max(1, out.length);
  const pair = resume.trim() && jd.trim() ? { sim: round1(100 * docSimilarity(resume, jd)) } : null;
  return { matched_skills: matched, partially_matched_skills: partial, missing_skills: missing,
    skill_coverage_score: round1(100 * (matched.length + partial.reduce((s, p) => s + p.confidence, 0)) / total), semantic_similarity: pair ? pair.sim : null,
    jd_requirement_coverage: pair ? round1(100 * (matched.length + partial.length * 0.5) / total) : null, backend: 'node-lexical', embedding_engine: 'lexical-hash', engine: engineInfo(), fallback_mode: true,
    thresholds: { mode: 'keyword' }, note: ENGINE_NOTE, served_by: 'node-fallback',
    evidence: { summary: `Keyword match: ${matched.length} matched, ${partial.length} related, ${missing.length} missing of ${out.length} requirements.`, fallback_mode: true } };
}

// ---------------------------------------------------------------- RAG ---------------------------------------------
let _kb = null;
function knowledgeBase() {
  if (_kb) return _kb;
  const chunks = [];
  const roleTitles = new Set();
  for (const r of roleCatalog()) {
    const skills = [...r.skills.values()].sort((a, b) => b.w - a.w);
    if (!skills.length) continue;
    roleTitles.add(r.name);
    chunks.push({ source: 'roadmap', title: `${r.name}: core skills`, text: `${r.name} \u2014 skills employers ask for, most in-demand first: ${skills.map((s) => s.label).join(', ')}.${r.aliases.size ? ` Also called: ${[...r.aliases].filter(Boolean).slice(0, 5).join(', ')}.` : ''}`, role: r.name });
  }
  for (const a of DATA.archetypes || []) {
    if (a.milestones && a.milestones.length) chunks.push({ source: 'roadmap', title: `${a.title}: milestones`, text: `${a.title} learning milestones: ${[].concat(a.milestones).map((m) => (typeof m === 'string' ? m : (m.title || m.name || JSON.stringify(m)))).join('; ')}.`, role: a.title });
  }
  for (const [file, md] of Object.entries(DATA.kb || {})) {
    let head = file.replace(/\.md$/, '').replace(/[-_]/g, ' ');
    for (const sec of String(md).split(/\n(?=##\s)/)) {
      const m = /^##\s+(.+)\n?/.exec(sec); const title = m ? m[1].trim() : head; const body = sec.replace(/^#+\s+.+\n?/, '').trim();
      if (body.length > 30) chunks.push({ source: 'guidance', title, text: body });
    }
  }
  _kb = chunks.map((c, i) => ({ ...c, id: `kb-${i}`, tokens: tokens(`${c.title} ${c.text}`) }));
  return _kb;
}
const SOURCE_LABELS = { resume: 'Your resume', roadmap: 'Career roadmap', guidance: 'Placement guidance', jd: 'Job description' };

function bm25(qTokens, docs, k1 = 1.4, b = 0.75) {
  const n = docs.length; if (!n || !qTokens.length) return docs.map(() => 0);
  const avg = Math.max(1, docs.reduce((s, d) => s + d.length, 0) / n); const df = new Map();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  return docs.map((d) => {
    const tf = new Map(); d.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1)); let s = 0;
    for (const t of new Set(qTokens)) { const f = tf.get(t); if (!f) continue; const idf = Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5)); s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg)); }
    return s;
  });
}
function retrieve(body) {
  const t0 = Date.now();
  const q = String(body.question || '').trim(); const scope = ['all', 'resume', 'knowledge'].includes(body.scope) ? body.scope : 'all';
  const topK = Math.max(1, Math.min(12, Number(body.top_k) || 5));
  const resume = String(body.resume_text || ''), jd = String(body.jd_text || '');
  const role = resolveRole(body.target_role || q);
  const pool = [];
  if (scope !== 'knowledge') {
    splitPassages(resume).forEach((p, i) => pool.push({ id: `resume-${i}`, source: 'resume', title: 'Resume', text: p, tokens: tokens(p) }));
    splitPassages(jd).forEach((p, i) => pool.push({ id: `jd-${i}`, source: 'jd', title: 'Job description', text: p, tokens: tokens(p) }));
  }
  const resumeCount = pool.length;
  if (scope !== 'resume') knowledgeBase().forEach((c) => pool.push(c));
  // Query expansion: skill aliases the question mentions (e.g. "k8s" -> kubernetes), and the resolved role's name.
  const qt = tokens(q); detectSkills(q).forEach((s) => tokens(s).forEach((t) => qt.push(t))); if (role.role) tokens(role.role).forEach((t) => qt.push(t));
  const scores = bm25(qt, pool.map((d) => d.tokens)); const max = Math.max(...scores, 0);
  const ranked = pool.map((d, i) => ({ d, s: scores[i] + (role.role && d.role === role.role ? max * 0.15 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  let picked = ranked.slice(0, topK);
  if (scope === 'all') {   // questions about "my resume" must see the student's own lines even when knowledge passages score higher
    const own = ranked.filter((x) => x.d.source === 'resume' || x.d.source === 'jd').slice(0, 2);
    for (const o of own) if (!picked.includes(o)) { picked = picked.slice(0, Math.max(1, topK - 1)); picked.push(o); }
    const personal = /\b(my|i|me|mine|resume|cv|projects?|experience|have)\b/i.test(q);
    picked.sort((a, b) => (personal ? (Number(b.d.source === 'resume') - Number(a.d.source === 'resume')) : 0) || b.s - a.s);
  }
  const hits = picked
    .map((x, i) => ({ n: i + 1, id: x.d.id, source: x.d.source, source_label: SOURCE_LABELS[x.d.source] || x.d.source, title: x.d.title === 'Resume' ? '' : x.d.title, text: x.d.text, similarity: round3(max ? x.s / (max * 1.0001) : 0), score: round3(x.s) }));
  // Reject weak evidence: a single common-word overlap must not produce an "answer".
  const strong = hits.filter((h) => (h.similarity >= 0.25 || h.source === 'resume') && qt.length);
  return { hits: strong, info: { retrieval_ms: Date.now() - t0, resume_passages: resumeCount, kb_passages: pool.length - resumeCount, resolved_role: role.role, engine: 'node-lexical-bm25' } };
}
const CITE_RE = /\[(\d{1,2})\]/g;
async function ragQuery(body, deps = {}) {
  const q = String(body.question || '').trim();
  const scope = ['all', 'resume', 'knowledge'].includes(body.scope) ? body.scope : 'all';
  const warnings = ['Answered by the built-in keyword engine (the transformer AI/ML service is not answering), so retrieval is keyword-based, not semantic.'];
  if ((scope === 'all' || scope === 'resume') && !String(body.resume_text || '').trim()) warnings.push('No resume text was supplied, so nothing could be said about your own experience.');
  const { hits, info } = retrieve({ ...body, question: q, scope });
  const base = { question: q, sources: hits, retrieval: info, warnings, provider: null, llm_used: false, citations_used: [], citation_coverage: 0, served_by: 'node-fallback', fallback_mode: true };
  if (!hits.length) return { ...base, mode: 'no-evidence', grounded: false, answer: 'I could not find anything in your resume or the career knowledge base that answers this, so I will not guess. Try naming a skill, project or target role, or paste a job description.' };
  const extractive = () => ({ ...base, mode: 'extractive', grounded: true, citations_used: hits.slice(0, 4).map((h) => h.n),
    answer: ['Here are the most relevant passages found for your question (no generated summary):', ...hits.slice(0, 4).map((h) => `- ${h.text} [${h.n}]`)].join('\n') });
  if (typeof deps.callLlm === 'function') {
    try {
      const ctx = hits.map((h) => `[${h.n}] (${h.source_label}: ${h.title || 'untitled'})\n${h.text}`).join('\n\n').slice(0, 6000);
      const text = String(await deps.callLlm('You answer a student\'s career question using ONLY the numbered sources. Cite every claim like [1]. If the sources do not contain the answer, say so. Plain text, under 180 words.',
        `SOURCES:\n<<<\n${ctx}\n>>>\n\n${body.target_role ? `Target role: ${body.target_role}\n` : ''}Student's question: ${q}\n\nAnswer using only the sources, with [n] citations.`) || '').trim();
      const valid = new Set(hits.map((h) => h.n)); const cited = [...text.matchAll(CITE_RE)].map((m) => Number(m[1]));
      const used = [...new Set(cited.filter((n) => valid.has(n)))].sort((a, b) => a - b);
      if (text.length >= 30 && used.length) return { ...base, sources: hits, mode: 'llm', grounded: true, answer: text.replace(CITE_RE, (m, n) => (valid.has(Number(n)) ? m : '')), provider: 'node-fallback-llm', llm_used: true, citations_used: used, citation_coverage: 1 };
    } catch (_) { /* extractive answer below */ }
  }
  return extractive();
}
function ragStatus() {
  const kb = knowledgeBase(); const by = {}; kb.forEach((c) => { by[c.source] = (by[c.source] || 0) + 1; });
  return { knowledge_base: { passages: kb.length, by_source: by, fingerprint: 'node-lexical', embedded: false, embed_seconds: 0, kb_dir: 'built-in', kb_dir_exists: true },
    engine: engineInfo(), settings: { top_k: 5, min_similarity: 0.25, max_context_chars: 6000, dense_weight: 0, lexical_weight: 1 }, served_by: 'node-fallback' };
}

module.exports = { engineInfo, roleFit, resumeJd, resumeJdExplain, ragQuery, ragStatus, retrieve, detectSkills, resolveRole, roleRequirements, matchRequirements, docSimilarity };
