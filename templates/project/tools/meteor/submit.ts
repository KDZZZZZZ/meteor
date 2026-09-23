import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { AssignedHypothesis, BuildReceipt, Case, Hypothesis, KernelSubmission, ProfileReceipt, Project, ResearchRecord, Submission, TestReceipt } from './contracts.ts';
import { buildReceiptPath, experimentDir, validateBuildStillFresh } from './kernel-build.ts';
import { hashObject, inside, readJson, safeId, writeImmutable, writeJson } from './util.ts';
import {
  type CommitEnvelope,
  commitSubmissionTransaction,
  ensureStore,
  integrationChannel,
  listJsonFiles,
  nowIso,
  readResearchManifest,
  resolveEvidenceRef,
  storePaths,
  updateResearchManifest,
  writeArtifact,
} from './store.ts';

export interface SubmissionIssue {
  path: string;
  code: string;
  message: string;
}

export class SubmissionValidationError extends Error {
  readonly issues: SubmissionIssue[];

  constructor(issues: SubmissionIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'SubmissionValidationError';
    this.issues = issues;
  }
}

export interface PreparedSubmission {
  prepared_submission_id: string;
  submission_hash: string;
  submission_ref: string;
}

export interface ResearchCommitReport {
  submission_id: string;
  prepared_submission_id: string;
  submission_hash: string;
  research_id: string;
  agent_session_id: string;
  research_goal_met: boolean;
  verdict: string;
  current_hypothesis_verdict?: string;
  submitted_kernel_count: number;
  report_ref: string;
  report: {
    summary: string;
    findings: string[];
    unresolved: string[];
    next_steps: string[];
  };
  integration_event_id: string;
  integration_event_ref: string;
}

interface PreparedEnvelope {
  prepared_submission_id: string;
  submission_hash: string;
  prepared_at: string;
  submission: Submission;
}

export function prepareSubmission(project: Project, submission: Submission): PreparedSubmission {
  const paths = ensureStore(project);
  const normalized = normalizeSubmission(submission);
  validateSubmission(project, normalized);
  const submissionHash = hashObject(normalized);
  const preparedId = `prepared_${submissionHash.slice(0, 24)}`;
  const envelope: PreparedEnvelope = {
    prepared_submission_id: preparedId,
    submission_hash: submissionHash,
    prepared_at: nowIso(),
    submission: normalized,
  };
  const path = join(paths.preparedRoot, `${preparedId}.json`);
  if (existsSync(path)) {
    const existing = readJson<PreparedEnvelope>(path);
    if (existing.submission_hash === submissionHash && hashObject(existing.submission) === submissionHash) {
      return { prepared_submission_id: preparedId, submission_hash: submissionHash, submission_ref: path };
    }
  }
  writeImmutable(path, envelope);
  return { prepared_submission_id: preparedId, submission_hash: submissionHash, submission_ref: path };
}

export function commitSubmission(project: Project, preparedId: string, sessionId: string): ResearchCommitReport {
  const paths = ensureStore(project);
  safeId(preparedId);
  const preparedPath = join(paths.preparedRoot, `${preparedId}.json`);
  if (!existsSync(preparedPath)) throw new Error(`Prepared submission not found: ${preparedId}`);
  const prepared = readJson<PreparedEnvelope>(preparedPath);
  const submission = prepared.submission;
  if (hashObject(submission) !== prepared.submission_hash) {
    throw new SubmissionValidationError([{
      path: 'prepared_submission',
      code: 'PREPARED_HASH_MISMATCH',
      message: 'prepared submission content no longer matches its frozen hash',
    }]);
  }
  if (submission.agent_session_id !== sessionId) {
    throw new SubmissionValidationError([{
      path: 'agent_session_id',
      code: 'SESSION_MISMATCH',
      message: 'prepared submission must be committed by the original agent session',
    }]);
  }
  validateSubmission(project, submission);

  const submissionId = `submission_${prepared.submission_hash.slice(0, 24)}`;
  const commitPath = join(paths.commitRoot, `${submissionId}.json`);
  const goalHypothesis = researchGoalHypothesis(project, submission);
  const researchGoalMet = computeResearchGoalMet(project, submission, goalHypothesis);
  const reportRef = join(paths.reportsRoot, safeId(submission.research_id), `${submissionId}.json`);
  const eventId = `integration_${prepared.submission_hash.slice(0, 24)}`;
  const eventRef = join(paths.integrationEventRoot, `${eventId}.json`);

  const existingCommit = existsSync(commitPath) ? readJson<CommitEnvelope>(commitPath) : undefined;
  const committedAt = existingCommit?.committed_at ?? nowIso();
  const report = buildReport(submission, researchGoalMet, goalHypothesis, reportRef, eventId, eventRef);
  const envelope: CommitEnvelope = {
    submission_id: submissionId,
    prepared_submission_id: prepared.prepared_submission_id,
    submission_hash: prepared.submission_hash,
    committed_at: committedAt,
    agent_session_id: sessionId,
    research_goal_met: researchGoalMet,
    submission,
    report_ref: reportRef,
  };
  const event = {
    integration_event_id: eventId,
    submission_id: submissionId,
    submission_hash: prepared.submission_hash,
    research_id: submission.research_id,
    execution_backend: submission.execution_backend,
    channel: integrationChannel(project),
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    status: 'QUEUED',
    created_at: committedAt,
    updated_at: committedAt,
    report_ref: reportRef,
    submitted_kernel_count: submission.submitted_kernels.length,
  };
  commitSubmissionTransaction(project, { commit: envelope, report, event });
  mkdirSync(join(paths.reportsRoot, safeId(submission.research_id)), { recursive: true });
  writeImmutable(reportRef, report);
  writeImmutable(commitPath, envelope);
  writeIntegrationEvent(eventRef, event);
  updateResearchManifest(project, submission.research_id, {
    run_status: 'CLOSED',
    research_goal_met: researchGoalMet,
    prepared_submission_id: prepared.prepared_submission_id,
    submission_id: submissionId,
    report_ref: reportRef,
    integration_event_id: eventId,
  });

  return readJson<ResearchCommitReport>(reportRef);
}

