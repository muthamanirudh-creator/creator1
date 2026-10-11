'use strict';
// Static regression checks for the real-semantic Career Fit wiring (no network, no Python needed).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const ui = read('frontend', 'app-runtime.js');
assert(ui.includes('function CareerFitLiveSemanticPanel'), 'Career Fit must render the live semantic panel');
assert(ui.includes("'/match/role-fit'") && ui.includes("'/match/engine'"), 'panel must call role-fit and engine status through the authenticated gateway');
assert(ui.includes('AbortController') && ui.includes('seq.current'), 'live panel must abort/ignore stale requests');
assert(ui.includes('AI/ML engine is still starting') && ui.includes('liveRetries'), 'panel must wait for / quietly retry the engine instead of substituting a score');
assert(ui.includes('role-skill-match') && !ui.includes('NOT semantic matching'), 'skill-gap local result must be presented as a normal role-readiness result');
assert(/React\.createElement\(CareerFitLiveSemanticPanel/.test(ui), 'panel must be mounted in the careerFit tab');
// nothing that existed before may disappear
for (const keep of ['GapRoadmapPanel', 'ResumeAtsOptimizerPanel', 'MarketIntelRadarPanel', 'handleGenerateRoadmap', 'handlePredictCareerPath', 'careerFitSkillGapSection', 'cfPolishOpen']) {
  assert(ui.includes(keep), `previous Career Fit feature missing: ${keep}`);
}

const py = (...p) => read('ai-ml-service', ...p);
const matcher = py('app', 'services', 'matcher.py');
assert(!/_lightweight_embed|offline-hybrid-hash-tfidf/.test(matcher), 'matcher must not contain the silent hashed fallback');
assert(py('app', 'services', 'embeddings.py').includes('class EmbeddingUnavailable'), 'strict embedding engine must exist');
assert(py('app', 'main.py').includes('EMBEDDING_MODEL_UNAVAILABLE') || py('app', 'main.py').includes('exc.code'), 'API must answer 503 EMBEDDING_MODEL_UNAVAILABLE');
assert(py('app', 'main.py').includes('start_background_load'), 'model must be warmed at start-up');
const reqs = py('requirements-ml.txt');
for (const pkg of ['torch', 'transformers', 'sentence-transformers', 'faiss-cpu']) assert(reqs.includes(pkg), `requirements-ml.txt must install ${pkg}`);
assert(py('requirements.txt').includes('-r requirements-ml.txt'), 'requirements.txt must include the ML stack');
assert(py('Dockerfile').includes('download_models.py'), 'image must bake in the embedding model');

const launcher = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'mlLauncher.js'), 'utf8');
assert(launcher.includes('sentence_transformers') && launcher.includes('requirements-ml.txt'), 'launcher must install the ML stack');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(server.includes("'/match/role-fit'") && server.includes('engineStatus'), 'gateway must know the new routes and report engine status');
console.log('Semantic Career Fit wiring checks passed.');
