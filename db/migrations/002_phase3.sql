-- Phase 3: grounded assistant, answer audits, knowledge graph and validated search traces.
CREATE TABLE IF NOT EXISTS answer_audits (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  question TEXT NOT NULL,
  mode TEXT NOT NULL,
  recruitment_id TEXT REFERENCES recruitments(id),
  answer TEXT NOT NULL,
  claims JSONB NOT NULL DEFAULT '[]',
  verification JSONB NOT NULL DEFAULT '{}',
  filters JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS answer_audits_recruitment_idx ON answer_audits(recruitment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS answer_audits_actor_idx ON answer_audits(actor, created_at DESC);
