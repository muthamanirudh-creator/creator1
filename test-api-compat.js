'use strict';
// v2.9.1 pass 4B - API / contract compatibility for the Hybrid RAG upgrade. Dependency-free (static source analysis: no
// express, pg or network needed), so it runs in CI before `npm ci`.
//
//   node test-api-compat.js            check against tests/api-contract/*.golden.json
//   node test-api-compat.js --update   rewrite the golden files after an INTENTIONAL route change (review the diff!)
//
// What it protects: every HTTP route the Node servers declare (method + path), the AI/ML gateway contract (header trust,
// required-route list), the legacy `/rag/*` request keys the Career Fit UI sends, the new Hybrid RAG additions being
// *additive only*, and the npm test chain still running every suite.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const UPDATE = process.argv.includes('--update');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ok -', name); };

// ---------------------------------------------------------------------------------------------- route extraction
const ROUTE_RE = /\b(app|router|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3/g;
function routesOf(file) {
  const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(src))) out.push(`${m[2].toUpperCase()} ${m[4]}`);
  return out;
}
function collectNodeRoutes() {
  const files = ['server.js', 'routes/admin.js', 'campus/backend/server.js', 'campus/backend/api/index.js']
    .concat(fs.readdirSync(path.join(ROOT, 'campus/backend/src/routes')).filter((f) => f.endsWith('.js')).map((f) => `campus/backend/src/routes/${f}`))
    .filter(exists);
  const table = {};
  for (const f of files) table[f] = Array.from(new Set(routesOf(f))).sort();
  return table;
}
const GOLDEN = path.join(ROOT, 'tests/api-contract/node-routes.golden.json');

console.log('Node route table');
const current = collectNodeRoutes();
if (UPDATE) { fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + '\n'); console.log('  golden rewritten:', Object.values(current).reduce((a, r) => a + r.length, 0), 'routes'); }

t('golden route snapshot exists', () => assert.ok(exists('tests/api-contract/node-routes.golden.json'), 'run: node test-api-compat.js --update'));
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

t('no route that existed in the snapshot has been removed or renamed (per file)', () => {
  const lost = [];
  for (const [f, routes] of Object.entries(golden)) for (const r of routes) if (!(current[f] || []).includes(r)) lost.push(`${f}: ${r}`);
  assert.deepStrictEqual(lost, [], 'routes missing: ' + lost.join('; '));
});
t('no route was added outside the snapshot without an intentional --update (additions must be reviewed)', () => {
  const added = [];
  for (const [f, routes] of Object.entries(current)) for (const r of routes) if (!(golden[f] || []).includes(r)) added.push(`${f}: ${r}`);
  assert.deepStrictEqual(added, [], 'new routes: ' + added.join('; '));
});
t('routes named in earlier release notes are still declared', () => {
  const all = Object.values(current).flat();
  const need = ['GET /api/feed', 'GET /api/autolive/status', 'GET /api/meta', 'GET /api/ai-ml-status', 'GET /api/ai-status'];
  const missing = need.filter((r) => !all.some((x) => x === r || x === r.replace('/api', '')));
  assert.deepStrictEqual(missing, []);
});
t('the ONLY Node route the Hybrid RAG work added is the admin sync (everything else flows through the existing /api/ai-ml gateway)', () => {
  const hybrid = Object.entries(current).flatMap(([f, rs]) => rs.filter((r) => /hybrid/i.test(r)).map((r) => `${f}: ${r}`));
  assert.deepStrictEqual(hybrid, ['routes/admin.js: POST /hybrid-rag/sync']);
});
t('the admin sync is admin-only and audited', () => {
  const a = read('routes/admin.js');
  const i = a.indexOf("'/hybrid-rag/sync'");
  const block = a.slice(i, i + 700);
  assert.ok(/requireRole\('ADMIN'\)/.test(block), 'must require ADMIN');
  assert.ok(/audit\(/.test(block) && /HYBRID_RAG_SYNC/.test(block), 'must write an audit entry');
});

// ---------------------------------------------------------------------------------------------- gateway contract
console.log('AI/ML gateway contract');
const gw = read('campus/backend/server.js');
t('gateway still forwards every /api/ai-ml/* path (no per-route allow-list that could drop legacy or hybrid routes)', () => {
  assert.ok(/app\.use\('\/api\/ai-ml', requireAuth/.test(gw));
  assert.ok(gw.includes("req.originalUrl.replace(/^\\/api\\/ai-ml/, '')"));
});
t('client-supplied x-user-id / x-user-role are dropped and re-set only from the verified JWT', () => {
  const strip = gw.match(/if \(!\[([^\]]+)\]\.includes\(lower\)/);
  assert.ok(strip, 'header strip list not found');
  assert.ok(strip[1].includes("'x-user-id'") && strip[1].includes("'x-user-role'"));
  assert.ok(/req\.user && req\.user\.sub != null\) headers\['x-user-id'\] = String\(req\.user\.sub\)/.test(gw));
  assert.ok(/req\.user && req\.user\.role === 'ADMIN'\) headers\['x-user-role'\] = 'admin'/.test(gw));
  assert.ok(!/headers\['x-user-role'\]\s*=\s*req\.(headers|get)/.test(gw), 'role must never be copied from the request');
});
t('the readiness contract still requires the legacy routes and does NOT require hybrid routes (older AI builds stay "complete")', () => {
  const m = gw.match(/const AI_ML_REQUIRED_ROUTES = \[([\s\S]*?)\];/);
  const routes = Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
  const legacy = ['/parse/resume', '/match/resume-jd', '/match/resume-jd/explain', '/resume/analyze', '/resume/ats-optimize', '/resume/enhance',
    '/skill-gap/analyze', '/roadmap/generate', '/career-path/predict', '/market/radar', '/match/role-fit', '/match/engine', '/rag/query', '/rag/status'];
  assert.deepStrictEqual(routes, legacy);
  assert.ok(!routes.some((r) => r.includes('/rag/hybrid')));
});
t('the Node fallback only answers routes it already handled (hybrid routes are never faked by the fallback)', () => {
  const fb = read('campus/backend/src/services/aiMlFallback.js');
  assert.ok(!/hybrid/i.test(fb), 'aiMlFallback must not fabricate hybrid-RAG answers');
});

