// Read side of the live feed and the freshness/status report. Public facts only: published records, official links and
// source health. Nothing here is generated or guessed.
const KIND_EVENT = { NEW_NOTIFICATION: 'job.new', DEADLINE_EXTENDED: 'deadline.extended', AMENDED: 'job.amended', DETECTED_UNVERIFIED: 'job.detected', RETRACTED: 'job.retracted' };
const toEvent = (r) => ({ id: Number(r.id), kind: r.kind, recruitment_id: r.recruitment_id, title: r.title, organization: r.organization, payload: r.payload || {}, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at });

async function recent(db, { since = 0, limit = 30, kinds } = {}) {
  limit = Math.min(100, Math.max(1, Number(limit) || 30));
  const rows = (await db.query(`SELECT id,kind,recruitment_id,title,organization,payload,created_at FROM feed_events WHERE id > $1 AND ($2::text[] IS NULL OR kind = ANY($2)) ORDER BY id DESC LIMIT $3`, [Number(since) || 0, kinds && kinds.length ? kinds : null, limit])).rows;
  return rows.map(toEvent);
}
async function maxId(db) { return Number((await db.query('SELECT COALESCE(MAX(id),0) m FROM feed_events')).rows[0].m); }

async function status(db, env = process.env) {
  const agg = (await db.query(`SELECT
      count(*) FILTER (WHERE verification_status='VERIFIED' AND crawl_enabled)::int AS monitored,
      count(*) FILTER (WHERE verification_status='PENDING_VERIFICATION')::int AS pending_verification,
      count(*) FILTER (WHERE verification_status='VERIFIED' AND crawl_enabled AND health='ONLINE')::int AS online,
      count(*) FILTER (WHERE cooldown_until > now())::int AS cooling_down,
      max(last_success_at) AS last_success_at, max(last_checked_at) AS last_checked_at,
      min(crawl_frequency_minutes) FILTER (WHERE crawl_enabled) AS interval_minutes
    FROM sources WHERE source_type NOT IN ('DEMO','MANUAL_UPLOAD')`)).rows[0];
  const sources = (await db.query(`SELECT source_id, organization, health, verification_status, auto_verified, crawl_enabled, crawl_frequency_minutes, last_success_at, last_checked_at, cooldown_until, left(coalesce(last_error, auto_verify_note, ''),140) AS note
    FROM sources WHERE source_type NOT IN ('DEMO','MANUAL_UPLOAD') ORDER BY organization`)).rows;
  const q = (await db.query(`SELECT status, count(*)::int n FROM job_queue WHERE status IN ('PENDING','RUNNING','FAILED') GROUP BY status`)).rows;
  const f = (await db.query(`SELECT kind, count(*)::int n FROM feed_events WHERE created_at > now() - interval '7 days' GROUP BY kind`)).rows;
  const awaiting = (await db.query(`SELECT count(*)::int n FROM recruitments WHERE NOT is_sample AND published_at IS NOT NULL AND verification->>'level'='AUTO_EXTRACTED' AND lifecycle<>'ARCHIVED'`)).rows[0].n;
  const review = (await db.query(`SELECT count(*)::int n FROM review_items WHERE status='OPEN'`)).rows[0].n;
  const channels = ['TELEGRAM', 'DISCORD', 'EMAIL'].filter((c) => ({ TELEGRAM: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID, DISCORD: env.DISCORD_WEBHOOK_URL, EMAIL: env.RESEND_API_KEY && env.EMAIL_FROM && env.EMAIL_BROADCAST_TO }[c]));
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    now: new Date().toISOString(),
    sources: { monitored: agg.monitored, online: agg.online, pending_verification: agg.pending_verification, cooling_down: agg.cooling_down },
    freshness: {
      last_successful_check: iso(agg.last_success_at), last_check: iso(agg.last_checked_at), interval_minutes: agg.interval_minutes,
      note: 'Official sources are checked on a schedule, not instantly. A new notice appears after the next successful check of its source, then after document reading finishes.',
    },
    pipeline: { queue: Object.fromEntries(q.map((x) => [x.status, x.n])), review_open: review, auto_published_awaiting_audit: awaiting, feed_last_7_days: Object.fromEntries(f.map((x) => [x.kind, x.n])) },
    auto_publish: { enabled: env.AUTO_PUBLISH !== '0', min_confidence: Number(env.AUTO_PUBLISH_MIN_CONFIDENCE || 0.85) },
    broadcast_channels: channels,
    per_source: sources.map((s) => ({ ...s, last_success_at: iso(s.last_success_at), last_checked_at: iso(s.last_checked_at), cooldown_until: iso(s.cooldown_until) })),
  };
}

module.exports = { KIND_EVENT, toEvent, recent, maxId, status };
