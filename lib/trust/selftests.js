'use strict';
// Self-tests that need no network, database or server: extraction accuracy on the gold set, eligibility vs hand calculation.
const policy = require('./policy');
const evalLib = require('./evaluation');
const { evaluate } = require('../eligibility');

function extractionReport() {
  const cases = require('../../eval/extraction/gold.js');
  const { extractWithRules } = require('../rulesExtractor');
  const problems = evalLib.validateGold(cases);
  const rep = evalLib.scoreExtraction(cases, evalLib.runExtractor(cases, (p, c) => extractWithRules(p, c)));
  return { ...rep, gold_problems: problems, human_verification: policy.humanVerificationRequired(rep) };
}

function eligibilitySelfTest() {
  const f = require('../../eval/eligibility/manual-cases.json'); const { ageOn } = require('../dates');
  const failures = [];
  for (const c of f.cases) {
    const j = f.jobs[c.job], r = evaluate(j, c.profile), age = r.rows.find((x) => x.key === 'age').result;
    let ageOk = true; if (c.expected_age && c.profile.dob && j.age) { const a = ageOn(c.profile.dob, j.age.cutoff_date); for (const k of Object.keys(c.expected_age)) if (a[k] !== c.expected_age[k]) ageOk = false; }
    if (age !== c.expected_age_result || r.overall !== c.expected_overall || !ageOk) failures.push({ id: c.id, why: c.why, got: { age, overall: r.overall }, expected: { age: c.expected_age_result, overall: c.expected_overall } });
  }
  return { cases: f.cases.length, passed: f.cases.length - failures.length, failures, basis: 'Expected results were calculated by hand from the rule text.' };
}

module.exports = { extractionReport, eligibilitySelfTest };
