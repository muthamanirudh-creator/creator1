const assert = require('assert');
const { ageOn } = require('./lib/dates');
const { evaluate } = require('./lib/eligibility');
const { parseQuery, runSearch } = require('./lib/search');
const { publishedJobs, buildJobs } = require('./data/jobs');

const now = new Date();
const jobs = publishedJobs(now);
const get = (id) => jobs.find((j) => j.id === id);
const year = now.getFullYear();

// 1. Age uses the cutoff date, not today
assert.deepStrictEqual(ageOn('2000-03-15', '2026-01-01'), { years: 25, months: 9, days: 17 });
const gd = get('rrb-group-d');
const turned34AfterCutoff = `${year - 34}-06-01`; // 33 on 1 Jan, 34 later
assert.strictEqual(evaluate(gd, { education: { level: '10th' }, dob: turned34AfterCutoff }).rows.find(r => r.key === 'age').result, 'MATCH');

// 2. Category relaxation is only applied when the user states it
const old = `${year - 36}-01-01`;
assert.strictEqual(evaluate(gd, { education: { level: '10th' }, dob: old }).rows.find(r => r.key === 'age').result, 'NOT_ELIGIBLE');
assert.strictEqual(evaluate(gd, { education: { level: '10th' }, dob: old, category: 'SC' }).rows.find(r => r.key === 'age').result, 'MATCH');

// 3. No assumed equivalency: 12th pass vs "10th or ITI" (no 'or higher') is UNKNOWN, not MATCH
assert.strictEqual(evaluate(gd, { education: { level: '12th' }, dob: `${year - 22}-05-05` }).rows[0].result, 'UNKNOWN');
// ...but 'or higher' is honoured when the notification says so
assert.strictEqual(evaluate(get('ssc-mts'), { education: { level: '12th' }, dob: `${year - 22}-05-05` }).rows[0].result, 'MATCH');

// 4. Domicile is never inferred from residence
const tsp = get('ts-police-constable');
const r = evaluate(tsp, { education: { level: '12th' }, dob: `${year - 22}-05-05` });
assert.strictEqual(r.rows.find(x => x.key === 'domicile').result, 'UNKNOWN');
assert.strictEqual(evaluate(tsp, { education: { level: '12th' }, dob: `${year - 22}-05-05`, domicileState: 'Kerala' }).overall, 'NOT_ELIGIBLE');

// 5. Subjects are checked only when required, and asked for rather than assumed
const gds = get('postal-gds');
assert.strictEqual(evaluate(gds, { education: { level: '10th' }, dob: `${year - 20}-01-01` }).rows.find(x => x.key === 'subjects').result, 'UNKNOWN');
assert.strictEqual(evaluate(gds, { education: { level: '10th' }, dob: `${year - 20}-01-01`, subjectsKnown: true, subjects: ['English'] }).overall, 'NOT_ELIGIBLE');

// 6. Final-year is conditional only where the notification allows it
assert.strictEqual(evaluate(get('bank-po'), { education: { level: 'bachelor', status: 'final_year' }, dob: `${year - 22}-02-02` }).rows[0].result, 'CONDITIONAL');
assert.strictEqual(evaluate(get('rrb-technician'), { education: { level: 'diploma', status: 'final_year', field: 'engineering' }, dob: `${year - 22}-02-02` }).rows[0].result, 'NOT_ELIGIBLE');

// 7. Unverified drafts are never visible
assert.ok(buildJobs(now).some(j => j.id === 'draft-unverified'));
assert.ok(!jobs.some(j => j.id === 'draft-unverified'));

// 8. NL parsing + conversational memory
let p = parseQuery("I'm 18, passed 10th, from Telangana and want government jobs where the application is currently open.");
assert.deepStrictEqual([p.filters.age, p.filters.education, p.filters.state, p.filters.status], [18, '10th', 'Telangana', 'OPEN']);
p = parseQuery('Show railway jobs');
p = parseQuery('Only 10th pass', p.filters);
p = parseQuery('closing this month', p.filters);
assert.deepStrictEqual([p.filters.domain, p.filters.education, p.filters.closing_this_month], ['railway', '10th', true]);
assert.deepStrictEqual(parseQuery('start over', p.filters).filters, {});

// 9. Search never returns closed jobs by default, and respects state filter
const res = runSearch(jobs, { state: 'Telangana' }, {}, now);
assert.ok(res.every(x => x.deadline.status !== 'CLOSED'));
assert.ok(res.some(x => x.id === 'ts-police-constable') && res.some(x => x.id === 'ssc-mts'));
assert.ok(!runSearch(jobs, { state: 'Kerala' }, {}, now).some(x => x.id === 'ts-police-constable'));
console.log('All tests passed');