function writeIntegrationEvent(path: string, value: unknown): void {
  writeImmutable(path, value);
}

function normalizeSubmission(submission: Submission): Submission {
  return JSON.parse(JSON.stringify(submission)) as Submission;
}

function buildReport(
  submission: Submission,
  researchGoalMet: boolean,
  goalHypothesis: Hypothesis | undefined,
  reportRef: string,
  integrationEventId: string,
  integrationEventRef: string,
): ResearchCommitReport {
  const submissionHash = hashObject(submission);
  const submissionId = `submission_${submissionHash.slice(0, 24)}`;
  return {
    submission_id: submissionId,
    prepared_submission_id: `prepared_${submissionHash.slice(0, 24)}`,
    submission_hash: submissionHash,
    research_id: submission.research_id,
    agent_session_id: submission.agent_session_id,
    research_goal_met: researchGoalMet,
    verdict: goalHypothesis?.verdict ?? 'INCONCLUSIVE',
    ...(goalHypothesis !== submission.hypothesis ? { current_hypothesis_verdict: submission.hypothesis.verdict } : {}),
    submitted_kernel_count: submission.submitted_kernels.length,
    report_ref: reportRef,
    report: {
      summary: submission.chief_report.summary,
      findings: submission.chief_report.findings,
      unresolved: submission.chief_report.unresolved,
      next_steps: submission.chief_report.next_steps,
    },
    integration_event_id: integrationEventId,
    integration_event_ref: integrationEventRef,
  };
}

function matchesAssignedHypothesis(hypothesis: Hypothesis | undefined, assigned: AssignedHypothesis): boolean {
  return !!hypothesis && Object.entries(assigned).every(([key, value]) => value === undefined
    || hashObject(hypothesis[key as keyof AssignedHypothesis]) === hashObject(value));
}

function researchGoalHypothesis(project: Project, submission: Submission): Hypothesis | undefined {
  const assigned = readResearchManifest<ResearchRecord>(project, submission.research_id)?.assigned_hypothesis;
  if (!assigned || matchesAssignedHypothesis(submission.hypothesis, assigned)) return submission.hypothesis;
  // History is chronological; the latest assessment of the unchanged assigned
  // proposition remains the goal when the current proposition is a revision.
  return submission.hypothesis_history.findLast(entry => matchesAssignedHypothesis(entry.hypothesis, assigned))?.hypothesis;
}

function computeResearchGoalMet(project: Project, submission: Submission, goalHypothesis: Hypothesis | undefined): boolean {
  if (isMock(project, submission)) return false;
  return goalHypothesis?.verdict === 'SUPPORTED' || goalHypothesis?.verdict === 'REFUTED';
}

function isMock(project: Project, submission: Submission): boolean {
  return project.config.execution.backend === 'mock'
    || submission.execution_backend === 'mock'
    || project.config.environment.simulated;
}

