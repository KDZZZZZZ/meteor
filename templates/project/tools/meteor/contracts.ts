export type Backend = 'mock' | 'ssh';
export type Verdict = 'SUPPORTED' | 'REFUTED' | 'INCONCLUSIVE';
export type RunStatus = 'CREATED' | 'ACTIVE' | 'PAUSED' | 'OUTPUT_FROZEN' | 'COMMIT_PENDING' | 'REPORT_PENDING' | 'CLOSED' | 'CANCELLED' | 'FAILED' | 'INTERRUPTED' | 'UNKNOWN_REMOTE';
export type CaseStatus = 'PASS' | 'INCORRECT' | 'UNSUPPORTED' | 'RESOURCE_REJECTED' | 'RUN_FAILED' | 'TIMEOUT' | 'NOT_RUN';
export interface Shape { m: number; n: number; k: number }
export interface Case { case_id: string; shape: Shape; dtype: string; layout: string; input_hash: string; oracle_hash: string; data_ref?: string }
export interface CaseSuite { revision: string; operator_abi: string; cases: Case[] }
export interface Environment { environment_ref: string; hardware: string; toolchain: string; measurement_protocol_ref: string; simulated: boolean }
export interface MeteorConfig {
  schema_version: 1;
  execution: { backend: Backend; profile_ref: string };
  case_suite: string;
  environment: Environment;
  sampling: { epsilon: number; lambda: number; tau_hours: number; count: number };
  budget: { max_experiments: number; max_wall_time_seconds: number };
  integration: { min_relative_improvement: number };
}
export interface Project { root: string; config: MeteorConfig; suite: CaseSuite; dataRoot: string; snapshotRoot?: string }
export interface KernelRef { kernel_id: string; revision: string }
export interface Dependency { id: string; path: string; sha256: string; kind: 'preamble' | 'shared' }
export interface KernelModule extends KernelRef {
  operator_abi: string; symbol_prefix: string; launcher: string;
  device_file: string; host_file: string; supported_case_ids: string[];
  dependencies: Dependency[]; hardware_scope: string; resource_constraints: string[];
}
export interface InitialContext {
  mode: 'random' | 'specified';
  sampling?: { count?: number; seed?: number; epsilon?: number; lambda?: number; tau_hours?: number };
  kernel_refs?: string[];
  knowledge_refs?: string[];
}
export interface AssignedHypothesis {
  statement: string;
  scope?: string; mechanism?: string; intervention?: string; measurement_plan?: string;
  controls?: string[]; predictions?: string[]; support_criteria?: string[];
  refutation_criteria?: string[]; confounders?: string[];
}
export interface ResearchRecord {
  research_id: string; agent_session_id: string; chief_id: string; execution_backend: Backend;
  case_suite_revision: string; environment_ref: string; measurement_protocol_ref: string;
  goal: string; run_status: RunStatus; created_at: string;
  budget: MeteorConfig['budget']; research_goal_met: boolean;
  job_id?: string; prepared_submission_id?: string; report_ref?: string; error?: string;
  updated_at?: string; stop_reason?: string;
  initial_context?: InitialContext; assigned_hypothesis?: AssignedHypothesis;
}
export interface BuildReceipt {
  build_id: string; research_id: string; experiment_id: string; kernel_ref: KernelRef;
  source_hash: string; artifact_hash: string; environment_ref: string;
  execution_backend: Backend; simulated: boolean; status: 'COMPLETED' | 'FAILED' | 'UNKNOWN_REMOTE';
  source_ref: string; module_ref: string; fixture_id?: string; error?: string;
  rendered_source_hash?: string; remote_build_id?: string; remote_request_id?: string;
  raw_receipt_ref?: string; remote_release_confirmed?: boolean;
}
export interface Measurement {
  case_id: string; status: CaseStatus; samples_us: number[]; median_us?: number;
  reason?: string; actual_kernel_ref: KernelRef; source_hash: string;
  input_hash: string; oracle_hash: string;
}
export interface TestReceipt {
  run_id: string; research_id: string; experiment_id: string; kernel_ref: KernelRef;
  build_ref: string; source_hash: string; artifact_hash: string;
  execution_backend: Backend; simulated: boolean; fixture_id?: string;
  case_suite_revision: string; environment_ref: string; measurement_protocol_ref: string;
  mode: 'probe' | 'full'; status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN_REMOTE';
  rows: Measurement[]; accounting_complete: boolean; supported_correct_count: number;
  timed_case_count: number; data_hash: string;
  remote_request_id?: string; raw_receipt_ref?: string; remote_release_confirmed?: boolean;
}
export interface KernelSubmission extends KernelRef {
  source_hash: string; artifact_refs: string[];
  supported_domain: string; verified_case_ids: string[]; recommended_domain: string;
  recommended_case_ids: string[]; hardware_scope: string; resource_constraints: string[];
  unsupported_cases: string[]; case_suite_revision: string; environment_ref: string;
  measurement_protocol_ref: string; full_size_test_ref: string; test_status: 'COMPLETED';
  performance_data_ref: string; data_hash: string; measured_tradeoffs: string; limitations: string[];
}
export interface Hypothesis {
  hypothesis_id: string; revision: string; statement: string; scope: string; mechanism: string;
  intervention: string; controls: string[]; predictions: string[];
  support_criteria: string[]; refutation_criteria: string[];
  confounders: string[]; measurement_plan: string;
  verdict: Verdict; supporting_evidence: string[]; counterevidence: string[]; limitations: string[];
  simulated_verdict?: Verdict;
}
export interface Experiment {
  experiment_id: string; hypothesis_revision: string; question: string; intervention: string;
  controls: string[]; kernel_revisions: KernelRef[]; environment_ref: string;
  full_size_test_refs: string[]; profile_refs: string[]; analysis: string; next_experiment: string;
}
export interface KnowledgeUpdate {
  claim_id: string; kind: 'observation' | 'mechanism' | 'hypothesis' | 'counterexample';
  statement: string; scope: string; evidence_refs: string[]; related_material_ids: string[];
}
export interface Submission {
  research_id: string; agent_session_id: string; execution_backend: Backend; termination_reason: string;
  hypothesis: Hypothesis; hypothesis_history: Array<{ hypothesis: Hypothesis; reason: string }>;
  experiments: Experiment[]; submitted_kernels: KernelSubmission[]; knowledge_updates: KnowledgeUpdate[];
  chief_report: { summary: string; findings: string[]; unresolved: string[]; next_steps: string[] };
}
export interface PreparedSubmission { prepared_submission_id: string; submission_hash: string; submission_ref: string }
export interface ProfileReceipt {
  profile_id: string; research_id: string; experiment_id: string; kernel_ref: KernelRef;
  source_hash: string; environment_ref: string; execution_backend: Backend; simulated: boolean;
  fixture_id?: string; observations: Array<{ case_id: string; metric: string; value: number; unit: string }>;
  instrumented: true;
  remote_request_id?: string; raw_receipt_ref?: string; remote_release_confirmed?: boolean;
}
