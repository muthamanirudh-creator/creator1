-- Phase 4: consent-based citizen accounts, watchlists, saved searches, deduplicated alerts,
-- application tracking and ICS calendar subscriptions.
CREATE TABLE citizen_accounts (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  consent_version TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE citizen_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE consent_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('GRANTED','WITHDRAWN')),
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE watchlists (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,recruitment_id)
);
CREATE TABLE saved_searches (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  query TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alert_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  recruitment_id TEXT REFERENCES recruitments(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,dedupe_key)
);
CREATE TABLE notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('IN_APP','EMAIL','PUSH')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENT','FAILED')),
  attempts INT NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(alert_id,channel)
);
CREATE TABLE application_tracker (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'SAVED' CHECK(status IN ('SAVED','PLANNED','APPLIED','ADMIT_CARD','EXAM_DONE','RESULT_AWAITED','SELECTED','NOT_SELECTED','WITHDRAWN')),
  application_number TEXT,
  notes TEXT,
  applied_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,recruitment_id)
);
CREATE TABLE calendar_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX saved_searches_account_idx ON saved_searches(account_id,enabled);
CREATE INDEX alert_events_account_idx ON alert_events(account_id,created_at DESC);
CREATE INDEX notification_queue_idx ON notification_deliveries(status,created_at);
CREATE INDEX application_tracker_account_idx ON application_tracker(account_id,updated_at DESC);
