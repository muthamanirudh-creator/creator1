'use strict';
// Campus side of the GovCareer Bridge.
//
// Two-sided consent: Campus keeps its OWN record of the link (in PortalKV, so no schema migration is needed).
// Profile data is released only while that record exists, is not revoked, and names the same GovCareer
// account that is asking. The student can revoke from either side; either revocation stops the data flow.
//
// All functions take their dependencies (prisma, secret, clock) as arguments so they can be unit-tested
// without a database or HTTP server. src/routes/bridgeSource.js is a thin Express adapter.
const serviceAuth = require('./bridgeServiceAuth');

const SCOPE = 'bridge';
const KEY = 'govcareer-link';
const RESULT_TYPES = ['INTERVIEW', 'MIRROR_MENTOR', 'QUIZ', 'RESUME_ANALYSIS'];
const MAX_RESULTS = 60;

const kvWhere = (userId) => ({ scope: SCOPE, key: KEY, ownerId: userId });

async function readLink(prisma, userId) {
  const row = await prisma.portalKV.findFirst({ where: kvWhere(userId) });
  return row ? { id: row.id, ...(row.value || {}) } : null;
}

function publicLink(link) {
  if (!link) return { linked: false };
  return {
    linked: !link.revokedAt,
    govcareer_account_id: link.accountId,
    consent_version: link.consentVersion,
    linked_at: link.linkedAt,
    revoked_at: link.revokedAt || null,
  };
}

// Verifies the server-to-server signature for a request already authenticated as `userId`.
function checkService({ secret, method, path, accountId, userId, body, headers, now }) {
  return serviceAuth.verify(secret, { method, path, accountId, userId, body: body ? JSON.stringify(body) : '' }, headers || {}, now);
}

async function status({ prisma, userId }) {
  return { status: 200, body: publicLink(await readLink(prisma, userId)) };
}

async function link({ prisma, userId, accountId, body, now = new Date() }) {
  if (!accountId || !/^\d{1,18}$/.test(String(accountId))) return { status: 400, body: { error: 'A GovCareer account id is required.' } };
  const consentVersion = String((body && body.consent_version) || '').slice(0, 40);
  if (!consentVersion) return { status: 400, body: { error: 'consent_version is required.' } };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { status: 404, body: { error: 'Account no longer exists.' } };
  const existing = await readLink(prisma, userId);
  if (existing && !existing.revokedAt && String(existing.accountId) !== String(accountId)) {
    return { status: 409, body: { error: 'This Campus account is already linked to a different GovCareer account. Unlink it first.', code: 'CAMPUS_ALREADY_LINKED' } };
  }
  const value = { accountId: String(accountId), consentVersion, linkedAt: now.toISOString(), revokedAt: null };
  await prisma.portalKV.upsert({
    where: { scope_key_ownerId: kvWhere(userId) },
    update: { value },
    create: { ...kvWhere(userId), value },
  });
  return { status: 201, body: { ...publicLink({ ...value }), campus_user: { id: user.id, name: user.name, email: user.email } } };
}

async function unlink({ prisma, userId, now = new Date() }) {
  const existing = await readLink(prisma, userId);
  if (!existing) return { status: 200, body: { linked: false } };
  const value = { accountId: existing.accountId, consentVersion: existing.consentVersion, linkedAt: existing.linkedAt, revokedAt: now.toISOString() };
  await prisma.portalKV.update({ where: { id: existing.id }, data: { value } });
  return { status: 200, body: publicLink(value) };
}

// ---- profile -------------------------------------------------------------------------------------
function resumeSkillNames(results) {
  const names = new Set();
  for (const r of results) {
    if (r.type !== 'RESUME_ANALYSIS' || !r.payload || typeof r.payload !== 'object') continue;
    for (const key of ['skills', 'resumeSkills', 'matchedSkills', 'matched_skills', 'skillsFound']) {
      const v = r.payload[key];
      if (!Array.isArray(v)) continue;
      for (const x of v) { const s = typeof x === 'string' ? x : x && (x.skill || x.name); if (s) names.add(String(s).slice(0, 60)); }
    }
  }
  return [...names].slice(0, 80);
}

function shapeProfile({ user, attempted, correct, competencies, results, now }) {
  const key = (r) => `${r.qGroup || ''}\u0000${r.topic || ''}`;
  const topics = new Map();
  for (const r of attempted) topics.set(key(r), { group: r.qGroup || null, topic: r.topic || null, attempted: r._count._all, correct: 0 });
  for (const r of correct) { const t = topics.get(key(r)); if (t) t.correct = Math.min(t.attempted, r._count._all); }
  const list = [...topics.values()];
  return {
    schema: 'bridge-source/1',
    generated_at: now.toISOString(),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch || null, graduationYear: user.graduationYear || null },
    aptitude: {
      stats: { attempted: list.reduce((s, t) => s + t.attempted, 0), correct: list.reduce((s, t) => s + t.correct, 0) },
      topics: list,
    },
    competencies,
    // Summaries only: the full saved payloads stay in Campus.
    results: results.map((r) => ({ type: r.type, topic: r.topic, summaryScore: r.summaryScore, createdAt: r.createdAt })),
    resume_skills: resumeSkillNames(results),
  };
}

async function profile({ prisma, userId, accountId, now = new Date() }) {
  const lk = await readLink(prisma, userId);
  if (!lk || lk.revokedAt) return { status: 403, body: { error: 'This Campus account is not linked to GovCareer (or the link was revoked).', code: 'BRIDGE_NOT_LINKED' } };
  if (String(lk.accountId) !== String(accountId)) return { status: 403, body: { error: 'This Campus account is linked to a different GovCareer account.', code: 'BRIDGE_ACCOUNT_MISMATCH' } };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { status: 404, body: { error: 'Account no longer exists.' } };
  const [attempted, correct, comps, results] = await Promise.all([
    prisma.aptitudeAttempt.groupBy({ by: ['qGroup', 'topic'], where: { userId, attempted: true }, _count: { _all: true } }),
    prisma.aptitudeAttempt.groupBy({ by: ['qGroup', 'topic'], where: { userId, correct: true }, _count: { _all: true } }),
    prisma.studentCompetency.findMany({ where: { userId }, include: { skill: { select: { name: true, category: true } } }, orderBy: { updatedAt: 'desc' }, take: 200 }),
    prisma.result.findMany({ where: { userId, type: { in: RESULT_TYPES } }, orderBy: { createdAt: 'desc' }, take: MAX_RESULTS }),
  ]);
  const competencies = comps.map((c) => ({
    skillName: c.skill.name, category: c.skill.category, pKnow: c.pKnow, level: c.level, masteryStatus: c.masteryStatus,
    questionsAnswered: c.questionsAnswered, lastPracticedAt: c.lastPracticedAt,
  }));
  return { status: 200, body: shapeProfile({ user, attempted, correct, competencies, results, now }) };
}

module.exports = { status, link, unlink, profile, checkService, shapeProfile, resumeSkillNames, publicLink, SCOPE, KEY };
