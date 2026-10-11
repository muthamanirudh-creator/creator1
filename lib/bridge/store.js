'use strict';
// Persistence for Bridge (PostgreSQL runtime). Every function is scoped by account id.
const db = require('./../db');
const study = require('../study');

const SNAPSHOT_KEEP = 60;

async function getLink(accountId) {
  return (await db.query('SELECT account_id,campus_user_id,campus_email,campus_name,consent_version,linked_at,revoked_at FROM bridge_links WHERE account_id=$1', [accountId])).rows[0] || null;
}
async function saveLink(accountId, { campusUserId, email, name, consentVersion }) {
  const r = await db.query(
    `INSERT INTO bridge_links(account_id,campus_user_id,campus_email,campus_name,consent_version,linked_at,revoked_at)
     VALUES($1,$2,$3,$4,$5,now(),NULL)
     ON CONFLICT(account_id) DO UPDATE SET campus_user_id=EXCLUDED.campus_user_id,campus_email=EXCLUDED.campus_email,campus_name=EXCLUDED.campus_name,consent_version=EXCLUDED.consent_version,linked_at=now(),revoked_at=NULL
     RETURNING account_id,campus_user_id,campus_email,campus_name,consent_version,linked_at,revoked_at`,
    [accountId, campusUserId, email || null, name || null, consentVersion]);
  return r.rows[0];
}
async function revokeLink(accountId) {
  await db.tx(async (c) => {
    await c.query('UPDATE bridge_links SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL', [accountId]);
    await c.query('DELETE FROM bridge_campus_cache WHERE account_id=$1', [accountId]);
  });
}

async function getSettings(accountId) {
  const r = (await db.query('SELECT self_skills,typing_wpm,daily_minutes,resume_claims,updated_at FROM bridge_settings WHERE account_id=$1', [accountId])).rows[0];
  return r || { self_skills: {}, typing_wpm: null, daily_minutes: 120, resume_claims: [], updated_at: null };
}
async function putSettings(accountId, s) {
  const r = await db.query(
    `INSERT INTO bridge_settings(account_id,self_skills,typing_wpm,daily_minutes,resume_claims,updated_at) VALUES($1,$2,$3,$4,$5,now())
     ON CONFLICT(account_id) DO UPDATE SET self_skills=EXCLUDED.self_skills,typing_wpm=EXCLUDED.typing_wpm,daily_minutes=EXCLUDED.daily_minutes,resume_claims=EXCLUDED.resume_claims,updated_at=now()
     RETURNING self_skills,typing_wpm,daily_minutes,resume_claims,updated_at`,
    [accountId, JSON.stringify(s.self_skills || {}), s.typing_wpm == null ? null : s.typing_wpm, s.daily_minutes || 120, JSON.stringify(s.resume_claims || [])]);
  return r.rows[0];
}

async function getCampusCache(accountId) {
  return (await db.query('SELECT evidence,fetched_at FROM bridge_campus_cache WHERE account_id=$1', [accountId])).rows[0] || null;
}
async function putCampusCache(accountId, evidence) {
  await db.query(`INSERT INTO bridge_campus_cache(account_id,evidence,fetched_at) VALUES($1,$2,now()) ON CONFLICT(account_id) DO UPDATE SET evidence=EXCLUDED.evidence,fetched_at=now()`, [accountId, JSON.stringify(evidence)]);
}

async function saveSnapshot(accountId, summary, top) {
  await db.query('INSERT INTO bridge_snapshots(account_id,summary,top) VALUES($1,$2,$3)', [accountId, JSON.stringify(summary), JSON.stringify(top || [])]);
  await db.query('DELETE FROM bridge_snapshots WHERE account_id=$1 AND id NOT IN (SELECT id FROM bridge_snapshots WHERE account_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2)', [accountId, SNAPSHOT_KEEP]);
}
async function listSnapshots(accountId, limit = 30) {
  return (await db.query('SELECT id,summary,top,created_at FROM bridge_snapshots WHERE account_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2', [accountId, Math.min(+limit || 30, SNAPSHOT_KEEP)])).rows.reverse();
}

// GovCareer study-hub evidence for this account: syllabus progress and mock attempts.
async function govcareerEvidence(accountId) {
  const progress = (await db.query(
    `SELECT sn.code,sn.title,sn.description,sp.progress_pct,ev.id exam_version_id
       FROM syllabus_progress sp JOIN syllabus_nodes sn ON sn.id=sp.syllabus_node_id JOIN exam_versions ev ON ev.id=sn.exam_version_id AND ev.status='VERIFIED'
      WHERE sp.account_id=$1`, [accountId])).rows;
  const attempts = (await db.query(
    `SELECT ma.answers,mt.questions,ev.pattern,ev.id exam_version_id
       FROM mock_attempts ma JOIN mock_tests mt ON mt.id=ma.mock_test_id JOIN exam_versions ev ON ev.id=mt.exam_version_id AND ev.status='VERIFIED'
      WHERE ma.account_id=$1 ORDER BY ma.attempted_at DESC LIMIT 20`, [accountId])).rows;
  const reviews = [];
  for (const a of attempts) {
    const qs = Array.isArray(a.questions) ? a.questions : [];
    const byId = new Map(qs.map((q) => [String(q.id), q]));
    const scored = study.scoreAttempt(qs, a.answers, a.pattern || {});
    for (const r of scored.review) { const q = byId.get(String(r.id)) || {}; reviews.push({ label: `${q.origin || ''} ${q.syllabus_code || ''} ${q.topic || ''}`, result: r.result, exam_version_id: a.exam_version_id }); }
  }
  return { progress, reviews };
}

module.exports = { getLink, saveLink, revokeLink, getSettings, putSettings, getCampusCache, putCampusCache, saveSnapshot, listSnapshots, govcareerEvidence, SNAPSHOT_KEEP };
