'use strict';
// Node-side, live-AI fallback for the FastAPI AI/ML service.
//
// Why this exists: every AI/ML tab calls the FastAPI service through the /api/ai-ml gateway in server.js. When that
// service cannot answer (asleep, crashed, wrong link, service-token mismatch, older build without the route), the
// browser used to drop straight to its *deterministic* offline result and show "Live AI/ML enrichment is temporarily
// unavailable". The gateway now calls serveFallback() first, so the student still gets the same response shape from
// this process - ranking computed exactly like ai-ml-service/app/services/career_path.py, plus a live Groq/Gemini
// rationale when a provider key is configured (the same keys /api/ai uses).
//
// The FastAPI service stays the primary path; nothing is removed. Responses served from here carry
// `served_by: "node-fallback"` so it is always visible where an answer came from.

let ARCHETYPES = null;
function archetypes() {
  if (ARCHETYPES) return ARCHETYPES;
  // Own copy (kept identical to ai-ml-service/data/career_paths.json by tests) because Vercel builds exclude ai-ml-service/.
  // A static require() lets Vercel's file tracing bundle the JSON with the function.
  ARCHETYPES = require('./data/career_paths.json').archetypes;
  return ARCHETYPES;
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6; };
// Python's round(x, 1) on the same values (used by the original) - JS has no banker's rounding, so mirror via toFixed on an epsilon-free path.
const pyFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));   // Python prints 36.0, JS prints 36
const round1 = (x) => Math.round((x + Number.EPSILON) * 10) / 10;

function evidenceFor(s, coverage, masteryBonus, interestBoost) {
  const coveragePts = round1(100 * 0.6 * coverage);
  const masteryPts = round1(100 * 0.4 * masteryBonus);
  const total = s.matched_skills.length + s.missing_skills.length;
  const factors = [
    { label: 'Core-skill coverage',
      detail: `You have ${s.matched_skills.length} of ${total} core skills this track needs (weighted 60% of the score).`,
      contribution_pct: coveragePts, direction: coveragePts > 0 ? 'supports' : 'neutral' },
    { label: 'Mastery depth on matched skills',
      detail: 'Average verified mastery (from Adaptive Diagnostic results where available, 0.6 assumed for skills you\'ve listed but not been tested on) across the skills you already have (weighted 40% of the score).',
      contribution_pct: masteryPts, direction: masteryPts > 0 ? 'supports' : 'neutral' },
  ];
  if (interestBoost) {
    factors.push({ label: 'Stated interest match', detail: 'You named this track (or a close synonym) as your target interest.', contribution_pct: 15.0, direction: 'supports' });
  }
  const caveats = [];
  if (s.missing_skills.length > 0) {
    caveats.push(`Missing skills (${s.missing_skills.slice(0, 4).join(', ')}${s.missing_skills.length > 4 ? '\u2026' : ''}) are not yet verified \u2014 this score can't confirm you'd succeed in the role, only that your current profile overlaps with it.`);
  }
  if (masteryPts) caveats.push('Mastery values for skills without an Adaptive Diagnostic attempt are an unverified default (0.6), not a measured score.');
  return {
    recommendation: `${s.title} is your closest career-path match.`,
    confidence: s.confidence,
    method: 'Exact weighted sum: 60% core-skill overlap + 40% average mastery on matched skills (+15 flat if you named this as your target interest). No LLM or trained model is used for the ranking itself.',
    factors, caveats,
  };
}

