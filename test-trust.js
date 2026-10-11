// v2.9.0 trust & evidence tests. Offline: no network, no database, no server.
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const policy = require('./lib/trust/policy'); const ledger = require('./lib/trust/ledger'); const flagsLib = require('./lib/trust/flags');
const monitor = require('./lib/trust/sourceMonitor'); const guard = require('./lib/trust/aiGuard'); const ev = require('./lib/trust/evaluation');
const prefs = require('./lib/trust/alertPrefs'); const careerFit = require('./lib/trust/careerFit'); const prepQ = require('./lib/trust/prepQuality'); const privacy = require('./lib/trust/accountPrivacy');
const self = require('./lib/trust/selftests'); const { evaluate } = require('./lib/eligibility'); const { ask } = require('./lib/answer'); const { buildJobs } = require('./data/jobs');

const tests = []; const t = (n, f) => tests.push([n, f]);
const NOW = new Date('2026-10-11T06:00:00Z');
const D = (off) => new Date(NOW.getTime() + off * 864e5).toISOString().replace('Z', '+00:00').replace('+00:00', '+05:30').slice(0, 19) + '+05:30';
const mkJob = (o = {}) => ({ id: 'r1', title: 'Clerk', organization: 'Board', lifecycle: 'PUBLISHED', dates: { application_open: D(-10), application_close: D(20), exam_date: null }, vacancies: { total: 1000 }, age: { min: 18, max: 30, cutoff_date: '2026-01-01', relaxation: {} }, education: { accepted: ['12th'], or_higher: false, label: '12th pass', fields: ['any'] }, ...o });
const rev = { email: 'rev@test.in' };
const ev1 = (field, job) => ({ document_id: 7, page: 2, quote: ({ 'dates.application_close': 'Last date to apply: 31 October 2026', 'dates.application_open': 'Application opens: 01 October 2026', 'vacancies.total': 'Total vacancies: 1000', 'age.min': 'Age limit: 18 to 30 years', 'age.max': 'Age limit: 18 to 30 years', 'age.cutoff_date': 'as on 01 January 2026', education: 'Education: 12th pass' })[field] });
const page = { page_number: 2, text: 'Application opens: 01 October 2026\nLast date to apply: 31 October 2026\nTotal vacancies: 1000\nAge limit: 18 to 30 years as on 01 January 2026\nEducation: 12th pass' };
async function verifyAll(store, job, only) {
  const j = { ...job, dates: { ...job.dates, application_open: '2026-10-01T10:00:00+05:30', application_close: '2026-10-31T23:59:00+05:30' } };
  for (const f of policy.CRITICAL_FIELDS) { if (only && !only.includes(f)) continue; await ledger.confirmField({ store, job: j, field: f, evidence: ev1(f, j), reviewer: rev, pages: [page], now: NOW }); }
  return j;
}
const trustOf = async (store, job, extra = {}) => policy.computeTrust(job, { now: NOW, verifications: await store.verificationsFor(job.id), ...extra });

