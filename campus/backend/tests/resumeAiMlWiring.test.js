'use strict';
// Resume / Career-Fit tab AI/ML wiring regression checks (static + behavioural, no network, no DB).
//  * every Resume-tab AI action tries the AI/ML gateway first (/resume/*, /roadmap/generate, /parse/resume, /match/*)
//  * the old crash (jdText declared inside `try`, read inside `catch`) and the blank "Week :" rows are gone
//  * the Skill Gap & Market Radar has a real offline fallback (used when the deployed service 404s / sleeps)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rt = fs.readFileSync(path.join(__dirname, '../../frontend/app-runtime.js'), 'utf8');
const pyMain = fs.readFileSync(path.join(__dirname, '../../ai-ml-service/app/main.py'), 'utf8');

// --- routes exist on both sides
for (const route of ['/resume/analyze', '/resume/ats-optimize', '/resume/enhance']) {
  assert(rt.includes(`aimlTry('${route}'`), `frontend must call ${route} through the AI/ML gateway`);
}
assert(pyMain.includes('app.include_router(resume.router)'), 'FastAPI service must register the resume router');
assert(rt.includes("aimlTry('/roadmap/generate'"), 'Gap-closing roadmap must try the AI/ML service first');
assert(rt.includes('/parse/resume`'), 'Resume upload must use the AI/ML parser (enrichment + recovery)');
assert(rt.includes("aimlTry('/match/resume-jd/explain'"), 'Semantic match must also fetch the explainable skill breakdown');

// --- no more "API key" dead end: none of the Resume-tab actions may open the key modal before trying the AI/ML service
const enh = rt.slice(rt.indexOf('const handleAiEnhanceResume'), rt.indexOf('const handleAiEnhanceResume') + 900);
assert(!/if \(!hasWorkingAi\) \{\s*setShowApiKeyModal\(true\);\s*return;\s*\}\s*if \(!rbForm2/.test(enh), 'Enhance with AI must not bounce to the API-key modal first');
const deep = rt.slice(rt.indexOf('const handleAiResumeAnalysis'), rt.indexOf('const handleAiResumeAnalysis') + 700);
assert(!deep.includes('setShowApiKeyModal(true)'), 'AI Deep-Dive must not bounce to the API-key modal first');

// --- crash regression: jdText must not be block-scoped inside the try of the semantic handler
const sem = rt.slice(rt.indexOf('const runAiMlSemantic'), rt.indexOf('const handleAiMlSemanticMatch'));
assert(sem.length > 200 && /const jdText = [^\n]*\n[^\n]*\n?[^\n]*setAiMlSemanticLoading\(true\)/.test(sem), 'jdText must be declared before any try block');
assert(!/try \{[^}]*const jdText/.test(sem), 'jdText declared inside try would be a ReferenceError in catch');
assert(/Math\.round\(local\.similarity \* 1000\) \/ 10/.test(sem), 'local fallback must be converted to the 0-100 scale the card prints with "%"');

// --- blank "Week :" rows: fallback milestones are {week, focus} objects and the renderer tolerates strings
assert(rt.includes("milestones: missing.slice(0, 5).map((s, i) => ({ week: String(i + 1), focus:"), 'career-path fallback milestones must be {week, focus} objects');
assert(rt.includes("typeof ms === 'object'"), 'milestone renderer must tolerate plain-string milestones');

// --- offline radar (pure functions evaluated in a sandbox)
const from = rt.indexOf('const AIML_MARKET_FALLBACK');
const toFn = rt.indexOf('function aimlOfflineTrending');
const end = rt.indexOf('\n}\n', toFn) + 3;
assert(from > 0 && toFn > from && end > toFn, 'offline radar helpers must exist');
const sb = {}; vm.createContext(sb);
vm.runInContext(rt.slice(from, end) + '\nthis.radar = aimlOfflineRadar; this.roles = aimlOfflineRoles; this.resolve = aimlResolveRole; this.trending = aimlOfflineTrending;', sb);
const r = sb.radar('Data Scientist', ['sql']);
assert.strictEqual(r.target_role, 'Data Scientist');
assert(r.skills.find(s => s.skill === 'SQL').you_have_it === true, 'SQL must be recognised');
assert(r.skills.find(s => s.skill === 'Python').you_have_it === false, 'Python must be reported missing');
assert(r.coverage_pct > 0 && r.coverage_pct < 100 && r.missing_high_demand_skills.length > 0 && r.radar_chart.categories.length > 0);
assert.strictEqual(sb.resolve('Software Development Engineer'), 'Software Engineer', 'substring alias "PM" must not hijack "Development"');
assert.strictEqual(sb.radar('Quantum Gardener', ['']).skills.some(s => s.you_have_it), false, 'a blank skill must not match anything');
assert(sb.roles().length >= 10 && sb.trending().trending.length > 0);

// --- ATS panel keeps its deterministic fallback and the "no key" notice only shows when nothing can serve the request
const ats = rt.slice(rt.indexOf('function ResumeAtsOptimizerPanel('), rt.indexOf('function GapRoadmapPanel('));
assert(ats.includes("aimlTry('/resume/ats-optimize'") && ats.includes('Compatibility review based on the evidence'), 'ATS panel: AI/ML first, deterministic fallback kept');
assert(ats.includes('hasAiKey || !!(mlStatus && mlStatus.available)'), 'ATS panel must not show the add-a-key notice while the AI/ML service is available');

console.log('Resume AI/ML wiring regression checks passed.');