function validateSubmission(project: Project, submission: Submission): void {
  const issues: SubmissionIssue[] = [];
  const record = readResearchManifest<ResearchRecord>(project, submission.research_id);
  requiredString(issues, 'research_id', submission.research_id);
  requiredString(issues, 'agent_session_id', submission.agent_session_id);
  if (!record) issue(issues, 'research_id', 'UNKNOWN_RESEARCH', 'research manifest is required before submission');
  if (submission.execution_backend !== project.config.execution.backend) {
    issue(issues, 'execution_backend', 'BACKEND_MISMATCH', 'submission backend must match project backend');
  }
  if (record?.agent_session_id && record.agent_session_id !== submission.agent_session_id) {
    issue(issues, 'agent_session_id', 'SESSION_MISMATCH', 'submission must come from the original research session');
  }
  if (record?.case_suite_revision && record.case_suite_revision !== project.suite.revision) {
    issue(issues, 'case_suite_revision', 'SUITE_MISMATCH', 'project suite does not match research manifest');
  }
  if (record?.environment_ref && record.environment_ref !== project.config.environment.environment_ref) {
    issue(issues, 'environment_ref', 'ENVIRONMENT_MISMATCH', 'project environment does not match research manifest');
  }
  if (record?.measurement_protocol_ref && record.measurement_protocol_ref !== project.config.environment.measurement_protocol_ref) {
    issue(issues, 'measurement_protocol_ref', 'PROTOCOL_MISMATCH', 'project protocol does not match research manifest');
  }
  validateHypothesis(project, submission, issues);
  if (record?.assigned_hypothesis) validateAssignedHypothesis(project, submission, record.assigned_hypothesis, issues);
  validateExperiments(submission, issues);
  validateKnowledge(submission, issues);
  if (!Array.isArray(submission.submitted_kernels)) {
    issue(issues, 'submitted_kernels', 'REQUIRED', 'submitted_kernels must be an array, possibly empty');
  } else {
    submission.submitted_kernels.forEach((kernel, index) => validateKernelSubmission(project, submission.research_id, kernel, `submitted_kernels.${index}`, issues));
  }
  if (!submission.chief_report?.summary) issue(issues, 'chief_report.summary', 'REQUIRED', 'chief report summary is required');
  if (!Array.isArray(submission.chief_report?.findings)) issue(issues, 'chief_report.findings', 'REQUIRED', 'chief report findings must be an array');
  if (!Array.isArray(submission.chief_report?.unresolved)) issue(issues, 'chief_report.unresolved', 'REQUIRED', 'chief report unresolved must be an array');
  if (!Array.isArray(submission.chief_report?.next_steps) || submission.chief_report.next_steps.length === 0) {
    issue(issues, 'chief_report.next_steps', 'REQUIRED', 'chief report must include next step suggestions');
  }
  if (issues.length) throw new SubmissionValidationError(issues);
}

function validateAssignedHypothesis(project: Project, submission: Submission, assigned: AssignedHypothesis, issues: SubmissionIssue[]): void {
  const entries = [
    { hypothesis: submission.hypothesis, path: 'hypothesis' },
    ...(Array.isArray(submission.hypothesis_history) ? submission.hypothesis_history.map((entry, index) => ({
      hypothesis: entry.hypothesis, path: `hypothesis_history.${index}.hypothesis`,
    })) : []),
  ];
  const originals = entries.filter(entry => matchesAssignedHypothesis(entry.hypothesis, assigned));
  if (originals.length === 0) {
    issue(issues, 'hypothesis', 'ASSIGNED_HYPOTHESIS_MISSING', 'the chief assigned hypothesis and every supplied field must be preserved in the current hypothesis or its history');
    return;
  }
  const originalIdentities = new Set(originals.map(entry => hashObject([entry.hypothesis.hypothesis_id, entry.hypothesis.revision])));
  for (const entry of entries) {
    if (matchesAssignedHypothesis(entry.hypothesis, assigned)) {
      if (entry.path === 'hypothesis') continue; // Already validated above.
      const historyIssues: SubmissionIssue[] = [];
      validateHypothesis(project, { ...submission, hypothesis: entry.hypothesis, hypothesis_history: [] }, historyIssues);
      issues.push(...historyIssues.map(item => ({ ...item, path: item.path.replace(/^hypothesis(?=\.|$)/, entry.path) })));
    } else if (entry.hypothesis && originalIdentities.has(hashObject([entry.hypothesis.hypothesis_id, entry.hypothesis.revision]))) {
      issue(issues, `${entry.path}.revision`, 'ASSIGNED_HYPOTHESIS_REVISION_REQUIRED', 'a changed assigned proposition must use a distinct hypothesis revision identity');
    }
  }
}

