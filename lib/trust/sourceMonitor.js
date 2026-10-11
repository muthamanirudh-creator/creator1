'use strict';
// Source monitor (v2.9.0): detect changed pages, expired notices, conflicting dates and broken links.
//
// Detection is pure (snapshots in, findings out) so it can be tested against fixtures without a network.
// The only I/O is checkLinks(), which takes an injectable fetch and applies the same safety rules as the crawler:
// https only, public hosts only, official domains only, at most 3 redirects, hard timeout, no cookies.
const crypto = require('crypto');
const net = require('net');
const { datesIn } = require('../rulesExtractor');
const { isOfficialDomain, isPrivateIp } = require('../sourcePolicy');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ymd = (v) => (v ? String(v).slice(0, 10) : null);

// ---- text normalisation: the same notice must hash the same even if a visitor counter or timestamp moved ---------
function normaliseHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ')
    // volatile page furniture that is not part of the notice
    .replace(/(visitors?|hits?|page views?|last updated|last modified|today'?s date)\s*[:\-]?\s*[\d,/: \-A-Za-z]{0,30}/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
const fingerprint = (text) => sha(String(text).toLowerCase().replace(/\s+/g, ' ').trim());

// Numbers that carry meaning in a notice (vacancies, ages, fees). Dates are handled separately.
const meaningfulNumbers = (t) => [...String(t).replace(/\d{1,2}[\s-][A-Za-z]{3,9}[\s,-]+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}/g, ' ').matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, '')).filter((n) => n.length >= 2);
const setDiff = (a, b) => { const sb = new Set(b); return [...new Set(a)].filter((x) => !sb.has(x)); };

// prev/next: { text, status, final_url } (text already normalised). Returns what changed in terms a reviewer can act on.
function detectPageChange(prev, next) {
  if (!prev) return { changed: false, kind: 'FIRST_SEEN', fingerprint: fingerprint(next.text) };
  const fp0 = fingerprint(prev.text), fp1 = fingerprint(next.text);
  if (fp0 === fp1) return { changed: false, kind: 'NONE', fingerprint: fp1 };
  const d0 = datesIn(prev.text), d1 = datesIn(next.text);
  const n0 = meaningfulNumbers(prev.text), n1 = meaningfulNumbers(next.text);
  const addedDates = setDiff(d1, d0), removedDates = setDiff(d0, d1);
  const addedNums = setDiff(n1, n0), removedNums = setDiff(n0, n1);
  const material = addedDates.length || removedDates.length || addedNums.length || removedNums.length;
  return {
    changed: true, kind: material ? 'CONTENT' : 'COSMETIC', fingerprint: fp1, previous_fingerprint: fp0,
    added_dates: addedDates, removed_dates: removedDates, added_numbers: addedNums.slice(0, 20), removed_numbers: removedNums.slice(0, 20),
    summary: material
      ? `Page text changed. ${removedDates.length || addedDates.length ? `Dates: ${removedDates.join(', ') || 'none'} removed, ${addedDates.join(', ') || 'none'} added. ` : ''}${removedNums.length || addedNums.length ? `Figures: ${removedNums.slice(0, 5).join(', ') || 'none'} removed, ${addedNums.slice(0, 5).join(', ') || 'none'} added.` : ''}`.trim()
      : 'Wording changed but no date or figure moved.',
  };
}

// Labelled dates on a page ("Last date: ...") versus what the record says.
const CLOSE_RX = /(last date|closing date|application(?:s)? clos(?:e|es|ing)|apply (?:on or )?before)[^\n:]{0,40}[:\-]?\s*([^\n]{0,60})/gi;
function pageClosingDates(text) {
  const out = [];
  for (const m of String(text).matchAll(CLOSE_RX)) for (const d of datesIn(m[2])) out.push({ date: d, line: m[0].trim().slice(0, 120) });
  return out;
}
function findDateMismatch(job, pageText) {
  const rec = ymd(job && job.dates && job.dates.application_close);
  if (!rec) return null;
  const onPage = pageClosingDates(pageText);
  if (!onPage.length) return null;
  const distinct = [...new Set(onPage.map((x) => x.date))];
  if (distinct.includes(rec) && distinct.length === 1) return null;
  if (distinct.length > 1 && distinct.includes(rec)) return { kind: 'SOURCE_DATE_MISMATCH', severity: 'MEDIUM', field: 'dates.application_close', recorded: rec, on_page: distinct, summary: `The page shows several closing dates (${distinct.join(', ')}); the record has ${rec}. A corrigendum may have moved it.` };
  return { kind: 'SOURCE_DATE_MISMATCH', severity: 'HIGH', field: 'dates.application_close', recorded: rec, on_page: distinct, summary: `The official page says the closing date is ${distinct.join(' / ')}, but the record has ${rec}.` };
}

