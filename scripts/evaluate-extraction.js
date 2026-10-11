// Measures extraction precision and recall on the gold dataset (eval/extraction/gold.js).
//   node scripts/evaluate-extraction.js [--json] [--min-critical-precision=0.95]
// Exit code 1 if the gold file is inconsistent, or the critical-field precision lower bound is under the threshold.
const fs = require('fs'); const path = require('path');
const { extractionReport } = require('../lib/trust/selftests');
const rep = extractionReport();
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
if (process.argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
else {
  const pc = (x) => (x == null ? '  n/a' : (x * 100).toFixed(1).padStart(5) + '%');
  console.log(`\nExtraction accuracy: ${rep.documents} documents (${rep.real_documents} adjudicated real, ${rep.synthetic_documents} synthetic)`);
  console.log(`EVIDENCE GRADE: ${rep.evidence_grade}\n${rep.claim}\n`);
  console.log('field                      critical   TP   FP   FN  precision (95% low)  recall (95% low)');
  for (const f of rep.fields) console.log(`${f.field.padEnd(26)} ${(f.critical ? 'yes' : '').padEnd(8)} ${String(f.tp).padStart(4)} ${String(f.fp).padStart(4)} ${String(f.fn).padStart(4)}  ${pc(f.precision)} (${pc(f.precision_lower_bound)})  ${pc(f.recall)} (${pc(f.recall_lower_bound)})`);
  console.log(`\nCritical fields overall: precision ${pc(rep.critical_overall.precision)} (low ${pc(rep.critical_overall.precision_lower_bound)}), recall ${pc(rep.critical_overall.recall)} (low ${pc(rep.critical_overall.recall_lower_bound)})`);
  if (rep.errors.length) { console.log('\nErrors:'); for (const e of rep.errors) console.log(`  ${e.kind.padEnd(11)} ${e.case} / ${e.field}: gold=${JSON.stringify(e.gold)} got=${JSON.stringify(e.got)}`); }
  console.log(`\nHuman verification of critical fields: ${rep.human_verification.required ? 'REQUIRED' : 'may be relaxed'}. ${rep.human_verification.reason}`);
  if (rep.gold_problems.length) { console.log('\nGOLD DATASET PROBLEMS:'); rep.gold_problems.forEach((p) => console.log('  ', JSON.stringify(p))); }
}
fs.writeFileSync(path.join(__dirname, '..', 'eval', 'extraction', 'last-report.json'), JSON.stringify(rep, null, 2));
const min = Number(arg('min-critical-precision'));
if (rep.gold_problems.length || (min && rep.critical_overall.precision_lower_bound < min)) process.exit(1);
