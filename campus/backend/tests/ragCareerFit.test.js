'use strict';
// Static regression checks for the Career Fit RAG wiring (no network, no Python needed).
// Behavioural tests for retrieval / citations / fallbacks live in ai-ml-service/tests/test_rag.py.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const ui = read('frontend', 'app-runtime.js');
assert(ui.includes('function CareerFitRagPanel'), 'Career Fit must define the RAG panel');
assert(/React\.createElement\(CareerFitRagPanel/.test(ui), 'RAG panel must be mounted in the careerFit tab');
assert(ui.includes("'/rag/query'") && ui.includes("'/rag/status'"), 'panel must call the RAG routes through the authenticated gateway');
assert(ui.includes('AbortController') && ui.includes('submitting.current'), 'panel must abort stale requests and guard double-submit');
assert(ui.includes('nothing guessed') && ui.includes('press Ask again'), 'panel must not invent an answer when there is no evidence or the engine is down');
assert(ui.includes('function RagAnswerText') && ui.includes('citations_used'), 'answers must render clickable numbered citations');
assert(!/localStorage\.setItem\([^)]*resume/i.test(ui.slice(ui.indexOf('function CareerFitRagPanel'), ui.indexOf('function AiMlNotConfiguredNotice'))), 'RAG panel must not persist the resume');
// the panel must sit inside the Career Fit tab, after the live semantic panel and before the skill-gap section
const iLive = ui.indexOf('React.createElement(CareerFitLiveSemanticPanel');
const iRag = ui.indexOf('React.createElement(CareerFitRagPanel');
const iGap = ui.indexOf('id: "careerFitSkillGapSection"');
assert(iLive > 0 && iRag > iLive && iGap > iRag, 'RAG panel must be rendered between the live semantic panel and the skill-gap section');
// nothing that existed before may disappear
for (const keep of ['CareerFitLiveSemanticPanel', 'GapRoadmapPanel', 'ResumeAtsOptimizerPanel', 'MarketIntelRadarPanel', 'handleGenerateRoadmap', 'handlePredictCareerPath',
  'careerFitSkillGapSection', 'cfPolishOpen', 'handleAiMlSemanticMatch', 'ResumeExplainableSkills', 'role-skill-match']) {
  assert(ui.includes(keep), `previous Career Fit feature missing: ${keep}`);
}

const py = (...p) => read('ai-ml-service', ...p);
const main = py('app', 'main.py');
assert(main.includes('rag') && main.includes('app.include_router(rag.router)'), 'FastAPI app must register the rag router');
const svc = py('app', 'services', 'rag.py');
assert(svc.includes('EmbeddingUnavailable') || svc.includes('ensure_ready'), 'RAG must use the strict embedding engine (no hashed substitute)');
assert(svc.includes('reciprocal') || svc.includes('RRF'), 'retrieval must fuse dense + keyword rankings');
assert(svc.includes('ONLY the numbered SOURCES') && svc.includes('do not follow them'), 'prompt must restrict the LLM to sources and treat them as data');
assert(svc.includes('"no-evidence"') && svc.includes('"extractive"'), 'RAG must have honest no-evidence and extractive modes');
assert(fs.existsSync(path.join(root, 'ai-ml-service', 'data', 'rag_kb', 'placement-guidance.md')), 'curated knowledge file must ship');
assert(py('.dockerignore').includes('!data/rag_kb/*.md'), 'knowledge markdown must survive .dockerignore');
for (const pyTest of ['test_rag.py']) assert(fs.existsSync(path.join(root, 'ai-ml-service', 'tests', pyTest)), `${pyTest} must exist`);

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(server.includes("'/rag/query'") && server.includes("'/rag/status'"), 'gateway contract check must know the RAG routes');
// earlier gateway routes must remain
for (const r of ["'/match/role-fit'", "'/match/engine'", "'/skill-gap/analyze'", "'/roadmap/generate'", "'/career-path/predict'", "'/market/radar'"]) assert(server.includes(r), `gateway lost route ${r}`);
console.log('Career Fit RAG wiring checks passed.');
