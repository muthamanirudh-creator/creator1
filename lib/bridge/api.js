'use strict';
// Bridge API handlers, independent of Express so they can be reused by server.js (PostgreSQL runtime),
// standalone.js (zero-dependency runtime) and the tests.
//
// Every handler takes a context  { body, params, query, account, cookies }  and resolves to  { status, body }.
//   account : the signed-in citizen ({id,email,name}) or null
//   cookies : the raw Cookie header (used only to forward the student's own Campus session)
//
// deps = {
//   jobs(now), exams(), syllabus(versionId)            -> verified GovCareer data (async allowed)
//   store      | null   (null in the resilient/standalone runtime: no accounts, no persistence)
//   campus     | null   (campusClient; null when Campus is not part of the deployment)
//   consentVersion(), audit(actor, action, type, id, detail), privacyEvent(accountId, type, detail)
//   now()
// }
const T = require('./taxonomy');
const S = require('./service');
const { parseResume } = require('./resumeParser');
const { explainJob } = require('./matcher');
const { cookieValue } = require('./campusClient');

const ok = (body, status = 200) => ({ status, body });
const err = (status, message, extra = {}) => ({ status, body: { error: message, ...extra } });

function createApi(deps) {
  const now = () => (deps.now ? deps.now() : new Date());
  const hasAccounts = () => !!deps.store;

  async function verifiedData(at) {
    const [jobs, exams] = await Promise.all([Promise.resolve(deps.jobs(at)), Promise.resolve(deps.exams())]);
    const syllabusByVersion = {};
    for (const e of exams) syllabusByVersion[e.version_id || e.id] = (await Promise.resolve(deps.syllabus(e.version_id || e.id))) || [];
    return { jobs, exams, syllabusByVersion };
  }

  // ---- evidence gathering for a signed-in citizen -------------------------------------------------
  async function campusEvidence(account, cookies) {
    const status = { linked: false, state: 'NOT_LINKED', fetched_at: null, reason: null };
    if (!account || !deps.store) { status.state = hasAccounts() ? 'NOT_LINKED' : 'ACCOUNT_REQUIRED'; return { data: null, status }; }
    const lk = await deps.store.getLink(account.id);
    if (!lk || lk.revoked_at) return { data: null, status };
    status.linked = true;
    const cache = await deps.store.getCampusCache(account.id);
    if (!deps.campus) {
      if (cache) return { data: cache.evidence, status: { ...status, state: 'CACHED', fetched_at: cache.fetched_at, reason: 'CAMPUS_UNAVAILABLE' } };
      return { data: null, status: { ...status, state: 'UNAVAILABLE', reason: 'CAMPUS_UNAVAILABLE' } };
    }
    const token = cookieValue(cookies, 'cp_access');
    const res = await deps.campus.profile({ token, accountId: String(account.id) });
    if (res.status === 200 && res.body && res.body.schema) {
      await deps.store.putCampusCache(account.id, res.body);
      return { data: res.body, status: { ...status, state: 'LIVE', fetched_at: res.body.generated_at } };
    }
    const c = deps.campus.classify(res);
    if (res.status === 403 && ['BRIDGE_NOT_LINKED', 'BRIDGE_ACCOUNT_MISMATCH'].includes(res.body && res.body.code)) {
      // Campus says the link no longer exists on its side (e.g. revoked in Campus): honour that here too.
      await deps.store.revokeLink(account.id);
      return { data: null, status: { linked: false, state: 'REVOKED_BY_CAMPUS', fetched_at: null, reason: c.code } };
    }
    if (cache) return { data: cache.evidence, status: { ...status, state: 'CACHED', fetched_at: cache.fetched_at, reason: c.code } };
    return { data: null, status: { ...status, state: 'UNAVAILABLE', reason: c.code } };
  }

  async function gather(ctx, input) {
    const at = now();
    const data = await verifiedData(at);
    const account = ctx.account || null;
    let merged = input;
    let settings = null; let gov = null;
    let campus = { data: null, status: { linked: false, state: hasAccounts() ? 'NOT_LINKED' : 'ACCOUNT_REQUIRED', fetched_at: null, reason: null } };
    if (account && deps.store) {
      settings = await deps.store.getSettings(account.id);
      if (ctx.body && ctx.body.use_saved !== false) {
        merged = {
          ...input,
          self: { ...S.sanitizeSelf(settings.self_skills), ...input.self },
          typing_wpm: input.typing_wpm != null ? input.typing_wpm : settings.typing_wpm,
          daily_minutes: input.daily_minutes != null ? input.daily_minutes : settings.daily_minutes,
          resume_claims: input.resume_text ? input.resume_claims : (input.resume_claims.length ? input.resume_claims : S.sanitizeClaims(settings.resume_claims)),
        };
      }
      if (!(ctx.body && ctx.body.include_campus === false)) campus = await campusEvidence(account, ctx.cookies);
      gov = await deps.store.govcareerEvidence(account.id);
    }
    return { at, data, merged, campus, gov, settings };
  }

  async function analyzeCore(ctx) {
    const input = S.sanitizeInput(ctx.body, now());
    const g = await gather(ctx, input);
    const out = S.runAnalysis({ input: g.merged, jobs: g.data.jobs, exams: g.data.exams, syllabusByVersion: g.data.syllabusByVersion, campus: g.campus.data, gov: g.gov, now: g.at });
    return { g, out, input: g.merged };
  }

  const sourcesStatus = (g, out) => ({
    campus: g.campus.status,
    govcareer: g.gov ? { syllabus_topics_started: g.gov.progress.length, mock_questions_answered: g.gov.reviews.filter((r) => r.result !== 'UNANSWERED').length } : { state: hasAccounts() ? 'SIGN_IN_REQUIRED' : 'ACCOUNT_REQUIRED' },
    resume: { analysed: !!(out.parsed_resume && out.parsed_resume.ok), skills_found: out.parsed_resume && out.parsed_resume.ok ? out.parsed_resume.skills.length : (g.merged.resume_claims || []).length, stored: false },
    self: { skills_declared: Object.keys(g.merged.self).length + (g.merged.typing_wpm ? 1 : 0) },
  });

  const handlers = {
    // ---- public ---------------------------------------------------------------------------------
    async meta() {
      const mode = hasAccounts() ? 'ACCOUNTS' : 'DEMO';
      return ok({
        taxonomy_version: '1', mode, campus_linking: hasAccounts() && !!deps.campus,
        skills: T.IDS.filter((id) => !T.SKILLS[id].selfCheck).map((id) => ({ id, label: T.label(id), group: T.SKILLS[id].group, group_label: T.GROUPS[T.SKILLS[id].group], practice: T.SKILLS[id].practice })),
        self_levels: Object.keys(T.SELF_LEVELS), weights: require('./matcher').WEIGHTS,
        notes: ['Skill requirements are derived from verified records and labelled stated or inferred.', 'Eligibility is decided only by the deterministic engine.'],
      });
    },
    async parseResume(ctx) {
      const text = ctx.body && ctx.body.resume_text;
      if (typeof text !== 'string') return err(400, 'resume_text is required.');
      const r = parseResume(text);
      return r.ok ? ok(r) : err(400, r.error, { warnings: r.warnings });
    },
    async analyze(ctx) {
      const { g, out, input } = await analyzeCore(ctx);
      let snapshot = false;
      if (ctx.account && deps.store && ctx.body && ctx.body.save_snapshot === true) {
        const top = out.result.matches.slice(0, 5).map((m) => ({ id: m.id, title: m.title, bridge_score: m.bridge_score, action: m.action.code }));
        await deps.store.saveSnapshot(ctx.account.id, { ...out.result.summary, avg_top_fit: Math.round((out.result.matches.slice(0, 5).reduce((s, m) => s + (m.fit ? m.fit.score : 0), 0) / Math.max(1, Math.min(5, out.result.matches.length))) * 10) / 10 }, top);
        snapshot = true;
      }
      if (deps.audit) await deps.audit(ctx.account ? `citizen:${ctx.account.email}` : 'public', 'BRIDGE_ANALYSIS', 'bridge', null, { matches: out.result.summary.matches, campus: g.campus.status.state }).catch(() => {});
      return ok({
        generated_at: out.result.generated_at, mode: hasAccounts() ? 'ACCOUNTS' : 'DEMO', signed_in: !!ctx.account,
        sources: sourcesStatus(g, out), skills: out.profile.skills, skill_breakdown: out.profile.breakdown, evidence_summary: out.profile.summary,
        result: out.result, gap: out.gap, what_if: out.what_if || null, parsed_resume: out.parsed_resume && out.parsed_resume.ok ? { skills: out.parsed_resume.skills, education_suggestion: out.parsed_resume.education_suggestion, experience_years: out.parsed_resume.experience_years, typing_wpm: out.parsed_resume.typing_wpm, warnings: out.parsed_resume.warnings } : null,
        snapshot_saved: snapshot, daily_minutes: input.daily_minutes || out.daily_minutes,
      });
    },
    async explain(ctx) {
      const id = String(ctx.params && ctx.params.id || '');
      const body = { ...(ctx.body || {}), include_closed: true };
      const { g, out } = await analyzeCore({ ...ctx, body });
      const all = [...out.result.matches, ...out.result.not_eligible, ...out.result.closed];
      const m = all.find((x) => x.id === id);
      if (!m) return err(404, 'Recruitment not found or not yet verified.');
      return ok({ job: explainJob(m, { resumeText: g.merged.resume_text, syllabusByVersion: g.data.syllabusByVersion, skills: out.profile.skills }), sources: sourcesStatus(g, out) });
    },

    // ---- account-bound --------------------------------------------------------------------------
    async linkStatus(ctx) {
      if (!deps.store) return ok({ available: false, reason: 'ACCOUNTS_UNAVAILABLE', linked: false });
      const lk = await deps.store.getLink(ctx.account.id);
      const cache = lk && !lk.revoked_at ? await deps.store.getCampusCache(ctx.account.id) : null;
      return ok({
        available: !!deps.campus, linked: !!(lk && !lk.revoked_at), campus: lk && !lk.revoked_at ? { id_hint: String(lk.campus_user_id).slice(0, 8), email: lk.campus_email, name: lk.campus_name } : null,
        consent_version: lk ? lk.consent_version : null, linked_at: lk ? lk.linked_at : null, revoked_at: lk ? lk.revoked_at : null, cache_fetched_at: cache ? cache.fetched_at : null,
        shares: ['Campus aptitude accuracy per topic', 'Campus competency (digital twin) levels', 'Summary scores of interview, MirrorMentor, quiz and resume-analysis results', 'Skill names listed in Campus resume analyses'],
        never_shares: ['Passwords or tokens', 'Face / fingerprint data', 'Gate passes, attendance or other portal records', 'Full resume or interview transcripts'],
      });
    },
    async link(ctx) {
      if (!deps.store || !deps.campus) return err(503, 'Linking is not available in this runtime.', { code: 'BRIDGE_UNAVAILABLE' });
      if (!ctx.body || ctx.body.consent !== true) return err(400, 'Explicit consent is required to link accounts.', { code: 'CONSENT_REQUIRED' });
      const token = cookieValue(ctx.cookies, 'cp_access');
      const version = deps.consentVersion();
      const res = await deps.campus.link({ token, accountId: String(ctx.account.id), consentVersion: version });
      if (res.status !== 201 && res.status !== 200) { const c = deps.campus.classify(res); return err(res.status === 401 ? 409 : res.status === 409 ? 409 : 502, c.message, { code: c.code }); }
      const cu = res.body && res.body.campus_user;
      if (!cu || !cu.id) return err(502, 'Campus did not identify the student account.', { code: 'CAMPUS_ERROR' });
      try {
        await deps.store.saveLink(ctx.account.id, { campusUserId: cu.id, email: cu.email, name: cu.name, consentVersion: version });
      } catch (e) {
        await deps.campus.unlink({ token }).catch(() => {});
        if (e && e.code === '23505') return err(409, 'That Campus account is already linked to another GovCareer account.', { code: 'CAMPUS_ALREADY_LINKED' });
        throw e;
      }
      if (deps.privacyEvent) await deps.privacyEvent(ctx.account.id, 'BRIDGE_LINKED', { campus_user: String(cu.id).slice(0, 8) });
      if (deps.audit) await deps.audit(`citizen:${ctx.account.email}`, 'BRIDGE_LINKED', 'citizen_account', ctx.account.id, { consent_version: version });
      return handlers.linkStatus(ctx);
    },
    async unlink(ctx) {
      if (!deps.store) return err(503, 'Linking is not available in this runtime.', { code: 'BRIDGE_UNAVAILABLE' });
      await deps.store.revokeLink(ctx.account.id);
      let campusRevoked = false;
      if (deps.campus) {
        const token = cookieValue(ctx.cookies, 'cp_access');
        if (token) { const r = await deps.campus.unlink({ token }); campusRevoked = r.status === 200; }
      }
      if (deps.privacyEvent) await deps.privacyEvent(ctx.account.id, 'BRIDGE_UNLINKED', { campus_revoked: campusRevoked });
      if (deps.audit) await deps.audit(`citizen:${ctx.account.email}`, 'BRIDGE_UNLINKED', 'citizen_account', ctx.account.id, { campus_revoked: campusRevoked });
      return ok({ linked: false, campus_revoked: campusRevoked, note: campusRevoked ? 'Both sides are now unlinked and the cached Campus evidence was deleted.' : 'GovCareer stopped using Campus data and deleted the cache. Your Campus session was not available, so also use “Unlink GovCareer” inside Campus to revoke on that side.' });
    },
    async getSettings(ctx) {
      if (!deps.store) return err(503, 'Saved settings need an account.', { code: 'BRIDGE_UNAVAILABLE' });
      const s = await deps.store.getSettings(ctx.account.id);
      return ok({ self_skills: s.self_skills, typing_wpm: s.typing_wpm, daily_minutes: s.daily_minutes, resume_claims: s.resume_claims, updated_at: s.updated_at });
    },
    async putSettings(ctx) {
      if (!deps.store) return err(503, 'Saved settings need an account.', { code: 'BRIDGE_UNAVAILABLE' });
      const input = S.sanitizeInput({ self: ctx.body && ctx.body.self, typing_wpm: ctx.body && ctx.body.typing_wpm, daily_minutes: ctx.body && ctx.body.daily_minutes, resume_claims: ctx.body && ctx.body.resume_claims }, now());
      const cur = await deps.store.getSettings(ctx.account.id);
      const s = await deps.store.putSettings(ctx.account.id, {
        self_skills: ctx.body && ctx.body.self !== undefined ? input.self : cur.self_skills,
        typing_wpm: ctx.body && 'typing_wpm' in ctx.body ? input.typing_wpm : cur.typing_wpm,
        daily_minutes: input.daily_minutes || cur.daily_minutes || 120,
        resume_claims: ctx.body && ctx.body.resume_claims !== undefined ? input.resume_claims : cur.resume_claims,
      });
      return ok(s);
    },
    async history(ctx) {
      if (!deps.store) return ok({ snapshots: [] });
      const rows = await deps.store.listSnapshots(ctx.account.id, ctx.query && ctx.query.limit);
      return ok({ snapshots: rows.map((r) => ({ id: r.id, at: r.created_at, summary: r.summary, top: r.top })) });
    },
    async exportData(accountId) {
      if (!deps.store) return null;
      const [link, settings, cache, snaps] = await Promise.all([deps.store.getLink(accountId), deps.store.getSettings(accountId), deps.store.getCampusCache(accountId), deps.store.listSnapshots(accountId, 60)]);
      return { link, settings, campus_cache: cache, snapshots: snaps };
    },
  };
  return handlers;
}

module.exports = { createApi };
