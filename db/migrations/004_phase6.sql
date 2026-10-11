CREATE TABLE IF NOT EXISTS user_documents (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','DELETED')),
  purpose TEXT NOT NULL DEFAULT 'ELIGIBILITY_REVIEW',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_documents_account_idx ON user_documents(account_id, created_at DESC);
CREATE TABLE IF NOT EXISTS privacy_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES citizen_accounts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  purpose TEXT,
  policy_version TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_preferences (
  account_id BIGINT PRIMARY KEY REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','hi','bn','te','mr','ta','gu','kn','ml','pa','or')),
  voice_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lineage_events (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  source_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lineage_entity_idx ON lineage_events(entity_type, entity_id, created_at);
CREATE TABLE IF NOT EXISTS extraction_benchmarks (
  id BIGSERIAL PRIMARY KEY,
  fixture TEXT NOT NULL,
  field TEXT NOT NULL,
  expected JSONB,
  actual JSONB,
  correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
