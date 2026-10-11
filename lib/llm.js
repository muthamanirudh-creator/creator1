// LLM provider adapter (Groq, Gemini). The model only proposes {value, page, quote} per field.
// Nothing it returns is trusted until the quote is found on the cited page (see extract.js).
const resilience = require('./resilience');
const KEY_LIST = ['title', 'organization', 'department', 'state', 'dates.application_open', 'dates.application_close', 'dates.exam_date',
  'education', 'age.min', 'age.max', 'age.cutoff_date', 'age.relaxation', 'experience_years', 'domicile', 'physical', 'fee',
  'vacancies.total', 'vacancies.breakdown', 'vacancies.pwbd', 'vacancies.ex_servicemen', 'selection', 'application_link'];

function buildPrompt(pages) {
  const body = pages.map((p) => `=== PAGE ${p.page_number} ===\n${p.text}`).join('\n\n').slice(0, 60000);
  return `You extract facts from an Indian government recruitment notification. Use ONLY the text below.
Return one JSON object: {"fields": {"<key>": {"value": ..., "page": <int>, "quote": "<exact text copied from that page>"}}}.
Rules: copy "quote" verbatim from the page (one line or sentence). If a field is not stated, OMIT it. Never guess, infer, or default.
Dates: application_open / application_close as ISO "YYYY-MM-DDTHH:MM:SS+05:30" (only if a time is given; otherwise omit the time part as "YYYY-MM-DD"), exam_date and age.cutoff_date as "YYYY-MM-DD".
education = {"accepted": [one or more of 10th,12th,iti,diploma,bachelor,master,phd], "or_higher": bool, "label": "<as written>", "fields": ["engineering"|"science"|"any"], "allow_final_year": bool (only if stated)}.
age.relaxation = {"SC":n,"ST":n,"OBC":n,"EWS":n,"PwBD":n,"ExServicemen":n} (years, only if stated). domicile = {"type":"ALL_INDIA"} or {"type":"STATE","state":"<name>"}.
fee = {"general":"₹500","reserved":"₹250"}; vacancies.breakdown = {"UR":n,"SC":n,"ST":n,"OBC":n,"EWS":n}; selection = [stage names].
Allowed keys: ${KEY_LIST.join(', ')}.

${body}`;
}

async function withTimeout(fetchImpl, url, init, ms = 60000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetchImpl(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

const PROVIDERS = {
  groq: {
    model: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    available: () => !!process.env.GROQ_API_KEY,
    async call(prompt, fetchImpl) {
      const res = await withTimeout(fetchImpl, 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: PROVIDERS.groq.model(), temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
      const j = await res.json();
      return j.choices[0].message.content;
    },
  },
  gemini: {
    model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    available: () => !!process.env.GEMINI_API_KEY,
    async call(prompt, fetchImpl) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDERS.gemini.model()}:generateContent`;
      const res = await withTimeout(fetchImpl, url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const j = await res.json();
      return j.candidates[0].content.parts.map((p) => p.text).join('');
    },
  },
};

function parseJson(text) {
  const t = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const j = JSON.parse(t);
  if (!j || typeof j.fields !== 'object') throw new Error('Response has no "fields" object');
  return j.fields;
}

// Try providers in order (default groq, gemini). Returns { provider, model, fields } or { error, attempts }.
async function proposeFields(pages, { order, fetchImpl = globalThis.fetch, providers = PROVIDERS } = {}) {
  const names = order || (process.env.LLM_PROVIDERS || 'groq,gemini').split(',').map((s) => s.trim()).filter(Boolean);
  const attempts = []; const prompt = buildPrompt(pages);
  for (const n of names) {
    const p = providers[n];
    if (!p) { attempts.push({ provider: n, ok: false, error: 'unknown provider' }); continue; }
    if (!p.available()) { attempts.push({ provider: n, ok: false, error: 'API key not configured' }); continue; }
    try {
      const fields = parseJson(await resilience.guarded('llm:' + n, () => p.call(prompt, fetchImpl)));
      attempts.push({ provider: n, ok: true });
      return { provider: n, model: p.model(), fields, attempts };
    } catch (e) { attempts.push({ provider: n, ok: false, error: String(e.message).slice(0, 200), ...(e.code === 'CIRCUIT_OPEN' ? { skipped: 'circuit_open' } : {}) }); }
  }
  return { error: 'No LLM provider produced usable output', attempts };
}

module.exports = { proposeFields, buildPrompt, PROVIDERS, KEY_LIST, parseJson };
