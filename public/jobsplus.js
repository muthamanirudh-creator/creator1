/* GovCareer Jobs+ (v2.6, additive). Wraps renderResults/openJob; nothing in app.js is replaced.
 * 1 Filters + sort  2 Alert center (local, opt-in)  3 Job detail upgrades  4 Compare tray.
 * Only verified fields are used; admit card / result dates are never invented. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => typeof window.showToast === 'function' && window.showToast(m);
  const KEY = 'govcareer.jobsplus.v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };
  const st = Object.assign({ f: {}, sort: 'fit', alerts: {}, notify: false, presets: [] }, load());
  let last = null, cmp = [], keep = false;
  const DAY = 864e5;
  const days = (ymd) => ymd ? Math.ceil((Date.parse(String(ymd).slice(0, 10) + 'T23:59:00+05:30') - Date.now()) / DAY) : null;

  /* ---------- 1. Filters + sort ---------- */
  const SORTS = { fit: 'Best fit', close: 'Closing soonest', seats: 'Most vacancies', exam: 'Exam date', new: 'Recently verified' };
  function apply(rows) {
    const f = st.f, q = (f.text || '').toLowerCase();
    let out = rows.filter((r) => (!q || (r.title + ' ' + r.organization + ' ' + r.department).toLowerCase().includes(q)) &&
      (!f.dept || r.department === f.dept) && (!f.org || r.organization === f.org) &&
      (!f.minSeats || (r.vacancies_total || 0) >= +f.minSeats) &&
      (!f.free || /no fee|nil|free/i.test(r.fee?.general || '') || /no fee|nil|free/i.test(r.fee?.reserved || '')) &&
      (!f.until || (r.deadline.closes_ymd || '9999') <= f.until) && (!f.updated || r.updated));
    const d = (r) => r.deadline.ms_left ?? 9e15, ex = (r) => r.exam_date || '9999';
    const cmpf = { close: (a, b) => d(a) - d(b), seats: (a, b) => b.vacancies_total - a.vacancies_total, exam: (a, b) => ex(a).localeCompare(ex(b)), new: (a, b) => String(b.verified_at).localeCompare(String(a.verified_at)) }[st.sort];
    return cmpf ? out.sort(cmpf) : out;
  }
  function panel(rows) {
    let el = $('#jp-filters'); const host = $('#chips'); if (!host) return;
    if (!el) { el = document.createElement('div'); el.id = 'jp-filters'; host.after(el); }
    const uniq = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))].sort();
    const sel = (id, k, label) => `<label>${label}<select id="${id}"><option value="">All</option>${uniq(k).map((v) => `<option ${st.f[id.slice(3)] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
    const n = Object.values(st.f).filter(Boolean).length;
    el.innerHTML = `<button class="jp-toggle" type="button" aria-expanded="${!!st.open}">Filters &amp; sort${n ? ` <b>${n}</b>` : ''}</button>
    <div class="jp-body" ${st.open ? '' : 'hidden'}><label>Keyword<input id="jp-text" type="search" value="${esc(st.f.text || '')}" placeholder="title, board, department"></label>
    ${sel('jp-dept', 'department', 'Department')}${sel('jp-org', 'organization', 'Organisation')}
    <label>Last date on or before<input id="jp-until" type="date" value="${esc(st.f.until || '')}"></label>
    <label>Min. vacancies<input id="jp-minSeats" type="number" min="0" step="100" value="${esc(st.f.minSeats || '')}"></label>
    <label>Sort by<select id="jp-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="check"><input id="jp-free" type="checkbox" ${st.f.free ? 'checked' : ''}> Fee-free for some applicants</label>
    <label class="check"><input id="jp-updated" type="checkbox" ${st.f.updated ? 'checked' : ''}> Has official updates</label>
    <div class="jp-actions"><button type="button" id="jp-reset" class="text-btn">Reset</button><button type="button" id="jp-savep" class="text-btn">Save as preset</button></div>
    <div class="jp-presets">${st.presets.map((p, i) => `<button type="button" class="chip" data-p="${i}">${esc(p.name)} <span data-x="${i}" aria-label="Delete preset">×</span></button>`).join('')}</div></div>`;
    $('.jp-toggle', el).onclick = () => { st.open = !st.open; save(); panel(rows); };
    const redo = () => { save(); keep = true; window.renderResults(last); const b = $('.jp-toggle b', el); const n2 = Object.values(st.f).filter(Boolean).length; if (b) b.textContent = n2; };
    $$('input,select', el).forEach((i) => { if (i.id === 'jp-sort') i.onchange = () => { st.sort = i.value; redo(); }; else if (i.id) i[i.type === 'checkbox' ? 'onchange' : 'oninput'] = () => { st.f[i.id.slice(3)] = i.type === 'checkbox' ? i.checked : i.value; redo(); }; });
    $('#jp-reset', el)?.addEventListener('click', () => { st.f = {}; st.sort = 'fit'; redo(); });
    $('#jp-savep', el)?.addEventListener('click', () => { const name = prompt('Preset name'); if (name) { st.presets.push({ name: name.slice(0, 30), f: { ...st.f }, sort: st.sort }); redo(); } });
    $$('[data-p]', el).forEach((b) => b.onclick = (e) => { if (e.target.dataset.x) { st.presets.splice(+e.target.dataset.x, 1); } else { const p = st.presets[+b.dataset.p]; st.f = { ...p.f }; st.sort = p.sort; } redo(); });
  }
  const origRender = window.renderResults;
  window.renderResults = function (data) {
    last = data; const rows = data.results || []; if (!keep || !$('#jp-filters .jp-body')) panel(rows); keep = false;
    origRender({ ...data, results: apply(rows) }); decorate(); alertStrip(rows);
  };
  function decorate() {
    $$('#results > li').forEach((li, i) => {
      const card = $('.card', li); if (!card || $('.jp-cmp', li)) return;
      const title = $('h2', card)?.textContent, row = (last.results || []).find((r) => r.title === title); if (!row) return;
      const b = document.createElement('label'); b.className = 'jp-cmp check';
      b.innerHTML = `<input type="checkbox" ${cmp.includes(row.id) ? 'checked' : ''}> Compare`;
      b.onclick = (e) => e.stopPropagation(); $('input', b).onchange = (e) => { cmp = e.target.checked ? [...cmp, row.id].slice(-3) : cmp.filter((x) => x !== row.id); tray(); };
      const bell = document.createElement('button'); bell.type = 'button'; bell.className = 'jp-bell' + (st.alerts[row.id] ? ' on' : ''); bell.setAttribute('aria-label', 'Toggle alerts for ' + title); bell.textContent = st.alerts[row.id] ? '🔔' : '🔕';
      bell.onclick = () => { toggleAlert(row); bell.className = 'jp-bell' + (st.alerts[row.id] ? ' on' : ''); bell.textContent = st.alerts[row.id] ? '🔔' : '🔕'; };
      li.append(b, bell);
    });
  }

  /* ---------- Compare tray ---------- */
  function tray() {
    let t = $('#jp-tray'); if (!t) { t = document.createElement('div'); t.id = 'jp-tray'; document.body.append(t); }
    t.hidden = cmp.length < 2; if (t.hidden) return;
    t.innerHTML = `<span>${cmp.length} selected</span><button class="primary-btn" type="button">Compare</button><button class="text-btn" type="button">Clear</button>`;
    $('.primary-btn', t).onclick = showCompare; $('.text-btn', t).onclick = () => { cmp = []; tray(); window.renderResults(last); };
  }
  async function showCompare() {
    const jobs = await Promise.all(cmp.map((id) => fetch('/api/jobs/' + encodeURIComponent(id)).then((r) => r.json())));
    const rows = [['Organisation', (j) => j.organization], ['Education', (j) => j.education?.label], ['Age limit', (j) => j.age ? `${j.age.min}–${j.age.max}` : ''], ['Vacancies', (j) => Number(j.vacancies?.total || 0).toLocaleString('en-IN')],
      ['Closes', (j) => j.deadline?.closes_exact], ['Exam', (j) => j.dates?.exam_date || 'Not announced'], ['Fee (general / reserved)', (j) => `${j.fee?.general} / ${j.fee?.reserved}`], ['Selection', (j) => (j.selection || []).join(' → ')]];
    $('#d-body').innerHTML = `<h2 id="d-title">Compare</h2><div class="jp-scroll"><table class="jp-compare"><thead><tr><th></th>${jobs.map((j) => `<th>${esc(j.title)}</th>`).join('')}</tr></thead><tbody>${rows.map(([l, f]) => `<tr><th>${l}</th>${jobs.map((j) => `<td>${esc(f(j) ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    $('#drawer').hidden = false; $('#scrim').hidden = false;
  }

  /* ---------- 2. Alert center (browser-local, opt-in) ---------- */
  function toggleAlert(r) {
    if (st.alerts[r.id]) { delete st.alerts[r.id]; toast('Alerts off'); }
    else { st.alerts[r.id] = { title: r.title, close: r.deadline.closes_ymd, exam: r.exam_date, admit: true, result: true, at: Date.now() }; toast('Alerts on: deadline, admit card and result watch'); if (st.notify === false && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().then((p) => { st.notify = p === 'granted'; save(); }); }
    save(); alertStrip(last?.results || []);
  }
  function due() {
    const out = [];
    for (const [id, a] of Object.entries(st.alerts)) {
      const dc = days(a.close), de = a.exam ? days(a.exam) : null;
      if (dc != null && dc >= 0 && dc <= 7) out.push({ id, kind: 'deadline', text: `${a.title}: applications close ${dc === 0 ? 'today' : 'in ' + dc + ' day' + (dc === 1 ? '' : 's')}`, key: `${id}:c:${dc}` });
      if (de != null && de >= 0 && de <= 14 && a.admit) out.push({ id, kind: 'admit', text: `${a.title}: exam in ${de} day${de === 1 ? '' : 's'}. Check the official portal for the admit card.`, key: `${id}:a:${de}` });
      if (de != null && de < 0 && a.result) out.push({ id, kind: 'result', text: `${a.title}: exam date has passed. Check the official portal for the result.`, key: `${id}:r` });
    }
    return out;
  }
  function alertStrip(rows) {
    const list = due(); let el = $('#jp-alerts'); const host = $('#jp-filters'); if (!host) return;
    if (!el) { el = document.createElement('div'); el.id = 'jp-alerts'; el.setAttribute('role', 'status'); host.before(el); }
    const n = Object.keys(st.alerts).length;
    el.hidden = !n; el.innerHTML = n ? `<strong>🔔 ${n} watched</strong>${list.length ? `<ul>${list.map((a) => `<li class="${a.kind}">${esc(a.text)}</li>`).join('')}</ul>` : '<span class="muted"> Nothing due in the next 7 days.</span>'}` : '';
    if (st.notify && 'Notification' in window && Notification.permission === 'granted') {
      const seen = JSON.parse(sessionStorage.getItem('jp-seen') || '[]');
      list.filter((a) => !seen.includes(a.key)).forEach((a) => { try { new Notification('GovCareer', { body: a.text }); } catch {} seen.push(a.key); });
      sessionStorage.setItem('jp-seen', JSON.stringify(seen));
    }
  }
  setInterval(() => last && alertStrip(last.results || []), 60 * 60 * 1000);

  /* ---------- 3. Job detail upgrades ---------- */
  const DOCS = (j, p) => [
    ['Photo and signature (scanned, as per notification)', true], [`${j.education?.label || 'Educational'} certificates and marksheets`, true], ['Date of birth proof (10th certificate)', true],
    ['Government photo ID', true], ['Category certificate (SC / ST / OBC / EWS)', !!p.category && p.category !== 'GEN' && p.category !== 'General'],
    ['Domicile certificate', j.domicile?.type && j.domicile.type !== 'ALL_INDIA'], ['Disability certificate', !!p.pwbd], ['Discharge certificate', !!p.exServiceman], ['Experience certificate', j.experience || /experience/i.test(j.education?.label || '')],
  ].filter((x) => x[1]).map((x) => x[0]);
  async function enhance(id) {
    const body = $('#d-body'); if (!body || $('.jp-glance', body) || !$('#d-title', body)) return;
    let j; try { j = await fetch('/api/jobs/' + encodeURIComponent(id)).then((r) => r.json()); } catch { return; }
    if ($('.jp-glance', body) || !j.dates) return;
    const p = JSON.parse(localStorage.getItem('govcareer.profile.v2') || '{}');
    const verdicts = $$('.elig tbody .verdict', body).map((v) => (v.className.match(/v-(\w+)/) || [])[1]);
    const cnt = (k) => verdicts.filter((v) => v === k).length, bad = $$('.elig tbody tr', body).filter((tr) => /NOT_ELIGIBLE/.test(tr.innerHTML)).map((tr) => $('strong', tr)?.textContent);
    const need = verdicts.filter((v) => v === 'UNKNOWN').length;
    const d = j.dates, steps = [['Applications open', d.application_open], ['Applications close', d.application_close], ['Exam', d.exam_date]].filter((s) => s[1]);
    const total = Math.max(1, Date.parse(steps.at(-1)[1]) - Date.parse(steps[0][1])), pos = Math.min(100, Math.max(0, (Date.now() - Date.parse(steps[0][1])) / total * 100));
    const b = j.vacancies?.breakdown || {}, mx = Math.max(1, ...Object.values(b)), mine = (p.category || '').toUpperCase();
    const html = `<section class="jp-glance blk"><h3>At a glance</h3>
      <div class="jp-score"><span class="ok">${cnt('MATCH')} met</span><span class="cond">${cnt('CONDITIONALLY_ELIGIBLE') + cnt('PARTIAL_MATCH')} partial</span><span class="no">${cnt('NOT_ELIGIBLE')} not met</span><span class="unk">${need} need info</span></div>
      ${bad.length ? `<p class="fine"><strong>Blocking:</strong> ${esc(bad.join(', '))}. Use Strategy → What-if to see which change would open this post.</p>` : need ? '<p class="fine">Answer the highlighted questions below to complete your check.</p>' : ''}
      <div class="jp-timeline" aria-label="Timeline"><i style="width:${pos}%"></i>${steps.map((s, i) => `<span style="left:${steps.length > 1 ? i / (steps.length - 1) * 100 : 0}%"><b>${esc(s[0])}</b>${esc(window.fmtDate ? window.fmtDate(s[1]) : String(s[1]).slice(0, 10))}</span>`).join('')}</div></section>
      <section class="jp-seats blk"><h3>Seats by category</h3>${Object.entries(b).map(([k, v]) => `<div class="${k.toUpperCase() === mine ? 'mine' : ''}"><span>${esc(k)}</span><i style="width:${v / mx * 100}%"></i><b>${Number(v).toLocaleString('en-IN')}</b></div>`).join('')}</section>
      <section class="jp-docs blk"><h3>Document checklist</h3><ul>${DOCS(j, p).map((x, i) => `<li><label><input type="checkbox" data-d="${id}:${i}" ${st['d' + id + i] ? 'checked' : ''}> ${esc(x)}</label></li>`).join('')}</ul><p class="fine">Derived from the verified requirements. The notification is the final word.</p></section>
      <section class="jp-act blk"><div><button class="secondary-btn" id="jp-alert" type="button">${st.alerts[id] ? '🔔 Alerts on' : '🔕 Watch deadline, admit card, result'}</button><button class="secondary-btn" id="jp-ics" type="button">Add to calendar (.ics)</button><button class="secondary-btn" id="jp-share" type="button">Share summary</button></div><p class="fine">Admit card and result dates are not in verified records, so watching reminds you to check the official portal as the exam date passes.</p></section>`;
    $('.clock', body)?.insertAdjacentHTML('afterend', html);
    $$('[data-d]', body).forEach((c) => c.onchange = () => { st['d' + c.dataset.d.replace(':', '')] = c.checked; save(); });
    const row = { id, title: j.title, deadline: { closes_ymd: String(d.application_close).slice(0, 10) }, exam_date: d.exam_date && String(d.exam_date).slice(0, 10) };
    $('#jp-alert', body).onclick = (e) => { toggleAlert(row); e.target.textContent = st.alerts[id] ? '🔔 Alerts on' : '🔕 Watch deadline, admit card, result'; };
    $('#jp-ics', body).onclick = () => ics(j);
    $('#jp-share', body).onclick = async () => { const t = `${j.title} (${j.organization})\nCloses: ${j.deadline?.closes_exact}\nVacancies: ${j.vacancies?.total}\nOfficial notice: ${j.sources?.[0]?.url || ''}`; try { navigator.share ? await navigator.share({ title: j.title, text: t }) : (await navigator.clipboard.writeText(t), toast('Summary copied')); } catch {} };
  }
  function ics(j) {
    const z = (s) => String(s).slice(0, 10).replace(/-/g, ''), ev = [['Apply by', j.dates.application_close], ['Exam', j.dates.exam_date]].filter((e) => e[1]);
    const t = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GovCareer//Jobs+//EN', ...ev.flatMap(([n, d], i) => ['BEGIN:VEVENT', `UID:${j.id}-${i}@govcareer`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`, `DTSTART;VALUE=DATE:${z(d)}`, `SUMMARY:${n}: ${j.title}`, 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Tomorrow', 'END:VALARM', 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/calendar' })); a.download = j.id + '.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const origOpen = window.openJob;
  window.openJob = async function (id, keep) { const r = await origOpen(id, keep); enhance(id); return r; };

  /* ---------- 4. Mobile: bottom-sheet drawer is CSS-only ---------- */
  if (typeof window.search === 'function') setTimeout(() => last && window.renderResults(last), 0);
})();
