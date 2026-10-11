-- v2.9.0 trust & evidence layer. Additive only: no existing table, column or constraint is changed or dropped.

-- WHO confirmed WHICH critical field, at WHAT value, against WHICH page and quote of WHICH preserved document. Append-only.
CREATE TABLE IF NOT EXISTS field_verifications (
  id BIGSERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  version_no INT,
  field TEXT NOT NULL,
  value JSONB,
  value_hash TEXT NOT NULL,
  evidence JSONB NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL DEFAULT 'HUMAN_CONFIRMATION',
  note TEXT
);
CREATE INDEX IF NOT EXISTS field_verifications_rec_idx ON field_verifications(recruitment_id, field, id DESC);
DROP TRIGGER IF EXISTS field_verifications_no_change ON field_verifications;
CREATE TRIGGER field_verifications_no_change BEFORE UPDATE OR DELETE ON field_verifications FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Hash-chained history of every trust-relevant event. Append-only (same trigger as audit_log).
CREATE TABLE IF NOT EXISTS evidence_ledger (
  id BIGSERIAL PRIMARY KEY,
  recruitment_id TEXT,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_ledger_rec_idx ON evidence_ledger(recruitment_id, id);
DROP TRIGGER IF EXISTS evidence_ledger_no_change ON evidence_ledger;
CREATE TRIGGER evidence_ledger_no_change BEFORE UPDATE OR DELETE ON evidence_ledger FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Conflicts, deadline changes and source problems. Closed only by a named person with a reason.
CREATE TABLE IF NOT EXISTS trust_flags (
  id BIGSERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  field TEXT,
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS trust_flags_open_idx ON trust_flags(status, recruitment_id);

-- Source monitoring: every check is recorded; the last readable page text is kept to explain WHAT changed.
CREATE TABLE IF NOT EXISTS source_checks (
  id BIGSERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'PAGE',
  status TEXT NOT NULL,
  http_status INT,
  detail TEXT,
  fingerprint TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_checks_rec_idx ON source_checks(recruitment_id, id DESC);
CREATE TABLE IF NOT EXISTS source_snapshots (
  recruitment_id TEXT NOT NULL,
  url TEXT NOT NULL,
  text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recruitment_id, url)
);

-- Measured extraction accuracy over time (see eval/extraction and `npm run eval:extraction`).
CREATE TABLE IF NOT EXISTS extraction_eval_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  documents INT NOT NULL,
  real_documents INT NOT NULL,
  evidence_grade TEXT NOT NULL,
  report JSONB NOT NULL
);

-- Per-person alert choices.
CREATE TABLE IF NOT EXISTS alert_preferences (
  account_id BIGINT PRIMARY KEY REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  channels TEXT[] NOT NULL DEFAULT ARRAY['IN_APP','EMAIL','PUSH'],
  deadline_changes BOOLEAN NOT NULL DEFAULT TRUE,
  new_match BOOLEAN NOT NULL DEFAULT TRUE,
  trust_flags BOOLEAN NOT NULL DEFAULT TRUE,
  min_trust TEXT NOT NULL DEFAULT 'ANY' CHECK (min_trust IN ('ANY','VERIFIED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Do recommendations help? One row per recommendation shown and what the person did.
CREATE TABLE IF NOT EXISTS recommendation_outcomes (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  recruitment_id TEXT NOT NULL,
  action_code TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('SHOWN','APPLIED','SAVED','IGNORED','DISMISSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-purpose consent (the existing consent_events rows stay valid: purpose defaults to ACCOUNT).
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'ACCOUNT';
ALTER TABLE citizen_sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
