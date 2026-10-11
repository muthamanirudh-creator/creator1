// Runs the hand-calculated eligibility cases (eval/eligibility/manual-cases.json). Exit 1 on any disagreement.
const { eligibilitySelfTest } = require('../lib/trust/selftests');
const r = eligibilitySelfTest();
console.log(`Eligibility vs hand calculation: ${r.passed}/${r.cases} agree`);
for (const f of r.failures) console.log('  DISAGREES', f.id, f.why, JSON.stringify(f.got), 'expected', JSON.stringify(f.expected));
process.exit(r.failures.length ? 1 : 0);