// ---------- 1. status policy ----------
t('machine-read record is UNVERIFIED however high its confidence', () => {
  const tr = policy.computeTrust(mkJob({ auto_extracted: true, verification: { level: 'AUTO_EXTRACTED', confidence: 0.99 } }), { now: NOW });
  assert.strictEqual(tr.verification, 'UNVERIFIED'); assert.strictEqual(tr.can_rely_on_for_decisions, false); assert(/not proof/.test(tr.why.join(' ')));
});
t('sample and detected-only records are never labelled verified', () => {
  assert.strictEqual(policy.computeTrust(mkJob({ sample: true }), { now: NOW }).display_status, 'SAMPLE');
  const d = policy.computeTrust(mkJob(), { now: NOW, detected_only: true }); assert.strictEqual(d.display_status, 'DETECTED'); assert(/Nothing has been read/.test(d.why[0]));
});
t('VERIFIED needs every critical field confirmed by a named person with evidence', async () => {
  const s = ledger.memoryStore(); const j = await verifyAll(s, mkJob());
  const tr = await trustOf(s, j); assert.strictEqual(tr.verification, 'VERIFIED'); assert.strictEqual(tr.can_rely_on_for_decisions, true);
  const partial = ledger.memoryStore(); const j2 = await verifyAll(partial, mkJob(), ['dates.application_close', 'vacancies.total']);
  const pt = await trustOf(partial, j2); assert.strictEqual(pt.verification, 'PARTIALLY_VERIFIED'); assert(/Pending/.test(pt.why.join(' ')));
});
t('an amendment invalidates earlier confirmation (stale) until a person re-confirms', async () => {
  const s = ledger.memoryStore(); const j = await verifyAll(s, mkJob());
  const moved = { ...j, dates: { ...j.dates, application_close: '2026-11-14T23:59:00+05:30' }, history: [{ field: 'Application deadline', from: 'a', to: 'b' }] };
  const tr = await trustOf(s, moved); assert.notStrictEqual(tr.verification, 'VERIFIED'); assert.strictEqual(tr.critical_fields.status['dates.application_close'].status, 'STALE'); assert.strictEqual(tr.amended, true); assert.strictEqual(tr.needs_reverification, true);
});
t('policy/system/agent "reviewers" never count as human verification', () => {
  const j = mkJob(); const row = (by) => ({ field: 'vacancies.total', value_hash: policy.hashValue(1000), verified_by: by, verified_at: NOW.toISOString(), evidence: { document_id: 1, page: 1, quote: 'x' } });
  for (const by of ['system:auto-publish', 'policy', 'agent:x', 'AI']) assert.strictEqual(policy.verificationCounts(row(by), j).counts, false, by);
  assert.strictEqual(policy.verificationCounts(row('a@b.in'), j).counts, true);
});
t('open conflict wins over everything; expired and closed phases reported', () => {
  const c = policy.computeTrust(mkJob(), { now: NOW, flags: [{ kind: 'CONFLICTING_AMENDMENT', field: 'dates.application_close', summary: 'two documents disagree', severity: 'CRITICAL', status: 'OPEN' }] });
  assert.strictEqual(c.display_status, 'CONFLICTED'); assert.strictEqual(c.can_rely_on_for_decisions, false);
  assert.strictEqual(policy.phaseOf(mkJob({ dates: { application_open: D(-60), application_close: D(-40) } }), NOW).phase, 'EXPIRED');
  assert.strictEqual(policy.phaseOf(mkJob({ dates: { application_open: D(-60), application_close: D(-3) } }), NOW).phase, 'CLOSED');
  assert.strictEqual(policy.phaseOf(mkJob({ dates: { application_open: D(-6), application_close: D(3) } }), NOW).phase, 'CLOSING_SOON');
  assert.strictEqual(policy.phaseOf(mkJob(), NOW, { source: { gone: true } }).phase, 'EXPIRED');
});
t('fields the notice does not state are reported missing, not "verified"', async () => {
  const s = ledger.memoryStore(); const base = mkJob({ education: undefined }); const j = await verifyAll(s, base, ['dates.application_close', 'dates.application_open', 'vacancies.total', 'age.min', 'age.max', 'age.cutoff_date']);
  const tr = await trustOf(s, { ...j, education: undefined }); assert.strictEqual(tr.verification, 'PARTIALLY_VERIFIED'); assert(tr.critical_fields.missing.includes('education'));
});
t('relaxing human review is refused without measured real-notice accuracy', () => {
  assert.strictEqual(policy.humanVerificationRequired(null).required, true);
  assert.strictEqual(policy.humanVerificationRequired(self.extractionReport()).required, true);
  assert.strictEqual(policy.humanVerificationRequired({ real_documents: 250, critical: [{ field: 'x', precision_lower_bound: 0.99 }] }).required, false);
  assert.strictEqual(policy.humanVerificationRequired({ real_documents: 250, critical: [{ field: 'dates.application_close', precision_lower_bound: 0.9 }] }).required, true);
});

// ---------- 2. ledger & evidence ----------
t('confirmation must quote the page, support the value and name a person', async () => {
  const s = ledger.memoryStore(); const j = { ...mkJob(), dates: { application_open: '2026-10-01T10:00:00+05:30', application_close: '2026-10-31T23:59:00+05:30' } };
  const go = (o) => ledger.confirmField({ store: s, job: j, field: 'dates.application_close', evidence: ev1('dates.application_close'), reviewer: rev, pages: [page], now: NOW, ...o });
  await assert.rejects(() => go({ reviewer: null }), /signed-in reviewer/);
  await assert.rejects(() => go({ evidence: { ...ev1('dates.application_close'), quote: 'Last date to apply: 15 November 2026' } }), /not found on page/);
  await assert.rejects(() => go({ evidence: { document_id: 7, page: 2, quote: 'Total vacancies: 1000' } }), /does not contain the recorded value/);
  await assert.rejects(() => go({ evidence: { ...ev1('dates.application_close'), page: 9 } }), /does not exist/);
  await assert.rejects(() => go({ evidence: { quote: 'Last date to apply: 31 October 2026', page: 2 } }), /preserved official document/);
  await assert.rejects(() => ledger.confirmField({ store: s, job: j, field: 'title', evidence: ev1('x'), reviewer: rev }), /not a critical field/);
  await assert.rejects(() => go({ job: { ...j, dates: { application_close: null } } }), /nothing to confirm/);
  const ok = await go({}); assert(ok.id);
});
t('ledger is hash-chained and tampering is detected', async () => {
  const s = ledger.memoryStore(); await verifyAll(s, mkJob(), ['vacancies.total', 'age.max']);
  assert.deepStrictEqual(await ledger.verifyLedger(s), { ok: true, entries: 2 });
  s._ledger[0].detail.field = 'age.min'; assert.strictEqual((await ledger.verifyLedger(s)).ok, false);
});

