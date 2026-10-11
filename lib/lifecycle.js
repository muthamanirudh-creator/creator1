// Recruitment lifecycle state machine. Legal transitions are enforced here, in code.
const db = require('./db');
const { audit } = require('./audit');

const STATES = ['DISCOVERED', 'INGESTED', 'EXTRACTED', 'VALIDATING', 'REVIEW_REQUIRED', 'VERIFIED', 'PUBLISHED', 'UPDATED', 'APPLICATION_CLOSED', 'EXAM_PHASE', 'RESULT_PHASE', 'ARCHIVED'];

const TRANSITIONS = {
  DISCOVERED: ['INGESTED', 'ARCHIVED'],
  INGESTED: ['EXTRACTED', 'REVIEW_REQUIRED', 'ARCHIVED'],
  EXTRACTED: ['VALIDATING', 'REVIEW_REQUIRED'],
  VALIDATING: ['REVIEW_REQUIRED'],            // nothing is auto-verified: a person approves
  REVIEW_REQUIRED: ['VERIFIED', 'ARCHIVED'],
  VERIFIED: ['PUBLISHED', 'REVIEW_REQUIRED'],
  PUBLISHED: ['UPDATED', 'APPLICATION_CLOSED', 'ARCHIVED'],
  UPDATED: ['REVIEW_REQUIRED', 'PUBLISHED', 'APPLICATION_CLOSED'],
  APPLICATION_CLOSED: ['EXAM_PHASE', 'UPDATED', 'ARCHIVED'],
  EXAM_PHASE: ['RESULT_PHASE', 'UPDATED', 'ARCHIVED'],
  RESULT_PHASE: ['ARCHIVED'],
  ARCHIVED: [],
};

// States whose data is visible to the public.
const PUBLIC_STATES = ['PUBLISHED', 'UPDATED', 'APPLICATION_CLOSED', 'EXAM_PHASE', 'RESULT_PHASE'];

// Only a signed-in human may move a record into these states.
const HUMAN_ONLY = ['VERIFIED', 'PUBLISHED'];

function canTransition(from, to) { return (TRANSITIONS[from] || []).includes(to); }

class IllegalTransition extends Error {
  constructor(from, to) { super(`Illegal lifecycle transition ${from} -> ${to}`); this.code = 'ILLEGAL_TRANSITION'; }
}

// actor = { type: 'human'|'agent'|'system', name }
async function transition(recruitmentId, to, actor, reason = '', client) {
  const run = async (c) => {
    const row = (await c.query('SELECT lifecycle FROM recruitments WHERE id=$1 FOR UPDATE', [recruitmentId])).rows[0];
    if (!row) throw new Error(`Unknown recruitment ${recruitmentId}`);
    if (!canTransition(row.lifecycle, to)) throw new IllegalTransition(row.lifecycle, to);
    // Agents can never verify or publish. The ONE exception is the named auto-publish policy (lib/autopublish.js), which is
    // gated by its own evidence rules and can be switched off with AUTO_PUBLISH=0. Its records are labelled AUTO_EXTRACTED.
    const policyOk = actor.type === 'policy' && actor.name === 'auto-publish' && process.env.AUTO_PUBLISH !== '0';
    if (HUMAN_ONLY.includes(to) && actor.type !== 'human' && !policyOk) {
      const e = new Error(`Only a signed-in reviewer can move a recruitment to ${to}`); e.code = 'HUMAN_ONLY'; throw e;
    }
    await c.query('UPDATE recruitments SET lifecycle=$2, updated_at=now() WHERE id=$1', [recruitmentId, to]);
    await c.query('INSERT INTO lifecycle_events(recruitment_id,from_state,to_state,actor,reason) VALUES ($1,$2,$3,$4,$5)',
      [recruitmentId, row.lifecycle, to, `${actor.type}:${actor.name}`, reason]);
    await audit(`${actor.type}:${actor.name}`, 'LIFECYCLE', 'recruitment', recruitmentId, { from: row.lifecycle, to, reason }, c);
    return { from: row.lifecycle, to };
  };
  return client ? run(client) : db.tx(run);
}

// Date-driven progress for published records (run by a worker).
async function advanceByDates(now = new Date()) {
  const rows = (await db.query("SELECT id, lifecycle, data FROM recruitments WHERE lifecycle IN ('PUBLISHED','UPDATED','APPLICATION_CLOSED','EXAM_PHASE') AND data IS NOT NULL AND NOT is_sample")).rows;
  const moved = [];
  for (const r of rows) {
    const close = r.data.dates && r.data.dates.application_close && new Date(r.data.dates.application_close);
    const exam = r.data.dates && r.data.dates.exam_date && new Date(r.data.dates.exam_date + 'T23:59:59+05:30');
    const sys = { type: 'system', name: 'lifecycle-clock' };
    if (['PUBLISHED', 'UPDATED'].includes(r.lifecycle) && close && now > close) {
      await transition(r.id, 'APPLICATION_CLOSED', sys, 'Application deadline passed'); moved.push([r.id, 'APPLICATION_CLOSED']);
      r.lifecycle = 'APPLICATION_CLOSED';
    }
    if (r.lifecycle === 'APPLICATION_CLOSED' && exam && now > exam) {
      await transition(r.id, 'EXAM_PHASE', sys, 'Exam date passed'); moved.push([r.id, 'EXAM_PHASE']);
    }
  }
  return moved;
}

module.exports = { STATES, TRANSITIONS, PUBLIC_STATES, HUMAN_ONLY, canTransition, transition, advanceByDates, IllegalTransition };
