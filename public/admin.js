// Review desk. Every value from the server is inserted with textContent (never innerHTML).
const $app = document.getElementById('app');
const state = { token: sessionStorage.getItem('gc_admin') || null, user: null, tab: 'queue' };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const say = (m) => { document.getElementById('live').textContent = m; };
async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, { ...opts, headers: { ...(opts.body && !(opts.body instanceof ArrayBuffer) && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { state.token = null; sessionStorage.removeItem('gc_admin'); render(); }
  if (!res.ok) { const e = new Error(body.error || `Request failed (${res.status})`); e.errors = body.errors; throw e; }
  return body;
}
const pill = (t, cls = '') => h('span', { class: `pill ${cls}` }, t);
const healthCls = { ONLINE: 'ok', DEGRADED: 'warn', CONTENT_CHANGED: 'warn', TEMPORARILY_UNAVAILABLE: 'bad', BLOCKED: 'bad', PARSER_ERROR: 'bad' };
const fmt = (v) => (v === undefined || v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'never');
const isRole = (r) => ({ VIEWER: 1, REVIEWER: 2, ADMIN: 3 }[state.user.role] >= { VIEWER: 1, REVIEWER: 2, ADMIN: 3 }[r]);

function loginView() {
  const err = h('p', { class: 'small', role: 'alert' });
  const email = h('input', { type: 'email', id: 'em', autocomplete: 'username', required: true }), pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card', style: 'max-width:420px', onsubmit: async (e) => {
    e.preventDefault();
    try { const r = await api('/login', { method: 'POST', body: JSON.stringify({ email: email.value, password: pw.value }) }); state.token = r.token; sessionStorage.setItem('gc_admin', r.token); state.user = r.user; render(); }
    catch (x) { err.textContent = x.message; }
  } }, h('h2', null, 'Sign in'), h('label', null, 'Email', email), h('label', null, 'Password', pw), h('p', null, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')), err);
  $app.replaceChildren(form);
}

function nav() {
  const tabs = [['dashboard', 'Sources'], ['queue', 'Review queue'], ['recruitments', 'Recruitments'], ['upload', 'Upload'], ['trust', 'Trust & flags'], ...(isRole('ADMIN') ? [['audit', 'Audit log']] : [])];
  return h('nav', { 'aria-label': 'Sections' }, tabs.map(([k, label]) => h('button', { 'aria-current': state.tab === k ? 'page' : false, onclick: () => { state.tab = k; render(); } }, label)),
    h('button', { onclick: async () => { await api('/logout', { method: 'POST' }).catch(() => {}); state.token = null; sessionStorage.removeItem('gc_admin'); render(); } }, 'Sign out'));
}

async function dashboardView() {
  const d = await api('/dashboard');
  const rows = d.sources.map((s) => h('tr', null,
    h('td', null, h('strong', null, s.organization), h('br'), h('span', { class: 'small' }, s.official_domain)),
    h('td', null, pill(s.health.replaceAll('_', ' ').toLowerCase(), healthCls[s.health])),
    h('td', null, pill(s.verification_status.replaceAll('_', ' ').toLowerCase(), s.verification_status === 'VERIFIED' ? 'ok' : 'warn'), h('br'), h('span', { class: 'small' }, s.crawl_enabled ? 'Crawling on' : 'Crawling off')),
    h('td', { class: 'small' }, `Last success: ${when(s.last_success_at)}`, h('br'), s.last_error ? `Last problem: ${s.last_error}` : ''),
    h('td', null, isRole('ADMIN') ? h('div', { class: 'row' },
      s.verification_status !== 'VERIFIED' ? h('button', { class: 'btn', onclick: async () => { if (confirm(`Confirm ${s.official_domain} is the real official domain for ${s.organization}?`)) { await api(`/sources/${s.source_id}/verify`, { method: 'POST', body: JSON.stringify({ status: 'VERIFIED' }) }); render(); } } }, 'Verify source') : null,
      s.verification_status === 'VERIFIED' ? h('button', { class: 'btn', onclick: async () => { await api(`/sources/${s.source_id}/crawling`, { method: 'POST', body: JSON.stringify({ enabled: !s.crawl_enabled }) }); render(); } }, s.crawl_enabled ? 'Stop crawling' : 'Start crawling') : null) : null,
      isRole('REVIEWER') && s.crawl_enabled ? h('button', { class: 'btn', onclick: async () => { await api(`/sources/${s.source_id}/crawl`, { method: 'POST' }); say('Crawl queued'); } }, 'Crawl now') : null)));
  return [h('section', { class: 'card' }, h('h2', null, 'Source health'), h('p', { class: 'small' }, 'Only registered, verified sources are ever crawled. Real portals start unverified and switched off.'),
    h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Source', 'Health', 'Status', 'Details', ''].map((x) => h('th', null, x)))), h('tbody', null, rows)))),
  h('section', { class: 'card' }, h('h2', null, 'Pipeline'), h('p', null, 'Waiting for review: ', Object.entries(d.review_buckets).map(([b, n]) => `${b.replaceAll('_', ' ')} ${n}`).join(', ') || 'nothing'), h('p', null, 'Background jobs: ', Object.entries(d.job_queue).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ') || 'none'))];
}

async function queueView() {
  const bucket = state.bucket || '';
  const q = await api(`/queue${bucket ? `?bucket=${bucket}` : ''}`);
  const sel = h('select', { id: 'bk', 'aria-label': 'Filter by bucket', onchange: (e) => { state.bucket = e.target.value; render(); } }, h('option', { value: '' }, 'All buckets'), ['suspicious', 'conflicting_sources', 'changed_source', 'broken_link', 'potential_duplicate', 'low_confidence', 'medium_confidence', 'high_confidence'].map((b) => h('option', { value: b, selected: b === bucket }, `${b.replaceAll('_', ' ')} (${q.bucket_counts[b] || 0})`)));
  const rows = q.items.map((i) => h('tr', null, h('td', null, h('button', { class: 'btn', onclick: () => { state.open = i.id; render(); } }, 'Review')), h('td', null, h('strong', null, i.title || '(title not extracted)'), h('br'), h('span', { class: 'small' }, i.organization || '')),
    h('td', null, i.buckets.map((b) => pill(b.replaceAll('_', ' '), b === 'suspicious' ? 'bad' : b === 'conflicting_sources' || b === 'changed_source' ? 'warn' : ''))), h('td', null, i.is_update ? 'Update' : 'New'), h('td', null, i.priority)));
  return [h('section', { class: 'card' }, h('h2', null, 'Review queue'), h('p', { class: 'small' }, 'Highest priority first: suspicious sources, conflicts, changes to published records, then low-confidence extractions.'), h('label', null, 'Bucket', sel),
    q.items.length ? h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['', 'Recruitment', 'Why it is here', 'Type', 'Priority'].map((x) => h('th', null, x)))), h('tbody', null, rows))) : h('p', null, 'Nothing is waiting for review.'))];
}

function highlight(pageText, loc) {
  if (!loc) return [pageText];
  return [pageText.slice(0, loc.start), h('mark', { id: 'hl' }, pageText.slice(loc.start, loc.end)), pageText.slice(loc.end)];
}

async function reviewView(id) {
  const r = await api(`/review/${id}`);
  const edits = {}; let shown = r.fields.find((f) => f.lineage && f.lineage.page_number) || null;
  const pagePanel = h('div');
  const showSource = (f) => {
    shown = f; const l = f.lineage;
    if (!l || !l.page_number) { pagePanel.replaceChildren(h('p', null, 'No source page was recorded for this field. A reviewer must cite one before approving an edit.')); return; }
    const pg = r.pages.find((p) => p.document_id === l.document_id && p.page_number === l.page_number); const doc = r.documents.find((d) => d.id === l.document_id);
    pagePanel.replaceChildren(h('h3', null, `${f.label}: page ${l.page_number}${l.section ? `, section ${l.section}` : ''}`), h('p', { class: 'small' }, `${doc ? doc.title : ''}. Read by ${l.extraction_method.replaceAll('_', ' ').toLowerCase()}, confidence ${Math.round((l.confidence || 0) * 100)}%.`, doc ? h('a', { href: `/api/admin/documents/${doc.id}/file`, onclick: async (e) => { e.preventDefault(); const res = await fetch(`/api/admin/documents/${doc.id}/file`, { headers: { authorization: `Bearer ${state.token}` } }); window.open(URL.createObjectURL(await res.blob())); } }, ' Open original file') : null),
      h('div', { class: 'pagebox', tabindex: '0', role: 'region', 'aria-label': `Text of page ${l.page_number}` }, pg ? highlight(pg.text, l.source_text_location) : 'Page text unavailable.'));
    const m = document.getElementById('hl'); if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center' });
  };
  const canAct = isRole('REVIEWER') && r.item.status === 'OPEN';
  const fieldRows = r.fields.map((f) => {
    const input = h('input', { type: 'text', value: typeof f.value === 'object' && f.value !== null ? JSON.stringify(f.value) : f.value ?? '', 'aria-label': `Value for ${f.label}`, disabled: !canAct });
    const srcPage = h('input', { type: 'text', placeholder: 'Page', size: 4, 'aria-label': `Source page for ${f.label}`, style: 'display:none;width:70px' }), srcQuote = h('input', { type: 'text', placeholder: 'Passage on that page', 'aria-label': `Source passage for ${f.label}`, style: 'display:none' });
    input.addEventListener('input', () => {
      let v = input.value; try { v = JSON.parse(input.value); } catch {}
      edits[f.key] = { path: f.key, value: v, source: { page: srcPage.value ? +srcPage.value : undefined, quote: srcQuote.value || undefined } };
      srcPage.style.display = srcQuote.style.display = 'block';
    });
    const sync = () => { if (edits[f.key]) edits[f.key].source = { page: srcPage.value ? +srcPage.value : undefined, quote: srcQuote.value || undefined }; };
    srcPage.addEventListener('input', sync); srcQuote.addEventListener('input', sync);
    const l = f.lineage;
    return h('tr', null, h('td', null, h('strong', null, f.label)), h('td', null, input, srcPage, srcQuote),
      h('td', null, l && l.page_number ? h('button', { class: 'btn', onclick: () => showSource(f) }, `Page ${l.page_number}${l.section ? ` §${l.section}` : ''}`) : pill(f.value === undefined ? 'not found' : 'no page', 'warn'), l ? h('div', { class: 'small' }, `${l.extraction_method.toLowerCase().replaceAll('_', ' ')}, ${Math.round((l.confidence || 0) * 100)}%`) : null));
  });
  const note = h('textarea', { rows: 2, placeholder: 'Note (required for suspicious items, conflicts and duplicates)', 'aria-label': 'Reviewer note' });
  const msg = h('div', { role: 'alert' });
  const act = (fn) => async () => { try { await fn(); } catch (e) { msg.replaceChildren(h('p', { class: 'reason high' }, e.message), ...(e.errors || []).map((x) => h('p', { class: 'small' }, `${x.path}: ${x.message}`))); } };
  const buttons = canAct ? h('div', { class: 'row' },
    h('button', { class: 'btn primary', onclick: act(async () => { const res = await api(`/review/${id}/approve`, { method: 'POST', body: JSON.stringify({ note: note.value, edits: Object.values(edits) }) }); say('Approved. Publish when ready.'); state.published = res.recruitment_id; render(); }) }, Object.keys(edits).length ? 'Approve with my edits' : 'Approve'),
    h('button', { class: 'btn danger', onclick: act(async () => { const reason = note.value || prompt('Reason for rejecting?'); if (!reason) return; await api(`/review/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); state.open = null; render(); }) }, 'Reject')) : h('p', { class: 'small' }, r.item.status === 'OPEN' ? 'Your role can view but not decide.' : `Resolved: ${r.item.status.toLowerCase()}.`);
  const el = [
    h('p', null, h('button', { class: 'btn', onclick: () => { state.open = null; render(); } }, '← Back to queue')),
    h('section', { class: 'card' }, h('h2', null, r.version.data.title || '(title not extracted)'), h('p', { class: 'small' }, `${r.version.data.organization || ''}. Version ${r.version.version_no}. ${r.version.schema_valid ? 'Passed schema validation.' : 'Failed schema validation: missing or invalid fields below were rejected, not guessed.'}`), h('div', { class: 'row' }, r.item.buckets.map((b) => pill(b.replaceAll('_', ' '), b === 'suspicious' ? 'bad' : ''))),
      r.changes.filter((c) => c.supported).map((c) => h('div', { class: 'upd' }, c.message)), r.changes.filter((c) => !c.supported).map((c) => h('div', { class: 'reason medium' }, `${c.label} changed, but a cited source is missing. Not shown to users.`)),
      r.item.reasons.map((x) => h('div', { class: `reason ${x.severity}` }, h('strong', null, x.code.replaceAll('_', ' ').toLowerCase()), ': ', x.message))),
    h('div', { class: 'split' }, h('section', { class: 'card' }, h('h2', null, 'Extracted fields'), h('p', { class: 'small' }, 'Edit a value to correct it, then cite the page it came from.'), h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Field', 'Extracted value', 'Source'].map((x) => h('th', null, x)))), h('tbody', null, fieldRows))), note, msg, buttons),
      h('section', { class: 'card', 'aria-live': 'polite' }, h('h2', null, 'Source page'), pagePanel)),
  ];
  setTimeout(() => shown && showSource(shown), 0);
  return el;
}

async function recruitmentsView() {
  if (state.timeline) return timelineView(state.timeline);
  const list = await api('/recruitments');
  return [h('section', { class: 'card' }, h('h2', null, 'Recruitments from the pipeline'), h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Title', 'State', 'Version live', ''].map((x) => h('th', null, x)))),
    h('tbody', null, list.map((r) => h('tr', null, h('td', null, h('strong', null, r.title || r.id), h('br'), h('span', { class: 'small' }, r.organization || '')), h('td', null, pill(r.lifecycle.replaceAll('_', ' ').toLowerCase(), r.lifecycle === 'PUBLISHED' ? 'ok' : r.lifecycle === 'VERIFIED' ? 'warn' : '')), h('td', null, r.published_version || '—'),
      h('td', null, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { state.timeline = r.id; render(); } }, 'Timeline'), r.lifecycle === 'VERIFIED' && isRole('REVIEWER') ? h('button', { class: 'btn primary', onclick: async () => { try { await api(`/recruitments/${r.id}/publish`, { method: 'POST' }); say('Published'); render(); } catch (e) { alert(e.message); } } }, 'Publish') : null)))))))),
  list.length ? null : h('p', null, 'Nothing has come through the pipeline yet.')];
}

async function timelineView(id) {
  const t = await api(`/recruitments/${id}/timeline`);
  return [h('p', null, h('button', { class: 'btn', onclick: () => { state.timeline = null; render(); } }, '← Back')),
    h('section', { class: 'card' }, h('h2', null, `Source timeline: ${t.recruitment.title || id}`), h('p', { class: 'small' }, 'Every document version is kept. Nothing is overwritten.'),
      h('ol', { class: 'tl' }, t.entries.map((e) => h('li', null, h('strong', null, e.title), ` (version ${e.version || '?'}, ${String(e.version_status || '').toLowerCase()})`, h('div', { class: 'small' }, `${e.file}. Fingerprint ${e.sha256}. Received ${when(e.at)}.`), e.changes.filter((c) => c.supported).map((c) => h('div', { class: 'upd' }, c.message, h('div', { class: 'small' }, `Source: ${c.source || ''}`))))))),
    h('section', { class: 'card' }, h('h2', null, 'Lifecycle'), h('ol', { class: 'tl' }, t.lifecycle.map((l) => h('li', null, `${l.from_state || 'new'} → ${l.to_state}`, h('div', { class: 'small' }, `${l.actor}. ${when(l.at)}. ${l.reason || ''}`)))))];
}

function uploadView() {
  const out = h('div', { role: 'status' }); const file = h('input', { type: 'file', id: 'f', accept: '.pdf,.docx,.html,.png,.jpg' });
  const title = h('input', { type: 'text', id: 't' }), kind = h('select', { id: 'k' }, h('option', { value: '' }, 'Original (or amendment if linked below)'), ['AMENDMENT', 'CORRIGENDUM', 'FINAL_UPDATE'].map((k) => h('option', { value: k }, k.toLowerCase().replace('_', ' ')))), issued = h('input', { type: 'date', id: 'd' }), rec = h('input', { type: 'text', id: 'r', placeholder: 'rec-… (only when this updates an existing recruitment)' });
  const src = h('select', { id: 's' }, h('option', { value: 'manual-upload' }, 'Manual upload by reviewer'), h('option', { value: 'demo-psc' }, 'Demo State PSC'));
  return [h('section', { class: 'card', style: 'max-width:640px' }, h('h2', null, 'Upload an official document'), h('p', { class: 'small' }, 'Only upload documents you downloaded from the official portal. Files are scanned and read, then land in the review queue. They are never published automatically.'),
    h('label', null, 'File', file), h('label', null, 'Title', title), h('label', null, 'Source', src), h('label', null, 'Document type', kind), h('label', null, 'Date on the document', issued), h('label', null, 'Existing recruitment ID', rec),
    h('p', null, h('button', { class: 'btn primary', onclick: async () => {
      if (!file.files[0]) { out.textContent = 'Choose a file first.'; return; }
      const headers = { 'content-type': file.files[0].type || 'application/octet-stream', 'x-title': encodeURIComponent(title.value || file.files[0].name), 'x-source-id': src.value };
      if (kind.value) headers['x-kind'] = kind.value; if (issued.value) headers['x-issued-on'] = issued.value; if (rec.value) headers['x-recruitment-id'] = rec.value;
      const res = await fetch('/api/admin/upload', { method: 'POST', headers: { ...headers, authorization: `Bearer ${state.token}` }, body: file.files[0] }); const b = await res.json();
      out.replaceChildren(h('p', { class: res.ok ? 'upd' : 'reason high' }, res.ok ? `Queued for review: ${b.recruitmentId}.` : b.error || (b.duplicate_of ? 'This exact file was already received.' : (b.rejected || []).join(' ') || 'Rejected.')), ...(b.changes || []).map((c) => h('div', { class: 'upd' }, c)));
    } }, 'Upload and process')), out)];
}

async function auditView() {
  const [rows, v] = await Promise.all([api('/audit?limit=100'), api('/audit/verify')]);
  return [h('section', { class: 'card' }, h('h2', null, 'Audit log'), h('p', null, v.ok ? pill(`Chain intact (${v.entries} entries)`, 'ok') : pill('Chain broken', 'bad')), h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'What', 'On'].map((x) => h('th', null, x)))), h('tbody', null, rows.map((a) => h('tr', null, h('td', { class: 'small' }, when(a.at)), h('td', null, a.actor), h('td', null, a.action.replaceAll('_', ' ').toLowerCase()), h('td', { class: 'small' }, `${a.entity_type} ${a.entity_id || ''}`)))))))];
}

// v2.9.0 Trust desk: open flags (conflicts, deadline changes, source problems) and per-field confirmation. All text via textContent.
async function trustView() {
  const flags = await api('/trust/flags');
  const out = [h('section', { class: 'card' }, h('h2', null, 'Open flags'), h('p', { class: 'small' }, 'Conflicts and deadline changes are raised automatically. Closing one needs a reason; it is written to the evidence ledger with your name.'),
    flags.length ? h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Severity', 'Recruitment', 'Kind', 'What', 'Close'].map((x) => h('th', null, x)))),
      h('tbody', null, flags.map((f) => { const note = h('input', { type: 'text', placeholder: 'How was this resolved? (10+ characters)', 'aria-label': 'Resolution note' });
        return h('tr', null, h('td', null, pill(f.severity, /CRITICAL|HIGH/.test(f.severity) ? 'bad' : 'warn')), h('td', null, f.recruitment_id), h('td', null, f.kind), h('td', null, f.summary),
          h('td', null, isRole('REVIEWER') ? [note, h('button', { class: 'btn', onclick: async () => { try { await api(`/trust/flags/${f.id}/resolve`, { method: 'POST', body: JSON.stringify({ resolution: 'RESOLVED', note: note.value }) }); say('Flag closed'); render(); } catch (e) { say(e.message); note.setAttribute('aria-invalid', 'true'); note.title = e.message; } } }, 'Resolve')] : '—')); })))) : h('p', null, pill('No open flags', 'ok')))];
  const rec = await api('/recruitments');
  out.push(h('section', { class: 'card' }, h('h2', null, 'Confirm critical fields'), h('p', { class: 'small' }, 'A record is VERIFIED only when every critical field has been confirmed by a named person against a page and quote.'),
    h('ul', null, rec.slice(0, 30).map((r) => h('li', null, `${r.title} (${r.lifecycle}) `, h('button', { class: 'btn', onclick: async () => { state.sheet = await api(`/trust/recruitments/${encodeURIComponent(r.id)}/sheet`); render(); } }, 'Open sheet'))))));
  if (state.sheet) {
    const sh = state.sheet;
    out.push(h('section', { class: 'card' }, h('h2', null, `Sheet: ${sh.title}`), pill(sh.display_status, sh.display_status === 'VERIFIED' ? 'ok' : 'warn'),
      h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['Field', 'Value', 'Status', 'Evidence (document, page, exact quote)', ''].map((x) => h('th', null, x)))),
        h('tbody', null, sh.fields.map((f) => { const sg = f.suggested_evidence || {}; const doc = h('input', { type: 'number', value: sg.document_id ?? '', 'aria-label': 'Document id', size: 5 }), pg = h('input', { type: 'number', value: sg.page ?? '', 'aria-label': 'Page', size: 3 }), q = h('input', { type: 'text', value: sg.quote ?? '', 'aria-label': 'Quote' });
          return h('tr', null, h('td', null, f.field), h('td', null, fmt(f.value)), h('td', null, f.status), h('td', null, doc, pg, q),
            h('td', null, f.value == null || !isRole('REVIEWER') ? '' : h('button', { class: 'btn primary', onclick: async () => { try { await api(`/trust/recruitments/${encodeURIComponent(sh.recruitment_id)}/confirm`, { method: 'POST', body: JSON.stringify({ items: [{ field: f.field, evidence: { document_id: doc.value === '' ? null : Number(doc.value), page: Number(pg.value), quote: q.value } }] }) }); say('Confirmed'); state.sheet = await api(`/trust/recruitments/${encodeURIComponent(sh.recruitment_id)}/sheet`); render(); } catch (e) { say(e.message); q.title = e.message; q.setAttribute('aria-invalid', 'true'); } } }, 'Confirm'))); })))))); }
  return out;
}

async function render() {
  if (!state.token) { document.getElementById('who').textContent = ''; return loginView(); }
  try {
    if (!state.user) state.user = (await api('/me')).user;
    document.getElementById('who').textContent = `${state.user.name} (${state.user.role.toLowerCase()})`;
    const views = { dashboard: dashboardView, queue: () => (state.open ? reviewView(state.open) : queueView()), recruitments: recruitmentsView, upload: uploadView, trust: trustView, audit: auditView };
    const body = await views[state.tab]();
    $app.replaceChildren(nav(), ...[].concat(body).filter(Boolean)); $app.focus({ preventScroll: true });
  } catch (e) { $app.replaceChildren(h('p', { class: 'reason high', role: 'alert' }, e.message)); }
}
render();