function validateHypothesis(project: Project, submission: Submission, issues: SubmissionIssue[]): void {
  const hypothesis = submission.hypothesis;
  requiredString(issues, 'hypothesis.hypothesis_id', hypothesis?.hypothesis_id);
  requiredString(issues, 'hypothesis.revision', hypothesis?.revision);
  requiredString(issues, 'hypothesis.statement', hypothesis?.statement);
  requiredString(issues, 'hypothesis.scope', hypothesis?.scope);
  requiredString(issues, 'hypothesis.mechanism', hypothesis?.mechanism);
  requiredString(issues, 'hypothesis.intervention', hypothesis?.intervention);
  requiredString(issues, 'hypothesis.measurement_plan', hypothesis?.measurement_plan);
  requiredArray(issues, 'hypothesis.predictions', hypothesis?.predictions);
  requiredArray(issues, 'hypothesis.support_criteria', hypothesis?.support_criteria);
  requiredArray(issues, 'hypothesis.refutation_criteria', hypothesis?.refutation_criteria);
  if (!['SUPPORTED', 'REFUTED', 'INCONCLUSIVE'].includes(hypothesis?.verdict)) {
    issue(issues, 'hypothesis.verdict', 'INVALID_VERDICT', 'verdict must be SUPPORTED, REFUTED, or INCONCLUSIVE');
  }
  if (isMock(project, submission) && hypothesis?.verdict !== 'INCONCLUSIVE') {
    issue(issues, 'hypothesis.verdict', 'MOCK_VERDICT_MUST_BE_INCONCLUSIVE', 'mock runs cannot prove real hardware hypotheses; use simulated_verdict separately');
  }
  if (hypothesis?.verdict === 'SUPPORTED') requiredArray(issues, 'hypothesis.supporting_evidence', hypothesis.supporting_evidence);
  if (hypothesis?.verdict === 'REFUTED') requiredArray(issues, 'hypothesis.counterevidence', hypothesis.counterevidence);
  if (hypothesis?.verdict === 'INCONCLUSIVE') requiredArray(issues, 'hypothesis.limitations', hypothesis.limitations);
  if (!isMock(project, submission) && ['SUPPORTED', 'REFUTED'].includes(hypothesis?.verdict)) {
    validateHypothesisEvidence(project, submission, issues);
  }
  if (!Array.isArray(submission.hypothesis_history)) {
    issue(issues, 'hypothesis_history', 'REQUIRED', 'hypothesis history must be an array');
  } else {
    submission.hypothesis_history.forEach((entry, index) => {
      requiredString(issues, `hypothesis_history.${index}.reason`, entry.reason);
      requiredString(issues, `hypothesis_history.${index}.hypothesis.statement`, entry.hypothesis?.statement);
    });
  }
}

function validateHypothesisEvidence(project: Project, submission: Submission, issues: SubmissionIssue[]): void {
  const key = submission.hypothesis.verdict === 'SUPPORTED' ? 'supporting_evidence' : 'counterevidence';
  const references = submission.hypothesis[key];
  if (!Array.isArray(references)) return;
  let hasMeasurement = false;
  references.forEach((reference, index) => {
    const path = `hypothesis.${key}.${index}`;
    if (typeof reference !== 'string' || !reference.trim()) {
      issue(issues, path, 'INVALID_EVIDENCE', 'evidence references must be nonempty strings');
      return;
    }
    const experiment = Array.isArray(submission.experiments) ? submission.experiments.find(item => item.experiment_id === reference) : undefined;
    // Existing submissions use experiment IDs or receipt paths. Other strings
    // remain background explanations and cannot replace measured evidence.
    const refs = experiment
      ? [...(experiment.full_size_test_refs ?? []), ...(experiment.profile_refs ?? [])]
      : !/^(https?:|sqlite:)/.test(reference) && (reference.startsWith('artifact://') || /\.json$/i.test(reference)) ? [reference] : [];
    if (experiment && experiment.environment_ref !== project.config.environment.environment_ref) {
      issue(issues, path, 'STALE_ENVIRONMENT', 'cited experiment environment must match the research');
    }
    for (const ref of refs) {
      const before = issues.length;
      try {
        const receipt = readJson<ExperimentReceipt>(resolveEvidenceRef(project, ref));
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Evidence must be a runner receipt');
        let measured = false;
        if ('run_id' in receipt) {
          validateTestEvidence(project, submission.research_id, ref, receipt, path, issues);
          measured = Array.isArray(receipt.rows) && receipt.rows.some(row => row?.status === 'PASS');
        } else if ('profile_id' in receipt) {
          validateProfileEvidence(project, submission.research_id, ref, receipt, path, issues);
          measured = Array.isArray(receipt.observations) && receipt.observations.length > 0;
        } else if ('build_id' in receipt) {
          validateEvidenceOrigin(project, submission.research_id, ref, receipt, path, issues);
        } else {
          issue(issues, path, 'INVALID_EVIDENCE', 'decisive evidence must reference a test or profile receipt');
        }
        if (measured && issues.length === before) hasMeasurement = true;
      } catch (error) {
        issue(issues, path, 'MISSING_EVIDENCE', (error as Error).message);
      }
    }
  });
  if (!hasMeasurement) {
    issue(issues, `hypothesis.${key}`, 'MISSING_REAL_MEASUREMENT', 'a real conclusion requires valid measured test or profile evidence from this research');
  }
}