function rank(body) {
  const skills = Array.isArray(body.current_skills) ? body.current_skills.slice(0, 200) : [];
  const skillSet = new Set(skills.map(norm).filter(Boolean));
  const mastery = {};
  if (body.topic_mastery && typeof body.topic_mastery === 'object' && !Array.isArray(body.topic_mastery)) {
    for (const [k, v] of Object.entries(body.topic_mastery)) mastery[norm(k)] = v;
  }
  let topN = Number.parseInt(body.top_n, 10);
  if (!Number.isFinite(topN)) topN = 3;
  topN = Math.max(1, Math.min(6, topN));

  const scored = archetypes().map((a) => {
    const core = a.core_skills.map(norm);
    const matchedIdx = core.map((s, i) => (skillSet.has(s) ? i : -1)).filter((i) => i >= 0);
    const missingIdx = core.map((s, i) => (skillSet.has(s) ? -1 : i)).filter((i) => i >= 0);
    const coverage = core.length ? matchedIdx.length / core.length : 0;
    const masteryBonus = core.length ? matchedIdx.reduce((sum, i) => sum + clamp01(core[i] in mastery ? mastery[core[i]] : 0.6), 0) / core.length : 0;
    return {
      id: a.id, title: a.title,
      confidence: round1(100 * (0.6 * coverage + 0.4 * masteryBonus)),
      matched_skills: matchedIdx.map((i) => a.core_skills[i]),
      missing_skills: missingIdx.map((i) => a.core_skills[i]),
      milestones: a.milestones,
      _coverage: coverage, _mastery: masteryBonus,
    };
  });

  const interestIds = new Set();
  const interest = norm(body.target_interest);   // whitespace-only interest is ignored, exactly like the Python fix
  if (interest) {
    for (const s of scored) {
      if (s.title.toLowerCase().includes(interest) || s.id.includes(interest)) { s.confidence = Math.min(100, s.confidence + 15); interestIds.add(s.id); }
    }
  }
  scored.sort((x, y) => y.confidence - x.confidence);   // Array.prototype.sort is stable, like Python's
  const top = scored.slice(0, topN);
  for (const s of top) {
    s.evidence = evidenceFor(s, s._coverage, s._mastery, interestIds.has(s.id));
    delete s._coverage; delete s._mastery;
  }
  return top;
}

const LLM_SYSTEM = 'You are a concise, encouraging career coach for campus placement students in India. ' +
  'In 2-3 sentences, explain why the given top career-path match fits the student\'s current skills, ' +
  'and name the single most valuable skill to learn next from the missing list. No markdown, no preamble, plain text only.';

// Live rationale is optional: any provider failure keeps the deterministic sentence, never an error.
async function predictCareerPath(body, { callLlm } = {}) {
  const top = rank(body || {});
  let rationale = top.length
    ? `Based on overlap with your current skills, ${top[0].title} is your closest match (${pyFloat(top[0].confidence)}% skill coverage).`
    : 'Add a few skills to get a career-path match.';
  let llmEnriched = false;
  if (top.length && typeof callLlm === 'function') {
    try {
      const text = await callLlm(LLM_SYSTEM, JSON.stringify({
        top_match: top[0].title, matched_skills: top[0].matched_skills, missing_skills: top[0].missing_skills, confidence: top[0].confidence,
      }));
      const clean = String(text || '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
      // Grounding guard (mirrors the intent of ai_reliability): must be a short sentence group that actually names the match or a real skill from the lists.
      const known = [top[0].title, ...top[0].matched_skills, ...top[0].missing_skills].map((s) => s.toLowerCase());
      if (clean.length >= 20 && clean.length <= 700 && known.some((k) => clean.toLowerCase().includes(k))) { rationale = clean; llmEnriched = true; }
    } catch (_) { /* deterministic rationale already set */ }
  }
  return { matches: top, rationale, llm_enriched: llmEnriched, served_by: 'node-fallback' };
}

// Routes this process can answer itself. Key = path after /api/ai-ml (no query string).
// Career Fit routes (semantic match + RAG) are answered by the keyword engine in mlLexicalEngine.js and are always
// labelled fallback_mode / semantic:false - never passed off as transformer results.
const lexical = require('./mlLexicalEngine');
const HANDLERS = {
  'POST /career-path/predict': (body, deps) => predictCareerPath(body, deps),
  'GET /match/engine': () => lexical.engineInfo(),
  'POST /match/role-fit': (body) => lexical.roleFit(body || {}),
  'POST /match/resume-jd': (body) => lexical.resumeJd(body || {}),
  'POST /match/resume-jd/explain': (body) => lexical.resumeJdExplain(body || {}),
  'GET /rag/status': () => lexical.ragStatus(),
  'POST /rag/query': (body, deps) => lexical.ragQuery(body || {}, deps),
  'POST /rag/retrieve': (body) => { const r = lexical.retrieve(body || {}); return { sources: r.hits, retrieval: r.info, served_by: 'node-fallback' }; },
  // Government-notice RAG needs the indexed records of the real service; say so honestly (the UI hides the notices line).
  'GET /rag/hybrid/status': () => ({ records: 0, available: false, served_by: 'node-fallback', note: 'Recruitment-notice index is only available from the AI/ML service.' }),
};

function canServe(method, pathname) { return Object.prototype.hasOwnProperty.call(HANDLERS, `${String(method).toUpperCase()} ${pathname}`); }
async function serveFallback(method, pathname, body, deps) { return HANDLERS[`${String(method).toUpperCase()} ${pathname}`](body, deps); }

module.exports = { canServe, serveFallback, predictCareerPath, rank };
