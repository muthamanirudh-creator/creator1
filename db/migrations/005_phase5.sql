-- Phase 5: versioned exams, syllabus trees, study plans, mocks, tutor citations and career paths.
CREATE TABLE IF NOT EXISTS exams (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  organization TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS exam_versions (
  id BIGSERIAL PRIMARY KEY,
  exam_id BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  recruitment_year INT NOT NULL,
  pattern JSONB NOT NULL DEFAULT '{}',
  syllabus_version TEXT NOT NULL,
  source_document_id BIGINT REFERENCES documents(id) ON DELETE SET NULL,
  source_page INT,
  status TEXT NOT NULL DEFAULT 'VERIFIED' CHECK(status IN ('DRAFT','VERIFIED','RETIRED')),
  UNIQUE(exam_id,recruitment_year,syllabus_version)
);
CREATE TABLE IF NOT EXISTS syllabus_nodes (
  id BIGSERIAL PRIMARY KEY,
  exam_version_id BIGINT NOT NULL REFERENCES exam_versions(id) ON DELETE CASCADE,
  parent_id BIGINT REFERENCES syllabus_nodes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  source_page INT,
  source_ref TEXT,
  UNIQUE(exam_version_id,code)
);
CREATE INDEX IF NOT EXISTS syllabus_nodes_parent_idx ON syllabus_nodes(exam_version_id,parent_id,sort_order);
CREATE TABLE IF NOT EXISTS syllabus_progress (
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  syllabus_node_id BIGINT NOT NULL REFERENCES syllabus_nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK(status IN ('NOT_STARTED','IN_PROGRESS','MASTERED')),
  progress_pct INT NOT NULL DEFAULT 0 CHECK(progress_pct BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,syllabus_node_id)
);
CREATE TABLE IF NOT EXISTS study_plans (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  exam_version_id BIGINT NOT NULL REFERENCES exam_versions(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  target_date DATE NOT NULL,
  daily_minutes INT NOT NULL CHECK(daily_minutes > 0),
  plan JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_tests (
  id BIGSERIAL PRIMARY KEY,
  exam_version_id BIGINT NOT NULL REFERENCES exam_versions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  questions JSONB NOT NULL DEFAULT '[]',
  source_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_attempts (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES citizen_accounts(id) ON DELETE CASCADE,
  mock_test_id BIGINT NOT NULL REFERENCES mock_tests(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '{}',
  score NUMERIC,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS career_paths (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]'
);