function validateProfileEvidence(project: Project, researchId: string, ref: string, receipt: ProfileReceipt, path: string, issues: SubmissionIssue[]): void {
  validateEvidenceOrigin(project, researchId, ref, receipt, path, issues);
  const caseIds = new Set(project.suite.cases.map(item => item.case_id));
  if (receipt.instrumented !== true || !Array.isArray(receipt.observations) || receipt.observations.length === 0
    || receipt.observations.some(row => !row || !caseIds.has(row.case_id) || !row.metric || typeof row.value !== 'number' || !Number.isFinite(row.value) || !row.unit)) {
    issue(issues, path, 'INVALID_PROFILE', 'profile evidence requires actual observations for known cases');
  }
  // ProfileReceipt has no build_ref, so match its pinned source and revision to
  // a completed build in the same tool-owned experiment directory.
  const builds = join(experimentDir(project, receipt.research_id, receipt.experiment_id), 'builds');
  const hasBuild = listJsonFiles(builds).some(buildRef => {
    const build = readJson<BuildReceipt>(buildRef);
    if (build.status !== 'COMPLETED' || !build.artifact_hash || build.experiment_id !== receipt.experiment_id
      || build.source_hash !== receipt.source_hash || build.kernel_ref?.kernel_id !== receipt.kernel_ref?.kernel_id
      || build.kernel_ref?.revision !== receipt.kernel_ref?.revision) return false;
    const buildIssues: SubmissionIssue[] = [];
    validateEvidenceOrigin(project, researchId, buildRef, build, `${path}.build_ref`, buildIssues);
    return buildIssues.length === 0;
  });
  if (!hasBuild) issue(issues, `${path}.build_ref`, 'MISSING_BUILD', 'profile evidence requires a matching real build from this research');
}

function validateExperiments(submission: Submission, issues: SubmissionIssue[]): void {
  if (!Array.isArray(submission.experiments) || submission.experiments.length === 0) {
    issue(issues, 'experiments', 'REQUIRED', 'at least one experiment and analysis record is required');
    return;
  }
  submission.experiments.forEach((experiment, index) => {
    requiredString(issues, `experiments.${index}.experiment_id`, experiment.experiment_id);
    requiredString(issues, `experiments.${index}.question`, experiment.question);
    requiredString(issues, `experiments.${index}.intervention`, experiment.intervention);
    requiredString(issues, `experiments.${index}.analysis`, experiment.analysis);
    if (!Array.isArray(experiment.kernel_revisions)) {
      issue(issues, `experiments.${index}.kernel_revisions`, 'REQUIRED', 'kernel revisions must be listed, even if empty');
    }
    if (!Array.isArray(experiment.full_size_test_refs)) {
      issue(issues, `experiments.${index}.full_size_test_refs`, 'REQUIRED', 'full-size evidence refs must be listed, even if empty');
    }
  });
}

function validateKnowledge(submission: Submission, issues: SubmissionIssue[]): void {
  if (!Array.isArray(submission.knowledge_updates)) {
    issue(issues, 'knowledge_updates', 'REQUIRED', 'knowledge updates must be an array');
    return;
  }
  submission.knowledge_updates.forEach((claim, index) => {
    requiredString(issues, `knowledge_updates.${index}.claim_id`, claim.claim_id);
    requiredString(issues, `knowledge_updates.${index}.statement`, claim.statement);
    requiredString(issues, `knowledge_updates.${index}.scope`, claim.scope);
    requiredArray(issues, `knowledge_updates.${index}.evidence_refs`, claim.evidence_refs);
  });
}

