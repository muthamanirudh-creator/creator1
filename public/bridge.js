/* GovCareer AI — Bridge (additive module).
 * Matches your skill evidence (Campus tests, resume, self-assessment, Exam Lab) to verified government
 * recruitments. Works signed-out and in the zero-dependency runtime (resume + self-assessment); Campus
 * linking and saved history need a GovCareer account. No inline handlers: the page CSP forbids them. */
(function () {
  'use strict';
  const TOKEN_KEY = 'govcareer.citizen.token.v1', PROFILE_KEY = 'govcareer.profile.v2', LOCAL_KEY = 'govcareer.bridge.v1';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (typeof window.showToast === 'function' ? window.showToast(m) : undefined);
  const root = () => $('#view-bridge');

  const ACTION = {
    APPLY_NOW: ['good', 'Strong fit — apply'], APPLY_AND_PREPARE: ['info', 'Apply and keep preparing'], PREPARE_AHEAD: ['info', 'Prepare before it opens'],
    BUILD_SKILLS: ['warn', 'Build skills first'], STRETCH: ['warn', 'Stretch target'], COMPLETE_PROFILE: ['warn', 'Complete your profile'],
    CHECK_NOTIFICATION: ['info', 'Read the notification'], NOT_ELIGIBLE: ['bad', 'Not eligible'], CLOSED: ['', 'Closed'],
  };
  const ELIG = { MATCH: ['good', 'Eligible on checked rules'], PARTIAL_MATCH: ['info', 'Matches so far'], CONDITIONALLY_ELIGIBLE: ['warn', 'Conditional'], UNKNOWN: ['warn', 'Needs your details'], NOT_ELIGIBLE: ['bad', 'Not eligible'] };
  const STATUS = { MET: ['good', 'Met'], CLOSE: ['info', 'Close'], GAP: ['bad', 'Gap'], UNKNOWN: ['warn', 'No evidence'] };
  const SELF_LABEL = { basic: 'Basic', working: 'Working', strong: 'Strong' };
  const EDU_LABEL = { '8th': '8th pass', '10th': '10th pass', '12th': '12th pass', iti: 'ITI', diploma: 'Diploma', bachelor: "Bachelor's degree", master: "Master's degree", phd: 'PhD' };

  const st = {
    meta: null, mode: 'unknown', user: null, link: null, settings: null,
    self: {}, typing: '', minutes: 120, resumeText: '', parsed: null, excluded: new Set(),
    data: null, tab: 'matches', open: new Set(), explained: {}, busy: false, history: null, whatif: { skill: '', level: 70 }, ready: false,
  };
  let token = null; try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  try { const l = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); st.self = l.self || {}; st.typing = l.typing || ''; st.minutes = l.minutes || 120; } catch { /* ignore */ }
  const persistLocal = () => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ self: st.self, typing: st.typing, minutes: st.minutes })); } catch { /* ignore */ } };
  const profile = () => { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch { return {}; } };
  const profileReady = (p) => !!(p.education && p.education.level && p.dob);

  async function call(url, opts = {}) {
    const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
    if (token && url.startsWith('/api/account/')) headers.Authorization = 'Bearer ' + token;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 20000);
    try {
      const r = await fetch(url, { ...opts, headers, signal: ctl.signal });
      let d = {}; try { d = await r.json(); } catch { /* empty */ }
      return { status: r.status, ok: r.ok, data: d };
    } catch (e) { return { status: 0, ok: false, data: { error: e.name === 'AbortError' ? 'The request timed out.' : 'Network error.' } }; } finally { clearTimeout(t); }
  }

  // ---------- small renderers ----------
  const badge = (cls, text, title) => `<span class="br-badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  const pctText = (n) => `${Math.round(n)}%`;
  function fitBar(fit) {
    if (!fit) return '<div class="br-note">No skill-based stage identified for this post.</div>';
    const lo = Math.max(0, fit.low), hi = Math.min(100, fit.high);
    return `<div class="br-fit"><div>Skill fit <strong>${pctText(fit.score)}</strong> <span>(plausible range ${pctText(lo)}–${pctText(hi)})</span></div>
      <div class="br-track" role="img" aria-label="Skill fit ${pctText(fit.score)}, plausible range ${pctText(lo)} to ${pctText(hi)}"><span class="range" style="left:${lo}%;width:${Math.max(1, hi - lo)}%"></span><span class="tick" style="left:45%"></span><span class="tick" style="left:70%"></span><span class="est" style="left:calc(${fit.score}% - 2px)"></span></div></div>`;
  }
  const meter = (level, target) => `<div class="br-meter"><span>${level == null ? '—' : pctText(level * 100)} of ${pctText(target * 100)} needed</span><div class="br-track"><span class="range" style="left:0;width:${level == null ? 0 : Math.min(100, level * 100)}%"></span><span class="tick" style="left:${Math.min(100, target * 100)}%"></span></div></div>`;
  const evidenceKind = (sources) => (sources || []).some((s) => s.verified) ? badge('good', 'Tested', 'Backed by graded answers or tracked mastery') : (sources || []).length ? badge('warn', 'Claimed', 'Self-declared or from your resume; not yet tested') : badge('', 'No evidence');

  // ---------- banners ----------
  function banner(html, cls = '') { const b = $('#br-banner'); if (!b) return; if (!html) { b.hidden = true; b.className = 'br-banner'; b.innerHTML = ''; return; } b.hidden = false; b.className = 'br-banner ' + cls; b.innerHTML = html; }
  function updateBanner() {
    const p = profile();
    const parts = [];
    if (!profileReady(p)) parts.push(`<span>Add your qualification and date of birth so Bridge can check eligibility. Skills alone never make you eligible.</span><button class="secondary-btn" data-act="goto-profile" type="button">Open profile</button>`);
    const cs = st.data && st.data.sources && st.data.sources.campus;
    if (cs && cs.state === 'CACHED') parts.push(`<span>Using your last Campus export${cs.fetched_at ? ' from ' + esc(new Date(cs.fetched_at).toLocaleString('en-IN')) : ''}. ${cs.reason === 'CAMPUS_SESSION_REQUIRED' ? 'Open Campus to refresh your session, then run Bridge again.' : 'Campus is currently unavailable.'}</span><a class="secondary-btn" href="/campus/" target="_blank" rel="noopener">Open Campus ↗</a>`);
    if (cs && cs.state === 'REVOKED_BY_CAMPUS') parts.push('<span>The link was revoked on the Campus side, so Campus evidence is no longer used.</span>');
    banner(parts.join('<br>'), parts.length ? 'warn' : '');
  }

  // ---------- source cards ----------
  function renderCampus() {
    const el = $('#br-campus .br-body'); if (!el) return;
    if (!st.meta) { el.innerHTML = '<div class="muted">Loading…</div>'; return; }
    if (st.mode === 'demo' || (st.meta && st.meta.mode === 'DEMO')) {
      el.innerHTML = `<p>Linking a Campus account needs the PostgreSQL runtime with GovCareer accounts. This demo runtime still matches your <strong>resume</strong> and <strong>self-assessment</strong>.</p>${badge('info', 'Demo runtime')}`; return;
    }
    if (!st.user) {
      el.innerHTML = `<p>Sign in to GovCareer, then link your Campus account to bring in tested aptitude accuracy, digital-twin mastery and interview scores.</p><div class="br-row"><button class="primary-btn" data-act="signin" type="button">Sign in to GovCareer</button></div>`; return;
    }
    const l = st.link;
    if (l && l.linked) {
      const c = st.data && st.data.sources && st.data.sources.campus;
      const stateBadge = c ? ({ LIVE: badge('good', 'Live'), CACHED: badge('warn', 'Last export'), UNAVAILABLE: badge('bad', 'Unavailable') }[c.state] || '') : '';
      el.innerHTML = `<div class="br-row">${badge('good', 'Linked')} ${stateBadge}</div>
        <p>Campus account <strong>${esc((l.campus && (l.campus.name || l.campus.email)) || 'linked')}</strong>${l.linked_at ? ` · linked ${esc(new Date(l.linked_at).toLocaleDateString('en-IN'))}` : ''}</p>
        <details><summary>What is shared</summary><ul class="br-share">${(l.shares || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="br-note">Never shared: ${esc((l.never_shares || []).join('; '))}.</p></details>
        <div class="br-row"><button class="secondary-btn" data-act="refresh" type="button">Refresh from Campus</button><button class="ghost-btn" data-act="unlink" type="button">Unlink</button></div><div id="br-link-msg" class="br-note" aria-live="polite"></div>`;
      return;
    }
    const shares = (l && l.shares) || ['Campus aptitude accuracy per topic', 'Campus competency (digital twin) levels', 'Summary scores of interview, MirrorMentor, quiz and resume-analysis results', 'Skill names listed in Campus resume analyses'];
    const never = (l && l.never_shares) || ['Passwords or tokens', 'Face / fingerprint data', 'Gate passes, attendance or other portal records', 'Full resume or interview transcripts'];
    el.innerHTML = `<p>Signed in as <strong>${esc(st.user.name || st.user.email)}</strong>. To link, you must also be signed in to the <a href="/campus/" target="_blank" rel="noopener">Campus portal</a> in this browser — Bridge never sees your Campus password.</p>
      <details open><summary>What will be shared</summary><ul class="br-share">${shares.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><p class="br-note">Never shared: ${esc(never.join('; '))}.</p></details>
      <label class="check"><input type="checkbox" id="br-consent"> I agree to share the evidence above from Campus with GovCareer for skill-to-job matching. I can unlink at any time.</label>
      <div class="br-row"><button class="primary-btn" data-act="link" type="button">Link Campus account</button></div><div id="br-link-msg" class="br-note" aria-live="polite"></div>`;
  }

  function renderResume() {
    const el = $('#br-resume .br-body'); if (!el) return;
    const parsed = st.parsed;
    let out = `<label class="sr" for="br-resume-text">Paste resume text</label><textarea id="br-resume-text" maxlength="100000" placeholder="Paste your resume text here. It is analysed in memory and not stored.">${esc(st.resumeText)}</textarea>
      <div class="br-row"><button class="secondary-btn" data-act="parse" type="button">Analyse resume</button><label class="ghost-btn" style="display:inline-flex;align-items:center;min-height:44px;padding:0 14px;cursor:pointer">Load .txt<input id="br-resume-file" type="file" accept=".txt,.md,text/plain" hidden></label><button class="text-btn" data-act="clear-resume" type="button">Clear</button></div>`;
    if (parsed) {
      out += `<div class="br-note">${esc(parsed.privacy || '')}</div>`;
      out += parsed.skills && parsed.skills.length
        ? `<div class="br-chips" aria-label="Skills found in your resume">${parsed.skills.map((s) => `<label title="Mentioned ${s.mentions}× (${esc((s.terms || []).join(', '))})"><input type="checkbox" data-skill="${esc(s.skill)}" ${st.excluded.has(s.skill) ? '' : 'checked'}> ${esc(s.label)}</label>`).join('')}</div><div class="br-note">Untick anything that is not true. These count as <strong>claims</strong>, not tested skills.</div>`
        : '<div class="br-note">No recognisable skills found — that is fine for aptitude-based exams.</div>';
      const e = parsed.education_suggestion;
      if (e) out += `<div class="br-banner" style="margin:0"><span>Resume suggests <strong>${esc(EDU_LABEL[e.level] || e.level)}</strong>${e.status === 'final_year' ? ' (final year)' : ''} — “${esc(e.evidence)}”. Nothing is applied until you confirm.</span><button class="secondary-btn" data-act="use-edu" type="button">Use as my qualification</button></div>`;
      (parsed.warnings || []).forEach((w) => { out += `<div class="br-note">${esc(w)}</div>`; });
    }
    el.innerHTML = out;
  }

  function renderSelf() {
    const el = $('#br-self .br-body'); if (!el || !st.meta) return;
    const groups = {};
    st.meta.skills.forEach((s) => { (groups[s.group_label] = groups[s.group_label] || []).push(s); });
    const set = Object.keys(st.self).length;
    el.innerHTML = `<label>Typing speed (words per minute)<input id="br-wpm" type="number" min="5" max="200" inputmode="numeric" value="${esc(st.typing)}" placeholder="e.g. 35"></label>
      <details ${set ? 'open' : ''}><summary>Declare skill levels (${set} set)</summary>${Object.entries(groups).map(([g, list]) => `<fieldset style="border:0;padding:0;margin:10px 0"><legend class="eyebrow">${esc(g)}</legend>${list.filter((s) => s.id !== 'typing').map((s) => `<label style="display:grid;grid-template-columns:1fr 120px;gap:8px;align-items:center;margin:4px 0">${esc(s.label)}<select data-self="${esc(s.id)}" aria-label="${esc(s.label)} level"><option value="">Not set</option>${Object.keys(SELF_LABEL).map((k) => `<option value="${k}" ${st.self[s.id] === k ? 'selected' : ''}>${SELF_LABEL[k]}</option>`).join('')}</select></label>`).join('')}</fieldset>`).join('')}</details>
      <div class="br-note">Self-declared levels are treated as unverified. Campus tests make them reliable.</div>
      <div class="br-row">${st.user ? '<button class="secondary-btn" data-act="save-settings" type="button">Save to my account</button>' : ''}<span id="br-save-msg" class="br-note" aria-live="polite"></span></div>`;
  }

  function renderSources() { renderCampus(); renderResume(); renderSelf(); updateBanner(); }

  // ---------- panels ----------
  function renderMatches() {
    const d = st.data; if (!d) return '<div class="br-empty">Run Bridge to see matches.</div>';
    const r = d.result, s = r.summary;
    let out = `<div class="br-summary"><div class="br-stat"><strong>${s.matches}</strong><span>open opportunities you can pursue</span></div><div class="br-stat"><strong>${s.apply_now}</strong><span>strong fits — apply now</span></div><div class="br-stat"><strong>${s.apply_and_prepare}</strong><span>apply and keep preparing</span></div><div class="br-stat"><strong>${s.skills_verified}/${s.skills_known}</strong><span>skills backed by tested evidence</span></div></div>
      <div class="br-legend"><span><i style="background:var(--mint-strong)"></i>Estimated skill fit</span><span><i style="background:color-mix(in srgb,var(--mint-strong) 35%,transparent)"></i>Plausible range given evidence</span><span>Ticks: good (45) · strong (70)</span></div>`;
    if (r.profile_asks && r.profile_asks.length) out += `<div class="br-banner"><span>Eligibility for some posts still needs: ${esc(r.profile_asks.slice(0, 4).map((a) => a.prompt || a.field).join(' · '))}</span><button class="secondary-btn" data-act="goto-profile" type="button">Open profile</button></div>`;
    if (!r.matches.length) out += '<div class="br-empty">No open opportunities match your profile yet. Try completing the profile, or check closed and not-eligible posts below.</div>';
    out += r.matches.map(matchCard).join('');
    if (r.not_eligible.length) out += `<details class="br-card"><summary><strong>${r.not_eligible.length} not eligible</strong> — shown so you can see why</summary><div style="display:grid;gap:10px;margin-top:10px">${r.not_eligible.map((m) => `<div class="br-note"><strong>${esc(m.title)}</strong> · ${esc(m.eligibility.blockers.join('; ') || m.eligibility.summary)}</div>`).join('')}</div></details>`;
    out += `<ul class="br-list br-note">${(r.caveats || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
    return out;
  }
  function matchCard(m) {
    const a = ACTION[m.action.code] || ['', m.action.label], e = ELIG[m.eligibility.overall] || ['', m.eligibility.overall];
    const opened = st.open.has(m.id);
    return `<article class="br-match" data-job="${esc(m.id)}"><div class="br-match-top">
      <div class="br-ring" style="--p:${Math.round(m.bridge_score)}" role="img" aria-label="Bridge score ${Math.round(m.bridge_score)} out of 100"><b>${Math.round(m.bridge_score)}</b></div>
      <div><h4>${esc(m.title)}</h4><p class="org">${esc(m.organization)} · ${esc(m.state)}${m.sample ? ' · demo record' : ''}</p>
        <div class="br-row" style="margin-top:6px">${badge(a[0], a[1])} ${badge(e[0], e[1])} ${badge('', m.deadline.label)} ${m.requirements_basis === 'INFERRED' ? badge('warn', 'Skills inferred', 'Requirements derived from the selection process, not stated by the notification') : badge('good', 'Skills from verified syllabus')}</div></div>
      <div class="br-actions"><button class="secondary-btn" data-act="toggle" data-id="${esc(m.id)}" aria-expanded="${opened}" type="button">${opened ? 'Hide why' : 'Why this?'}</button><button class="ghost-btn" data-act="open-job" data-id="${esc(m.id)}" type="button">Opportunity</button></div></div>
      ${fitBar(m.fit)}<div class="br-note">${esc(m.action.reason)}</div>
      ${opened ? `<div class="br-detail" id="br-d-${esc(m.id)}">${st.explained[m.id] ? detail(st.explained[m.id]) : '<div class="muted">Loading explanation…</div>'}</div>` : ''}</article>`;
  }
  function detail(j) {
    const cov = (j.fit && j.fit.coverage) || [];
    let out = '';
    if (cov.length) {
      out += `<div><h5>What this selection process tests</h5><div class="br-table-wrap"><table class="br-table"><thead><tr><th>Skill</th><th>Basis</th><th>Weight</th><th>You vs needed</th><th>Status</th></tr></thead><tbody>${cov.map((c) => {
        const s = STATUS[c.status] || ['', c.status];
        return `<tr><td><strong>${esc(c.label)}</strong><div class="br-note">${esc(c.rationale)}</div>${(c.evidence || []).map((x) => `<div class="br-note">• ${esc(x.source)}: ${esc(x.detail)}</div>`).join('')}</td><td>${c.kind === 'STATED' ? badge('good', 'Stated') : badge('warn', 'Inferred')}</td><td>${Math.round(c.weight * 100)}%</td><td>${meter(c.level, c.target)} ${evidenceKind(c.evidence)}</td><td>${badge(s[0], s[1])}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
    }
    const r = j.readiness;
    if (r) out += `<div><h5>Readiness</h5><ul class="br-list"><li>${r.hours_needed ? `About <strong>${r.hours_needed} study hours</strong> to reach the targets${r.ready_by ? `; at ${r.daily_minutes} min/day that is about ${r.days_to_ready} days (ready around ${esc(r.ready_by)})` : ''}.` : 'No study gap against the derived targets.'}</li><li>${r.days_available} days available. ${r.feasible ? 'This fits your time.' : `At ${r.daily_minutes} min/day you can cover about ${Math.round(r.feasibility * 100)}% of it.`}</li><li class="br-note">${esc(r.window_note)}</li></ul></div>`;
    if (j.gaps && j.gaps.length) out += `<div><h5>Close these gaps</h5>${j.gaps.map((g) => `<div style="margin:6px 0"><strong>${esc(g.label)}</strong> ${badge((STATUS[g.status] || [''])[0], (STATUS[g.status] || ['', g.status])[1])}<div class="br-row">${g.actions.map(actionButton).join('')}</div></div>`).join('')}</div>`;
    if (j.checkpoints && j.checkpoints.length) out += `<div><h5>Also prepare for</h5><ul class="br-list">${j.checkpoints.map((c) => `<li><strong>${esc(c.label)}</strong> — ${esc(c.detail)}</li>`).join('')}</ul></div>`;
    if (j.eligibility && (j.eligibility.open.length || j.eligibility.blockers.length)) out += `<div><h5>Eligibility notes</h5><ul class="br-list">${[...j.eligibility.blockers, ...j.eligibility.open].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    if (j.resume) out += `<div><h5>Resume</h5><div class="br-note">${esc(j.resume.note)}</div>${j.resume.keywords_to_evidence && j.resume.keywords_to_evidence.length ? `<ul class="br-list">${j.resume.keywords_to_evidence.map((k) => `<li>${esc(k.label)}: show evidence of ${esc(k.suggest.join(', '))}</li>`).join('')}</ul>` : ''}</div>`;
    if (j.notes && j.notes.length) out += `<ul class="br-list br-note">${j.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
    return out || '<div class="br-note">No further detail.</div>';
  }
  function actionButton(a) {
    if (a.type === 'CAMPUS_PRACTICE') return `<a class="secondary-btn" style="min-height:36px;padding:0 12px;font-size:12px" href="${esc(a.href)}" target="_blank" rel="noopener">${esc(a.label)} ↗</a>`;
    if (a.type === 'EXAM_LAB' || a.type === 'MOCK_TEST') return `<button class="secondary-btn" style="min-height:36px;padding:0 12px;font-size:12px" data-act="exam" data-v="${esc(a.exam_version_id)}" type="button">${esc(a.label)}</button>`;
    return `<span class="br-note">${esc(a.label)}</span>`;
  }

  function renderSkills() {
    const d = st.data; if (!d) return '<div class="br-empty">Run Bridge first.</div>';
    const list = Object.values(d.skills).sort((a, b) => b.level - a.level);
    if (!list.length) return '<div class="br-empty">No skill evidence yet. Link Campus, analyse a resume or declare levels — or take a Campus aptitude test.</div>';
    return `<div class="br-note">Each bar is your estimated level; the badge says how it is backed. Hover a row for its sources.</div><div class="br-skillbars">${list.map((s) => `<div class="br-skillbar" title="${esc(s.sources.map((x) => x.source + ': ' + x.detail).join('\n'))}"><div><strong>${esc(s.label)}</strong><div class="br-note">${esc(s.group)}</div></div><div class="br-track"><span class="range" style="left:0;width:${Math.round(s.level * 100)}%"></span></div><div>${pctText(s.level * 100)} ${s.tested ? badge('good', s.verified ? 'Tested' : 'Some testing') : badge('warn', 'Claimed')} <span class="br-note">conf ${Math.round(s.confidence * 100)}%</span></div></div>`).join('')}</div>
      <details><summary>Where the evidence came from</summary><ul class="br-list">${Object.entries(d.evidence_summary).map(([k, v]) => `<li>${esc(k.replace(/_/g, ' '))}: ${esc(v)}</li>`).join('')}</ul></details>`;
  }

  function renderGaps() {
    const d = st.data; if (!d) return '<div class="br-empty">Run Bridge first.</div>';
    const g = d.gap;
    if (!g.skills.length) return '<div class="br-empty">No open skill gaps among the opportunities you are eligible for. Re-run after you complete your profile.</div>';
    let out = `<div class="br-note">Ranked by how many of your ${g.considered_jobs} reachable opportunities improve per 50 hours of study.</div>`;
    if (g.plan && g.plan.blocks.length) out += `<div><h5 class="eyebrow">DAILY PLAN · ${g.plan.daily_minutes} MIN</h5><div class="br-plan">${g.plan.blocks.map((b) => `<div><strong>${esc(b.label)}</strong><br>${b.minutes_per_day} min/day · about ${b.weeks_to_target} weeks · ${b.hours_total} h total</div>`).join('')}</div><div class="br-note">${esc(g.plan.note)}</div></div>`;
    out += g.skills.slice(0, 10).map((s) => `<article class="br-gap"><div class="br-gap-head"><h4>${esc(s.label)}</h4><div class="br-row">${badge('info', `${s.demand} job${s.demand === 1 ? '' : 's'}`)} ${badge('', `~${s.hours_to_close} h to close`)} ${s.unlocks.to_strong ? badge('good', `${s.unlocks.to_strong} → strong fit`) : ''} ${s.unlocks.to_good ? badge('good', `${s.unlocks.to_good} → good fit`) : ''}</div></div>
      <div class="br-note">${s.known ? `You: ${pctText((s.current_level || 0) * 100)} · needed up to ${pctText(s.target_level * 100)}.` : `No evidence yet; needed up to ${pctText(s.target_level * 100)}.`} ${esc(s.advice)}</div>
      <div class="br-note">Needed for: ${esc(s.jobs.map((j) => j.title).join(', '))}</div><div class="br-row">${s.actions.map(actionButton).join('')}<button class="ghost-btn" style="min-height:36px;padding:0 12px;font-size:12px" data-act="whatif-skill" data-skill="${esc(s.skill)}" data-level="${Math.round(s.target_level * 100)}" type="button">Simulate reaching it</button></div></article>`).join('');
    return out;
  }

  function renderWhatIf() {
    const d = st.data; if (!d || !st.meta) return '<div class="br-empty">Run Bridge first.</div>';
    const w = st.whatif; const skills = st.meta.skills;
    let out = `<div class="br-whatif"><label>Skill<select id="br-wi-skill">${skills.map((s) => `<option value="${esc(s.id)}" ${w.skill === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label><label>Level you could reach: <output id="br-wi-out">${w.level}%</output><input id="br-wi-level" type="range" min="10" max="95" step="5" value="${w.level}"></label><button class="primary-btn" data-act="simulate" type="button">Simulate</button></div>`;
    const wi = d.what_if;
    if (wi) {
      out += `<div class="br-note">If you reached this level in <strong>${esc(Object.keys(wi.raise).map((k) => (st.meta.skills.find((s) => s.id === k) || { label: k }).label).join(', '))}</strong>:</div>`;
      out += wi.movements.length ? `<div class="br-table-wrap"><table class="br-table"><thead><tr><th>Opportunity</th><th>Bridge score</th><th>Action</th></tr></thead><tbody>${wi.movements.slice(0, 10).map((m) => `<tr><td>${esc(m.title)}</td><td>${m.score_before == null ? '' : m.score_before + ' → '}${m.score_after} <span class="br-delta ${m.delta >= 0 ? 'up' : 'down'}">${m.delta == null ? '' : (m.delta >= 0 ? '+' : '') + m.delta}</span></td><td>${m.change === 'ACTION' ? `${esc((ACTION[m.before] || [0, m.before])[1])} → <strong>${esc((ACTION[m.after] || [0, m.after])[1])}</strong>` : esc((ACTION[m.after] || [0, m.after])[1])}</td></tr>`).join('')}</tbody></table></div>` : '<div class="br-empty">That skill does not change any of your current matches.</div>';
      out += '<div class="br-note">What-if results are hypothetical and are not saved or used anywhere else.</div>';
    } else if (d.gap.skills.length) {
      out += `<div class="br-note">Quick picks:</div><div class="br-row">${d.gap.skills.slice(0, 4).map((s) => `<button class="ghost-btn" data-act="whatif-skill" data-skill="${esc(s.skill)}" data-level="${Math.round(s.target_level * 100)}" type="button">${esc(s.label)} → ${Math.round(s.target_level * 100)}%</button>`).join('')}</div>`;
    }
    return out;
  }

  function spark(points, key, label) {
    if (points.length < 2) return '';
    const W = 560, H = 90, pad = 8, xs = points.map((_, i) => pad + (i * (W - 2 * pad)) / (points.length - 1));
    const vals = points.map((p) => Number(p[key]) || 0), max = Math.max(...vals, 1), min = Math.min(...vals, 0);
    const ys = vals.map((v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad));
    return `<figure style="margin:0"><figcaption class="br-note">${esc(label)}: ${vals[0]} → <strong>${vals[vals.length - 1]}</strong></figcaption><svg class="br-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over ${points.length} snapshots"><polyline fill="none" stroke="var(--mint-strong)" stroke-width="3" points="${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')}"/>${xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3.5" fill="var(--mint-strong)"/>`).join('')}</svg></figure>`;
  }
  function renderHistory() {
    if (!st.user) return '<div class="br-empty">Sign in to save progress snapshots and watch your fit improve as you practise.</div>';
    const h = st.history;
    if (!h) return '<div class="loading-panel">Loading your snapshots…</div>';
    if (!h.length) return '<div class="br-empty">No snapshots yet. Tick “save a snapshot” and run Bridge after each study week.</div>';
    const pts = h.map((x) => ({ at: x.at, fit: x.summary.avg_top_fit, apply: (x.summary.apply_now || 0), verified: x.summary.skills_verified || 0 }));
    return `${spark(pts, 'fit', 'Average skill fit of your top 5 matches')}${spark(pts, 'verified', 'Skills backed by tested evidence')}
      <div class="br-table-wrap"><table class="br-table"><thead><tr><th>When</th><th>Matches</th><th>Apply now</th><th>Top match</th></tr></thead><tbody>${[...h].reverse().slice(0, 12).map((x) => `<tr><td>${esc(new Date(x.at).toLocaleString('en-IN'))}</td><td>${x.summary.matches}</td><td>${x.summary.apply_now}</td><td>${esc((x.top[0] && x.top[0].title) || '—')} ${x.top[0] ? `(${x.top[0].bridge_score})` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function renderPanel() {
    const el = $('#br-panel'); if (!el) return;
    const tabs = { matches: renderMatches, skills: renderSkills, gaps: renderGaps, whatif: renderWhatIf, history: renderHistory };
    el.innerHTML = (tabs[st.tab] || renderMatches)();
    document.querySelectorAll('#view-bridge .br-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === st.tab)));
    if (st.tab === 'history' && st.user && !st.history) loadHistory();
  }

  // ---------- data flow ----------
  async function detectAccount() {
    const r = await call('/api/account/me');
    if (r.ok && r.data && r.data.id) { st.user = r.data; st.mode = 'accounts'; }
    else { st.user = null; st.mode = r.status === 401 ? 'accounts' : (r.status === 404 || r.status === 405 || r.status === 503) ? 'demo' : 'unknown'; if (r.status === 401 && token) { token = null; try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } } }
  }
  async function loadLink() {
    if (!st.user) { st.link = null; return; }
    const r = await call('/api/account/bridge/link'); st.link = r.ok ? r.data : null;
  }
  async function loadSettings() {
    if (!st.user) return;
    const r = await call('/api/account/bridge/settings');
    if (r.ok) {
      st.settings = r.data;
      if (!Object.keys(st.self).length && r.data.self_skills) st.self = { ...r.data.self_skills };
      if (!st.typing && r.data.typing_wpm) st.typing = String(r.data.typing_wpm);
      if (r.data.daily_minutes) { st.minutes = r.data.daily_minutes; }
    }
  }
  async function loadHistory() { const r = await call('/api/account/bridge/history'); st.history = r.ok ? r.data.snapshots : []; renderPanel(); }

  function body(extra = {}) {
    const claims = st.parsed && !st.resumeText ? (st.parsed.skills || []).filter((s) => !st.excluded.has(s.skill)).map((s) => ({ skill: s.skill, level_hint: s.level_hint, terms: s.terms })) : [];
    return { profile: profile(), self: st.self, typing_wpm: st.typing ? Number(st.typing) : null, daily_minutes: st.minutes, resume_text: st.resumeText || '', resume_claims: claims, resume_exclude: [...st.excluded], ...extra };
  }
  async function run(extra = {}, quiet = false) {
    if (st.busy) return; st.busy = true;
    const btn = $('#br-run'); if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    if (!quiet) { const p = $('#br-panel'); if (p && !st.data) p.innerHTML = '<div class="loading-panel">Matching evidence to verified recruitments…</div>'; }
    const url = st.user ? '/api/account/bridge/analyze' : '/api/bridge/analyze';
    const snap = !!(st.user && $('#br-snapshot') && $('#br-snapshot').checked);
    const r = await call(url, { method: 'POST', body: JSON.stringify(body({ ...extra, save_snapshot: snap })), timeout: 30000 });
    st.busy = false; if (btn) { btn.disabled = false; btn.textContent = 'Run Bridge'; }
    if (!r.ok) { $('#br-panel').innerHTML = `<div class="br-empty" role="alert"><strong>Bridge could not run.</strong><br>${esc(r.data.error || 'Please try again.')}<br><button class="secondary-btn" data-act="run" type="button">Retry</button></div>`; return; }
    st.data = r.data; st.explained = {};
    if (r.data.snapshot_saved) { st.history = null; toast('Snapshot saved'); }
    if (st.user && r.data.sources && r.data.sources.campus && r.data.sources.campus.state === 'REVOKED_BY_CAMPUS') await loadLink();
    renderSources(); renderPanel();
    st.open.forEach((id) => explain(id));
  }
  async function explain(id) {
    const url = st.user ? `/api/account/bridge/jobs/${encodeURIComponent(id)}/explain` : `/api/bridge/jobs/${encodeURIComponent(id)}/explain`;
    const r = await call(url, { method: 'POST', body: JSON.stringify(body()) });
    st.explained[id] = r.ok ? r.data.job : { notes: [r.data.error || 'Explanation unavailable.'] };
    if (st.tab === 'matches') renderPanel();
  }

  // ---------- actions ----------
  async function parseResume() {
    const text = ($('#br-resume-text') || {}).value || '';
    st.resumeText = text;
    const r = await call('/api/bridge/resume/parse', { method: 'POST', body: JSON.stringify({ resume_text: text }) });
    if (!r.ok) { toast(r.data.error || 'Could not analyse the resume.'); st.parsed = null; renderResume(); return; }
    st.parsed = r.data; st.excluded = new Set();
    if (r.data.typing_wpm && !st.typing) { st.typing = String(r.data.typing_wpm); persistLocal(); }
    renderSources(); toast(`Found ${r.data.skills.length} skill${r.data.skills.length === 1 ? '' : 's'} in your resume`);
    run({}, true);
  }
  function useEducation() {
    const e = st.parsed && st.parsed.education_suggestion; if (!e) return;
    const p = profile(); p.education = { level: e.level, status: e.status, field: e.field || undefined };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
    if (typeof window.profile === 'object' && window.profile) Object.assign(window.profile, p);
    try { if (typeof syncProfileUI === 'function') syncProfileUI(); } catch { /* ignore */ }
    toast('Qualification added to your profile. Check the details in Opportunities.'); run({}, true);
  }
  async function link() {
    const msg = $('#br-link-msg');
    if (!($('#br-consent') || {}).checked) { if (msg) msg.textContent = 'Please tick the consent box first.'; return; }
    if (msg) msg.textContent = 'Linking…';
    const r = await call('/api/account/bridge/link', { method: 'POST', body: JSON.stringify({ consent: true }) });
    if (!r.ok) {
      const code = r.data.code; const m = $('#br-link-msg');
      if (m) m.innerHTML = code === 'CAMPUS_SESSION_REQUIRED' ? 'You are not signed in to Campus in this browser (or the session expired). <a href="/campus/" target="_blank" rel="noopener">Open Campus ↗</a>, sign in, then press Link again.' : esc(r.data.error || 'Linking failed.');
      return;
    }
    st.link = r.data; toast('Campus linked'); run();
  }
  async function unlink() {
    if (!window.confirm('Unlink Campus? GovCareer will delete the cached Campus evidence and stop using it.')) return;
    const r = await call('/api/account/bridge/link', { method: 'DELETE' });
    if (!r.ok) { toast(r.data.error || 'Could not unlink.'); return; }
    st.link = { linked: false }; await loadLink(); renderSources(); toast(r.data.campus_revoked ? 'Unlinked on both sides' : 'Unlinked in GovCareer'); const m = $('#br-link-msg'); if (m) m.textContent = r.data.note || ''; run({}, true);
  }
  async function saveSettings() {
    const claims = st.parsed ? (st.parsed.skills || []).filter((s) => !st.excluded.has(s.skill)).map((s) => ({ skill: s.skill, level_hint: s.level_hint, terms: s.terms })) : undefined;
    const r = await call('/api/account/bridge/settings', { method: 'PUT', body: JSON.stringify({ self: st.self, typing_wpm: st.typing ? Number(st.typing) : null, daily_minutes: st.minutes, ...(claims ? { resume_claims: claims } : {}) }) });
    const m = $('#br-save-msg'); if (m) m.textContent = r.ok ? 'Saved. Resume text is never saved — only the skills you kept.' : (r.data.error || 'Could not save.');
  }

  // ---------- events ----------
  function onClick(e) {
    const t = e.target.closest('[data-act],[data-tab]'); if (!t || !root() || !root().contains(t)) return;
    if (t.dataset.tab) { st.tab = t.dataset.tab; renderPanel(); return; }
    const act = t.dataset.act;
    if (act === 'run') run();
    else if (act === 'parse') parseResume();
    else if (act === 'clear-resume') { st.resumeText = ''; st.parsed = null; st.excluded = new Set(); renderResume(); run({}, true); }
    else if (act === 'use-edu') useEducation();
    else if (act === 'link') link();
    else if (act === 'unlink') unlink();
    else if (act === 'refresh') run();
    else if (act === 'save-settings') saveSettings();
    else if (act === 'signin') { const b = $('#account-btn'); if (b) b.click(); }
    else if (act === 'goto-profile') { if (typeof window.nav === 'function') window.nav('opportunities'); setTimeout(() => { const p = $('#profile-panel'); if (p) p.scrollIntoView({ behavior: 'smooth' }); }, 120); }
    else if (act === 'open-job') { if (typeof window.openJob === 'function') window.openJob(t.dataset.id); }
    else if (act === 'toggle') { const id = t.dataset.id; if (st.open.has(id)) st.open.delete(id); else { st.open.add(id); if (!st.explained[id]) explain(id); } renderPanel(); }
    else if (act === 'exam') { if (typeof window.nav === 'function') window.nav('exams'); setTimeout(() => { try { if (typeof openExam === 'function') openExam(t.dataset.v); } catch { /* ignore */ } }, 400); }
    else if (act === 'whatif-skill') { st.whatif = { skill: t.dataset.skill, level: Number(t.dataset.level) || 70 }; st.tab = 'whatif'; run({ raise: { [st.whatif.skill]: st.whatif.level / 100 } }, true); }
    else if (act === 'simulate') { run({ raise: { [st.whatif.skill]: st.whatif.level / 100 } }, true); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.matches('[data-skill]')) { if (t.checked) st.excluded.delete(t.dataset.skill); else st.excluded.add(t.dataset.skill); return; }
    if (t.matches('[data-self]')) { if (t.value) st.self[t.dataset.self] = t.value; else delete st.self[t.dataset.self]; persistLocal(); const s = $('#br-self summary'); if (s) s.textContent = `Declare skill levels (${Object.keys(st.self).length} set)`; return; }
    if (t.id === 'br-wpm') { st.typing = t.value; persistLocal(); return; }
    if (t.id === 'br-wi-skill') { st.whatif.skill = t.value; return; }
    if (t.id === 'br-resume-file' && t.files && t.files[0]) {
      const f = t.files[0]; if (f.size > 300000) { toast('Please choose a text file under 300 KB.'); return; }
      const rd = new FileReader(); rd.onload = () => { st.resumeText = String(rd.result || '').slice(0, 100000); renderResume(); parseResume(); }; rd.readAsText(f);
    }
  }
  function onInput(e) {
    const t = e.target;
    if (t.id === 'br-minutes') { st.minutes = Number(t.value); $('#br-minutes-out').textContent = `${st.minutes} min`; persistLocal(); }
    else if (t.id === 'br-wi-level') { st.whatif.level = Number(t.value); const o = $('#br-wi-out'); if (o) o.textContent = `${t.value}%`; }
    else if (t.id === 'br-resume-text') st.resumeText = t.value;
  }

  async function loadBridge() {
    const mins = $('#br-minutes'); if (mins) { mins.value = st.minutes; $('#br-minutes-out').textContent = `${st.minutes} min`; }
    if (!st.meta) { const r = await call('/api/bridge/meta'); if (r.ok) { st.meta = r.data; if (!st.whatif.skill) st.whatif.skill = (r.data.skills.find((s) => s.id === 'gk') || r.data.skills[0]).id; } }
    renderSources();
    await detectAccount();
    await Promise.all([loadLink(), loadSettings()]);
    if (st.user && !$('#br-snapshot-wrap')) { const run = $('.bridge-run'); if (run) { const w = document.createElement('label'); w.id = 'br-snapshot-wrap'; w.className = 'check'; w.innerHTML = '<input type="checkbox" id="br-snapshot"> Save a progress snapshot'; run.insertBefore(w, $('#br-run')); } }
    if (!st.user) { const w = $('#br-snapshot-wrap'); if (w) w.remove(); }
    renderSources();
    st.ready = true;
    await run({}, !!st.data);
  }
  window.loadBridge = loadBridge;
  window.__bridge = st;   // read-only inspection aid for tests and debugging

  function bind() {
    const r = root(); if (!r || r.dataset.bound) return;
    r.dataset.bound = '1';
    r.addEventListener('click', onClick); r.addEventListener('change', onChange); r.addEventListener('input', onInput);
    renderSelf();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
