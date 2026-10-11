'use strict';
// Guards the Node keyword engine that answers Career Fit match / RAG routes when the FastAPI service cannot,
// the gateway wiring that uses it, and the 20 s browser timeout that used to cut the gateway off.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fb = require('../src/services/aiMlFallback');
const lx = require('../src/services/mlLexicalEngine');

(async () => {
  for (const [m, p] of [['GET', '/match/engine'], ['POST', '/match/role-fit'], ['POST', '/match/resume-jd'], ['POST', '/match/resume-jd/explain'],
    ['GET', '/rag/status'], ['POST', '/rag/query'], ['POST', '/rag/retrieve'], ['GET', '/rag/hybrid/status'], ['POST', '/career-path/predict']]) {
    assert.ok(fb.canServe(m, p), `${m} ${p} must be served by the fallback`);
  }
  assert.ok(!fb.canServe('POST', '/resume/ats-optimize'), 'routes without a faithful fallback must still be proxied');

  const eng = await fb.serveFallback('GET', '/match/engine', {}, {});
  assert.strictEqual(eng.ready, true); assert.strictEqual(eng.semantic, false); assert.strictEqual(eng.fallback_mode, true);

  const resume = 'Skills: SQL, Python, React\nBuilt a REST API in Flask with PostgreSQL that served 500 daily requests.\nDeployed with Docker on AWS using GitHub Actions.';
  const fit = await fb.serveFallback('POST', '/match/role-fit', { resume_text: resume, target_role: 'Full Stack Developer' }, {});
  assert.strictEqual(fit.resolved_role, 'Full Stack Developer', 'an exact role name must beat another role\'s alias');
  assert.ok(fit.fit_pct > 0 && fit.fit_pct <= 100);
  assert.ok(fit.matched.includes('React') && fit.matched.includes('SQL'));
  assert.ok(!fit.missing.includes('React'));
  assert.ok(fit.skills.every((s) => ['matched', 'partial', 'missing'].includes(s.status)));
  assert.strictEqual(fit.matching_engine.semantic, false, 'fallback results must never claim to be semantic');
  const unknown = await fb.serveFallback('POST', '/match/role-fit', { target_role: 'zzz qqq' }, {});
  assert.strictEqual(unknown.fit_pct, null); assert.ok(unknown.message);
  const jd = await fb.serveFallback('POST', '/match/role-fit', { resume_text: resume, jd_text: 'We need Python, Kubernetes, Docker and SQL.' }, {});
  assert.deepStrictEqual(jd.need.sort(), ['Docker', 'Kubernetes', 'Python', 'SQL'].sort());
  assert.ok(jd.missing.includes('Kubernetes') || jd.partial.includes('Kubernetes'), 'Kubernetes is not on the resume (related to Docker at best)');
  assert.ok(!jd.matched.includes('Kubernetes'));

  const ex = await fb.serveFallback('POST', '/match/resume-jd/explain', { resume_text: resume, jd_text: 'Python, Docker, Kubernetes, SQL' }, {});
  assert.ok(ex.matched_skills.length >= 3 && !ex.matched_skills.some((s) => s.skill === 'Kubernetes') && ex.fallback_mode === true);
  const pair = await fb.serveFallback('POST', '/match/resume-jd', { resume_text: resume, jd_text: 'Python Docker SQL' }, {});
  assert.ok(pair.semantic_similarity >= 0 && pair.confidence === 'low' && pair.fallback_mode === true);

  const st = await fb.serveFallback('GET', '/rag/status', {}, {});
  assert.ok(st.knowledge_base.passages > 10 && st.engine.ready === true);
  const ans = await fb.serveFallback('POST', '/rag/query', { question: 'Do I have evidence of Docker or cloud experience?', resume_text: resume }, {});
  assert.strictEqual(ans.mode, 'extractive'); assert.ok(ans.sources[0].source === 'resume', 'personal questions must surface the resume line first');
  assert.ok(/\[1\]/.test(ans.answer));
  const none = await fb.serveFallback('POST', '/rag/query', { question: 'qwerty zxcv' }, {});
  assert.strictEqual(none.mode, 'no-evidence'); assert.strictEqual(none.grounded, false, 'must abstain without evidence');
  // an LLM answer is accepted only when it cites real sources
  const good = await fb.serveFallback('POST', '/rag/query', { question: 'Do I have Docker experience?', resume_text: resume }, { callLlm: async () => 'Yes, your resume shows Docker deployment on AWS [1].' });
  assert.strictEqual(good.mode, 'llm');
  const bad = await fb.serveFallback('POST', '/rag/query', { question: 'Do I have Docker experience?', resume_text: resume }, { callLlm: async () => 'Absolutely, you are an expert with no citations at all here.' });
  assert.strictEqual(bad.mode, 'extractive', 'an uncited LLM answer must be replaced by the extractive one');

  // the bundled data must come from the FastAPI copies
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'data', 'ml_fallback_data.json'), 'utf8'));
  const ml = path.join(__dirname, '..', '..', 'ai-ml-service', 'data');
  if (fs.existsSync(ml)) assert.deepStrictEqual(data.market, JSON.parse(fs.readFileSync(path.join(ml, 'market_skills.json'), 'utf8')), 'ml_fallback_data.json market data drifted from ai-ml-service');

  // gateway + browser wiring
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/fallbackable/.test(server) && /AI_ML_FAST_WAKE_MS/.test(server) && /startKeepAlive/.test(server), 'gateway must fast-fallback and keep the service awake');
  const v23 = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'advanced-v23.js'), 'utf8');
  assert.ok(/LONG_ROUTES/.test(v23) && /ai-ml/.test(v23), 'the generic 20 s fetch timeout must not apply to /api/ai-ml');
  console.log('mlLexicalEngine tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
