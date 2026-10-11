// AI extraction with grounding: the model proposes, the document decides.
const { proposeFields } = require('./llm');
const { extractWithRules, assembleRecord, parseDate, datesIn, levelsFrom } = require('./rulesExtractor');
const { validateRecord, crossChecks } = require('./schema');
const { detectSections, sectionAt } = require('./docpipeline');

const { same } = require('./util');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// Locate a quote on a page. Returns {start,end} char offsets in page.text or null.
function locate(pageText, quote) {
  if (!quote) return null;
  const i = pageText.indexOf(quote);
  if (i >= 0) return { start: i, end: i + quote.length };
  // whitespace-insensitive fallback
  const flat = []; let map = [];
  for (let k = 0; k < pageText.length; k++) { if (/\s/.test(pageText[k])) { if (flat[flat.length - 1] !== ' ') { flat.push(' '); map.push(k); } } else { flat.push(pageText[k]); map.push(k); } }
  const flatStr = flat.join('').toLowerCase(); const q = norm(quote);
  const j = flatStr.indexOf(q);
  return j < 0 ? null : { start: map[j], end: map[Math.min(j + q.length - 1, map.length - 1)] + 1 };
}

// Does the quote actually support the value? Strict for numbers/dates/education; lenient for free text.
function supports(key, value, quote) {
  const q = quote.replace(/,/g, '');
  const dateOf = (v) => String(v).slice(0, 10);
  if (typeof value === 'number') return q.includes(String(value));
  if (/^dates\.|cutoff_date$/.test(key)) return datesIn(quote).includes(dateOf(value));
  if (key === 'education') return value.accepted.every((l) => levelsFrom(quote).accepted.includes(l));
  if (key === 'domicile') return value.type === 'ALL_INDIA' || norm(quote).includes(norm(value.state || ''));
  if (key === 'vacancies.breakdown' || key === 'age.relaxation') return Object.values(value).every((n) => q.includes(String(n)));
  if (key === 'fee') return Object.values(value).every((v) => v === 'No fee' || q.replace(/\s/g, '').includes(String(v).replace(/[₹\s,]/g, '')) || /no fee|nil|free/i.test(q));
  if (key === 'selection') return value.every((s) => norm(quote).includes(norm(s).slice(0, 12)));
  if (typeof value === 'string') return norm(quote).includes(norm(value)) || norm(value).includes(norm(quote));
  return true;
}

// Validate an LLM proposal against the pages. Returns accepted fields + rejected list.
function ground(pages, proposed) {
  const byPage = Object.fromEntries(pages.map((p) => [p.page_number, p]));
  const accepted = {}; const rejected = []; const notes = [];
  for (const [key, f] of Object.entries(proposed || {})) {
    if (!f || f.value === undefined || f.value === null) continue;
    if (/^dates\.application_(open|close)$/.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(f.value)) {
      const t = /(\d{1,2}:\d{2})/.exec(f.quote || '');
      const open = key.endsWith('open');
      f.value = `${f.value}T${t ? `${t[1]}:00` : open ? '10:00:00' : '23:59:00'}+05:30`;
      if (!t) notes.push(`${open ? 'Opening' : 'Closing'} time is not stated in the source line; ${open ? '10:00' : '23:59'} IST is a placeholder to confirm.`);
    }
    const page = byPage[f.page];
    if (!page) { rejected.push({ key, reason: 'cited page does not exist' }); continue; }
    const loc = locate(page.text, f.quote);
    if (!loc) { rejected.push({ key, reason: 'quote not found on cited page' }); continue; }
    if (!supports(key, f.value, f.quote)) { rejected.push({ key, reason: 'quote does not support the value' }); continue; }
    accepted[key] = { value: f.value, page: f.page, quote: f.quote, confidence: 0.85, method: 'LLM' };
  }
  return { accepted, rejected, notes };
}

// Add section + character location (lineage) to every field.
function addLineage(pages, fields, documentId) {
  const sectionsByPage = {}; for (const p of pages) sectionsByPage[p.page_number] = detectSections(p.text);
  const lineage = {};
  for (const [key, f] of Object.entries(fields)) {
    let loc = null; let section = null;
    if (f.page) { const page = pages.find((p) => p.page_number === f.page); loc = page && locate(page.text, f.quote); section = sectionAt(sectionsByPage, f.page, loc ? loc.start : 0); }
    lineage[key] = {
      document_id: documentId, page_number: f.page || null, section, source_text_location: loc ? { start: loc.start, end: loc.end } : null,
      quote: f.quote || null, extraction_method: f.method, confidence: f.confidence, value: f.value,
    };
  }
  return lineage;
}

const REQUIRED_KEYS = ['title', 'organization', 'department', 'state', 'dates.application_open', 'dates.application_close', 'education', 'age.min', 'age.max', 'age.cutoff_date', 'age.relaxation', 'domicile', 'fee', 'vacancies.total', 'vacancies.breakdown', 'vacancies.pwbd', 'vacancies.ex_servicemen', 'selection'];

async function extractDocument(pages, ctx = {}) {
  const notes = []; const attempts = []; let provider = 'rules'; let model = null; let disagreements = [];
  const rules = extractWithRules(pages, ctx);
  notes.push(...rules.notes);
  let fields = { ...rules.fields };

  if (!ctx.skipLlm) {
    const prop = await proposeFields(pages, ctx.llm || {});
    attempts.push(...(prop.attempts || []));
    if (!prop.error) {
      provider = prop.provider; model = prop.model;
      const { accepted, rejected, notes: gn } = ground(pages, prop.fields); notes.push(...gn);
      for (const r of rejected) notes.push(`AI proposal for "${r.key}" was rejected: ${r.reason}.`);
      for (const [k, f] of Object.entries(accepted)) {
        const rf = rules.fields[k];
        if (rf && !same(rf.value, f.value)) {
          disagreements.push({ key: k, rules: rf.value, ai: f.value });
          fields[k] = { ...rf, confidence: Math.min(rf.confidence, 0.5) };
        } else if (!rf) fields[k] = f;
        else fields[k] = { ...rf, confidence: 0.95, method: 'RULES+LLM' };
      }
    } else notes.push('No AI provider was available; the rule-based extractor was used on its own.');
  }

  const record = assembleRecord(fields, ctx);
  const errors = validateRecord(record);
  const missing = REQUIRED_KEYS.filter((k) => !fields[k]);
  const flags = crossChecks(record);
  return { provider, model, fields, record, schema_errors: errors, schema_valid: errors.length === 0, missing, flags, notes, disagreements, attempts };
}

module.exports = { extractDocument, ground, locate, supports, addLineage, REQUIRED_KEYS };
