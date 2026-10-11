// Phase 3: grounded answer composer. Answers are built from SEGMENTS; every fact segment is bound to a
// structured field and the audit re-verifies the rendered number/date against THAT field. Free text must
// carry no figures at all. A failed audit blocks the answer (HTTP 409) rather than shipping a guess.
const { MODES, SILENT, claimsForJob, verifyClaim, auditText, renderLeaf } = require('./claims');
const { classify, clarification, resolveJob } = require('./intent');
const { deadlineInfo } = require('./dates');
const { evaluate } = require('./eligibility');

const PHRASE = { OVERALL: { MATCH: 'matches every checked requirement', NOT_ELIGIBLE: 'does not meet at least one requirement', CONDITIONALLY_ELIGIBLE: 'is possible only if stated conditions are met', PARTIAL_MATCH: 'matches so far but needs more verification', UNKNOWN: 'cannot be decided without more details', INSUFFICIENT_EVIDENCE: 'cannot be decided because the official record does not state a required rule' } };
const HEADLINE = ['dates.application_open', 'dates.application_close', 'dates.exam_date', 'age.min', 'age.max', 'age.cutoff_date', 'vacancies.total'];

function factSegment(job, claim, mode) {
  if (!claim || !claim.supported) return { text: `${claim ? claim.label : 'This detail'}: ${SILENT}`, field: claim ? claim.field : null, silent: true };
  const body = `${claim.label}: ${renderLeaf(claim)}.`;
  if (mode === 'SOURCE_FIRST') {
    const s = claim.source; return { text: `${s ? `[${s.doc}, page ${s.page}] ` : '[source page not recorded] '}${body}`, field: claim.field, claim };
  }
  return { text: body, field: claim.field, claim };
}

// Verbatim record text (e.g. "12th pass or higher") is bound to its field; the audit masks it only if it equals the record.
function eduSeg(job, strict) { const v = job.education?.label; return v ? { text: `Education${strict ? ' (as written)' : ''}: ${v}.`, field: 'education', verbatim: { value: v, record: v } } : { text: `Education: ${SILENT}`, field: 'education', silent: true }; }
function selSeg(job, strict) { const v = (job.selection || []).join(', '); return v ? { text: `Selection stages: ${v}.`, field: 'selection', verbatim: { value: v, record: v } } : { text: `Selection stages: ${SILENT}`, field: 'selection', silent: true }; }

function composeSegments(job, route, mode, profile, now) {
  const all = claimsForJob(job, now);
  const get = (f) => all.find((c) => c.field === f);
  const seg = [{ text: `${job.title} — ${job.organization}.` , identity: true }];
  let fields = route.fields.length ? route.fields : [];

  if (mode === 'OFFICIAL_ONLY') {
    // Only what the user asked, only what the source states. Silence is stated, never filled.
    if (!fields.length && !route.text) fields = HEADLINE;
    for (const f of fields) { if (f === 'derived.days_left') continue; seg.push(factSegment(job, get(f) || { field: f, label: f, supported: false }, mode)); }
    if (route.text === 'education') seg.push(eduSeg(job, true));
    if (route.text === 'selection') seg.push(selSeg(job, true));
    return seg;
  }

  if (route.wantsEligibility) {
    const e = evaluate(job, profile || {});
    seg.push({ text: `Based on the details you shared, this recruitment ${PHRASE.OVERALL[e.overall]}.`, field: 'eligibility' });
    for (const r of e.rows) seg.push({ text: `${r.label}: ${String(r.result).replace(/_/g, ' ').toLowerCase()}.`, field: 'eligibility.row' });
    seg.push({ text: 'Missing details are not guessed; open the eligibility panel for the rule-by-rule explanation.', field: null });
    return seg;
  }

  if (route.wantsSource) {
    const want = route.fields.length ? route.fields : HEADLINE;
    const withSrc = all.filter((c) => c.supported && c.source && want.includes(c.field));
    for (const c of withSrc) seg.push({ text: `${c.label} is stated in ${c.source.doc}, page ${c.source.page}, section ${c.source.section}.`, field: 'source', claim: c });
    if (!withSrc.length) seg.push({ text: 'Page-level source references are not recorded for this recruitment.', field: null });
    return seg;
  }

  if (route.wantsCompare) { seg.push({ text: 'To compare recruitments, open the comparison view; each figure there is read from its own verified record.', field: null }); return seg; }

  if (!fields.length) fields = (mode === 'QUICK') ? ['dates.application_close', 'vacancies.total'] : HEADLINE;
  if (mode === 'DETAILED' || mode === 'EXPLAINED' || mode === 'ACTIONABLE' || mode === 'SOURCE_FIRST') { if (route.fields.length && mode !== 'SOURCE_FIRST') fields = [...new Set([...fields, ...HEADLINE.slice(0, 2)])]; }
  for (const f of fields) seg.push(factSegment(job, get(f) || { field: f, label: f, supported: false }, mode));
  if (route.text === 'education') seg.push(eduSeg(job));
  if (route.text === 'selection') seg.push(selSeg(job));
  if (mode === 'DETAILED') { if (route.text !== 'education') seg.push(eduSeg(job)); if (route.text !== 'selection' && job.selection?.length) seg.push(selSeg(job)); }
  const dl = deadlineInfo(job.dates, now);
  seg.push({ text: `Status: ${dl.status.replace('_', ' ').toLowerCase()}.`, field: 'status' });
  if (mode === 'EXPLAINED') seg.push({ text: 'Age is counted on the cutoff date printed in the notification, not on today\'s date; relaxations are added to the maximum age by category.', field: null });
  if (mode === 'ACTIONABLE') seg.push({ text: 'Next step: use the official application link on the verified notification and re-check the latest corrigendum before you submit.', field: null });
  return seg;
}

