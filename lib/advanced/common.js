'use strict';
// Shared helpers for the Advanced Strategy Suite. Pure functions, no I/O, no AI: every number
// returned is computed from verified recruitment records or from values the user supplied.
const { istYMD, ageOn } = require('../dates');

const ENGINE_VERSION = 'advanced-1.0';
const DAY = 864e5;
const ymdToUTC = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (aYMD, bYMD) => Math.round((ymdToUTC(bYMD) - ymdToUTC(aYMD)) / DAY);
const addDays = (ymd, n) => new Date(ymdToUTC(ymd) + n * DAY).toISOString().slice(0, 10);
const todayYMD = (now) => istYMD(now || new Date());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const closeDate = (j) => (j.dates && (j.dates.application_close || j.dates.last_date) ? String(j.dates.application_close || j.dates.last_date).slice(0, 10) : null);
const openDate = (j) => (j.dates && j.dates.application_open ? String(j.dates.application_open).slice(0, 10) : null);
const examDate = (j) => (j.dates && j.dates.exam_date ? String(j.dates.exam_date).slice(0, 10) : null);

// "₹500" -> 500, "No fee" -> 0, missing -> null (unknown is never turned into zero).
function parseFee(text) {
  if (text == null || text === '') return null;
  if (/no\s*fee|nil|free/i.test(String(text))) return 0;
  const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
// Which fee column applies: the notification lists General and Reserved; we never guess other splits.
function feeFor(job, profile) {
  const f = job.fee || {};
  const reserved = ['SC', 'ST'].includes(profile.category) || !!profile.pwbd || !!(profile.exServicemen || profile.exServiceman);
  const text = reserved ? (f.reserved != null ? f.reserved : f.general) : f.general;
  return { amount: parseFee(text), label: text == null ? null : String(text), column: reserved ? 'reserved' : 'general' };
}
function normProfile(p) {
  const o = { ...(p || {}) };
  if (o.exServiceman && !o.exServicemen) o.exServicemen = true;
  return o;
}
function relaxationFor(job, p) {
  const rel = (job.age && job.age.relaxation) || {};
  let years = 0; const parts = [];
  if (p.category && rel[p.category]) { years += rel[p.category]; parts.push(`${p.category} +${rel[p.category]}`); }
  if (p.pwbd && rel.PwBD) { years += rel.PwBD; parts.push(`PwBD +${rel.PwBD}`); }
  if ((p.exServicemen || p.exServiceman) && rel.ExServicemen) { years += rel.ExServicemen; parts.push(`Ex-servicemen +${rel.ExServicemen}`); }
  return { years, parts };
}
function sourceOf(job, key) { return (job.field_sources && job.field_sources[key]) || null; }
module.exports = { ENGINE_VERSION, DAY, ymdToUTC, daysBetween, addDays, todayYMD, clamp, round1, closeDate, openDate, examDate, parseFee, feeFor, normProfile, relaxationFor, sourceOf, ageOn };