// ---------------------------------------------------------------------------------------------- UI -> API contract
console.log('Front-end calls');
const rt = read('campus/frontend/app-runtime.js');
const app = read('public/app.js');
// The two calls sit side by side in one ternary, so each is sliced exactly instead of using a loose window.
const hybridCall = (() => { const i = rt.indexOf("aimlRequest('/rag/hybrid/query'"); const j = rt.indexOf("aimlRequest('/rag/query'", i); return i > 0 && j > i ? rt.slice(i, j) : ''; })();
const legacyCall = (() => { const i = rt.indexOf("aimlRequest('/rag/query'"); const j = rt.indexOf(';', rt.indexOf('history })', i)); return i > 0 && j > i ? rt.slice(i, j) : ''; })();
t('Career Fit: the three original scopes still call /rag/query with the original request keys', () => {
  assert.ok(legacyCall, 'legacy /rag/query call not found');
  for (const k of ['question', 'resume_text', 'target_role', 'scope', 'history']) assert.ok(new RegExp(`\\b${k}\\b`).test(legacyCall), 'request key lost: ' + k);
  const panel = rt.slice(rt.indexOf('CareerFitRagPanel'));
  for (const s of ["'all'", "'resume'", "'knowledge'"]) assert.ok(panel.includes(s), 'scope chip lost: ' + s);
});
t('Career Fit: the notices scope uses /rag/hybrid/query with domain "government" and sends no resume, role or JD text', () => {
  assert.ok(hybridCall, 'hybrid call not found');
  assert.ok(/domain:\s*'government'/.test(hybridCall));
  for (const k of ['resume_text', 'jd_text', 'target_role']) assert.ok(!hybridCall.includes(k), k + ' must not be sent to the notices path');
});
t('the notices path is taken only for scope === "notices" (the three original scopes cannot reach the hybrid route)', () => {
  assert.ok(/scope === 'notices'\s*\?\s*await aimlRequest\('\/rag\/hybrid\/query'/.test(rt));
});
t('the GovCareer server still bridges /api/ai-ml/* to the Campus gateway (the eligibility drawer and Career Fit notices both depend on it)', () => {
  const srv = read('server.js');
  const m = srv.match(/const campusApiPrefixes = \[([\s\S]*?)\];/);
  assert.ok(m, 'campusApiPrefixes not found');
  assert.ok(m[1].includes("'/api/ai-ml'"));
});
t('Eligibility drawer: opt-in call to /api/ai-ml/rag/hybrid/eligibility; the legacy eligibility analysis is still rendered', () => {
  assert.ok(app.includes('/api/ai-ml/rag/hybrid/eligibility'));
  assert.ok(/Eligibility analysis/.test(app), 'existing "Eligibility analysis" heading must remain');
  assert.ok(/Check against the notice text/.test(app));
});
t('no new top-level navigation item: GovCareer nav buttons are exactly the seven original views, in order', () => {
  const idx = read('public/index.html');
  const nav = Array.from(idx.matchAll(/<button class="nav-btn[^"]*" data-view="([^"]+)">([^<]+)<\/button>/g)).map((m) => `${m[1]}:${m[2]}`);
  assert.deepStrictEqual(nav, ['overview:Overview', 'opportunities:Opportunities', 'exams:Exam Lab', 'career:Career Paths', 'bridge:Bridge', 'advanced:Strategy', 'tools:My Tools']);
});
t('Campus tab / option ids are identical to the untouched campus/mainapp.js copy (no RAG tab or duplicate chatbot was added to the runtime)', () => {
  const ids = (src) => Array.from(src.matchAll(/\{ id: '([A-Za-z]+)', label: '/g)).map((m) => m[1]);
  // 'custom' is a review-requirement option that mainapp.js formats on separate lines, not a tab.
  const runtimeIds = ids(rt).filter((x) => x !== 'custom');
  const mainIds = ids(read('campus/mainapp.js'));
  assert.deepStrictEqual(runtimeIds, mainIds);
  for (const id of runtimeIds) assert.ok(!/rag|hybrid|knowledge/i.test(id === 'average' ? '' : id), 'unexpected RAG-related id: ' + id);
});
t('GovCareer index.html has no RAG/knowledge-portal view or duplicate chat entry', () => {
  const idx = read('public/index.html');
  assert.ok(!/data-view="[^"]*(rag|hybrid|knowledge)[^"]*"/i.test(idx));
});

// ---------------------------------------------------------------------------------------------- caching of changed assets
console.log('Asset cache invalidation');
t('service worker cache name was bumped after public/app.js and styles.css changed (cache-first assets would otherwise hide the new UI)', () => {
  const sw = read('public/sw.js');
  const v = sw.match(/const CACHE='govcareer-shell-v(\d+)'/);
  assert.ok(v && Number(v[1]) >= 19, 'expected govcareer-shell-v19 or later, found ' + (v && v[0]));
  for (const a of ['/app.js', '/styles.css', '/index.html']) assert.ok(sw.includes(`'${a}'`), a + ' must stay in the precache list');
});
t('Campus index.html cache-bust token for app-runtime.js changed after the runtime changed, and keeps the prefix an older test pins', () => {
  const idx = read('campus/frontend/index.html');
  const m = idx.match(/app-runtime\.js\?v=([A-Za-z0-9._-]+)/);
  assert.ok(m, 'app-runtime.js must keep a ?v= token');
  assert.ok(m[1].startsWith('gc-officialletter2'), 'prefix pinned by gatePassHandwrittenLetter.test.js');
  assert.notStrictEqual(m[1], 'gc-officialletter2', 'token must differ from the one shipped before the notices UI');
});

// ---------------------------------------------------------------------------------------------- packaging / test chain
console.log('Packaging');
const pkg = JSON.parse(read('package.json'));
const chain = pkg.scripts.test.split('&&').map((s) => s.trim());
t('every root test-*.js (except the UI-only one run by `check`) is part of `npm test`', () => {
  const files = fs.readdirSync(ROOT).filter((f) => /^test.*\.js$/.test(f) && f !== 'test-ui.js');
  const missing = files.filter((f) => !chain.includes(`node ${f}`));
  assert.deepStrictEqual(missing, []);
});
t('this compatibility suite and the hybrid suites are wired into npm test', () => {
  for (const f of ['test-api-compat.js', 'test-hybrid-records.js']) assert.ok(chain.includes(`node ${f}`), f);
});
t('every file named in npm scripts exists', () => {
  const named = new Set();
  for (const s of Object.values(pkg.scripts)) for (const m of s.matchAll(/node(?: --check)? ((?:\.\/)?[\w\/.-]+\.js)/g)) named.add(m[1].replace(/^\.\//, ''));
  const missing = [...named].filter((f) => !exists(f));
  assert.deepStrictEqual(missing, []);
});
t('new configuration is documented with placeholders only (no real secret in .env.example files)', () => {
  for (const f of ['.env.example', 'campus/ai-ml-service/.env.example']) {
    const txt = read(f);
    assert.ok(/HYBRID_RAG_/.test(txt), f + ' should document the HYBRID_RAG_* settings');
    assert.ok(!/(sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,})/.test(txt), f + ' looks like it contains a real API key');
  }
});
t('Hybrid RAG scheduled sync: template ships 30 minutes; the scheduler treats unset/0 as disabled', () => {
  const m = read('.env.example').match(/^#?\s*HYBRID_RAG_SYNC_MINUTES=([^#\n]*)/m);
  assert.ok(m, 'HYBRID_RAG_SYNC_MINUTES must be documented');
  assert.strictEqual(m[1].trim(), '30', 'template should ship with a 30 minute sync, found: ' + m[1].trim());
  const sch = read('lib/scheduler.js');
  const line = sch.split('\n').find((l) => l.includes('HYBRID_RAG_SYNC_MINUTES'));
  assert.ok(line, 'scheduler must read HYBRID_RAG_SYNC_MINUTES');
  assert.ok(/\|\|\s*0\b|,\s*0\)|\?\s*0|> ?0/.test(sch), 'scheduler should default the sync to 0 / off');
});

console.log(`\nAPI compatibility checks passed: ${passed}`);