// ---------- 3. flags ----------
const V = (n, close, extra = {}) => ({ version_no: n, data: { dates: { application_close: close }, vacancies: { total: extra.total ?? 1000 }, ...(extra.data || {}) }, lineage: extra.noLineage ? {} : { 'dates.application_close': { page_number: n, quote: `Last date ${close}`, document_id: n }, 'vacancies.total': { page_number: n, quote: 'v', document_id: n } }, document: { id: n, kind: n === 1 ? 'ORIGINAL' : 'CORRIGENDUM' } });
t('an earlier deadline is CRITICAL, an extension HIGH; both carry evidence', () => {
  const f = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30'), V(2, '2026-10-20T23:59:00+05:30')] });
  const d = f.find((x) => x.kind === 'DEADLINE_CHANGED'); assert.strictEqual(d.severity, 'CRITICAL'); assert(/ADVANCED by 11 days/.test(d.summary)); assert(d.evidence.from && d.evidence.to);
  const g = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30'), V(2, '2026-11-14T23:59:00+05:30')] }).find((x) => x.kind === 'DEADLINE_CHANGED'); assert.strictEqual(g.severity, 'HIGH'); assert(/extended by 14 days/.test(g.summary));
});
t('a change without cited evidence is flagged as unsupported', () => {
  const f = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30'), V(2, '2026-11-14T23:59:00+05:30', { noLineage: true })] }); assert(f.some((x) => x.kind === 'UNSUPPORTED_CHANGE'));
});
t('A -> B -> A and large vacancy swings are flagged', () => {
  const f = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30'), V(2, '2026-11-14T23:59:00+05:30'), V(3, '2026-10-31T23:59:00+05:30')] }); assert(f.some((x) => x.kind === 'REVERSED_AMENDMENT'));
  assert(flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30', { total: 1000 }), V(2, '2026-10-31T23:59:00+05:30', { total: 1500 })] }).some((x) => x.kind === 'LARGE_VACANCY_CHANGE'));
});
t('equal-authority documents that disagree are an UNRESOLVED conflict; a later corrigendum overrides', () => {
  const same = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [], documents: [{ document_id: 1, kind: 'CORRIGENDUM', issued_on: '2026-10-01', official: true, data: { dates: { application_close: '2026-11-01' } } }, { document_id: 2, kind: 'CORRIGENDUM', issued_on: '2026-10-01', official: true, data: { dates: { application_close: '2026-11-08' } } }] });
  assert(same.some((x) => x.kind === 'CONFLICTING_AMENDMENT' && x.severity === 'CRITICAL'));
  const later = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [], documents: [{ document_id: 1, kind: 'ORIGINAL', issued_on: '2026-09-01', official: true, data: { dates: { application_close: '2026-11-01' } } }, { document_id: 2, kind: 'CORRIGENDUM', issued_on: '2026-10-01', official: true, data: { dates: { application_close: '2026-11-08' } } }] });
  assert(later.some((x) => x.kind === 'AMENDMENT_OVERRIDES_EARLIER') && !later.some((x) => x.kind === 'CONFLICTING_AMENDMENT'));
});
t('flags are raised once, written to the ledger, and closed only with a reason by a person', async () => {
  const l = ledger.memoryStore(); const fs_ = flagsLib.memoryStore(l);
  const found = flagsLib.detectFlags({ recruitment_id: 'r1', versions: [V(1, '2026-10-31T23:59:00+05:30'), V(2, '2026-10-20T23:59:00+05:30')] });
  const first = await flagsLib.raiseAll(fs_, found), again = await flagsLib.raiseAll(fs_, found); assert(first.length > 0); assert.strictEqual(again.length, 0);
  assert(l._ledger.some((e) => e.kind === 'FLAG_RAISED'));
  const id = first[0].id;
  await assert.rejects(() => flagsLib.resolveFlag(fs_, id, null, { note: 'long enough note here' }), /signed-in/);
  await assert.rejects(() => flagsLib.resolveFlag(fs_, id, rev, { note: 'ok' }), /Explain how/);
  const closed = await flagsLib.resolveFlag(fs_, id, rev, { note: 'Checked corrigendum 2 page 1: date really moved earlier.' }); assert.strictEqual(closed.status, 'RESOLVED');
  await assert.rejects(() => flagsLib.resolveFlag(fs_, id, rev, { note: 'again and again again' }), /already closed/);
  assert(l._ledger.some((e) => e.kind === 'FLAG_RESOLVED' && e.actor === 'human:rev@test.in')); assert.strictEqual((await ledger.verifyLedger(l)).ok, true);
  assert((await fs_.open('r1')).length < first.length + 5);
});

