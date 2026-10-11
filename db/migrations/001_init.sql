-- GovCareer AI Phase 2 schema

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','REVIEWER','VIEWER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  organization TEXT NOT NULL,
  department TEXT,
  official_domain TEXT NOT NULL,
  portal_url TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('OFFICIAL_PORTAL','OFFICIAL_RSS','OFFICIAL_SITEMAP','OFFICIAL_API','MANUAL_UPLOAD','DEMO')),
  state TEXT NOT NULL DEFAULT 'All India',
  language TEXT NOT NULL DEFAULT 'en',
  crawler TEXT NOT NULL DEFAULT 'index-links',
  parser TEXT NOT NULL DEFAULT 'pdf-text',
  crawl_frequency_minutes INT NOT NULL DEFAULT 360,
  crawl_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_request_interval_ms INT NOT NULL DEFAULT 5000,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  last_index_hash TEXT,
  last_links JSONB NOT NULL DEFAULT '[]',
  health TEXT NOT NULL DEFAULT 'TEMPORARILY_UNAVAILABLE'
    CHECK (health IN ('ONLINE','DEGRADED','TEMPORARILY_UNAVAILABLE','BLOCKED','PARSER_ERROR','CONTENT_CHANGED')),
  verification_status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION'
    CHECK (verification_status IN ('PENDING_VERIFICATION','VERIFIED','SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recruitments (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(source_id),
  title TEXT,
  organization TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DISCOVERED','INGESTED','EXTRACTED','VALIDATING','REVIEW_REQUIRED','VERIFIED','PUBLISHED','UPDATED','APPLICATION_CLOSED','EXAM_PHASE','RESULT_PHASE','ARCHIVED')),
  published_version INT,
  data JSONB,                -- last published job record (the shape of data/jobs.js)
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  verification JSONB,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  source_id TEXT REFERENCES sources(source_id),
  recruitment_id TEXT REFERENCES recruitments(id),
  url TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ORIGINAL' CHECK (kind IN ('ORIGINAL','AMENDMENT','CORRIGENDUM','FINAL_UPDATE')),
  issued_on DATE,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  storage_path TEXT NOT NULL,
  page_count INT NOT NULL DEFAULT 0,
  is_scanned BOOLEAN NOT NULL DEFAULT FALSE,
  language TEXT NOT NULL DEFAULT 'en',
  scan_status TEXT NOT NULL CHECK (scan_status IN ('CLEAN','REJECTED')),
  scan_method TEXT,
  supersedes_document_id INT REFERENCES documents(id),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_sha_idx ON documents(sha256);
CREATE INDEX documents_rec_idx ON documents(recruitment_id);

CREATE TABLE document_pages (
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  text TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('TEXT_LAYER','OCR','HTML','DOCX')),
  ocr_confidence NUMERIC,
  columns INT NOT NULL DEFAULT 1,
  tables JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (document_id, page_number)
);

CREATE TABLE document_sections (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INT NOT NULL,
  section TEXT NOT NULL,
  heading TEXT,
  start_char INT NOT NULL,
  end_char INT NOT NULL
);

CREATE TABLE extraction_runs (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('OK','SCHEMA_REJECTED','PROVIDER_ERROR')),
  fields JSONB,
  record JSONB,
  validation_errors JSONB NOT NULL DEFAULT '[]',
  provider_attempts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recruitment_versions (
  id SERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  version_no INT NOT NULL,
  document_id INT NOT NULL REFERENCES documents(id),
  extraction_run_id INT REFERENCES extraction_runs(id),
  data JSONB NOT NULL,
  lineage JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
  schema_valid BOOLEAN NOT NULL DEFAULT FALSE,
  confidence NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recruitment_id, version_no)
);

CREATE TABLE change_events (
  id SERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  from_version INT NOT NULL,
  to_version INT NOT NULL,
  field TEXT NOT NULL,
  label TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  delta TEXT,
  source TEXT,
  supported BOOLEAN NOT NULL,
  message TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lifecycle_events (
  id SERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE review_items (
  id SERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  version_id INT NOT NULL REFERENCES recruitment_versions(id),
  buckets TEXT[] NOT NULL,
  primary_bucket TEXT NOT NULL,
  priority INT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
CREATE INDEX review_open_idx ON review_items(status, priority DESC);

CREATE TABLE conflicts (
  id SERIAL PRIMARY KEY,
  recruitment_id TEXT NOT NULL REFERENCES recruitments(id),
  field TEXT NOT NULL,
  candidates JSONB NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('RESOLVED_LATER_AUTHORITATIVE','UNRESOLVED')),
  chosen JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE TABLE job_queue (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_idx ON job_queue(status, run_at);
