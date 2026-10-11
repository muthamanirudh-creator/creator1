// Natural language -> structured filters -> database query. The LLM never invents results:
// results only ever come from verified records.
const { deadlineInfo, istYMD } = require('./dates');
const { evaluate, evalEducation, evalAge, LEVEL_LABEL } = require('./eligibility');

const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh', 'Andaman and Nicobar Islands', 'Lakshadweep', 'Dadra and Nagar Haveli and Daman and Diu'];
const DOMAINS = [
  [/\brailways?\b|\brrb\b|\brrc\b/i, 'railway', 'Railway'], [/\bbank(s|ing)?\b|\bpo\b|\bclerk\b/i, 'banking', 'Banking'],
  [/\bpolice\b|\bconstable\b|\bsi\b/i, 'police', 'Police'], [/\bdefen[cs]e\b|\barmy\b|\bnavy\b|\bair force\b|\barmed forces?\b/i, 'defence', 'Defence'],
  [/\bssc\b|\bstaff selection\b/i, 'ssc', 'SSC'], [/\bpostal\b|\bpost office\b|\bdak\b/i, 'postal', 'Postal'],
  [/\bresearch\b|\bscientist\b|\blaborator(y|ies)\b/i, 'research', 'Research'], [/\bstate (services|jobs?)\b|\bpublic service commission\b|\bpsc\b/i, 'state-services', 'State services'],
];
const EDU = [
  [/\b(ph\.?\s?d|doctorate)\b/i, 'phd'], [/\b(post ?graduate|master'?s?|m\.?\s?tech|mba|mca|m\.?\s?sc|m\.?\s?com)\b/i, 'master'],
  [/\b(graduate|graduation|degree|b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|bca|bba|bachelor'?s?)\b/i, 'bachelor'],
  [/\b(diploma|polytechnic)\b/i, 'diploma'], [/\biti\b/i, 'iti'],
  [/\b(12th|12 th|class 12|intermediate|plus two|higher secondary)\b/i, '12th'], [/\b(10th|10 th|class 10|matric(ulation)?)\b/i, '10th'],
  [/\b(8th|class 8)\b/i, '8th'],
];
const rx = (s) => new RegExp('\\b' + s.replace(/ /g, '\\s+') + '\\b', 'i');

function parseQuery(q, context = {}) {
  const text = (q || '').trim();
  if (/^(clear|reset|start over|new search)\b/i.test(text)) return { filters: {}, reset: true };
  const f = { ...context };
  for (const [re, level] of EDU) if (re.test(text)) { f.education = level; break; }
  let m = text.match(/\b(?:i'?m|i am|age[d]?|aged)\s*(\d{2})\b/i) || text.match(/\b(\d{2})\s*(?:years?|yrs?)(?:\s*old)?\b/i) || text.match(/\b(\d{2})\s*(?:year|yr)s?[- ]old\b/i);
  if (m && +m[1] >= 14 && +m[1] <= 70) f.age = +m[1];
  for (const s of STATES) if (rx(s).test(text)) { f.state = s; break; }
  for (const [re, key] of DOMAINS) if (re.test(text)) { f.domain = key; break; }
  if (/\b(all|any) (departments?|jobs?|sectors?)\b|\bany domain\b/i.test(text)) delete f.domain;
  if (/\bclos(ing|es)\s+(this month)\b|\bending this month\b/i.test(text)) { f.closing_this_month = true; delete f.closing_days; }
  else if ((m = text.match(/\bclos(?:ing|es)\s+(?:in|within)\s+(?:the next\s+)?(\d{1,3})\s+days?\b/i))) { f.closing_days = +m[1]; delete f.closing_this_month; }
  else if (/\bclosing soon\b|\bending soon\b|\blast date (is )?near\b|\bdeadline (is )?near\b/i.test(text)) { f.closing_days = 7; delete f.closing_this_month; }
  if (/\b(upcoming|opening soon|yet to open|not (yet )?open)\b/i.test(text)) f.status = 'UPCOMING';
  else if (/\b(currently open|open now|applications? (is |are )?(currently )?open|still open|ongoing|active)\b|\bopen\b/i.test(text)) f.status = 'OPEN';
  else if (/\bclosed\b|\bexpired\b/i.test(text)) f.status = 'CLOSED';
  return { filters: f, reset: false };
}

function describe(f) {
  const chips = [];
  if (f.domain) chips.push({ key: 'domain', label: (DOMAINS.find((d) => d[1] === f.domain) || [0, 0, f.domain])[2] });
  if (f.education) chips.push({ key: 'education', label: LEVEL_LABEL[f.education] });
  if (f.age) chips.push({ key: 'age', label: `Age about ${f.age}` });
  if (f.state) chips.push({ key: 'state', label: f.state });
  if (f.status) chips.push({ key: 'status', label: { OPEN: 'Applications open', UPCOMING: 'Opening soon', CLOSED: 'Closed' }[f.status] });
  if (f.closing_this_month) chips.push({ key: 'closing_this_month', label: 'Closing this month' });
  if (f.closing_days) chips.push({ key: 'closing_days', label: `Closing within ${f.closing_days} days` });
  return chips;
}

// A stated age today (e.g. 18) allows a range of birthdays, so a job is excluded only if
// NO birthday in that range would satisfy the age rule on the official cutoff date.
function dobRange(age, now) {
  const today = istYMD(now); const [y, m, d] = today.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const youngest = `${y - age}-${pad(m)}-${pad(d)}`;
  const oldest = istYMD(new Date(Date.UTC(y - age - 1, m - 1, d + 1, 6)));
  return [youngest, oldest];
}

const ORDER = { MATCH: 0, CONDITIONALLY_ELIGIBLE: 1, PARTIAL_MATCH: 2, UNKNOWN: 3, INSUFFICIENT_EVIDENCE: 3, NOT_ELIGIBLE: 4 };

function runSearch(jobs, f, profile, now = new Date()) {
  const today = istYMD(now);
  const hasProfile = !!(profile && profile.education && profile.education.level);
  const out = [];
  for (const job of jobs) {
    const dl = deadlineInfo(job.dates, now);
    if (f.status === 'CLOSED') { if (dl.status !== 'CLOSED') continue; }
    else if (dl.status === 'CLOSED') continue;
    else if (f.status === 'UPCOMING') { if (dl.status !== 'UPCOMING') continue; }
    else if (f.status === 'OPEN') { if (dl.status === 'UPCOMING') continue; }
    if (f.domain && job.domain !== f.domain) continue;
    if (f.state && job.state !== 'All India' && job.state !== f.state) continue;
    if (f.closing_this_month && (dl.status === 'UPCOMING' || dl.closes_ymd.slice(0, 7) !== today.slice(0, 7))) continue;
    if (f.closing_days && (dl.status === 'UPCOMING' || dl.ms_left > f.closing_days * 864e5)) continue;
    if (f.education && evalEducation(job, { education: { level: f.education, status: 'completed' } }).result === 'NOT_ELIGIBLE') continue;
    if (f.age && dobRange(f.age, now).every((dob) => evalAge(job, { dob }).result === 'NOT_ELIGIBLE')) continue;
    const elig = hasProfile || (profile && profile.dob) ? evaluate(job, profile) : null;
    out.push({
      id: job.id, title: job.title, organization: job.organization, state: job.state, domain: job.domain, summary: job.summary,
      deadline: dl, vacancies_total: job.vacancies.total,
      department: job.department, fee: job.fee, exam_date: (job.dates || {}).exam_date || null, education_label: job.education && job.education.label,
      age_max: job.age && job.age.max, verified_at: job.verification && job.verification.verified_at, updated: !!(job.history && job.history.length),
      eligibility: elig && { overall: elig.overall, short_reason: elig.short_reason },
    });
  }
  const statusOrder = { CLOSING_SOON: 0, OPEN: 1, UPCOMING: 2, CLOSED: 3 };
  out.sort((a, b) => {
    const ea = a.eligibility ? ORDER[a.eligibility.overall] : 0, eb = b.eligibility ? ORDER[b.eligibility.overall] : 0;
    return ea - eb || statusOrder[a.deadline.status] - statusOrder[b.deadline.status] || a.deadline.ms_left - b.deadline.ms_left;
  });
  return out;
}

module.exports = { parseQuery, describe, runSearch, STATES };