function auditSegments(job, segments, now) {
  const checks = [];
  for (const s0 of segments) {
    if (s0.identity || !s0.text) continue;
    let s = s0;
    if (s0.verbatim) {
      // Mask verbatim record text only when it is byte-identical to the record; anything else stays under audit.
      const rec = s0.field === 'education' ? job.education?.label : (job.selection || []).join(', ');
      if (rec && s0.verbatim.value === rec) s = { ...s0, text: s0.text.split(rec).join(' ') };
    }
    if (s.field && s.claim && s.claim.supported) {
      // Field-bound: every figure in this sentence must equal the declared field's value (or a recorded page).
      const per = auditText(job, s.text, now);
      for (const c of per.checks) {
        if (c.kind === 'page' || c.kind === 'identity' || c.kind === 'section') { checks.push({ ...c, bound: s.field }); continue; }
        const bound = verifyClaim(job, c.token, { field: s.claim.field, now });
        checks.push({ token: c.token, kind: 'fact', bound: s.field, ...bound });
      }
    } else {
      // Free text and silent statements must carry no unsupported figures.
      const per = auditText(job, s.text, now);
      for (const c of per.checks) checks.push({ ...c, bound: s.field || 'free-text' });
    }
  }
  return { ok: checks.every((c) => c.supported), checks, unsupported: checks.filter((c) => !c.supported).map((c) => c.token) };
}

// Pure entry point (no I/O): used by the HTTP route, the test-suite and the alert/tutor code.
function ask({ jobs, question, recruitmentId, mode = 'QUICK', profile = {}, now = new Date() }) {
  if (!MODES.includes(mode)) throw Object.assign(new Error('Unknown answer mode'), { status: 400 });
  const q = String(question || '').trim();
  if (!q) throw Object.assign(new Error('Question is required.'), { status: 400 });
  const route = classify(q);
  const { job, candidates } = resolveJob(jobs, q, recruitmentId);
  const clar = clarification({ route, job, candidates, profile });
  if (clar) return { needs_clarification: true, clarification: clar, question: clar.question, options: clar.options, intent: route.intent };
  const segments = composeSegments(job, route, mode, profile, now);
  const text = segments.map((s) => s.text).join(' ');
  const audit = auditSegments(job, segments, now);
  if (!audit.ok) throw Object.assign(new Error('Unsupported claim blocked'), { status: 409, audit, text });
  const used = segments.filter((s) => s.claim).map((s) => s.claim);
  return {
    mode, intent: route.intent, recruitment_id: job.id, text, audit,
    segments: segments.map((s) => ({ text: s.text, field: s.field || null, silent: !!s.silent })),
    claims: used,
    where_did_this_come_from: used.filter((c) => c.source).map((c) => ({ field: c.field, label: c.label, value: renderLeaf(c), ...c.source, viewer_page: c.source.page, viewer_url: c.source.document_id != null ? `/api/documents/${c.source.document_id}/file#page=${c.source.page}` : null })),
    official_silent: segments.some((s) => s.silent),
  };
}

// Legacy signature kept for callers that already hold a job.
function answerJob(job, question, mode = 'QUICK', profile = {}, now = new Date()) {
  return ask({ jobs: [job], question, recruitmentId: job.id, mode, profile, now });
}

module.exports = { ask, answerJob, composeSegments, auditSegments };
