-- v2.8.2 automatic lane: continuous monitoring, auto-publish of cited official notifications, live feed, broadcast.
-- Everything here is additive. Existing columns, tables and constraints are untouched.

-- Conditional requests (ETag / Last-Modified), failure cool-downs and "last checked" for every source.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS etag TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_modified TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_verify_note TEXT;

-- New sources check every 30 minutes by default instead of every 6 hours. Per-source values are still honoured:
-- only rows that still hold the old default are moved.
ALTER TABLE sources ALTER COLUMN crawl_frequency_minutes SET DEFAULT 30;
UPDATE sources SET crawl_frequency_minutes = 30 WHERE crawl_frequency_minutes = 360;

-- Persistent "what is new" feed. One row per real event; dedupe_key makes repeated runs idempotent.
-- The server polls this table, so events written by a separate worker process still reach every open browser.
CREATE TABLE IF NOT EXISTS feed_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('NEW_NOTIFICATION','AMENDED','DEADLINE_EXTENDED','DETECTED_UNVERIFIED','RETRACTED')),
  recruitment_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT,
  organization TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_events_recent_idx ON feed_events(id DESC);
CREATE INDEX IF NOT EXISTS feed_events_recruitment_idx ON feed_events(recruitment_id);

-- Channel broadcast (Telegram channel, Discord webhook, e-mail API). One row per (event, channel): never sent twice.
CREATE TABLE IF NOT EXISTS broadcast_log (
  id BIGSERIAL PRIMARY KEY,
  feed_event_id BIGINT NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','SKIPPED')),
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (feed_event_id, channel)
);
CREATE INDEX IF NOT EXISTS broadcast_log_due_idx ON broadcast_log(status, next_attempt_at);
