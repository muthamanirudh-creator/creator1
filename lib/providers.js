// Delivery providers for per-person alerts (lib/alerts.js). IN_APP needs none. E-mail uses the Resend HTTP API when
// RESEND_API_KEY + EMAIL_FROM are set; PUSH stays unconfigured (alerts are then SKIPPED, never faked as sent).
function alertProviders(env = process.env, fetch = globalThis.fetch) {
  const out = {};
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    out.EMAIL = async ({ to, payload, idempotencyKey }) => {
      const p = payload || {};
      const text = [p.title || 'GovCareer alert', p.message, p.reason && `Why you got this: ${p.reason}`, p.official_url && `Official: ${p.official_url}`, 'Always confirm dates and eligibility on the official notification.'].filter(Boolean).join('\n\n');
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}`, 'idempotency-key': String(idempotencyKey || '') }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: String(p.title || 'GovCareer alert').slice(0, 200), text }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id) throw new Error(`email provider HTTP ${r.status}`);
        return { id: String(j.id) };
      } finally { clearTimeout(t); }
    };
  }
  return out;
}
module.exports = { alertProviders };