function validateKernelSubmission(project: Project, researchId: string, kernel: KernelSubmission, path: string, issues: SubmissionIssue[]): void {
  requiredString(issues, `${path}.kernel_id`, kernel.kernel_id);
  requiredString(issues, `${path}.revision`, kernel.revision);
  requiredString(issues, `${path}.source_hash`, kernel.source_hash);
  requiredString(issues, `${path}.supported_domain`, kernel.supported_domain);
  requiredString(issues, `${path}.recommended_domain`, kernel.recommended_domain);
  requiredString(issues, `${path}.hardware_scope`, kernel.hardware_scope);
  requiredString(issues, `${path}.full_size_test_ref`, kernel.full_size_test_ref);
  requiredString(issues, `${path}.performance_data_ref`, kernel.performance_data_ref);
  requiredArray(issues, `${path}.recommended_case_ids`, kernel.recommended_case_ids);
  requiredArray(issues, `${path}.verified_case_ids`, kernel.verified_case_ids);
  if (kernel.test_status !== 'COMPLETED') issue(issues, `${path}.test_status`, 'INCOMPLETE_TEST', 'submitted kernels must have completed full-size tests');
  if (kernel.case_suite_revision !== project.suite.revision) issue(issues, `${path}.case_suite_revision`, 'SUITE_MISMATCH', 'kernel suite must match project suite');
  if (kernel.environment_ref !== project.config.environment.environment_ref) issue(issues, `${path}.environment_ref`, 'ENVIRONMENT_MISMATCH', 'kernel environment must match project environment');
  if (kernel.measurement_protocol_ref !== project.config.environment.measurement_protocol_ref) {
    issue(issues, `${path}.measurement_protocol_ref`, 'PROTOCOL_MISMATCH', 'kernel protocol must match project environment');
  }

  let receipt: TestReceipt | undefined;
  try {
    receipt = readJson<TestReceipt>(resolveEvidenceRef(project, kernel.full_size_test_ref));
  } catch (error) {
    issue(issues, `${path}.full_size_test_ref`, 'MISSING_RECEIPT', (error as Error).message);
  }
  if (receipt) validateFullReceipt(project, researchId, kernel, receipt, path, issues);
  try {
    const performancePath = resolveEvidenceRef(project, kernel.performance_data_ref);
    if (realpathSync(performancePath) !== realpathSync(resolveEvidenceRef(project, kernel.full_size_test_ref))) {
      issue(issues, `${path}.performance_data_ref`, 'PERFORMANCE_MISMATCH', 'performance data must reference the validated full test receipt');
    }
  } catch (error) {
    issue(issues, `${path}.performance_data_ref`, 'MISSING_PERFORMANCE', (error as Error).message);
  }
}

type ExperimentReceipt = BuildReceipt | TestReceipt | ProfileReceipt;

function validateEvidenceOrigin(project: Project, researchId: string, ref: string, receipt: ExperimentReceipt, path: string, issues: SubmissionIssue[]): void {
  if (receipt.research_id !== researchId) issue(issues, `${path}.research_id`, 'RESEARCH_MISMATCH', 'experiment evidence must belong to the submitting research');
  if (receipt.execution_backend !== project.config.execution.backend) issue(issues, `${path}.execution_backend`, 'BACKEND_MISMATCH', 'evidence backend must match project backend');
  if (receipt.environment_ref !== project.config.environment.environment_ref) issue(issues, `${path}.environment_ref`, 'STALE_ENVIRONMENT', 'evidence environment must match project environment');
  if (receipt.simulated !== (project.config.execution.backend === 'mock')) issue(issues, `${path}.simulated`, 'SIMULATION_MISMATCH', 'evidence must carry the correct explicit simulation flag');
  try {
    const dir = experimentDir(project, receipt.research_id, receipt.experiment_id);
    const expected = 'run_id' in receipt ? join(dir, 'full-tests', `${safeId(receipt.run_id)}.json`)
      : 'build_id' in receipt ? buildReceiptPath(project, { ...receipt, build_id: safeId(receipt.build_id) })
        : join(dir, 'profiles', `${safeId(receipt.profile_id)}.json`);
    // Resolve the data root once so symlinks inside evidence storage cannot turn
    // an agent-writable draft into an apparently tool-owned receipt.
    const expectedPhysical = join(realpathSync(project.dataRoot), relative(resolve(project.dataRoot), expected));
    if (realpathSync(resolveEvidenceRef(project, ref)) !== expectedPhysical) {
      issue(issues, path, 'UNTRUSTED_RECEIPT', 'evidence must be the original receipt in tool-owned experiment storage');
    }
  } catch (error) {
    issue(issues, path, 'UNTRUSTED_RECEIPT', (error as Error).message);
  }
}

