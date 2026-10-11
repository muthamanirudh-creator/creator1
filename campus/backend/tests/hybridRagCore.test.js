'use strict';
// Static wiring checks for the shared Hybrid RAG core (no network, no Python). Behaviour is covered by
// ai-ml-service/tests/test_rag_core.py (run: python3 -I tests/test_rag_core.py).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

for (const f of ['models', 'security', 'lexical', 'fusion', 'filters', 'store', 'context', 'citations', 'cache', 'metrics', 'router', 'pipeline', 'langchain_adapter', 'evaluation']) {
  assert(fs.existsSync(path.join(root, 'ai-ml-service', 'app', 'rag_core', `${f}.py`)), `rag_core/${f}.py must exist`);
}
const main = read('ai-ml-service', 'app', 'main.py');
assert(main.includes('app.include_router(hybrid_rag.router)') && main.includes('app.include_router(rag.router)'), 'both RAG routers must be registered');
const pipe = read('ai-ml-service', 'app', 'rag_core', 'pipeline.py');
for (const k of ['abstained', 'deterministic_redirect', 'not_a_probability', 'detect_conflicts', 'cit.validate']) assert(pipe.includes(k), `pipeline must implement ${k}`);
const sec = read('ai-ml-service', 'app', 'rag_core', 'security.py');
assert(sec.includes('possible_prompt_injection'), 'prompt-injection sanitiser must exist');
// gateway: identity comes from the verified token and a client-sent x-user-id is never forwarded
const server = read('backend', 'server.js');
assert(server.includes("'x-user-id','x-user-role'].includes(lower)"), 'gateway must drop client-supplied x-user-id and x-user-role');
assert(server.includes("headers['x-user-id'] = String(req.user.sub)"), 'gateway must set x-user-id from the verified JWT');
// nothing that existed may disappear
assert(read('ai-ml-service', 'app', 'services', 'rag.py').includes('async def answer_question'), 'legacy Career Fit RAG must remain');
assert(server.includes("'/rag/query'") && server.includes("'/rag/status'"), 'gateway contract must still list the legacy RAG routes');
assert(!/'\/rag\/hybrid/.test(server.slice(server.indexOf('AI_ML_REQUIRED_ROUTES'), server.indexOf('AI_ML_REQUIRED_ROUTES') + 600)), 'new routes must not be REQUIRED (older deployed services would be flagged broken)');
console.log('Hybrid RAG core wiring checks passed.');

// ---- pass 2: recruitment records + eligibility routes, admin-only management, gateway role header
const router = fs.readFileSync(path.join(__dirname, '..', '..', 'ai-ml-service', 'app', 'routers', 'hybrid_rag.py'), 'utf8');
for (const r of ['"/eligibility"', '"/records"', '"/records/sweep"', '"/records/{record_id}/verified"', '"/records/{record_id}/unreachable"']) {
  assert(router.includes(r), 'hybrid router must expose ' + r);
}
assert((router.match(/_admin\(x_user_role\)/g) || []).length >= 5, 'every record-mutating route must call the admin guard');
assert(!/_admin\(x_user_role\)[\s\S]{0,40}async def hybrid_eligibility/.test(router), 'eligibility must stay available to normal users');
assert(server.includes("headers['x-user-role'] = 'admin'") && server.includes("req.user.role === 'ADMIN'"), 'gateway must set x-user-role from the verified JWT role');
console.log('Pass 2 wiring checks passed.');
