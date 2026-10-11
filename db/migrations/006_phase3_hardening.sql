-- Phase 3 hardening: intent, segments, page-level sources and a hash chain on per-answer audits.
ALTER TABLE answer_audits ADD COLUMN IF NOT EXISTS intent TEXT;
ALTER TABLE answer_audits ADD COLUMN IF NOT EXISTS segments JSONB NOT NULL DEFAULT '[]';
ALTER TABLE answer_audits ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]';
ALTER TABLE answer_audits ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE answer_audits ADD COLUMN IF NOT EXISTS hash TEXT;
CREATE OR REPLACE FUNCTION answer_audits_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'answer_audits is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS answer_audits_no_update ON answer_audits;
CREATE TRIGGER answer_audits_no_update BEFORE UPDATE OR DELETE ON answer_audits FOR EACH ROW EXECUTE FUNCTION answer_audits_immutable();