function validateLinkedBuild(project: Project, researchId: string, receipt: TestReceipt, path: string, issues: SubmissionIssue[]): BuildReceipt | undefined {
  let build: BuildReceipt;
  try {
    build = readJson<BuildReceipt>(resolveEvidenceRef(project, receipt.build_ref));
  } catch (error) {
    issue(issues, path, 'MISSING_BUILD', (error as Error).message);
    return;
  }
  validateEvidenceOrigin(project, researchId, receipt.build_ref, build, path, issues);
  if (build.status !== 'COMPLETED') issue(issues, `${path}.status`, 'INCOMPLETE_BUILD', 'test evidence requires a completed build');
  if (build.experiment_id !== receipt.experiment_id) issue(issues, `${path}.experiment_id`, 'EXPERIMENT_MISMATCH', 'build and test must belong to the same experiment');
  if (build.kernel_ref?.kernel_id !== receipt.kernel_ref?.kernel_id || build.kernel_ref?.revision !== receipt.kernel_ref?.revision) {
    issue(issues, `${path}.kernel_ref`, 'KERNEL_MISMATCH', 'build must match the exact tested kernel revision');
  }
  if (build.source_hash !== receipt.source_hash) issue(issues, `${path}.source_hash`, 'SOURCE_MISMATCH', 'build must match the tested source hash');
  if (!build.artifact_hash || build.artifact_hash !== receipt.artifact_hash) issue(issues, `${path}.artifact_hash`, 'ARTIFACT_MISMATCH', 'build must match the tested artifact hash');
  return build;
}

function validateKernelArtifact(project: Project, kernel: KernelSubmission, build: BuildReceipt, path: string, issues: SubmissionIssue[]): void {
  const moduleRef = Array.isArray(kernel.artifact_refs)
    ? kernel.artifact_refs.find(ref => typeof ref === 'string' && /[\\/]kernel\.json$/.test(ref)) : undefined;
  if (!moduleRef) issue(issues, `${path}.artifact_refs`, 'MISSING_MODULE', 'submitted kernel requires its measured module manifest');
  else {
    try {
      if (realpathSync(inside(project.root, moduleRef)) !== realpathSync(inside(project.root, build.module_ref))) {
        issue(issues, `${path}.artifact_refs`, 'MODULE_MISMATCH', 'submitted module must be the module used by the tested build');
      }
    } catch (error) {
      issue(issues, `${path}.artifact_refs`, 'MISSING_MODULE', (error as Error).message);
    }
  }
  try {
    validateBuildStillFresh(project, build);
  } catch (error) {
    issue(issues, `${path}.artifact_refs`, 'STALE_SOURCE', (error as Error).message);
  }
}

function validateTestEvidence(project: Project, researchId: string, ref: string, receipt: TestReceipt, path: string, issues: SubmissionIssue[]): BuildReceipt | undefined {
  validateEvidenceOrigin(project, researchId, ref, receipt, path, issues);
  const build = validateLinkedBuild(project, researchId, receipt, `${path}.build_ref`, issues);
  if (!Array.isArray(receipt.rows) || receipt.data_hash !== hashObject(receipt.rows)) {
    issue(issues, `${path}.data_hash`, 'DATA_HASH_MISMATCH', 'receipt data hash must match its complete measurement rows');
  }
  if (!['full', 'probe'].includes(receipt.mode)) issue(issues, `${path}.mode`, 'INVALID_MODE', 'test receipt must be probe or full mode');
  if (receipt.status !== 'COMPLETED') issue(issues, `${path}.status`, 'INCOMPLETE_TEST', 'test evidence must be completed');
  if (receipt.mode === 'full' && !receipt.accounting_complete) issue(issues, `${path}.accounting_complete`, 'PARTIAL_ACCOUNTING', 'full test must account for every case');
  if (receipt.case_suite_revision !== project.suite.revision) issue(issues, `${path}.case_suite_revision`, 'STALE_SUITE', 'receipt suite does not match project suite');
  if (receipt.measurement_protocol_ref !== project.config.environment.measurement_protocol_ref) {
    issue(issues, `${path}.measurement_protocol_ref`, 'STALE_PROTOCOL', 'receipt protocol does not match project environment');
  }
  const casesById = new Map(project.suite.cases.map(item => [item.case_id, item]));
  const seen = new Set<string>();
  for (const row of Array.isArray(receipt.rows) ? receipt.rows : []) {
    const rowPath = `${path}.rows.${row?.case_id ?? '<missing>'}`;
    const testCase = casesById.get(row?.case_id);
    if (!testCase) {
      issue(issues, rowPath, 'UNKNOWN_CASE', 'receipt row is not in the fixed case suite');
      continue;
    }
    if (seen.has(row.case_id)) issue(issues, rowPath, 'DUPLICATE_CASE', 'receipt has duplicate case rows');
    seen.add(row.case_id);
    validateMeasurementRow({ ...receipt.kernel_ref, source_hash: receipt.source_hash }, row, testCase, rowPath, issues);
  }
  if (receipt.mode === 'full') for (const testCase of project.suite.cases) {
    if (!seen.has(testCase.case_id)) issue(issues, `${path}.rows.${testCase.case_id}`, 'MISSING_CASE', 'full-size receipt is missing a case');
  }
  return build;
}

