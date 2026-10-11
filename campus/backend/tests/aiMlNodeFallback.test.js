'use strict';
// Guards the Node-side fallback used by the /api/ai-ml gateway when the FastAPI service cannot answer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const fb = require('../src/services/aiMlFallback');

(async () => {
  // 1) The bundled dataset must stay identical to the FastAPI service's copy (Vercel excludes ai-ml-service/).
  const mine = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'data', 'career_paths.json'), 'utf8');
  const theirs = fs.readFileSync(path.join(__dirname, '..', '..', 'ai-ml-service', 'data', 'career_paths.json'), 'utf8');
  assert.deepStrictEqual(JSON.parse(mine), JSON.parse(theirs), 'backend career_paths.json drifted from ai-ml-service/data/career_paths.json');

  // 2) Routing table
  assert.ok(fb.canServe('POST', '/career-path/predict'));
  assert.ok(!fb.canServe('GET', '/career-path/predict'));
  assert.ok(!fb.canServe('POST', '/resume/analyze'));

  // 3) Ranking behaviour (same rules as career_path.py)
  const r = await fb.predictCareerPath({ current_skills: ['Python', 'sql', ' Docker '], top_n: 3 });
  assert.strictEqual(r.matches.length, 3);
  assert.strictEqual(r.llm_enriched, false);
  assert.strictEqual(r.served_by, 'node-fallback');
  assert.ok(r.matches[0].confidence >= r.matches[1].confidence && r.matches[1].confidence >= r.matches[2].confidence);
  assert.ok(r.matches[0].evidence && Array.isArray(r.matches[0].evidence.factors));
  const blank = await fb.predictCareerPath({ current_skills: ['Python'], target_interest: '   ' });
  const none = await fb.predictCareerPath({ current_skills: ['Python'] });
  assert.deepStrictEqual(blank.matches, none.matches, 'whitespace-only target_interest must not boost every track');
  assert.strictEqual((await fb.predictCareerPath({ current_skills: [], top_n: 99 })).matches.length, 6, 'top_n clamps to 6');
  assert.strictEqual((await fb.predictCareerPath({ current_skills: [], top_n: 0 })).matches.length, 1, 'top_n clamps to 1');
  assert.strictEqual((await fb.predictCareerPath({})).matches.length, 3, 'missing body fields use defaults');
  const big = await fb.predictCareerPath({ current_skills: ['Python'], topic_mastery: { python: 85 } });
  assert.ok(big.matches.every((m) => m.confidence <= 100), 'a percent-style mastery must not push confidence past 100');

  // 4) Live rationale: accepted only when grounded, never fatal
  const title = r.matches[0].title;
  const good = await fb.predictCareerPath({ current_skills: ['Python'] }, { callLlm: async () => `**${'Python'}** gives you a head start; next learn SQL for this path.` });
  assert.strictEqual(good.llm_enriched, true);
  assert.ok(!/[*_`#]/.test(good.rationale), 'markdown stripped');
  const ungrounded = await fb.predictCareerPath({ current_skills: ['Python'] }, { callLlm: async () => 'The weather is lovely today, enjoy your holiday season!' });
  assert.strictEqual(ungrounded.llm_enriched, false);
  assert.ok(ungrounded.rationale.includes('closest match'));
  const boom = await fb.predictCareerPath({ current_skills: ['Python'] }, { callLlm: async () => { throw new Error('provider down'); } });
  assert.strictEqual(boom.llm_enriched, false);
  const empty = await fb.predictCareerPath({ current_skills: ['Python'] }, { callLlm: async () => '' });
  assert.strictEqual(empty.llm_enriched, false);
  assert.ok(title);

  // 5) Gateway wiring: every failure path must try the fallback before returning an error
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const reason of ["'upstream-429'", '`upstream-${upstream.status}`', "'route-missing'", "'unreachable'"]) {
    assert.ok(server.includes(`serveAiMlFallback(req, res, ${reason}, startedAt)`), `gateway must call the fallback for ${reason}`);
  }
  const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app-runtime.js'), 'utf8');
  assert.ok(ui.includes("detail = (j && (j.detail || (j.error && j.error.message))) || ''"), 'career-path UI must show the gateway reason');

  console.log('aiMlNodeFallback tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
