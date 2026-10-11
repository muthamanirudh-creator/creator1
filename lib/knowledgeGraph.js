// Phase 3: knowledge graph for multi-hop questions. Nodes/edges are derived only from published records;
// answers are job ids plus the traversal path that justifies them (no figures are generated here).
const LEVELS = ['8th', '10th', '12th', 'iti', 'diploma', 'bachelor', 'master', 'phd'];
const ORDER = { '8th': 0, '10th': 1, '12th': 2, iti: 2, diploma: 3, bachelor: 4, master: 5, phd: 6 };

function buildGraph(jobs) {
  const nodes = new Map(), edges = [], seen = new Set();
  const add = (id, type, label) => { if (!nodes.has(id)) nodes.set(id, { id, type, label }); return id; };
  const link = (from, to, label) => { const k = `${from}|${label}|${to}`; if (!seen.has(k)) { seen.add(k); edges.push({ from, to, label }); } };
  for (const j of jobs) {
    const J = add(`job:${j.id}`, 'job', j.title);
    link(J, add(`org:${j.organization}`, 'organization', j.organization), 'OFFERED_BY');
    link(J, add(`state:${j.state}`, 'state', j.state), 'LOCATED_IN');
    link(J, add(`domain:${j.domain}`, 'domain', j.domain), 'IN_DOMAIN');
    for (const lv of j.education?.accepted || []) link(J, add(`edu:${lv}`, 'education', lv), 'ACCEPTS');
    for (const st of j.selection || []) link(J, add(`stage:${st.toLowerCase()}`, 'stage', st), 'HAS_STAGE');
    if (j.physical) link(J, add('feature:physical-test', 'feature', 'physical standards'), 'REQUIRES');
    if (j.dates?.exam_date) link(J, add('feature:has-exam-date', 'feature', 'exam date published'), 'HAS');
  }
  return { nodes: [...nodes.values()], edges };
}

const idx = (g) => { const m = new Map(); for (const e of g.edges) { (m.get(e.from) || m.set(e.from, []).get(e.from)).push({ to: e.to, label: e.label, dir: 'out' }); (m.get(e.to) || m.set(e.to, []).get(e.to)).push({ to: e.from, label: e.label, dir: 'in' }); } return m; };

function queryGraph(graph, terms) {
  const q = String(terms || '').toLowerCase();
  const ids = new Set(graph.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
  const related = graph.edges.filter((e) => ids.has(e.from) || ids.has(e.to));
  return { nodes: graph.nodes.filter((n) => ids.has(n.id) || related.some((e) => e.from === n.id || e.to === n.id)), edges: related };
}

// Shortest path between two nodes (BFS). Used for "how is X related to Y" questions.
function shortestPath(graph, from, to) {
  const m = idx(graph); const prev = new Map([[from, null]]); const q = [from];
  while (q.length) { const n = q.shift(); if (n === to) break; for (const e of m.get(n) || []) if (!prev.has(e.to)) { prev.set(e.to, { n, label: e.label, dir: e.dir }); q.push(e.to); } }
  if (!prev.has(to)) return null;
  const path = []; let cur = to; while (prev.get(cur)) { const p = prev.get(cur); path.unshift({ from: p.n, to: cur, label: p.label, dir: p.dir }); cur = p.n; }
  return path;
}

// Multi-hop constraint query: intersect job sets reached through each constraint hop.
function constraintQuery(graph, c) {
  const m = idx(graph); const jobs = graph.nodes.filter((n) => n.type === 'job').map((n) => n.id);
  const reach = (nodeId) => new Set((m.get(nodeId) || []).filter((e) => e.to.startsWith('job:')).map((e) => e.to));
  let set = new Set(jobs); const hops = [];
  const apply = (nodeId, label) => { if (!graph.nodes.some((n) => n.id === nodeId)) { set = new Set(); hops.push({ via: label, node: nodeId, found: 0 }); return; } const r = reach(nodeId); set = new Set([...set].filter((j) => r.has(j))); hops.push({ via: label, node: nodeId, found: r.size }); };
  if (c.domain) apply(`domain:${c.domain}`, 'IN_DOMAIN');
  if (c.state) { const allIndia = reach('state:All India'), st = reach(`state:${c.state}`); set = new Set([...set].filter((j) => allIndia.has(j) || st.has(j))); hops.push({ via: 'LOCATED_IN', node: `state:${c.state} or All India`, found: st.size + allIndia.size }); }
  if (c.organization) apply(`org:${c.organization}`, 'OFFERED_BY');
  if (c.education) { // accepts the stated level, or anything at/below it for "or higher" is NOT assumed here; exact ACCEPTS edge only.
    apply(`edu:${c.education}`, 'ACCEPTS'); }
  if (c.stage) apply(`stage:${c.stage.toLowerCase()}`, 'HAS_STAGE');
  if (c.physical) apply('feature:physical-test', 'REQUIRES');
  const title = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return { jobs: [...set].map((id) => ({ id: id.slice(4), title: title.get(id) })), path: hops };
}

// Parse a natural multi-hop question into constraints (deterministic; shares vocabulary with search.js).
function questionToConstraints(q, graph) {
  const text = String(q || '').toLowerCase(); const c = {};
  for (const n of graph.nodes) {
    if (n.type === 'domain' && new RegExp(`\\b${n.label.replace('-', '[ -]')}\\b`).test(text)) c.domain = n.label;
    if (n.type === 'state' && n.label !== 'All India' && text.includes(n.label.toLowerCase())) c.state = n.label;
    if (n.type === 'organization' && text.includes(n.label.toLowerCase())) c.organization = n.label;
    if (n.type === 'stage' && text.includes(n.label.toLowerCase())) c.stage = n.label;
  }
  if (/\b(railway|rrb)\b/.test(text)) c.domain = c.domain || 'railway';
  if (/\bpolice\b/.test(text)) c.domain = c.domain || 'police';
  if (/\bssc\b/.test(text)) c.domain = c.domain || 'ssc';
  const edu = [[/\b(graduate|degree|bachelor)/, 'bachelor'], [/\b(diploma)/, 'diploma'], [/\bitI\b|\biti\b/, 'iti'], [/\b(12th|intermediate)/, '12th'], [/\b(10th|matric)/, '10th']].find(([re]) => re.test(text));
  if (edu) c.education = edu[1];
  if (/\bphysical\b/.test(text)) c.physical = true;
  return c;
}

function answerGraphQuestion(graph, q) {
  const c = questionToConstraints(q, graph);
  if (!Object.keys(c).length) return { understood: false, constraints: {}, jobs: [], path: [], note: 'No graph-answerable constraint found.' };
  return { understood: true, constraints: c, ...constraintQuery(graph, c) };
}

module.exports = { buildGraph, queryGraph, shortestPath, constraintQuery, questionToConstraints, answerGraphQuestion, LEVELS, ORDER };
