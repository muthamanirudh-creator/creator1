-- v2.10.0 national coverage + instant push. Additive only: no existing column, table or constraint is changed.

-- Source tiers (how often an official page is checked), region and the domain-guard verdict.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS priority_tier INT NOT NULL DEFAULT 3;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS domain_status TEXT NOT NULL DEFAULT 'UNCHECKED';   -- UNCHECKED | OK | CORRECTED | REVIEW
ALTER TABLE sources ADD COLUMN IF NOT EXISTS domain_note TEXT;
CREATE INDEX IF NOT EXISTS sources_state_idx ON sources(state);

-- Web Push (browser / phone notifications that arrive even when the site is closed).
-- No account is required: a subscription is just a browser endpoint plus what the person wants to hear about.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  states TEXT[] NOT NULL DEFAULT '{}',                -- empty = every State and UT
  kinds TEXT[] NOT NULL DEFAULT '{NEW_NOTIFICATION,DEADLINE_EXTENDED,AMENDED}',
  include_unverified BOOLEAN NOT NULL DEFAULT FALSE,   -- "detected, not yet verified" items are opt-in and always labelled
  include_central BOOLEAN NOT NULL DEFAULT TRUE,       -- All-India (central) recruiters
  lang TEXT NOT NULL DEFAULT 'en',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failures INT NOT NULL DEFAULT 0,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_active_idx ON push_subscriptions(active);

-- One row per (feed event, subscription): an event is pushed at most once to a browser, failures retry with back-off,
-- and a row is SENT only when the push service accepted it.
CREATE TABLE IF NOT EXISTS push_log (
  id BIGSERIAL PRIMARY KEY,
  feed_event_id BIGINT NOT NULL,
  subscription_id BIGINT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','GONE')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS push_log_queue_idx ON push_log(status, next_attempt_at);

-- VAPID key pair, generated once when none is supplied through the environment (so push works without manual setup).
CREATE TABLE IF NOT EXISTS push_vapid (
  id INT PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