// ---------- 4. source monitor ----------
t('page fingerprint ignores visitor counters/timestamps but sees real changes', () => {
  const a = monitor.normaliseHtml('<html><script>x=1</script><p>Last date: 24 October 2026</p><p>Visitors: 120,331</p><!-- c --></html>');
  const b = monitor.normaliseHtml('<html><p>Last date: 24 October 2026</p><p>Visitors: 120,999</p></html>');
  assert.strictEqual(monitor.fingerprint(a), monitor.fingerprint(b));
  const ch = monitor.detectPageChange({ text: a }, { text: monitor.normaliseHtml('<p>Last date: 07 November 2026</p><p>Vacancies 1,125</p>') });
  assert.strictEqual(ch.kind, 'CONTENT'); assert(ch.removed_dates.includes('2026-10-24') && ch.added_dates.includes('2026-11-07'));
  assert.strictEqual(monitor.detectPageChange({ text: 'Apply now please' }, { text: 'Please apply now' }).kind, 'COSMETIC');
});
t('page date vs record date mismatch', () => {
  const j = mkJob({ dates: { application_open: D(-10), application_close: '2026-10-24T23:59:00+05:30' } });
  assert.strictEqual(monitor.findDateMismatch(j, 'Last date to apply: 24 October 2026'), null);
  const m = monitor.findDateMismatch(j, 'Last date to apply: 07 November 2026'); assert.strictEqual(m.severity, 'HIGH'); assert(/07 November|2026-11-07/.test(m.summary));
});
t('expired notices: past grace, or the page gone for 3 checks', () => {
  assert.strictEqual(monitor.classifyFreshness(mkJob({ dates: { application_close: D(-45) } }), { now: NOW }).state, 'EXPIRED');
  assert.strictEqual(monitor.classifyFreshness(mkJob({ dates: { application_close: D(-2) } }), { now: NOW }).state, 'CLOSED');
  assert.strictEqual(monitor.classifyFreshness(mkJob(), { now: NOW, consecutiveMissing: 3 }).reason, 'SOURCE_GONE');
});
const resp = (status, body = '', headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => body });
t('link checker classifies OK / redirect / 404 / soft-404 / wrong type / blocked / timeout and refuses unsafe targets', async () => {
  const page = '<html><body><p>Recruitment notification for the post of clerk. Last date to apply 24 October 2026. Read the full notice below carefully.</p></body></html>';
  const routes = { 'https://ssc.gov.in/ok': resp(200, page, { 'content-type': 'text/html' }), 'https://ssc.gov.in/old': resp(301, '', { location: '/ok' }), 'https://ssc.gov.in/gone': resp(404), 'https://ssc.gov.in/soft': resp(200, '<p>Page not found</p>', { 'content-type': 'text/html' }), 'https://ssc.gov.in/file': resp(200, page, { 'content-type': 'text/html' }), 'https://ssc.gov.in/deny': resp(403), 'https://ssc.gov.in/leave': resp(302, '', { location: 'https://evil.example.com/x' }) };
  const fetch = async (u) => { if (u.includes('slow')) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return routes[u] || resp(404); };
  const st = async (u, o = {}) => (await monitor.checkLink(u, { fetch, ...o })).status;
  assert.strictEqual(await st('https://ssc.gov.in/ok'), 'OK'); assert.strictEqual(await st('https://ssc.gov.in/old'), 'REDIRECTED'); assert.strictEqual(await st('https://ssc.gov.in/gone'), 'BROKEN');
  assert.strictEqual(await st('https://ssc.gov.in/soft'), 'SOFT_404'); assert.strictEqual(await st('https://ssc.gov.in/file', { expectPdf: true }), 'WRONG_TYPE'); assert.strictEqual(await st('https://ssc.gov.in/deny'), 'BLOCKED');
  assert.strictEqual(await st('https://ssc.gov.in/slow'), 'TIMEOUT'); assert.strictEqual(await st('https://ssc.gov.in/leave'), 'UNSAFE');
  for (const u of ['http://ssc.gov.in/ok', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://evil.example.com/x', 'not a url']) assert.strictEqual(await st(u), 'UNSAFE', u);
  const sum = await monitor.checkLinks(['https://ssc.gov.in/ok', 'https://ssc.gov.in/gone'], { fetch, pauseMs: 0 }); assert.strictEqual(sum.broken, 1); assert.strictEqual(sum.ok, 1);
});
t('findingsFor raises page-changed, mismatch, broken-link and expired findings with stable dedupe keys', () => {
  const j = mkJob({ dates: { application_open: D(-60), application_close: '2026-08-01T23:59:00+05:30' }, id: 'r9' });
  const f = monitor.findingsFor(j, { page: { prev: { text: 'Last date to apply: 01 August 2026' }, next: { text: 'Last date to apply: 15 August 2026' } }, links: [{ url: 'https://ssc.gov.in/x', status: 'BROKEN', http: 404 }] }, NOW);
  assert.deepStrictEqual(f.map((x) => x.kind).sort(), ['NOTICE_EXPIRED', 'SOURCE_DATE_MISMATCH', 'SOURCE_PAGE_CHANGED', 'SOURCE_UNREACHABLE']);
  assert.deepStrictEqual(monitor.findingsFor(j, { page: { prev: { text: 'Last date to apply: 01 August 2026' }, next: { text: 'Last date to apply: 15 August 2026' } } }, NOW).map((x) => x.dedupe_key), f.filter((x) => x.kind !== 'SOURCE_UNREACHABLE').map((x) => x.dedupe_key));
});

// ---------- 5. AI guard ----------
const jobs = buildJobs(NOW); const gd = jobs.find((j) => j.id === 'rrb-group-d');
const askG = (q, tr, fl = [], mode = 'QUICK') => guard.guardAnswer({ result: ask({ jobs, question: q, recruitmentId: 'rrb-group-d', mode, now: NOW }), trust: tr, flags: fl, question: q });
t('verified answer separates official facts, computed statements and guidance', async () => {
  const s = ledger.memoryStore(); const tr = policy.computeTrust({ ...gd, sample: false }, { now: NOW, verifications: [] });
  const r = askG('What is the last date and how many vacancies?', { ...tr, verification: 'VERIFIED', verification_label: 'x', display_status: 'VERIFIED' }, [], 'ACTIONABLE');
  assert.strictEqual(r.answer_status, 'ANSWERED_VERIFIED'); assert(r.official_facts.some((f) => f.official && f.source && f.source.page)); assert(r.guidance.some((g) => g.generated)); assert(r.derived.length >= 1);
  assert(!r.official_facts.some((f) => /Next step/.test(f.text)));
});
t('unverified records are answered with a prefix, never silently', () => {
  const tr = policy.computeTrust({ ...gd, sample: false }, { now: NOW }); const r = askG('What is the last date?', tr);
  assert.strictEqual(r.answer_status, 'ANSWERED_UNVERIFIED'); assert(/^Unverified/.test(r.text));
});
t('DETECTED notice: the AI refuses to name a deadline or vacancy', () => {
  const tr = policy.computeTrust({ ...gd, sample: false }, { now: NOW, detected_only: true }); const r = askG('What is the last date to apply?', tr);
  assert.strictEqual(r.answer_status, 'INSUFFICIENT_EVIDENCE'); assert(r.abstained); assert(!/\d{4}/.test(r.text)); assert.deepStrictEqual(r.official_facts, []);
});
t('conflicting official documents: both values reported, none chosen', () => {
  const fl = [{ kind: 'CONFLICTING_AMENDMENT', field: 'dates.application_close', status: 'OPEN', severity: 'CRITICAL', summary: 'Corrigendum 1 says 1 Nov, corrigendum 2 says 8 Nov', from: '2026-11-01', to: '2026-11-08' }];
  const r = askG('What is the last date to apply?', policy.computeTrust({ ...gd, sample: false }, { now: NOW, flags: fl }), fl);
  assert.strictEqual(r.answer_status, 'CONFLICTING_OFFICIAL_SOURCES'); assert(/disagree/.test(r.text)); assert.strictEqual(r.conflicts.length, 1);
  const other = askG('How many vacancies are there?', policy.computeTrust({ ...gd, sample: false }, { now: NOW, flags: fl }), fl); assert.notStrictEqual(other.answer_status, 'CONFLICTING_OFFICIAL_SOURCES');
});
t('official silence becomes INSUFFICIENT_EVIDENCE, not an invented value', () => {
  const bare = JSON.parse(JSON.stringify(gd)); delete bare.dates.exam_date;
  const res = ask({ jobs: [bare], question: 'What is the exam date?', recruitmentId: bare.id, mode: 'OFFICIAL_ONLY', now: NOW });
  const r = guard.guardAnswer({ result: res, trust: policy.computeTrust(bare, { now: NOW }), question: 'What is the exam date?' }); assert.strictEqual(r.answer_status, 'INSUFFICIENT_EVIDENCE'); assert(!/20\d\d-\d\d-\d\d/.test(r.text));
});
t('model-written text cannot invent a date, vacancy, age, qualification or syllabus topic', () => {
  const g = (text, extra = {}) => guard.guardFreeText({ text, job: gd, now: NOW, ...extra });
  assert(g('The last date is 15 March 2031.').violations.some((v) => v.kind === 'INVENTED_DATE'));
  assert(g('There are 99,999 vacancies in this recruitment.').violations.some((v) => v.kind === 'INVENTED_FIGURE'));
  assert(g('You must have a B.Tech degree to be eligible.').violations.some((v) => v.kind === 'INVENTED_QUALIFICATION'));
  const syl = [{ title: 'Quantitative Aptitude', description: 'Arithmetic, algebra' }];
  assert(g('The syllabus includes arithmetic, quantum physics.', { syllabusNodes: syl }).violations.some((v) => v.kind === 'INVENTED_SYLLABUS_TOPIC' && /quantum/.test(v.token)));
  assert.strictEqual(g('Prepare steadily and read the notification carefully.').ok, true);
  assert.strictEqual(g('This is a 10th pass or ITI recruitment.').ok, true);
  const bad = g('The last date is 15 March 2031.'); assert.strictEqual(bad.sanitized, guard.NO_ANSWER);
});

// ---------- 6. extraction evaluation ----------
t('precision/recall arithmetic: wrong value = FP+FN, invented = FP, correct abstention = TN', () => {
  const cases = [{ id: 'a', family: 'X', provenance: 'SYNTHETIC', fields_in_scope: ['vacancies.total', 'dates.exam_date', 'age.max'], gold: { 'vacancies.total': 100, 'age.max': 30 } }];
  const rep = ev.scoreExtraction(cases, { a: { 'vacancies.total': 100, 'dates.exam_date': '2027-01-01', 'age.max': 32 } });
  const f = (n) => rep.fields.find((x) => x.field === n);
  assert.deepStrictEqual([f('vacancies.total').tp, f('vacancies.total').fp, f('vacancies.total').fn], [1, 0, 0]);
  assert.deepStrictEqual([f('dates.exam_date').tp, f('dates.exam_date').fp, f('dates.exam_date').fn], [0, 1, 0]);
  assert.deepStrictEqual([f('age.max').tp, f('age.max').fp, f('age.max').fn], [0, 1, 1]);
  const tn = ev.scoreExtraction([{ id: 'b', family: 'X', provenance: 'SYNTHETIC', fields_in_scope: ['dates.exam_date'], gold: {} }], { b: {} }); assert.strictEqual(tn.fields[0].tn, 1);
  assert.strictEqual(ev.equal('dates.application_close', '2026-10-24T23:59:00+05:30', '2026-10-24'), true);
});
t('Wilson interval is honest about small samples', () => { const w = ev.wilson(10, 10); assert(w.lower < 0.75 && w.upper === 1); assert(ev.wilson(990, 1000).lower > 0.98); assert.strictEqual(ev.wilson(0, 0).point, null); });
t('synthetic-only corpus cannot be reported as measured real-notice accuracy', () => {
  const rep = self.extractionReport(); assert.strictEqual(rep.evidence_grade, 'SYNTHETIC_ONLY'); assert.strictEqual(rep.real_documents, 0); assert(/NO accuracy claim/.test(rep.claim)); assert.strictEqual(rep.human_verification.required, true);
  const fake = ev.scoreExtraction([{ id: 'r', family: 'X', provenance: 'REAL', adjudicators: 1, fields_in_scope: [], gold: {} }], { r: {} }); assert.strictEqual(fake.real_documents, 0);
});
t('real cases must carry source URL, document hash and two adjudicators', () => {
  const p = ev.validateGold([{ id: 'r', provenance: 'REAL', pages: [{ page_number: 1, text: 'x' }], gold: {} }]).map((x) => x.problem).join('|'); assert(/source_url/.test(p) && /sha256/.test(p) && /adjudicators/.test(p));
});
t('the gold corpus is internally consistent and the extractor is measured on it', () => {
  const rep = self.extractionReport(); assert.deepStrictEqual(rep.gold_problems, []); assert(rep.documents >= 18); assert.strictEqual(rep.critical_overall.fp, 0, JSON.stringify(rep.errors.filter((e) => e.kind !== 'MISSED')));
  assert(rep.critical_overall.precision_lower_bound > 0.9); assert(rep.errors.some((e) => e.kind === 'MISSED'), 'known recall gaps must stay visible, not be hidden');
});
t('regression: "Master\'s degree" is not read as "bachelor or master"', () => {
  const { levelsFrom } = require('./lib/rulesExtractor'); assert.deepStrictEqual(levelsFrom("Master's degree in the concerned subject").accepted, ['master']); assert.deepStrictEqual(levelsFrom('Post-graduation').accepted, ['master']); assert.deepStrictEqual(levelsFrom('Graduation in any discipline').accepted, ['bachelor']);
});

// ---------- 7. eligibility ----------
t('28 hand-calculated eligibility cases agree with the engine', () => { const r = self.eligibilitySelfTest(); assert.deepStrictEqual(r.failures, []); assert(r.cases >= 28); });
t('failed criteria are listed with rule, your value, reason and source', () => {
  const e = evaluate(gd, { education: { level: '10th' }, dob: '1980-01-01' }); assert.strictEqual(e.overall, 'NOT_ELIGIBLE'); const f = e.failed_criteria.find((x) => x.key === 'age'); assert(f && f.official_rule && f.your_value && f.reason && f.result === 'NOT_ELIGIBLE');
  assert(e.rows.find((r) => r.key === 'age').rule_detail.upper_limit_additive >= 33);
});
t('missing rules give INSUFFICIENT_EVIDENCE and never crash', () => {
  const e = evaluate({ id: 'x', domicile: { type: 'ALL_INDIA' } }, { education: { level: '12th' }, dob: '2000-01-01' }); assert.strictEqual(e.overall, 'INSUFFICIENT_EVIDENCE'); assert(/Insufficient evidence/.test(e.summary));
  assert.strictEqual(evaluate(mkJob({ age: { min: 18, max: 30, cutoff_date: 'soon' } }), { education: { level: '12th' }, dob: '2000-01-01' }).overall, 'INSUFFICIENT_EVIDENCE');
});
t('eligibility never turns an unknown into a pass', () => {
  assert.strictEqual(evaluate(gd, { education: { level: '10th' } }).rows.find((r) => r.key === 'age').result, 'UNKNOWN');
  assert.notStrictEqual(evaluate(gd, { education: { level: '10th' } }).overall, 'MATCH');
});

// ---------- 8. alerts ----------
t('preferences are validated and honoured before anything is queued', () => {
  assert.throws(() => prefs.normalisePrefs({ channels: ['SMS'] }), /channels/); assert.throws(() => prefs.normalisePrefs({ min_trust: 'x' }), /min_trust/); assert.throws(() => prefs.normalisePrefs({ new_match: 'yes' }), /true or false/);
  const plans = [{ accountId: 1, recruitmentId: 'a', eventType: 'NEW_MATCH' }, { accountId: 2, recruitmentId: 'a', eventType: 'NEW_MATCH' }, { accountId: 3, recruitmentId: 'a', eventType: 'DEADLINE_CHANGED' }, { accountId: 3, recruitmentId: 'a', eventType: 'TRUST_FLAG' }];
  const r = prefs.applyPreferences(plans, { 1: { ...prefs.DEFAULTS, new_match: false }, 2: { ...prefs.DEFAULTS, min_trust: 'VERIFIED', channels: ['IN_APP'] }, 3: { ...prefs.DEFAULTS, min_trust: 'VERIFIED' } }, { a: 'UNVERIFIED' });
  assert.strictEqual(r.suppressed.length, 2); assert(r.suppressed.every((s) => s.eventType === 'NEW_MATCH')); assert.deepStrictEqual(r.plans.filter((p) => p.accountId === 3).length, 2);
});
t('deadline/conflict warnings are never hidden by "only verified"', () => assert.strictEqual(prefs.allow({ ...prefs.DEFAULTS, min_trust: 'VERIFIED' }, 'DEADLINE_CHANGED', 'UNVERIFIED').ok, true));
t('trust alerts: only people already watching, once per flag, never for inactive accounts or old flags', () => {
  const flag = { recruitment_id: 'r1', kind: 'DEADLINE_CHANGED', severity: 'CRITICAL', field: 'dates.application_close', from: 'a', to: 'b', summary: 'moved earlier', status: 'OPEN', raised_at: '2026-10-10T00:00:00Z', dedupe_key: 'k1' };
  const w = [{ account_id: 1, recruitment_id: 'r1', watch_created_at: '2026-10-01T00:00:00Z', account_active: true, title: 'T' }, { account_id: 2, recruitment_id: 'r1', watch_created_at: '2026-10-10T12:00:00Z', account_active: true }, { account_id: 3, recruitment_id: 'r1', watch_created_at: '2026-10-01T00:00:00Z', account_active: false }];
  const p = prefs.planTrustAlerts([flag, flag], w, { now: NOW }); assert.strictEqual(p.length, 1); assert.strictEqual(p[0].accountId, 1); assert.strictEqual(p[0].dedupeKey, 'TRUST_FLAG:k1'); assert(p[0].payload.verify_on_official_source);
  assert.strictEqual(prefs.planTrustAlerts([{ ...flag, raised_at: '2026-01-01T00:00:00Z' }], w, { now: NOW }).length, 0);
});
t('receipts claim "delivered" only with a provider confirmation id', () => {
  const rows = [{ alert_id: 1, channel: 'EMAIL', status: 'SENT', provider_message_id: 'm1', attempts: 1, event_type: 'X', payload: { title: 'T' } }, { alert_id: 1, channel: 'PUSH', status: 'SENT', provider_message_id: null, attempts: 1, payload: {} }, { alert_id: 1, channel: 'IN_APP', status: 'SKIPPED', last_error: 'consent withdrawn', attempts: 0, payload: {} }, { alert_id: 1, channel: 'X', status: 'QUEUED', attempts: 2, last_error: 'timeout', payload: {} }];
  const d = prefs.receipts(rows)[0].deliveries; assert.strictEqual(d[0].delivered_confirmed, true); assert.strictEqual(d[1].delivered_confirmed, false); assert(/consent/.test(d[2].note)); assert(/retrying/.test(d[3].note));
});

// ---------- 9. career fit ----------
t('score explanation reproduces the score and states it is not a probability', () => {
  const { matchJobs } = require('./lib/bridge/matcher'); const res = matchJobs({ jobs: jobs.slice(0, 6), profile: { education: { level: '12th' }, dob: '2002-05-05' }, skills: { arithmetic: { level: 0.5, confidence: 0.6 } }, resumeText: null, now: NOW });
  for (const m of res.matches.slice(0, 6)) { const x = careerFit.explainMatch(m); assert(Math.abs(x.components_sum - m.bridge_score) <= 0.6, `${m.id}: ${x.components_sum} vs ${m.bridge_score}`); assert(/not estimate/.test(x.not_a_probability)); assert(x.formula.includes('%')); }
});
t('recommendation outcomes: small samples are labelled, not over-read', () => {
  const m = careerFit.measureRecommendations([{ action_code: 'APPLY_NOW', outcome: 'APPLIED' }, { action_code: 'APPLY_NOW', outcome: 'IGNORED' }]); assert.strictEqual(m[0].enough_data, false); assert(/Too few/.test(m[0].note));
});

// ---------- 10. exam prep ----------
t('syllabus is "verified" only when pinned to a year, sourced, and every topic names a page', () => {
  const v = { recruitment_year: 2026, syllabus_version: 'v1', source_ref: 'Notification p.3', status: 'VERIFIED' };
  assert.strictEqual(prepQ.syllabusStatus(v, [{ id: 1, parent_id: null, source_page: 3 }]).verified, true);
  const bad = prepQ.syllabusStatus({ recruitment_year: 2026, status: 'DRAFT' }, [{ id: 1, parent_id: null }]); assert.strictEqual(bad.verified, false); assert(bad.problems.length >= 4);
});
t('question quality catches duplicate options, missing key, tiny option sets and unreviewed AI items', () => {
  const c = (q) => prepQ.checkQuestion({ id: 'q', text: 'What is two plus two exactly?', options: ['3', '4', '5', '6'], answer: 1, origin: 'EDITORIAL', explanation: 'x', ...q });
  assert.strictEqual(c({}).ok, true); assert(c({ options: ['3', '3', '5', '6'] }).issues.some((i) => i.code === 'DUPLICATE_OPTIONS')); assert(c({ answer: 9 }).issues.some((i) => i.code === 'KEY_NOT_AN_OPTION')); assert(c({ options: ['3', '4'] }).issues.some((i) => i.code === 'FEW_OPTIONS'));
  assert(c({ origin: 'AI_GENERATED' }).issues.some((i) => i.code === 'AI_UNREVIEWED')); assert(c({ origin: 'PREVIOUS_YEAR' }).issues.some((i) => i.code === 'PYQ_NO_SOURCE'));
  const set = prepQ.checkQuestionSet([{ id: 1, text: 'Same stem repeated here', options: ['a', 'b', 'c'], answer: 0 }, { id: 2, text: 'same  stem repeated here', options: ['a', 'b', 'c'], answer: 0 }]); assert.strictEqual(set.duplicate_stems.length, 1);
  const { BANK } = require('./lib/prep'); assert.strictEqual(prepQ.checkQuestionSet(BANK.map((x) => ({ id: x.id, q: x.q, o: x.o, a: x.a, origin: 'EDITORIAL' }))).failing.length, 0);
});
t('analytics show intervals and flag unreliable topics; the plan follows measured weakness', () => {
  const att = []; for (let i = 0; i < 20; i++) att.push({ topic: 'Quant', correct: i % 4 === 0, at: `2026-10-0${1 + (i % 9)}` }); att.push({ topic: 'GK', correct: true, at: '2026-10-09' });
  const an = prepQ.progressAnalytics(att, { now: NOW }); const q = an.topics.find((x) => x.topic === 'Quant'), g = an.topics.find((x) => x.topic === 'GK'); assert(q.reliable && !g.reliable); assert(q.ci95_pct[0] < q.accuracy_pct && q.ci95_pct[1] > q.accuracy_pct);
  const plan = prepQ.adaptivePlan({ topics: ['Quant', 'GK', 'English'], analytics: an, days: 30, minutesPerDay: 120 }); const dd = (n) => plan.allocation.find((x) => x.topic === n).days; assert(dd('Quant') > dd('GK')); assert(plan.allocation.find((x) => x.topic === 'English').why.includes('diagnostic'));
});

// ---------- 11. account ----------
t('consent is per purpose, revocable, and ACCOUNT cannot be "withdrawn" without deleting', () => {
  const st = privacy.currentConsents([{ action: 'GRANTED', version: 'v1', at: '1' }, { action: 'GRANTED', purpose: 'ALERTS', version: 'v1', at: '2' }, { action: 'WITHDRAWN', purpose: 'ALERTS', version: 'v1', at: '3' }]);
  assert.strictEqual(privacy.canProcess(st, 'ACCOUNT'), true); assert.strictEqual(privacy.canProcess(st, 'ALERTS'), false); assert.strictEqual(privacy.canProcess(st, 'PERSONALISATION'), false);
  assert.throws(() => privacy.validateChange('ACCOUNT', 'WITHDRAWN'), /deleting/); assert.throws(() => privacy.validateChange('NOPE', 'GRANTED'), /Unknown purpose/);
  assert.strictEqual(privacy.describeSessions([{ token_hash: 'a'.repeat(64), created_at: 1, expires_at: 2 }], 'a'.repeat(64))[0].current, true); assert(!JSON.stringify(privacy.describeSessions([{ token_hash: 'abcdef1234567890' }], 'x')).includes('abcdef1234567890'));
});

// ---------- 12. wiring ----------
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
t('migration 010 is additive and idempotent', () => { const m = read('db/migrations/010_trust.sql'); assert(!/DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/i.test(m)); assert(/CREATE TABLE IF NOT EXISTS field_verifications/.test(m) && /audit_immutable/.test(m) && /evidence_ledger/.test(m)); assert(!/CREATE TABLE (?!IF NOT EXISTS)/.test(m)); });
t('server wires the trust layer without removing earlier routes', () => {
  const s = read('server.js'); for (const r of ["require('./routes/trust').mount", 'lib/trust/service', 'guardAnswer', "'/api/assistant/ask'", "'/api/jobs/:id/eligibility'", "'/api/account/export'"]) assert(s.includes(r), r);
  assert(read('lib/scheduler.js').includes('trustMonitor')); assert(read('routes/admin.js').includes('scanRecruitment')); assert(read('lib/alerts.js').includes('processTrustAlerts'));
});
t('UI: badge, reasons panel and answer block are CSP-safe and cached by the service worker', () => {
  const js = read('public/trust.js'); assert(!/\son[a-z]+=/.test(js) && !/innerHTML\s*=\s*[^`'"]*\+/.test(js)); assert(read('public/index.html').includes('trust.js') && read('public/index.html').includes('trust.css')); const sw = read('public/sw.js'); assert(sw.includes('/trust.js') && sw.includes('/trust.css')); assert(read('public/app.js').includes('GCTrust'));
  assert(!/\son[a-z]+=/.test(read('public/admin.js').slice(read('public/admin.js').indexOf('trustView'))));
});

(async () => { let pass = 0, fail = 0; for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); } } console.log(`\nTrust & evidence: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })();
