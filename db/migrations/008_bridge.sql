-- Bridge: links a GovCareer citizen account to a Campus student account and keeps the minimum needed to
-- explain skill-to-job matches. Everything here is deleted with the account (ON DELETE CASCADE) and is
-- included in /api/account/export.
CREATE TABLE IF NOT EXISTS bridge_links (
  account_id BIGINT PRIMARY KEY REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  campus_user_id TEXT NOT NULL,
  campus_email TEXT,
  campus_name TEXT,
  consent_version TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
-- A Campus student can be actively linked to only one GovCareer account.
CREATE UNIQUE INDEX IF NOT EXISTS bridge_links_active_campus_idx ON bridge_links(campus_user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS bridge_settings (
  account_id BIGINT PRIMARY KEY REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  self_skills JSONB NOT NULL DEFAULT '{}'::jsonb,
  typing_wpm INT CHECK (typing_wpm IS NULL OR typing_wpm BETWEEN 5 AND 200),
  daily_minutes INT NOT NULL DEFAULT 120 CHECK (daily_minutes BETWEEN 15 AND 480),
  resume_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Last successful Campus evidence export. Lets Bridge keep working (clearly labelled as stale) after the
-- short-lived Campus session expires. Removed on unlink.
CREATE TABLE IF NOT EXISTS bridge_campus_cache (
  account_id BIGINT PRIMARY KEY REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  evidence JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bridge_snapshots (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  summary JSONB NOT NULL,
  top JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bridge_snapshots_account_idx ON bridge_snapshots(account_id, created_at DESC);
