'use strict';
// Deadline & Conflict Radar + application budget. Dates come only from verified records.
const C = require('./common');

function lifecycle(job, today) {
  const close = C.closeDate(job), open = C.openDate(job);
  if (close && close < today) return 'CLOSED';
  if (open && open > today) return 'UPCOMING';
  return close ? 'OPEN' : 'OPEN_NO_DEADLINE';
}
function buildEvents(jobs, today) {
  const ev = [];
  for (const j of jobs) {
    const close = C.closeDate(j), open = C.openDate(j), exam = C.examDate(j);
    if (open && open >= today) ev.push({ date: open, type: 'OPENS', job_id: j.id, title: j.title });
    if (close && close >= today) ev.push({ date: close, type: 'CLOSES', job_id: j.id, title: j.title, apply_by: C.addDays(close, -3) > today ? C.addDays(close, -3) : today });
    if (exam && exam >= today) ev.push({ date: exam, type: 'EXAM', job_id: j.id, title: j.title });
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type)).map((e) => ({ ...e, in_days: C.daysBetween(today, e.date) }));
}
function conflicts(events, opts = {}) {
  const win = opts.examWindowDays ?? 3, crunch = opts.crunchCloses ?? 3, crunchDays = opts.crunchWindowDays ?? 7;
  const out = [];
  const exams = events.filter((e) => e.type === 'EXAM'), closes = events.filter((e) => e.type === 'CLOSES');
  for (let i = 0; i < exams.length; i++) for (let k = i + 1; k < exams.length; k++) {
    const gap = Math.abs(C.daysBetween(exams[i].date, exams[k].date));
    if (gap <= win) out.push({ kind: gap === 0 ? 'EXAM_SAME_DAY' : 'EXAM_CLOSE', severity: gap === 0 ? 'HIGH' : 'MEDIUM', jobs: [exams[i].job_id, exams[k].job_id], dates: [exams[i].date, exams[k].date], gap_days: gap, message: gap === 0 ? `${exams[i].title} and ${exams[k].title} are on the same day (${exams[i].date}). You can sit only one.` : `${exams[i].title} and ${exams[k].title} are only ${gap} day(s) apart.` });
  }
  for (let i = 0; i < closes.length; i++) {
    const group = closes.filter((c) => { const g = C.daysBetween(closes[i].date, c.date); return g >= 0 && g < crunchDays; });
    if (group.length >= crunch) {
      const key = group.map((g) => g.job_id).sort().join('|');
      if (!out.some((o) => o.kind === 'DEADLINE_CRUNCH' && o.key === key)) out.push({ kind: 'DEADLINE_CRUNCH', key, severity: 'MEDIUM', jobs: group.map((g) => g.job_id), dates: [group[0].date, group[group.length - 1].date], message: `${group.length} applications close within ${crunchDays} days (${group[0].date} to ${group[group.length - 1].date}). Prepare documents and fees together.` });
    }
  }
  // Applying costs time: an application closing after another exam starts is flagged as a sequencing risk.
  for (const c of closes) for (const x of exams) if (c.job_id !== x.job_id && c.date > x.date) out.push({ kind: 'APPLY_AFTER_EXAM', severity: 'LOW', jobs: [c.job_id, x.job_id], dates: [x.date, c.date], message: `Applications for ${c.title} close after ${x.title} is held; plan study time around both.` });
  return out.map(({ key, ...r }) => r);
}
function weekly(events, today, weeks = 12) {
  const start = C.addDays(today, -((new Date(C.ymdToUTC(today)).getUTCDay() + 6) % 7)); // Monday
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const from = C.addDays(start, w * 7), to = C.addDays(from, 6);
    const items = events.filter((e) => e.date >= from && e.date <= to);
    if (items.length) out.push({ week_start: from, week_end: to, items });
  }
  return out;
}
function budget(jobs, profile) {
  const rows = jobs.map((j) => { const f = C.feeFor(j, profile); return { job_id: j.id, title: j.title, fee_label: f.label, fee_column: f.column, amount: f.amount }; });
  const known = rows.filter((r) => r.amount != null);
  return { rows, total_known: known.reduce((s, r) => s + r.amount, 0), unknown_count: rows.length - known.length, note: 'Fee column chosen from your category/PwBD/ex-servicemen answers; the notification decides. Unknown fees are never counted as zero.' };
}
module.exports = { lifecycle, buildEvents, conflicts, weekly, budget };
