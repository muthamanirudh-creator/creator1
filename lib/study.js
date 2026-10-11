// Phase 5 pure logic (no DB): question labelling, scoring, planning, progress parsing, syllabus-grounded tutor.
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- questions: origin must be declared; AI-generated is always labelled; PYQs need a legal basis ----------
const ORIGINS = ['PREVIOUS_YEAR', 'AI_GENERATED', 'EDITORIAL'];
const LEGAL_BASIS = ['OFFICIAL_PUBLIC', 'LICENSED', 'PERMISSION'];
const LABELS = {
  AI_GENERATED: 'AI-generated practice question — not from an official paper',
  EDITORIAL: 'Practice question written by our editors',
};
function questionLabel(q) {
  if (q.origin === 'PREVIOUS_YEAR') return `Previous-year question — ${q.source_ref}`;
  return LABELS[q.origin] || 'Origin not recorded — do not treat as an official question';
}
function validateQuestions(qs) {
  const errors = []; const ids = new Set();
  if (!Array.isArray(qs) || !qs.length) return { ok: false, errors: ['questions must be a non-empty array'] };
  qs.forEach((q, i) => {
    const at = `question ${i + 1}`;
    if (q == null || typeof q !== 'object') return errors.push(`${at}: not an object`);
    if (q.id == null || q.id === '') errors.push(`${at}: missing id`); else if (ids.has(String(q.id))) errors.push(`${at}: duplicate id ${q.id}`); else ids.add(String(q.id));
    if (typeof q.text !== 'string' || !q.text.trim()) errors.push(`${at}: missing text`);
    if (q.answer == null || String(q.answer) === '') errors.push(`${at}: missing answer key`);
    if (!ORIGINS.includes(q.origin)) errors.push(`${at}: origin must be one of ${ORIGINS.join(', ')}`);
    if (q.origin === 'PREVIOUS_YEAR') {
      if (!q.source_ref) errors.push(`${at}: previous-year question needs source_ref`);
      if (!LEGAL_BASIS.includes(q.legal_basis)) errors.push(`${at}: previous-year question needs legal_basis (${LEGAL_BASIS.join(', ')})`);
    }
  });
  return { ok: !errors.length, errors };
}
// What a learner may see BEFORE attempting: no answer key, no explanation, always a label.
function publicQuestions(qs) {
  return (Array.isArray(qs) ? qs : []).map((q) => { const { answer, explanation, legal_basis, ...rest } = q; return { ...rest, label: questionLabel(q), ai_generated: q.origin === 'AI_GENERATED' }; });
}

// ---------- scoring ----------
function scoreAttempt(questions, answers, pattern = {}) {
  const neg = Number.isFinite(Number(pattern.negative_marking)) && pattern.negative_marking >= 0 && pattern.negative_marking <= 1 ? Number(pattern.negative_marking) : 0;
  const a = answers && typeof answers === 'object' ? answers : {};
  let correct = 0, wrong = 0, unanswered = 0, unkeyed = 0; const review = [];
  for (const q of Array.isArray(questions) ? questions : []) {
    if (q.answer == null || String(q.answer) === '') { unkeyed++; continue; } // cannot be marked: excluded, never counted correct
    const given = a[q.id]; const has = given != null && String(given) !== '';
    const ok = has && String(given) === String(q.answer);
    if (!has) unanswered++; else if (ok) correct++; else wrong++;
    review.push({ id: q.id, given: has ? String(given) : null, correct_answer: String(q.answer), result: !has ? 'UNANSWERED' : ok ? 'CORRECT' : 'WRONG', explanation: q.explanation || null, label: questionLabel(q) });
  }
  const total = correct + wrong + unanswered; const marks = Math.round((correct - wrong * neg) * 100) / 100;
  return { total, correct, wrong, unanswered, unkeyed, negative_marking: neg, marks, score: total ? Math.round(marks / total * 10000) / 100 : 0, review };
}

// ---------- progress ----------
function parseProgress(v) {
  if (!(typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())))) throw bad('progress_pct must be a number from 0 to 100');
  const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) throw bad('progress_pct must be a number from 0 to 100');
  const pct = Math.round(n); return { pct, status: pct >= 100 ? 'MASTERED' : pct > 0 ? 'IN_PROGRESS' : 'NOT_STARTED' };
}

