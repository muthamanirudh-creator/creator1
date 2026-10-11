// Fraud and suspicious-source signals. These only FLAG for human review; they never auto-reject or auto-publish.
const hostsIn = (text) => [...new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,}|xn--[a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];
const inDomain = (host, d) => host === d || host.endsWith(`.${d}`);
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const PAYMENT_RX = [
  [/[\w.-]+@(?:ok(?:axis|sbi|hdfcbank|icici)|ybl|paytm|ibl|axl|upi|apl)\b/i, 'a UPI payment address'],
  [/\b(?:pay|send|transfer)\b[^.\n]{0,40}\b(?:to|via|on)\b[^.\n]{0,30}\b(?:gpay|google pay|phonepe|paytm|whatsapp|mobile number|personal account)/i, 'payment to a wallet or personal account'],
  [/\baccount\s*(?:no|number)\.?\s*[:\-]?\s*\d{8,}/i, 'a bank account number for payment'],
  [/\bprocessing fee\b[^.\n]*\b(?:upi|account|wallet)/i, 'a processing fee outside the portal'],
];

const STOP = new Set(['demo', 'of', 'the', 'and', 'for']);
const tokens = (s) => new Set(squash0(s).split(' ').filter((t) => t && !STOP.has(t)));
const squash0 = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const jaccard = (a, b) => { const i = [...a].filter((x) => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0; };

// ctx: { pages, record, source, registryDomains: [..] }
function analyzeFraud({ pages, record, source, registryDomains }) {
  const flags = [];
  const text = pages.map((p) => p.text).join('\n');
  const allowed = [...new Set([...(registryDomains || []), source && source.official_domain].filter(Boolean).map((d) => d.toLowerCase()))];
  for (const host of hostsIn(text)) {
    if (allowed.some((d) => inDomain(host, d))) continue;
    const lookalike = host.startsWith('xn--') || host.includes('.xn--') || allowed.some((d) => squash(host) === squash(d) || (lev(host, d) <= 2 && host !== d) || (squash(host).includes(squash(d).slice(0, Math.max(6, squash(d).length - 3))) && host !== d && !inDomain(host, d)));
    if (lookalike) flags.push({ code: 'LOOKALIKE_DOMAIN', severity: 'high', message: `A link points to ${host}, which looks like an official domain but is not on our list.`, evidence: host });
    else flags.push({ code: 'NON_OFFICIAL_DOMAIN', severity: /\.(gov|nic)\.in$/.test(host) ? 'medium' : 'high', message: `A link points to ${host}, which is not a registered official domain for this source.`, evidence: host });
  }
  if (record && record.application_link) {
    try { const h = new URL(record.application_link).hostname.toLowerCase(); if (!allowed.some((d) => inDomain(h, d))) flags.push({ code: 'APPLICATION_LINK_NOT_OFFICIAL', severity: 'high', message: `The application link (${h}) is not on a registered official domain.`, evidence: h }); } catch { flags.push({ code: 'APPLICATION_LINK_INVALID', severity: 'medium', message: 'The application link is not a valid URL.', evidence: record.application_link }); }
  }
  for (const [rx, what] of PAYMENT_RX) { const m = rx.exec(text); if (m) flags.push({ code: 'PAYMENT_OUTSIDE_PORTAL', severity: 'high', message: `The document asks for ${what}. Official fees are paid only on the official portal.`, evidence: m[0].slice(0, 80) }); break; }
  if (record && record.organization && source && source.organization && source.source_type !== 'MANUAL_UPLOAD') {
    const j = jaccard(tokens(record.organization), tokens(source.organization));
    if (j < 0.5) flags.push({ code: 'ISSUER_MISMATCH', severity: 'medium', message: `The document names "${record.organization}" but the source is registered as "${source.organization}".`, evidence: record.organization });
  }
  return flags;
}

module.exports = { analyzeFraud, hostsIn, lev, jaccard };