function validateFullReceipt(project: Project, researchId: string, kernel: KernelSubmission, receipt: TestReceipt, path: string, issues: SubmissionIssue[]): void {
  const build = validateTestEvidence(project, researchId, kernel.full_size_test_ref, receipt, `${path}.full_size_test_ref`, issues);
  if (build) validateKernelArtifact(project, kernel, build, path, issues);
  if (receipt.mode !== 'full') issue(issues, `${path}.full_size_test_ref.mode`, 'NOT_FULL', 'submitted kernel receipt must be full mode');
  if (receipt.kernel_ref?.kernel_id !== kernel.kernel_id || receipt.kernel_ref?.revision !== kernel.revision) {
    issue(issues, `${path}.full_size_test_ref.kernel_ref`, 'KERNEL_MISMATCH', 'receipt must measure the exact submitted kernel revision');
  }
  if (receipt.source_hash !== kernel.source_hash) issue(issues, `${path}.full_size_test_ref.source_hash`, 'SOURCE_MISMATCH', 'receipt source hash must match submitted source hash');
  if (receipt.data_hash !== kernel.data_hash) issue(issues, `${path}.data_hash`, 'DATA_HASH_MISMATCH', 'submitted data hash must match receipt');
  const passCaseIds = new Set((Array.isArray(receipt.rows) ? receipt.rows : []).filter(row => row?.status === 'PASS').map(row => row.case_id));
  for (const caseId of kernel.verified_case_ids) {
    if (!passCaseIds.has(caseId)) issue(issues, `${path}.verified_case_ids`, 'UNVERIFIED_CASE', `case ${caseId} is not PASS in the full-size receipt`);
  }
  for (const caseId of kernel.recommended_case_ids) {
    if (!passCaseIds.has(caseId)) issue(issues, `${path}.recommended_case_ids`, 'UNVERIFIED_RECOMMENDATION', `recommended case ${caseId} is not PASS in the full-size receipt`);
  }
}

function validateMeasurementRow(kernel: Pick<KernelSubmission, 'kernel_id' | 'revision' | 'source_hash'>, row: any, testCase: Case, path: string, issues: SubmissionIssue[]): void {
  if (row.status === 'NOT_RUN') issue(issues, `${path}.status`, 'NOT_RUN', 'submitted full-size tests cannot contain NOT_RUN rows');
  if (row.actual_kernel_ref?.kernel_id !== kernel.kernel_id || row.actual_kernel_ref?.revision !== kernel.revision) {
    issue(issues, `${path}.actual_kernel_ref`, 'KERNEL_MISMATCH', 'measurement row must execute the submitted kernel');
  }
  if (row.source_hash !== kernel.source_hash) issue(issues, `${path}.source_hash`, 'SOURCE_MISMATCH', 'measurement row source hash must match submitted source hash');
  if (row.input_hash !== testCase.input_hash) issue(issues, `${path}.input_hash`, 'INPUT_MISMATCH', 'measurement row input hash must match the case');
  if (row.oracle_hash !== testCase.oracle_hash) issue(issues, `${path}.oracle_hash`, 'ORACLE_MISMATCH', 'measurement row oracle hash must match the case');
  if (row.status === 'PASS') {
    if (!Array.isArray(row.samples_us) || row.samples_us.length === 0 || !row.samples_us.every((sample: unknown) => typeof sample === 'number' && Number.isFinite(sample) && sample > 0)
      || typeof row.median_us !== 'number' || !Number.isFinite(row.median_us) || row.median_us <= 0) {
      issue(issues, `${path}.samples_us`, 'MISSING_TIMING', 'PASS rows must include finite positive raw samples and median timing');
    }
  } else if (!row.reason) {
    issue(issues, `${path}.reason`, 'MISSING_REASON', 'non-PASS rows must include an explicit reason');
  }
}

function requiredString(issues: SubmissionIssue[], path: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') issue(issues, path, 'REQUIRED', 'non-empty string is required');
}

function requiredArray(issues: SubmissionIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) issue(issues, path, 'REQUIRED', 'non-empty array is required');
}

function issue(issues: SubmissionIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}