// Expired notice: closing date long past, or the official page has been gone for several consecutive checks.
function classifyFreshness(job, { now = new Date(), consecutiveMissing = 0, graceDays = 30, goneAfter = 3 } = {}) {
  const close = job && job.dates && Date.parse(job.dates.application_close);
  if (!close || Number.isNaN(close)) return { state: 'UNKNOWN', summary: 'No closing date recorded.' };
  const daysPast = Math.floor((now.getTime() - close) / 864e5);
  if (consecutiveMissing >= goneAfter) return { state: 'EXPIRED', reason: 'SOURCE_GONE', summary: `The official page has been unreachable for ${consecutiveMissing} consecutive checks.` };
  if (daysPast > graceDays) return { state: 'EXPIRED', reason: 'PAST_DEADLINE', summary: `Closed ${daysPast} days ago.` };
  if (daysPast > 0) return { state: 'CLOSED', reason: 'PAST_DEADLINE', summary: `Closed ${daysPast} day${daysPast === 1 ? '' : 's'} ago.` };
  return { state: 'CURRENT', summary: close - now.getTime() < 7 * 864e5 ? 'Closing within 7 days.' : 'Open.' };
}

// ---- links -------------------------------------------------------------------------------------------------------
const SOFT_404 = /(page (?:was )?not found|404 (?:error|not found)|no longer available|has been removed|this page does not exist|file not found|requested url was not found)/i;

