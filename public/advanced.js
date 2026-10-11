/* GovCareer AI — Advanced Strategy Suite (additive module).
 * Age runway, deadline radar, decision matrix, study planner with spaced revision, mock analytics, what-if,
 * target portfolio with syllabus overlap, and a local photo/signature checker. Everything is computed from verified
 * records or from numbers you enter; your profile is sent only to compute the answer and is never stored here.
 * No inline handlers: the page CSP forbids them. */
(function () {
  'use strict';
  const PROFILE_KEY = 'govcareer.profile.v2', STORE_KEY = 'govcareer.advanced.v1';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (typeof window.showToast === 'function' ? window.showToast(m) : undefined);
  const root = () => $('#view-advanced');
  const panel = () => $('#adv-panel');
  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
  const profile = () => readJSON(PROFILE_KEY, {});
  const ready = (p) => !!(p.education && p.education.level && p.dob);
  let store = readJSON(STORE_KEY, {}); // { weights, deck:[{id,title,ease,interval,reps,due}], study:{...}, mock:{...}, remind:bool, notified:{} }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage blocked */ } };
  const st = { tab: 'brief', busy: false, meta: null, seq: 0 };

  async function api(url, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      let d = {}; try { d = await r.json(); } catch { /* empty */ }
      if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
      return d;
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'The request timed out. Please try again.' : e.message); } finally { clearTimeout(t); }
  }
  const badge = (cls, text) => `<span class="br-badge ${cls}">${esc(text)}</span>`;
  const stat = (n, label) => `<div class="br-stat"><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`;
  const fmtDate = (ymd) => { if (!ymd) return '—'; const [y, m, d] = ymd.split('-').map(Number); return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d))); };
  const TIER = { A: 'good', B: 'info', C: 'warn', BLOCKED: 'bad' };
  const note = (t) => `<p class="fine">${esc(t)}</p>`;
  const err = (e) => `<div class="br-banner bad" role="alert">${esc(e.message || e)}</div>`;
  function needProfile() { return `<div class="br-banner warn"><span>Add your education and date of birth in your profile to unlock this analysis.</span><button class="secondary-btn" data-adv="goto-profile" type="button">Open profile</button></div>`; }

  /* ---------- tabs ---------- */
  const TABS = [['brief', 'Brief'], ['rank', 'Decision matrix'], ['timeline', 'Deadlines'], ['age', 'Age runway'], ['study', 'Study planner'], ['mock', 'Mock analytics'], ['whatif', 'What-if'], ['portfolio', 'Portfolio'], ['docs', 'Photo check']];
  function drawTabs() {
    const bar = $('#adv-tabs'); if (!bar || bar.dataset.ready) return; bar.dataset.ready = '1';
    bar.innerHTML = TABS.map(([k, l]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${k === st.tab}">${esc(l)}</button>`).join('');
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
    bar.addEventListener('keydown', (e) => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const i = TABS.findIndex((t) => t[0] === st.tab); go(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length][0]); $(`#adv-tabs [data-tab="${st.tab}"]`).focus(); });
  }
  function go(tab) { st.tab = tab; $$('#adv-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab))); render(); }
  async function render() {
    const my = ++st.seq; const p = panel(); if (!p) return;
    p.innerHTML = '<div class="loading-panel">Working…</div>';
    try { const html = await VIEWS[st.tab](); if (my !== st.seq) return; p.innerHTML = html; (WIRE[st.tab] || (() => {}))(p); }
    catch (e) { if (my === st.seq) p.innerHTML = err(e); }
  }
  const body = (extra) => ({ profile: profile(), ...extra });

  /* ---------- Brief ---------- */
  async function icsBuild() {
    const d = await api('/api/advanced/planner', body({}));
    const esc2 = (s) => String(s || '').replace(/[\\;,]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n');
    const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GovCareer AI//Advanced//EN', 'CALSCALE:GREGORIAN'];
    const label = { OPENS: 'Applications open', CLOSES: 'Application deadline', EXAM: 'Exam' };
    for (const e of d.events) {
      const day = e.date.replace(/-/g, ''), next = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
      out.push('BEGIN:VEVENT', `UID:${esc2(e.job_id)}-${e.type}-${day}@govcareer.ai`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc2(`${label[e.type]}: ${e.title}`)}`);
      if (e.type === 'CLOSES') out.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Deadline in 3 days', 'TRIGGER:-P3D', 'END:VALARM', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Deadline tomorrow', 'TRIGGER:-P1D', 'END:VALARM');
      out.push('END:VEVENT');
    }
    out.push('END:VCALENDAR'); return out.join('\r\n');
  }
  function download(name, text, type) { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([text], { type })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }
  function rowsList(rows) { return rows.length ? `<ul class="br-share">${rows.join('')}</ul>` : '<div class="muted">Nothing to show.</div>'; }
  const URG = { CRITICAL: 'bad', HIGH: 'warn', MEDIUM: 'info', LOW: 'good' };
  function nextActionsCard(na) {
    if (!na || na.error) return `<article class="br-card"><h3>Next actions</h3>${note('Next actions are unavailable right now. The rest of your brief is unaffected.')}</article>`;
    const items = na.actions.map((a) => `<li><strong>${esc(a.title)}</strong> ${badge(URG[a.urgency] || 'info', a.urgency.toLowerCase())} ${badge('info', 'confidence: ' + a.confidence.toLowerCase())}<div class="muted">${esc(a.why)}</div>${a.caveats && a.caveats.length ? `<div class="fine">${esc(a.caveats.join(' '))}</div>` : ''}</li>`);
    const miss = na.missing_profile_fields.length ? `<div class="br-banner warn">Missing from your profile: ${esc(na.missing_profile_fields.map((m) => m.label).join(', '))}. These stay "unable to determine" until you add them.</div>` : '';
    return `<article class="br-card"><h3>Next actions</h3>${miss}${rowsList(items)}${na.notes.map(note).join('')}${note(na.disclaimer)}</article>`;
  }
  async function viewBrief() {
    const p = profile(); const d = await api('/api/advanced/brief', body({}));
    const k = d.kpis;
    let na = null; try { na = await api('/api/advanced/next-actions', body({})); } catch (e) { na = { error: e.message }; }
    const remind = typeof Notification !== 'undefined' ? `<button class="secondary-btn" data-adv="remind" type="button">${store.remind ? 'Reminders on — turn off' : 'Enable deadline reminders'}</button>` : '';
    return `${ready(p) ? '' : needProfile()}
      <div class="br-summary">${stat(k.open_and_possible, 'Open and possible for you')}${stat(k.tier_a, 'Strong-fit (tier A)')}${stat(k.closing_in_7_days, 'Closing within 7 days')}${stat(k.conflicts, 'Schedule conflicts')}${stat(k.last_chance_age_windows, 'Age “last chance” windows')}</div>
      <div class="br-row"><button class="primary-btn" data-adv="ics" type="button">Download calendar (.ics)</button><button class="secondary-btn" data-adv="print" type="button">Print brief</button>${remind}</div>
      ${nextActionsCard(na)}
      <article class="br-card"><h3>Best next moves</h3>${rowsList(d.top.map((r) => `<li><strong>${esc(r.title)}</strong> ${badge(TIER[r.tier], 'Tier ' + r.tier)} <span class="muted">score ${r.score} · ${esc(r.eligibility.replace(/_/g, ' ').toLowerCase())}${r.top3_stability != null ? ` · top-3 in ${r.top3_stability}% of weightings` : ''}</span></li>`))}</article>
      <article class="br-card"><h3>Closing soon</h3>${rowsList(d.closing_soon.map((r) => `<li><strong>${esc(r.title)}</strong> — ${r.in_days === 0 ? 'today' : r.in_days + ' day(s)'} (${fmtDate(r.closes)})</li>`))}</article>
      <article class="br-card"><h3>Conflicts to plan around</h3>${rowsList(d.conflicts.map((c) => `<li>${badge(c.severity === 'HIGH' ? 'bad' : c.severity === 'MEDIUM' ? 'warn' : 'info', c.severity)} ${esc(c.message)}</li>`))}</article>
      <article class="br-card"><h3>Application fees</h3><div>Known total for your open, possible applications: <strong>₹${d.budget.total_known}</strong>${d.budget.unknown_count ? ` <span class="muted">(+${d.budget.unknown_count} with no published fee)</span>` : ''}</div>${note(d.budget.note)}</article>
      ${note('Scores rank fit and practicality from verified fields. They are not selection probabilities.')}`;
  }

  /* ---------- Decision matrix ---------- */
  const WLABEL = { eligibility: 'Eligibility fit', time_to_apply: 'Time left to apply', prep_time: 'Preparation time', seats: 'Seats open to you', cost: 'Low application fee', age_comfort: 'Age headroom' };
  async function viewRank() {
    st.meta = st.meta || await api('/api/advanced/meta');
    const w = { ...st.meta.default_weights, ...(store.weights || {}) };
    const d = await api('/api/advanced/rank', body({ weights: w }));
    const sliders = Object.keys(st.meta.default_weights).map((k) => `<label class="bridge-minutes">${esc(WLABEL[k] || k)} <output>${w[k]}</output><input type="range" min="0" max="100" step="5" value="${w[k]}" data-weight="${k}"></label>`).join('');
    const rows = d.rows.map((r) => `<article class="br-match${r.blocked ? ' dim' : ''}"><div class="br-row"><strong>${r.rank ? '#' + r.rank + ' ' : ''}${esc(r.title)}</strong>${badge(TIER[r.tier], r.blocked ? (r.lifecycle === 'CLOSED' ? 'Closed' : 'Not eligible') : 'Tier ' + r.tier)}<span class="muted">${r.blocked ? '' : 'score ' + r.score}${r.top3_stability != null ? ` · top-3 stability ${r.top3_stability}%` : ''}</span></div>
      <details><summary>Why this score</summary><table class="elig"><thead><tr><th>Criterion</th><th>Value</th><th>Score</th><th>Weight</th></tr></thead><tbody>${Object.entries(r.criteria).map(([k, c]) => c.excluded ? `<tr><td>${esc(WLABEL[k] || k)}</td><td colspan="3" class="muted">Excluded — no verified value</td></tr>` : `<tr><td>${esc(WLABEL[k] || k)}<div class="fine">${esc(c.note)}</div></td><td>${esc(c.raw)}</td><td>${Math.round(c.score)}</td><td>${c.weight_share}%</td></tr>`).join('')}</tbody></table></details></article>`).join('');
    return `<article class="br-card"><h3>What matters to you?</h3><div class="bridge-run">${sliders}</div><div class="br-row"><button class="secondary-btn" data-adv="reset-weights" type="button">Reset weights</button></div>${note(d.note)}</article>${rows}`;
  }

  /* ---------- Deadlines ---------- */
  async function viewTimeline() {
    const d = await api('/api/advanced/planner', body({}));
    const typeLabel = { OPENS: 'Opens', CLOSES: 'Closes', EXAM: 'Exam' };
    const weeks = d.weekly.map((w) => `<article class="br-match"><strong>${fmtDate(w.week_start)} – ${fmtDate(w.week_end)}</strong>${rowsList(w.items.map((e) => `<li>${badge(e.type === 'EXAM' ? 'info' : e.type === 'CLOSES' ? 'warn' : 'good', typeLabel[e.type])} ${fmtDate(e.date)} · ${esc(e.title)} <span class="muted">(in ${e.in_days} d)</span>${e.apply_by ? ` <span class="muted">· aim to apply by ${fmtDate(e.apply_by)}</span>` : ''}</li>`))}</article>`).join('');
    return `${ready(profile()) ? '' : needProfile()}<div class="br-summary">${stat(d.jobs_considered, 'Recruitments considered')}${stat(d.conflicts.length, 'Conflicts')}${stat('₹' + d.budget.total_known, 'Known fees')}</div>
      <article class="br-card"><h3>Conflict radar</h3>${rowsList(d.conflicts.map((c) => `<li>${badge(c.severity === 'HIGH' ? 'bad' : c.severity === 'MEDIUM' ? 'warn' : 'info', c.severity)} ${esc(c.message)}</li>`))}</article>
      <h3>Next 12 weeks</h3>${weeks || '<div class="muted">No upcoming dates.</div>'}
      <article class="br-card"><h3>Fees by application</h3><table class="elig"><thead><tr><th>Recruitment</th><th>Fee</th></tr></thead><tbody>${d.budget.rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${r.amount == null ? 'Not published' : esc(r.fee_label)}</td></tr>`).join('')}</tbody></table>${note(d.budget.note)}</article>`;
  }

  /* ---------- Age runway ---------- */
  async function viewAge() {
    const p = profile(); if (!p.dob) return needProfile();
    const d = await api('/api/advanced/runway', body({}));
    const U = { COMFORTABLE: ['good', 'Comfortable'], FEW_CYCLES_LEFT: ['info', 'Few cycles left'], LAST_CHANCE_WINDOW: ['warn', 'Last-chance window'], OVER_AGE: ['bad', 'Over age'], TOO_YOUNG: ['bad', 'Too young'] };
    return `<div class="br-summary">${stat(d.summary.eligible_by_age, 'Eligible by age')}${stat(d.summary.over_age, 'Over age')}${stat(d.summary.too_young, 'Below minimum')}</div>` + d.rows.map((r) => `<article class="br-match"><div class="br-row"><strong>${esc(r.title)}</strong>${badge(...U[r.urgency])}</div>
      <div class="fine">Age at cutoff ${esc(r.age_at_cutoff)} (as on ${fmtDate(r.cutoff_date)}) · official ${esc(r.official_range)} · your upper limit ${r.your_upper_limit}${r.relaxation_applied.length ? ' (' + esc(r.relaxation_applied.join(', ')) + ')' : ''}</div>
      <div>${r.ages_out_on ? `You pass the limit on <strong>${fmtDate(r.ages_out_on)}</strong> — last eligible cutoff <strong>${fmtDate(r.last_eligible_cutoff)}</strong>${r.cycles_left_if_same_cutoff_repeats ? `, about ${r.cycles_left_if_same_cutoff_repeats} more yearly cycle(s)` : ''}.` : r.becomes_eligible_on ? `You reach the minimum age on ${fmtDate(r.becomes_eligible_on)}.` : 'Above the upper age limit for this notification.'}</div></article>`).join('') + note('Assumes future notifications keep the same limits and cutoff month and day. Real notifications vary; always verify.');
  }

  /* ---------- Study planner + spaced revision ---------- */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  function studyForm(s) {
    return `<article class="br-card"><h3>Plan</h3><div class="br-body">
      <label>Exam date<input type="date" id="st-exam" value="${esc(s.exam_date || '')}"></label>
      <div class="br-row"><label>Hours per day<input type="number" id="st-hpd" min="0.5" max="14" step="0.5" value="${s.hours_per_day || 3}"></label><label>Rest day<select id="st-rest"><option value="">None</option>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}"${String(s.rest) === String(i) ? ' selected' : ''}>${d}</option>`).join('')}</select></label><label>Mock every (days)<input type="number" id="st-mock" min="0" max="60" value="${s.mock_every_days ?? 7}"></label><label>Final revision days<input type="number" id="st-final" min="0" max="14" value="${s.final_days ?? 3}"></label></div>
      <label>Topics — one per line: <code>Topic, confidence 0-5, weight</code><textarea id="st-topics" placeholder="Quantitative Aptitude, 2, 2&#10;English Comprehension, 4, 1">${esc(s.topics_text || '')}</textarea></label>
      <div class="br-row"><select id="st-exam-src" aria-label="Load topics from a verified syllabus"><option value="">Load topics from a verified syllabus…</option></select><button class="secondary-btn" data-adv="st-load" type="button">Load</button><button class="primary-btn" data-adv="st-run" type="button">Build plan</button></div></div></article><div id="st-out"></div><div id="deck-wrap">${deckHtml()}</div>`;
  }
  function deckHtml() {
    const deck = store.deck || [], t = today(), due = deck.filter((c) => c.due <= t);
    return `<article class="br-card"><h3>Spaced-revision deck (${due.length} due today)</h3>${due.length ? due.map((c) => `<div class="br-match"><strong>${esc(c.title)}</strong><div class="br-row"><span class="muted">How well did you recall it?</span>${[0, 1, 2, 3, 4, 5].map((q) => `<button class="secondary-btn" data-adv="rate" data-id="${esc(c.id)}" data-q="${q}" type="button" aria-label="Rate ${q} of 5">${q}</button>`).join('')}</div></div>`).join('') : '<div class="muted">Nothing due. Add topics from a plan below.</div>'}
      <div class="fine">${deck.length} card(s) in deck. 0 = blackout, 5 = perfect recall. Stored only in this browser.</div>${deck.length ? '<button class="secondary-btn" data-adv="deck-clear" type="button">Clear deck</button>' : ''}</article>`;
  }
  const refreshDeck = () => { const w = $('#deck-wrap'); if (w) w.innerHTML = deckHtml(); };
  const parseTopics = (txt) => txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => { const [title, c, w] = l.split(',').map((x) => x.trim()); return { id: 't' + (i + 1), title, confidence: c === undefined || c === '' ? 2 : +c, weight: w === undefined || w === '' ? 1 : +w }; });
  async function viewStudy() { return studyForm(store.study || {}); }
  async function wireStudy() {
    try { const ex = await api('/api/exams'); const sel = $('#st-exam-src'); if (sel) sel.innerHTML += ex.map((e) => `<option value="${esc(e.version_id)}">${esc(e.name)} (${esc(e.recruitment_year)})</option>`).join(''); } catch { /* optional */ }
  }
  async function runStudy() {
    const out = $('#st-out'); const topicsText = $('#st-topics').value;
    store.study = { exam_date: $('#st-exam').value, hours_per_day: +$('#st-hpd').value, rest: $('#st-rest').value, mock_every_days: +$('#st-mock').value, final_days: +$('#st-final').value, topics_text: topicsText }; save();
    try {
      const d = await api('/api/advanced/study-plan', { exam_date: store.study.exam_date, hours_per_day: store.study.hours_per_day, rest_weekday: store.study.rest === '' ? null : +store.study.rest, mock_every_days: store.study.mock_every_days, final_revision_days: store.study.final_days, topics: parseTopics(topicsText) });
      st.plan = d;
      const days = d.days.map((x) => `<article class="br-match"><strong>${fmtDate(x.date)}</strong> ${x.rest ? badge('', 'Rest') : ''}${x.final ? badge('info', 'Final revision') : ''}<span class="muted"> ${x.total_hours || 0} h</span>${x.blocks.length ? rowsList(x.blocks.map((b) => `<li>${badge(b.type === 'mock' ? 'warn' : b.type === 'revise' ? 'info' : 'good', b.type)} ${esc(b.title)} — ${b.hours} h</li>`)) : ''}</article>`);
      out.innerHTML = `<div class="br-summary">${stat(d.total_hours + ' h', 'Planned hours')}${stat(d.study_days, 'Study days')}${stat(d.mocks_planned, 'Mock tests')}${stat(d.final_revision_from ? fmtDate(d.final_revision_from) : '—', 'Final revision from')}</div>
        ${d.warnings.map((w) => `<div class="br-banner warn">${esc(w)}</div>`).join('')}
        <article class="br-card"><h3>Hours by topic</h3><table class="elig"><tbody>${d.topic_hours.map((t) => `<tr><td>${esc(t.title)}</td><td>confidence ${t.confidence}</td><td>${t.planned} h</td></tr>`).join('')}</tbody></table><div class="br-row"><button class="secondary-btn" data-adv="deck-add" type="button">Add topics to revision deck</button></div>${note(d.method)}</article>
        <div id="st-days">${days.slice(0, 10).join('')}</div>${days.length > 10 ? `<button class="secondary-btn" data-adv="st-all" type="button">Show all ${days.length} days</button>` : ''}`;
      st.planDays = days;
    } catch (e) { out.innerHTML = err(e); }
  }

  /* ---------- Mock analytics ---------- */
  const SAMPLE_MOCK = 'Quantitative Aptitude,0,95\nQuantitative Aptitude,1,70\nQuantitative Aptitude,0,88\nQuantitative Aptitude,1,64\nQuantitative Aptitude,0,102\nQuantitative Aptitude,1,75\nEnglish,1,32\nEnglish,1,41\nEnglish,1,38\nEnglish,0,52\nEnglish,1,35\nEnglish,1,40\nReasoning,1,45\nReasoning,0,60\nReasoning,1,48\nReasoning,,20\nReasoning,1,52\nReasoning,0,66';
  async function viewMock() {
    const m = store.mock || {};
    return `<article class="br-card"><h3>Paste your attempts</h3><div class="br-body"><label>One line per question: <code>topic, 1 (right) / 0 (wrong) / blank (skipped), seconds</code><textarea id="mk-rows" rows="8">${esc(m.rows || '')}</textarea></label>
      <div class="br-row"><label>Marks for right<input type="number" id="mk-r" step="0.25" value="${m.r ?? 1}"></label><label>Marks lost for wrong<input type="number" id="mk-w" step="0.25" value="${m.w ?? 0.25}"></label><label>Test length (min)<input type="number" id="mk-t" value="${m.t ?? 60}"></label><label>Target score (optional)<input type="number" id="mk-target" value="${m.target ?? ''}"></label></div>
      <label>Past test scores, oldest first (comma separated, optional)<input type="text" id="mk-tests" value="${esc(m.tests || '')}" placeholder="32, 38, 41"></label>
      <div class="br-row"><button class="primary-btn" data-adv="mk-run" type="button">Analyse</button><button class="secondary-btn" data-adv="mk-sample" type="button">Use sample data</button></div></div></article><div id="mk-out"></div>`;
  }
  async function runMock() {
    const out = $('#mk-out'); const rows = $('#mk-rows').value;
    store.mock = { rows, r: +$('#mk-r').value, w: +$('#mk-w').value, t: +$('#mk-t').value, target: $('#mk-target').value, tests: $('#mk-tests').value }; save();
    const attempts = rows.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [topic, c, s] = l.split(',').map((x) => x.trim()); return { topic, correct: c === '1' ? true : c === '0' ? false : null, seconds: s === undefined || s === '' ? undefined : +s }; });
    const tests = store.mock.tests.split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ score: +x }));
    try {
      const d = await api('/api/advanced/analytics', { attempts, marks_correct: store.mock.r, marks_wrong: store.mock.w, total_time_minutes: store.mock.t, target_score: store.mock.target === '' ? undefined : +store.mock.target, tests });
      const o = d.overall, ADV = { ATTEMPT_CONFIDENTLY: ['good', 'Attempt confidently'], ATTEMPT_SELECTIVELY: ['info', 'Attempt selectively'], AVOID_GUESSING_AND_REVISE: ['bad', 'Avoid guessing; revise'], NOT_ENOUGH_DATA: ['', 'Not enough data'] };
      out.innerHTML = `<div class="br-summary">${stat(o.net_marks, 'Net marks')}${stat(o.accuracy_pct == null ? '—' : o.accuracy_pct + '%', 'Accuracy')}${stat(o.break_even_accuracy_pct + '%', 'Break-even accuracy')}${stat(o.avg_seconds ?? '—', 'Avg seconds/question')}${d.target_gap != null ? stat(d.target_gap, 'Marks to target') : ''}</div>
        ${d.pace ? `<div class="br-banner ${d.pace.verdict === 'TOO_SLOW' ? 'warn' : ''}">Time budget ${d.pace.budget_seconds_per_question}s per question · you averaged ${d.pace.your_avg_seconds ?? '—'}s · ${esc(d.pace.verdict.replace(/_/g, ' ').toLowerCase())}</div>` : ''}
        ${d.trend ? `<div class="br-banner">Trend over ${d.trend.points} tests: ${esc(d.trend.direction.toLowerCase())} (${d.trend.slope_per_test > 0 ? '+' : ''}${d.trend.slope_per_test} per test)${d.trend.tests_to_target != null ? ` · about ${d.trend.tests_to_target} more test(s) to reach your target at this pace` : ''}</div>` : ''}
        <article class="br-card"><h3>By topic (weakest first)</h3><table class="elig"><thead><tr><th>Topic</th><th>Accuracy (95% range)</th><th>Net</th><th>Advice</th></tr></thead><tbody>${d.topics.map((t) => `<tr><td>${esc(t.topic)}<div class="fine">${t.attempted}/${t.questions} attempted · ${t.avg_seconds ?? '—'}s</div></td><td>${t.accuracy_pct ?? '—'}%${t.accuracy_95ci_pct ? ` <span class="muted">(${t.accuracy_95ci_pct[0]}–${t.accuracy_95ci_pct[1]})</span>` : ''}</td><td>${t.net_marks}</td><td>${badge(...ADV[t.advice])}</td></tr>`).join('')}</tbody></table>${note(d.note)}</article>`;
    } catch (e) { out.innerHTML = err(e); }
  }

  /* ---------- What-if ---------- */
  async function viewWhatif() {
    const p = profile(); if (!ready(p)) return needProfile();
    const d = await api('/api/advanced/whatif', body({}));
    return `<div class="br-summary">${stat(d.base.eligible_or_possible + ' / ' + d.base.total, 'Possible today')}</div>` + d.scenarios.map((s) => `<article class="br-match"><div class="br-row"><strong>${esc(s.label)}</strong>${badge(s.net_change > 0 ? 'good' : s.net_change < 0 ? 'bad' : '', (s.net_change > 0 ? '+' : '') + s.net_change + ' net')}</div>
      ${s.opens.length ? `<div>Opens: ${s.opens.map((o) => esc(o.title)).join(', ')}</div>` : ''}${s.closes.length ? `<div>Closes: ${s.closes.map((o) => esc(o.title)).join(', ')}</div>` : ''}${!s.opens.length && !s.closes.length ? '<div class="muted">No change in what is possible.</div>' : ''}${s.caveat ? note(s.caveat) : ''}</article>`).join('') + note('Uses the same verified eligibility rules on an altered profile. A guide for planning, not a promise.');
  }

  /* ---------- Portfolio + overlap ---------- */
  async function viewPortfolio() {
    const pf = store.pf || { weekly: 12, hpt: 12 };
    const [d, o] = await Promise.all([api('/api/advanced/portfolio', body({ weekly_hours: pf.weekly, hours_per_topic: pf.hpt })), api('/api/advanced/overlap', {}).catch(() => null)]);
    return `<article class="br-card"><h3>Your study capacity</h3><div class="bridge-run"><label class="bridge-minutes">Hours per week <output>${pf.weekly}</output><input type="range" min="3" max="60" value="${pf.weekly}" data-pf="weekly"></label><label class="bridge-minutes">Hours per topic (assumption) <output>${pf.hpt}</output><input type="range" min="4" max="40" value="${pf.hpt}" data-pf="hpt"></label></div></article>
      <article class="br-card"><h3>Target portfolio</h3>${d.targets.length ? `<table class="elig"><thead><tr><th>Exam</th><th>Date</th><th>New prep hours</th><th>Topics reused</th></tr></thead><tbody>${d.targets.map((t) => `<tr><td>${esc(t.title)}</td><td>${fmtDate(t.exam_date)}</td><td>${t.marginal_prep_hours}</td><td>${t.shared_topics_saved}</td></tr>`).join('')}</tbody></table><div><strong>${d.total_prep_hours} h</strong> total preparation</div>` : '<div class="muted">No feasible linked targets at this capacity.</div>'}
        ${d.not_feasible.map((n) => `<div class="br-banner warn"><strong>${esc(n.title)}</strong> — ${esc(n.reason)}</div>`).join('')}${d.no_syllabus_link.length ? note(`${d.no_syllabus_link.length} recruitment(s) have no verified syllabus linked yet, so they are not in this hours estimate.`) : ''}${note(d.note)}</article>
      ${o ? `<article class="br-card"><h3>Syllabus overlap</h3><div>Best foundation: <strong>${esc(o.best_foundation ? o.best_foundation.code : '—')}</strong></div>${o.pairs.map((p) => `<div class="br-match"><strong>${esc(p.a)} ↔ ${esc(p.b)}</strong> <span class="muted">${p.matched_topics} shared topic(s) · ${p.a_covered_pct}% of ${esc(p.a)} · ${p.b_covered_pct}% of ${esc(p.b)}</span>${rowsList(p.matches.map((m) => `<li>${esc(m.a)} ≈ ${esc(m.b)} <span class="muted">(${esc(m.how)})</span></li>`))}</div>`).join('')}${note(o.caveat)}</article>` : ''}`;
  }

  /* ---------- Photo / signature checker (runs entirely in the browser) ---------- */
  async function viewDocs() {
    const s = store.docspec || { minW: 100, maxW: 400, minH: 100, maxH: 500, minKB: 20, maxKB: 50, types: 'jpg,jpeg,png' };
    return `<article class="br-card"><h3>Check a photo or signature before upload</h3>${note('Enter the limits printed in the recruitment notification — they differ by exam. The file never leaves your device.')}
      <div class="br-body"><div class="br-row">${[['minW', 'Min width px'], ['maxW', 'Max width px'], ['minH', 'Min height px'], ['maxH', 'Max height px'], ['minKB', 'Min size KB'], ['maxKB', 'Max size KB']].map(([k, l]) => `<label>${l}<input type="number" data-spec="${k}" value="${s[k]}"></label>`).join('')}<label>Allowed types<input type="text" data-spec="types" value="${esc(s.types)}"></label></div>
      <input type="file" id="doc-file" accept="image/*" aria-label="Choose an image to check"><div id="doc-out" aria-live="polite"></div></div></article>`;
  }
  function checkFile(file) {
    const out = $('#doc-out'); const spec = {}; $$('[data-spec]').forEach((i) => { spec[i.dataset.spec] = i.type === 'number' ? +i.value : i.value; });
    store.docspec = spec; save();
    const ext = (file.name.split('.').pop() || '').toLowerCase(), types = String(spec.types).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const kb = file.size / 1024, rows = [['Format', types.includes(ext), `.${ext}`], ['Width', img.naturalWidth >= spec.minW && img.naturalWidth <= spec.maxW, img.naturalWidth + ' px'], ['Height', img.naturalHeight >= spec.minH && img.naturalHeight <= spec.maxH, img.naturalHeight + ' px'], ['File size', kb >= spec.minKB && kb <= spec.maxKB, kb.toFixed(1) + ' KB']];
      out.innerHTML = `<table class="elig"><tbody>${rows.map(([l, okk, v]) => `<tr><td>${l}</td><td>${esc(v)}</td><td>${badge(okk ? 'good' : 'bad', okk ? 'OK' : 'Outside limit')}</td></tr>`).join('')}</tbody></table>${rows.every((r) => r[1]) ? note('Within the limits you entered.') : note('Resize or recompress, then check again.')}`; URL.revokeObjectURL(url);
    };
    img.onerror = () => { out.innerHTML = err('That file could not be read as an image.'); URL.revokeObjectURL(url); };
    img.src = url;
  }

  /* ---------- reminders (local only) ---------- */
  async function checkReminders(quiet) {
    if (!store.remind || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !ready(profile())) return;
    try {
      const d = await api('/api/advanced/brief', body({})); store.notified = store.notified || {}; const t = today();
      for (const c of d.closing_soon.filter((x) => x.in_days <= 3)) { const key = `${c.job_id}:${t}`; if (store.notified[key]) continue; store.notified[key] = 1; new Notification('Deadline approaching', { body: `${c.title} closes ${c.in_days === 0 ? 'today' : 'in ' + c.in_days + ' day(s)'}.` }); }
      Object.keys(store.notified).forEach((k) => { if (!k.endsWith(':' + t)) delete store.notified[k]; }); save();
    } catch (e) { if (!quiet) toast(e.message); }
  }

  /* ---------- wiring ---------- */
  const VIEWS = { brief: viewBrief, rank: viewRank, timeline: viewTimeline, age: viewAge, study: viewStudy, mock: viewMock, whatif: viewWhatif, portfolio: viewPortfolio, docs: viewDocs };
  const WIRE = { study: wireStudy };
  let wTimer = null;
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-adv]'); if (!b || !root() || !root().contains(b)) return; const a = b.dataset.adv;
    try {
      if (a === 'goto-profile') { const n = document.querySelector('[data-view="opportunities"]'); if (n) n.click(); setTimeout(() => { const pp = $('#profile-panel'); if (pp) pp.scrollIntoView({ behavior: 'smooth' }); }, 120); }
      else if (a === 'ics') { download('govcareer-deadlines.ics', await icsBuild(), 'text/calendar'); toast('Calendar file downloaded'); }
      else if (a === 'print') window.print();
      else if (a === 'remind') { if (store.remind) { store.remind = false; save(); render(); } else { const r = await Notification.requestPermission(); if (r === 'granted') { store.remind = true; save(); toast('Reminders on for this browser'); checkReminders(); render(); } else toast('Notification permission was not granted'); } }
      else if (a === 'reset-weights') { store.weights = null; save(); render(); }
      else if (a === 'st-run') runStudy();
      else if (a === 'st-all') { $('#st-days').innerHTML = st.planDays.join(''); b.remove(); }
      else if (a === 'st-load') { const v = $('#st-exam-src').value; if (!v) return; const d = await api(`/api/exams/${encodeURIComponent(v)}/syllabus`); $('#st-topics').value = d.tree.map((n) => `${n.title}, 2, 1`).join('\n'); }
      else if (a === 'deck-add') { store.deck = store.deck || []; const t = today(); (st.plan ? st.plan.topic_hours : []).forEach((x) => { if (!store.deck.some((c) => c.title === x.title)) store.deck.push({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), title: x.title, ease: 2.5, interval: 0, reps: 0, due: t }); }); save(); toast('Added to revision deck'); refreshDeck(); }
      else if (a === 'rate') { const c = (store.deck || []).find((x) => x.id === b.dataset.id); if (!c) return; const d = await api('/api/advanced/sm2', { quality: +b.dataset.q, state: { ease: c.ease, interval: c.interval, reps: c.reps } }); Object.assign(c, { ease: d.state.ease, interval: d.state.interval, reps: d.state.reps, due: d.next_due }); save(); toast(`Next review ${fmtDate(d.next_due)}`); refreshDeck(); }
      else if (a === 'deck-clear') { store.deck = []; save(); refreshDeck(); }
      else if (a === 'mk-run') runMock();
      else if (a === 'mk-sample') { $('#mk-rows').value = SAMPLE_MOCK; }
    } catch (x) { toast(x.message); }
  });
  document.addEventListener('input', (e) => {
    const w = e.target.closest('[data-weight]'); const pf = e.target.closest('[data-pf]');
    if (w && root() && root().contains(w)) { store.weights = { ...(store.weights || {}), [w.dataset.weight]: +w.value }; w.previousElementSibling.textContent = w.value; save(); clearTimeout(wTimer); wTimer = setTimeout(render, 400); }
    if (pf && root() && root().contains(pf)) { store.pf = { ...(store.pf || { weekly: 12, hpt: 12 }), [pf.dataset.pf]: +pf.value }; pf.previousElementSibling.textContent = pf.value; save(); clearTimeout(wTimer); wTimer = setTimeout(render, 450); }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'doc-file' && e.target.files && e.target.files[0]) checkFile(e.target.files[0]); });

  window.loadAdvanced = function loadAdvanced() { drawTabs(); render(); checkReminders(true); };
  setInterval(() => checkReminders(true), 30 * 60 * 1000);
})();
