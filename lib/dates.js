// All date logic is deterministic and IST-aware. No AI involved.
const TZ = 'Asia/Kolkata';

function istYMD(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function addDaysIST(now, n) { return istYMD(new Date(now.getTime() + n * 864e5)); }
function toISTISO(ymd, time = '23:59:00') { return `${ymd}T${time}+05:30`; }
function formatIST(date) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date) + ' IST';
}
function formatYMD(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

// Age on an official cutoff date (never "today" unless the notification says so).
function ageOn(dobYMD, onYMD) {
  const [by, bm, bd] = dobYMD.split('-').map(Number);
  const [ay, am, ad] = onYMD.split('-').map(Number);
  let years = ay - by, months = am - bm, days = ad - bd;
  if (days < 0) { months--; days += new Date(Date.UTC(ay, am - 1, 0)).getUTCDate(); }
  if (months < 0) { years--; months += 12; }
  return { years, months, days };
}
function ageText(a) { return `${a.years} years, ${a.months} months, ${a.days} days`; }

function human(ms) {
  const days = Math.floor(ms / 864e5), hours = Math.floor((ms % 864e5) / 36e5);
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`;
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'in under an hour';
}

function deadlineInfo(dates, now = new Date()) {
  const open = new Date(dates.application_open), close = new Date(dates.application_close);
  const base = { opens_exact: formatIST(open), closes_exact: formatIST(close), closes_ymd: istYMD(close) };
  if (now < open) return { ...base, status: 'UPCOMING', label: `Applications open ${human(open - now)}`, ms_left: close - now };
  if (now > close) return { ...base, status: 'CLOSED', label: 'Applications closed', ms_left: 0 };
  const ms = close - now;
  const status = ms <= 7 * 864e5 ? 'CLOSING_SOON' : 'OPEN';
  return { ...base, status, label: `Applications close ${human(ms)}`, ms_left: ms };
}

module.exports = { TZ, istYMD, addDaysIST, toISTISO, formatIST, formatYMD, ageOn, ageText, deadlineInfo };