function linkSafety(url, { allowedDomain } = {}) {
  let u; try { u = new URL(url); } catch { return { ok: false, reason: 'MALFORMED_URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'NOT_HTTPS' };
  const h = u.hostname.toLowerCase();
  if (net.isIP(h) && isPrivateIp(h)) return { ok: false, reason: 'PRIVATE_ADDRESS' };
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return { ok: false, reason: 'PRIVATE_ADDRESS' };
  if (allowedDomain ? !(h === allowedDomain || h.endsWith('.' + allowedDomain)) : !isOfficialDomain(h)) return { ok: false, reason: 'NOT_OFFICIAL_DOMAIN' };
  return { ok: true, host: h };
}

// Classify ONE url. Returns { url, status: OK|REDIRECTED|BROKEN|SOFT_404|TIMEOUT|BLOCKED|WRONG_TYPE|UNSAFE, http, final_url, detail }.
async function checkLink(url, { fetch = globalThis.fetch, timeoutMs = 8000, allowedDomain, expectPdf = null, maxRedirects = 3, returnText = false } = {}) {
  const safe = linkSafety(url, { allowedDomain });
  if (!safe.ok) return { url, status: 'UNSAFE', detail: safe.reason };
  let cur = url, hops = 0;
  while (true) {
    const s = linkSafety(cur, { allowedDomain }); if (!s.ok) return { url, status: 'UNSAFE', detail: `redirect to ${s.reason}`, final_url: cur };
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetch(cur, { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': `GovCareerBot/0.1 (link check; contact: ${process.env.CRAWLER_CONTACT || 'set CRAWLER_CONTACT'})`, accept: 'text/html,application/pdf,*/*;q=0.5' } }); }
    catch (e) { clearTimeout(t); return { url, status: e && e.name === 'AbortError' ? 'TIMEOUT' : 'BROKEN', detail: e && e.name === 'AbortError' ? 'timed out' : String(e && e.message).slice(0, 120), final_url: cur }; }
    clearTimeout(t);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers && res.headers.get && res.headers.get('location');
      if (!loc) return { url, status: 'BROKEN', http: res.status, detail: 'redirect without a location', final_url: cur };
      if (++hops > maxRedirects) return { url, status: 'BROKEN', http: res.status, detail: 'too many redirects', final_url: cur };
      try { cur = new URL(loc, cur).toString(); } catch { return { url, status: 'BROKEN', http: res.status, detail: 'bad redirect target', final_url: cur }; }
      continue;
    }
    if (res.status === 403 || res.status === 429) return { url, status: 'BLOCKED', http: res.status, final_url: cur, detail: 'the site refused an automated check; this is not proof the link is broken' };
    if (res.status >= 400) return { url, status: 'BROKEN', http: res.status, final_url: cur, detail: `HTTP ${res.status}` };
    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
    if (expectPdf === true && !/pdf/.test(ct)) return { url, status: 'WRONG_TYPE', http: res.status, final_url: cur, detail: `expected a PDF, got ${ct || 'unknown type'}` };
    let pageText = null;
    if (/html|text/.test(ct)) {
      let body = ''; try { body = (await res.text()).slice(0, 200000); } catch (_) {}
      const text = normaliseHtml(body); pageText = text;
      if (SOFT_404.test(text.slice(0, 4000)) || (text.length < 80 && !/pdf/.test(ct))) return { url, status: 'SOFT_404', http: res.status, final_url: cur, detail: 'the page answers 200 but reads as "not found" or is empty' };
    }
    const out = { url, status: hops ? 'REDIRECTED' : 'OK', http: res.status, final_url: cur, redirects: hops, content_type: ct || null };
    if (returnText && pageText != null) out.text = pageText;
    return out;
  }
}

async function checkLinks(urls, opts = {}) {
  const uniq = [...new Set((urls || []).filter(Boolean))]; const out = [];
  const concurrency = opts.concurrency || 3; let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, uniq.length) }, async () => { while (i < uniq.length) { const u = uniq[i++]; out.push(await checkLink(u, opts)); await new Promise((r) => setTimeout(r, opts.pauseMs ?? 250)); } }));
  const by = (s) => out.filter((x) => x.status === s).length;
  return { checked: out.length, ok: by('OK') + by('REDIRECTED'), broken: by('BROKEN') + by('SOFT_404') + by('WRONG_TYPE'), blocked: by('BLOCKED'), timeout: by('TIMEOUT'), unsafe: by('UNSAFE'), results: out };
}

// One monitoring pass for ONE job: turns observations into flags (flag shape matches lib/trust/flags.js).
// obs: { page: { prev, next }, links: [checkLink results], missing_count }
function findingsFor(job, obs = {}, now = new Date()) {
  const f = []; const mk = (x) => ({ recruitment_id: job.id, status: 'OPEN', ...x });
  if (obs.page && obs.page.next) {
    const ch = detectPageChange(obs.page.prev, obs.page.next);
    if (ch.changed && ch.kind === 'CONTENT') f.push(mk({ kind: 'SOURCE_PAGE_CHANGED', severity: ch.added_dates.length || ch.removed_dates.length ? 'HIGH' : 'MEDIUM', field: 'source_page', from: ch.previous_fingerprint, to: ch.fingerprint, summary: ch.summary, dedupe_key: `SOURCE_PAGE_CHANGED:${job.id}:${ch.fingerprint}` }));
    const mm = findDateMismatch(job, obs.page.next.text); if (mm) f.push(mk({ ...mm, from: mm.recorded, to: mm.on_page.join(','), dedupe_key: `SOURCE_DATE_MISMATCH:${job.id}:${sha(mm.on_page.join(',') + mm.recorded)}` }));
  }
  for (const l of obs.links || []) if (['BROKEN', 'SOFT_404', 'WRONG_TYPE'].includes(l.status)) f.push(mk({ kind: 'SOURCE_UNREACHABLE', severity: 'MEDIUM', field: 'source_link', from: l.url, to: l.status, summary: `Official link ${l.url} is ${l.status.toLowerCase().replace('_', ' ')} (${l.detail || l.http}).`, dedupe_key: `SOURCE_UNREACHABLE:${job.id}:${sha(l.url)}:${l.status}` }));
  const fr = classifyFreshness(job, { now, consecutiveMissing: obs.missing_count || 0 });
  if (fr.state === 'EXPIRED') f.push(mk({ kind: 'NOTICE_EXPIRED', severity: 'LOW', field: 'dates.application_close', from: ymd(job.dates && job.dates.application_close), to: fr.reason, summary: fr.summary, dedupe_key: `NOTICE_EXPIRED:${job.id}:${fr.reason}` }));
  return f;
}

module.exports = { normaliseHtml, fingerprint, detectPageChange, pageClosingDates, findDateMismatch, classifyFreshness, linkSafety, checkLink, checkLinks, findingsFor };
