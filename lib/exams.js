const db = require('./db');
const study = require('./study');

const buildPlan = study.buildPlan;
async function version(id) {
  return (await db.query(`SELECT ev.*,e.code,e.name,e.organization FROM exam_versions ev JOIN exams e ON e.id=ev.exam_id WHERE ev.id=$1 AND ev.status='VERIFIED'`, [id])).rows[0];
}
const nodesOf = async (versionId) => (await db.query('SELECT id,parent_id,code,title,description,sort_order,source_page,source_ref FROM syllabus_nodes WHERE exam_version_id=$1 ORDER BY sort_order,id', [versionId])).rows;
function nest(rows) {
  const by = new Map(rows.map((r) => [r.id, { ...r, children: [] }])); const roots = [];
  for (const n of by.values()) { if (n.parent_id && by.has(n.parent_id)) by.get(n.parent_id).children.push(n); else roots.push(n); }
  return roots;
}
// Callers must pass a verified version id; DRAFT/RETIRED trees are never served.
async function tree(examVersionId) { if (!(await version(examVersionId))) return null; return nest(await nodesOf(examVersionId)); }
// Tutor: pinned to one verified version; a topic that only exists in another year's syllabus is reported as such, never answered from it.
async function tutor(examVersionId, topic, question) {
  const v = await version(examVersionId); if (!v) throw Object.assign(new Error('Verified exam version not found'), { status: 404 });
  const others = (await db.query(`SELECT id,recruitment_year,syllabus_version FROM exam_versions WHERE exam_id=$1 AND id<>$2 AND status='VERIFIED'`, [v.exam_id, v.id])).rows;
  for (const o of others) o.nodes = await nodesOf(o.id);
  return study.tutorAnswer({ version: v, nodes: await nodesOf(v.id), otherVersions: others, topic, question: question || '' }); // returns syllabus citations
}
module.exports = { buildPlan, version, tree, tutor, nodesOf };