// ---------- study plan ----------
const MAX_DAYS = 366;
function parseDate(s, name) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${name} must be YYYY-MM-DD`);
  const d = new Date(s + 'T00:00:00Z'); if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`${name} is not a real calendar date`); return d;
}
// Leaves only (parents are headings, not extra work); topics the learner mastered are skipped; remainder spread evenly.
function buildPlan(nodes, startDate, targetDate, dailyMinutes, progress = {}) {
  const start = parseDate(startDate, 'start_date'), end = parseDate(targetDate, 'target_date');
  if (start > end) throw bad('target_date must be on or after start_date');
  if (!Number.isFinite(dailyMinutes) || dailyMinutes < 15 || dailyMinutes > 720) throw bad('daily_minutes must be between 15 and 720');
  const days = Math.round((end - start) / 86400000) + 1; if (days > MAX_DAYS) throw bad(`plan length is limited to ${MAX_DAYS} days`);
  const parents = new Set(nodes.map((n) => n.parent_id).filter((x) => x != null));
  const todo = nodes.filter((n) => !parents.has(n.id) && (progress[n.id] || 'NOT_STARTED') !== 'MASTERED');
  const base = Math.floor(todo.length / days), extra = todo.length % days; let at = 0; const plan = [];
  for (let i = 0; i < days; i++) {
    const n = base + (i < extra ? 1 : 0); if (!n) continue;
    plan.push({ date: new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10), minutes: dailyMinutes, topics: todo.slice(at, at + n).map((x) => x.id) }); at += n;
  }
  return plan;
}
function planWarnings(plan, dailyMinutes) {
  const w = []; const heaviest = Math.max(0, ...plan.map((p) => p.topics.length));
  if (heaviest && dailyMinutes / heaviest < 10) w.push(`Up to ${heaviest} topics a day leaves under 10 minutes each; extend the target date or add study time.`);
  if (!plan.length) w.push('Nothing left to schedule: every topic is marked mastered, or the syllabus has no topics.');
  return w;
}

// ---------- tutor: answers only from the pinned syllabus version ----------
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function findNode(nodes, topic, question) {
  const t = norm(topic); if (t) { const x = nodes.find((n) => norm(n.title) === t || norm(n.code) === t); if (x) return x; }
  const q = norm(question); let best = null;
  for (const n of nodes) { const title = norm(n.title); if (title.length >= 3 && q.includes(title) && (!best || title.length > norm(best.title).length)) best = n; }
  return best;
}
const cite = (n) => ({ syllabus_node_id: n.id, code: n.code, title: n.title, page: n.source_page ?? null, source_ref: n.source_ref ?? null, page_recorded: n.source_page != null });
function tutorAnswer({ version, nodes, otherVersions = [], topic, question }) {
  const pin = { id: version.id, name: version.name, recruitment_year: version.recruitment_year, syllabus_version: version.syllabus_version };
  const node = findNode(nodes, topic, question);
  if (!node) {
    const elsewhere = otherVersions.map((o) => ({ v: o, n: findNode(o.nodes, topic, question) })).filter((x) => x.n);
    if (elsewhere.length) return { status: 'NOT_IN_THIS_VERSION', exam_version: pin, question, answer: `This topic is not listed in the ${version.recruitment_year} syllabus (version ${version.syllabus_version}). It appears in: ${elsewhere.map((x) => `${x.v.recruitment_year} (version ${x.v.syllabus_version})`).join(', ')}. Syllabi differ by year, so switch versions deliberately if you want that one.`, citations: [] };
    return { status: 'NOT_IN_SYLLABUS', exam_version: pin, question, answer: `The ${version.recruitment_year} syllabus (version ${version.syllabus_version}) does not list this topic.`, citations: [] };
  }
  const kids = nodes.filter((n) => n.parent_id === node.id).sort((a, b) => a.sort_order - b.sort_order);
  const trail = []; for (let p = node; p; p = nodes.find((n) => n.id === p.parent_id)) trail.unshift(p.title);
  const lines = [`In the ${version.recruitment_year} syllabus (version ${version.syllabus_version}), "${node.title}"${trail.length > 1 ? ` (under ${trail.slice(0, -1).join(' › ')})` : ''} ${node.description ? `is described as: ${node.description}` : 'is listed without further description.'}`];
  if (kids.length) lines.push(`Subtopics listed: ${kids.map((k) => k.title).join('; ')}.`);
  const citations = [cite(node), ...kids.map(cite)];
  if (citations.some((c) => !c.page_recorded)) lines.push('Some page references are not recorded for this version.');
  return { status: 'ANSWERED', exam_version: pin, question, answer: lines.join(' '), scope_notice: 'This states what the official syllabus lists. It does not teach the subject.', citations };
}

module.exports = { ORIGINS, LEGAL_BASIS, validateQuestions, publicQuestions, questionLabel, scoreAttempt, parseProgress, buildPlan, planWarnings, parseDate, tutorAnswer, findNode, MAX_DAYS };
