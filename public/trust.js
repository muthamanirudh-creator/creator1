'use strict';
// v2.9.0 trust UI: status badges with reasons, a "Why this status?" panel, and abstention-aware AI answers.
// No inline handlers (CSP). All text is escaped.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LABEL = { VERIFIED: 'Verified', AMENDED: 'Amended', UNVERIFIED: 'Unverified', PARTIALLY_VERIFIED: 'Partly verified', DETECTED: 'Detected, not read', CONFLICTED: 'Conflicting documents', RETRACTED: 'Retracted', CLOSED: 'Closed', EXPIRED: 'Expired', UPCOMING: 'Not open yet', SAMPLE: 'Sample (fictional)' };
  const ICON = { VERIFIED: '✓', AMENDED: '↻', UNVERIFIED: '?', PARTIALLY_VERIFIED: '◐', DETECTED: '◌', CONFLICTED: '⚠', RETRACTED: '✕', CLOSED: '■', EXPIRED: '■', UPCOMING: '◷', SAMPLE: '◇' };
  function badge(t) {
    if (!t) return '';
    const k = t.display_status || t.verification;
    return `<span class="tr-badge tr-${esc(k)}" title="${esc(t.verification_label || LABEL[k] || k)}"><span aria-hidden="true">${ICON[k] || '?'}</span> ${esc(LABEL[k] || k)}</span>`;
  }
  function panel(t) {
    if (!t) return '';
    const k = t.display_status || t.verification;
    const flags = (t.open_flags || []).map((f) => `<li class="tr-flag tr-sev-${esc(f.severity)}"><strong>${esc(f.severity)}</strong> ${esc(f.summary || f.kind)}</li>`).join('');
    const why = (t.why || []).map((w) => `<li>${esc(w)}</li>`).join('');
    const rely = t.can_rely_on_for_decisions ? 'Critical fields are confirmed. Still check the official notification before you pay a fee or submit.' : 'Do not rely on this record alone. Confirm the deadline, vacancies, age limit and qualification on the official notification.';
    return `<section class="blk tr-panel tr-p-${esc(k)}" aria-labelledby="tr-h"><h3 id="tr-h">${badge(t)} Why is it shown this way?</h3><ul class="plain tr-why">${why}</ul>${flags ? `<h4>Open flags</h4><ul class="plain">${flags}</ul>` : ''}<p class="fine"><strong>${esc(rely)}</strong></p></section>`;
  }
  function answerBlock(r) {
    if (!r || !r.answer_status) return '';
    const label = { ANSWERED_VERIFIED: 'Answered from a verified record', ANSWERED_UNVERIFIED: 'Answered from an UNVERIFIED record', CONFLICTING_OFFICIAL_SOURCES: 'Official documents disagree: no single answer', INSUFFICIENT_EVIDENCE: 'Insufficient evidence: no answer given' }[r.answer_status] || r.answer_status;
    const facts = (r.official_facts || []).map((f) => `<li>${esc(f.text)}${f.source ? ` <span class="src">${esc(f.source.doc)}, page ${esc(f.source.page)}</span>` : ''}</li>`).join('');
    const derived = (r.derived || []).map((f) => `<li>${esc(f.text)}</li>`).join('');
    const guide = (r.guidance || []).map((f) => `<li>${esc(f.text)}</li>`).join('');
    return `<div class="tr-answer tr-as-${esc(r.answer_status)}"><strong>${esc(label)}</strong>${facts ? `<h5>Official facts</h5><ul>${facts}</ul>` : ''}${derived ? `<h5>Computed from the facts</h5><ul>${derived}</ul>` : ''}${guide ? `<h5>Generated guidance (not official)</h5><ul>${guide}</ul>` : ''}${r.missing_evidence && r.missing_evidence.length ? `<p class="fine">Missing: ${esc(r.missing_evidence.join(', '))}</p>` : ''}</div>`;
  }
  window.GCTrust = { badge, panel, answerBlock, esc };
})();
