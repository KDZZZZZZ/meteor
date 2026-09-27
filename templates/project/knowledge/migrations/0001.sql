PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_runs (
  research_id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  case_suite_revision TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  measurement_protocol_ref TEXT NOT NULL,
  run_status TEXT NOT NULL,
  research_goal_met INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  latest_revision TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  mechanism TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hypothesis_revisions (
  hypothesis_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  verdict TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hypothesis_id, revision)
);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT NOT NULL,
  research_id TEXT NOT NULL,
  hypothesis_revision TEXT NOT NULL,
  question TEXT NOT NULL,
  intervention TEXT NOT NULL,
  analysis TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  PRIMARY KEY (research_id, experiment_id)
);

CREATE TABLE IF NOT EXISTS kernel_submissions (
  kernel_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  research_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  case_suite_revision TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  measurement_protocol_ref TEXT NOT NULL,
  full_size_test_ref TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  recommended_domain TEXT NOT NULL,
  supported_domain TEXT NOT NULL,
  PRIMARY KEY (kernel_id, revision, submission_id)
);

CREATE TABLE IF NOT EXISTS case_measurements (
  submission_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL,
  median_us REAL,
  reason TEXT,
  PRIMARY KEY (submission_id, kernel_id, revision, case_id)
);

CREATE TABLE IF NOT EXISTS knowledge_claims (
  claim_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_links (
  claim_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (claim_id, evidence_ref)
);

CREATE TABLE IF NOT EXISTS novelty_events (
  novelty_event_id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submission_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_commits (
  submission_id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  submission_hash TEXT NOT NULL,
  report_ref TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_reports (
  submission_id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  report_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_events (
  integration_event_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claim_token TEXT,
  lease_expires_at TEXT,
  result_ref TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS integration_channels (
  channel TEXT PRIMARY KEY,
  active_event_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  current_version_ref TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kernel_submissions_environment
  ON kernel_submissions(case_suite_revision, environment_ref, measurement_protocol_ref);

CREATE INDEX IF NOT EXISTS idx_measurements_case
  ON case_measurements(case_id, status, median_us);

CREATE INDEX IF NOT EXISTS idx_novelty_material
  ON novelty_events(material_id, created_at);
