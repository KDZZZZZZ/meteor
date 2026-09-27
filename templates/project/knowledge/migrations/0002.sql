BEGIN IMMEDIATE;
CREATE TABLE targets (target_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, op_id TEXT NOT NULL, dtype_id TEXT NOT NULL);
INSERT INTO targets VALUES ('', '', '', '');
ALTER TABLE research_runs RENAME TO research_runs_legacy_v1;
CREATE TABLE research_runs (
  target_key TEXT NOT NULL DEFAULT '',
  research_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  case_suite_revision TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  measurement_protocol_ref TEXT NOT NULL,
  run_status TEXT NOT NULL,
  research_goal_met INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_key, research_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO research_runs (research_id, agent_session_id, backend, case_suite_revision, environment_ref, measurement_protocol_ref, run_status, research_goal_met, created_at, updated_at) SELECT research_id, agent_session_id, backend, case_suite_revision, environment_ref, measurement_protocol_ref, run_status, research_goal_met, created_at, updated_at FROM research_runs_legacy_v1;
DROP TABLE research_runs_legacy_v1;
ALTER TABLE hypotheses RENAME TO hypotheses_legacy_v1;
CREATE TABLE hypotheses (
  target_key TEXT NOT NULL DEFAULT '',
  hypothesis_id TEXT NOT NULL,
  latest_revision TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  PRIMARY KEY (target_key, hypothesis_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO hypotheses (hypothesis_id, latest_revision, statement, scope, mechanism) SELECT hypothesis_id, latest_revision, statement, scope, mechanism FROM hypotheses_legacy_v1;
DROP TABLE hypotheses_legacy_v1;
ALTER TABLE hypothesis_revisions RENAME TO hypothesis_revisions_legacy_v1;
CREATE TABLE hypothesis_revisions (
  target_key TEXT NOT NULL DEFAULT '',
  hypothesis_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  verdict TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_key, hypothesis_id, revision),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO hypothesis_revisions (hypothesis_id, revision, statement, scope, mechanism, verdict, submission_id, created_at) SELECT hypothesis_id, revision, statement, scope, mechanism, verdict, submission_id, created_at FROM hypothesis_revisions_legacy_v1;
DROP TABLE hypothesis_revisions_legacy_v1;
ALTER TABLE experiments RENAME TO experiments_legacy_v1;
CREATE TABLE experiments (
  target_key TEXT NOT NULL DEFAULT '',
  experiment_id TEXT NOT NULL,
  research_id TEXT NOT NULL,
  hypothesis_revision TEXT NOT NULL,
  question TEXT NOT NULL,
  intervention TEXT NOT NULL,
  analysis TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  PRIMARY KEY (target_key, research_id, experiment_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO experiments (experiment_id, research_id, hypothesis_revision, question, intervention, analysis, submission_id) SELECT experiment_id, research_id, hypothesis_revision, question, intervention, analysis, submission_id FROM experiments_legacy_v1;
DROP TABLE experiments_legacy_v1;
ALTER TABLE kernel_submissions RENAME TO kernel_submissions_legacy_v1;
CREATE TABLE kernel_submissions (
  target_key TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (target_key, kernel_id, revision, submission_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO kernel_submissions (kernel_id, revision, research_id, submission_id, source_hash, case_suite_revision, environment_ref, measurement_protocol_ref, full_size_test_ref, data_hash, recommended_domain, supported_domain) SELECT kernel_id, revision, research_id, submission_id, source_hash, case_suite_revision, environment_ref, measurement_protocol_ref, full_size_test_ref, data_hash, recommended_domain, supported_domain FROM kernel_submissions_legacy_v1;
DROP TABLE kernel_submissions_legacy_v1;
ALTER TABLE case_measurements RENAME TO case_measurements_legacy_v1;
CREATE TABLE case_measurements (
  target_key TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL,
  kernel_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL,
  median_us REAL,
  reason TEXT,
  PRIMARY KEY (target_key, submission_id, kernel_id, revision, case_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO case_measurements (submission_id, kernel_id, revision, case_id, status, median_us, reason) SELECT submission_id, kernel_id, revision, case_id, status, median_us, reason FROM case_measurements_legacy_v1;
DROP TABLE case_measurements_legacy_v1;
ALTER TABLE knowledge_claims RENAME TO knowledge_claims_legacy_v1;
CREATE TABLE knowledge_claims (
  target_key TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'research' CHECK(category IN ('research', 'prediction_rule', 'ir_technique')),
  applicability TEXT NOT NULL DEFAULT 'target' CHECK(applicability IN ('target', 'hardware')),
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (target_key, claim_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO knowledge_claims (claim_id, kind, statement, scope, submission_id, created_at) SELECT claim_id, kind, statement, scope, submission_id, created_at FROM knowledge_claims_legacy_v1;
DROP TABLE knowledge_claims_legacy_v1;
ALTER TABLE evidence_links RENAME TO evidence_links_legacy_v1;
CREATE TABLE evidence_links (
  target_key TEXT NOT NULL DEFAULT '',
  claim_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (target_key, claim_id, evidence_ref),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO evidence_links (claim_id, evidence_ref) SELECT claim_id, evidence_ref FROM evidence_links_legacy_v1;
DROP TABLE evidence_links_legacy_v1;
ALTER TABLE novelty_events RENAME TO novelty_events_legacy_v1;
CREATE TABLE novelty_events (
  target_key TEXT NOT NULL DEFAULT '',
  novelty_event_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  PRIMARY KEY (target_key, novelty_event_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO novelty_events (novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id) SELECT novelty_event_id, material_id, backend, reason, content_hash, created_at, submission_id FROM novelty_events_legacy_v1;
DROP TABLE novelty_events_legacy_v1;
ALTER TABLE research_commits RENAME TO research_commits_legacy_v1;
CREATE TABLE research_commits (
  target_key TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL,
  research_id TEXT NOT NULL,
  submission_hash TEXT NOT NULL,
  report_ref TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (target_key, submission_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO research_commits (submission_id, research_id, submission_hash, report_ref, committed_at) SELECT submission_id, research_id, submission_hash, report_ref, committed_at FROM research_commits_legacy_v1;
DROP TABLE research_commits_legacy_v1;
ALTER TABLE research_reports RENAME TO research_reports_legacy_v1;
CREATE TABLE research_reports (
  target_key TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL,
  research_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  report_ref TEXT NOT NULL,
  PRIMARY KEY (target_key, submission_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO research_reports (submission_id, research_id, summary, report_ref) SELECT submission_id, research_id, summary, report_ref FROM research_reports_legacy_v1;
DROP TABLE research_reports_legacy_v1;
ALTER TABLE integration_events RENAME TO integration_events_legacy_v1;
CREATE TABLE integration_events (
  target_key TEXT NOT NULL DEFAULT '',
  integration_event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claim_token TEXT,
  lease_expires_at TEXT,
  result_ref TEXT,
  error TEXT,
  PRIMARY KEY (target_key, integration_event_id),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO integration_events (integration_event_id, submission_id, channel, status, created_at, updated_at, claim_token, lease_expires_at, result_ref, error) SELECT integration_event_id, submission_id, channel, status, created_at, updated_at, claim_token, lease_expires_at, result_ref, error FROM integration_events_legacy_v1;
DROP TABLE integration_events_legacy_v1;
ALTER TABLE integration_channels RENAME TO integration_channels_legacy_v1;
CREATE TABLE integration_channels (
  target_key TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  active_event_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  current_version_ref TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_key, channel),
  FOREIGN KEY (target_key) REFERENCES targets(target_key)
);
INSERT INTO integration_channels (channel, active_event_id, lease_token, lease_expires_at, current_version_ref, generation, updated_at) SELECT channel, active_event_id, lease_token, lease_expires_at, current_version_ref, generation, updated_at FROM integration_channels_legacy_v1;
DROP TABLE integration_channels_legacy_v1;
CREATE INDEX idx_kernel_submissions_environment ON kernel_submissions(target_key, case_suite_revision, environment_ref, measurement_protocol_ref);
CREATE INDEX idx_measurements_case ON case_measurements(target_key, case_id, status, median_us);
CREATE INDEX idx_novelty_material ON novelty_events(target_key, material_id, created_at);
CREATE VIEW prediction_rules AS SELECT * FROM knowledge_claims WHERE category = 'prediction_rule';
CREATE VIEW ir_techniques AS SELECT * FROM knowledge_claims WHERE category = 'ir_technique';
CREATE VIEW hardware_knowledge AS SELECT * FROM knowledge_claims WHERE applicability = 'hardware';
UPDATE metadata SET value='2' WHERE key='schema_version';
COMMIT;
