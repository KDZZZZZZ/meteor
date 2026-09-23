import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssignedHypothesis, BuildReceipt, Hypothesis, Project, ResearchRecord, Submission, TestReceipt, Verdict } from '../templates/project/tools/meteor/contracts.ts';
import { buildReceiptPath, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { commitSubmission, prepareSubmission, SubmissionValidationError } from '../templates/project/tools/meteor/submit.ts';
import { hashObject, writeJson } from '../templates/project/tools/meteor/util.ts';

const assigned: AssignedHypothesis = {
  statement: 'The selected tile keeps the large-to-small latency ratio below 1.5.',
  scope: 'The two pinned suite shapes', mechanism: 'Tile shape changes data reuse', intervention: 'Use the candidate tile',
  measurement_plan: 'Measure both cases under the same protocol', controls: ['Same inputs and environment'],
  predictions: ['The latency ratio is below 1.5'], support_criteria: ['Controlled ratio below 1.5'],
  refutation_criteria: ['Controlled ratio at least 1.5'], confounders: ['Timing noise'],
};

// These canonical receipts are protocol fixtures, not hardware measurements.
// This file never runs an SSH command or a hardware runner.
function setup(t: TestContext, assignment: AssignedHypothesis | null = assigned) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-assigned-hypothesis-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project: Project = {
    root, dataRoot: join(root, 'reports/meteor/ssh'),
    config: {
      schema_version: 1, execution: { backend: 'ssh', profile_ref: 'protocol-fixture-only' }, case_suite: 'fixture-suite',
      environment: { environment_ref: 'fixture-env', hardware: 'fixture-hardware', toolchain: 'fixture-toolchain', measurement_protocol_ref: 'fixture-median-5', simulated: false },
      sampling: { epsilon: 0.1, lambda: 1, tau_hours: 24, count: 1 },
      budget: { max_experiments: 3, max_wall_time_seconds: 60 }, integration: { min_relative_improvement: 0.01 },
    },
    suite: {
      revision: 'fixture-suite', operator_abi: 'qmq-v1',
      cases: [16, 32].map((m, index) => ({ case_id: `case_${index}`, shape: { m, n: 16, k: 64 }, dtype: 'int8', layout: 'qmq-v1', input_hash: `input_${index}`, oracle_hash: `oracle_${index}` })),
    },
  };
  const record: ResearchRecord = {
    research_id: 'assigned_research', agent_session_id: 'original_session', chief_id: 'chief', execution_backend: 'ssh',
    case_suite_revision: project.suite.revision, environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref, goal: 'Investigate the given hypothesis',
    run_status: 'ACTIVE', created_at: new Date().toISOString(), budget: project.config.budget, research_goal_met: false,
    ...(assignment ? { assigned_hypothesis: assignment } : {}),
  };
  writeJson(join(project.dataRoot, 'research', record.research_id, 'manifest.json'), record);
  const build: BuildReceipt = {
    build_id: 'build_candidate', research_id: record.research_id, experiment_id: 'measurement_1',
    kernel_ref: { kernel_id: 'candidate', revision: 'r1' }, source_hash: hashObject('fixture-source'), artifact_hash: hashObject('fixture-artifact'),
    environment_ref: record.environment_ref, execution_backend: 'ssh', simulated: false, status: 'COMPLETED',
    source_ref: 'fixtures/candidate', module_ref: 'fixtures/candidate/kernel.json',
  };
  const buildRef = receiptRef(project, buildReceiptPath(project, build));
  writeJson(join(root, buildRef), build);
  const rows: TestReceipt['rows'] = project.suite.cases.map((item, index) => ({
    case_id: item.case_id, status: 'PASS', samples_us: Array(5).fill(index ? 20 : 10), median_us: index ? 20 : 10,
    actual_kernel_ref: build.kernel_ref, source_hash: build.source_hash, input_hash: item.input_hash, oracle_hash: item.oracle_hash,
  }));
  const receipt: TestReceipt = {
    run_id: 'run_candidate', research_id: record.research_id, experiment_id: build.experiment_id, kernel_ref: build.kernel_ref,
    build_ref: buildRef, source_hash: build.source_hash, artifact_hash: build.artifact_hash, execution_backend: 'ssh', simulated: false,
    case_suite_revision: record.case_suite_revision, environment_ref: record.environment_ref, measurement_protocol_ref: record.measurement_protocol_ref,
    mode: 'full', status: 'COMPLETED', rows, accounting_complete: true, supported_correct_count: rows.length, timed_case_count: rows.length, data_hash: hashObject(rows),
  };
  const ref = receiptRef(project, join(experimentDir(project, record.research_id, receipt.experiment_id), 'full-tests', receipt.run_id + '.json'));
  writeJson(join(root, ref), receipt);
  function original(verdict: Verdict = 'INCONCLUSIVE'): Hypothesis {
    return {
      hypothesis_id: 'given_hypothesis', revision: 'h1', ...assigned, ...assignment,
      scope: assignment?.scope ?? assigned.scope!, mechanism: assignment?.mechanism ?? assigned.mechanism!,
      intervention: assignment?.intervention ?? assigned.intervention!, measurement_plan: assignment?.measurement_plan ?? assigned.measurement_plan!,
      controls: assignment?.controls ?? assigned.controls!, predictions: assignment?.predictions ?? assigned.predictions!,
      support_criteria: assignment?.support_criteria ?? assigned.support_criteria!, refutation_criteria: assignment?.refutation_criteria ?? assigned.refutation_criteria!,
      confounders: assignment?.confounders ?? assigned.confounders!, verdict,
      supporting_evidence: verdict === 'SUPPORTED' ? ['measurement_1'] : [], counterevidence: verdict === 'REFUTED' ? ['measurement_1'] : [],
      limitations: ['Protocol fixture; no real hardware result'],
    };
  }
  function revised(verdict: Verdict = 'SUPPORTED'): Hypothesis {
    return { ...original(verdict), revision: 'h2', statement: 'The selected tile keeps the large-to-small latency ratio below 2.5.',
      predictions: ['The latency ratio is below 2.5'], support_criteria: ['Controlled ratio below 2.5'], refutation_criteria: ['Controlled ratio at least 2.5'] };
  }
  function submission(hypothesis = original(), history: Hypothesis[] = []): Submission {
    return {
      research_id: record.research_id, agent_session_id: record.agent_session_id, execution_backend: 'ssh', termination_reason: 'Investigation ended',
      hypothesis, hypothesis_history: history.map(item => ({ hypothesis: item, reason: 'Preserve the original hypothesis and its current assessment' })),
      experiments: [{ experiment_id: 'measurement_1', hypothesis_revision: 'h1', question: 'What is the measured shape ratio?', intervention: 'Measure the candidate',
        controls: ['Pinned environment'], kernel_revisions: [build.kernel_ref], environment_ref: record.environment_ref, full_size_test_refs: [ref], profile_refs: [],
        analysis: 'The ratio is 2; assess the original and revised thresholds separately.', next_experiment: 'Repeat measurements' }],
      submitted_kernels: [], knowledge_updates: [],
      chief_report: { summary: 'Original and revised hypotheses are tracked separately', findings: ['Measured fixture ratio is 2'], unresolved: ['Hardware validation'], next_steps: ['Repeat on hardware'] },
    };
  }
  function commit(value: Submission) {
    const prepared = prepareSubmission(project, value);
    return commitSubmission(project, prepared.prepared_submission_id, value.agent_session_id);
  }
  return { project, original, revised, submission, commit, receipt, ref };
}

function issueCode(code: string) {
  return (error: unknown) => error instanceof SubmissionValidationError && error.issues.some(issue => issue.code === code);
}

test('the chief supplied hypothesis can remain current, with unspecified fields completed by the researcher', t => {
  const env = setup(t, { statement: assigned.statement });
  const submission = env.submission();
  submission.hypothesis.scope = 'Researcher supplied scope';
  const report = env.commit(submission);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.research_goal_met, false);
  assert.equal(report.submitted_kernel_count, 0);
});

test('submission cannot omit the chief hypothesis or alter any supplied field', t => {
  const env = setup(t);
  assert.throws(() => prepareSubmission(env.project, env.submission(env.revised())), issueCode('ASSIGNED_HYPOTHESIS_MISSING'));
  for (const [key, value] of Object.entries(assigned)) {
    const altered = { ...env.original(), [key]: Array.isArray(value) ? [...value, 'altered criterion'] : value + ' altered' };
    assert.throws(() => prepareSubmission(env.project, env.submission(altered)), issueCode('ASSIGNED_HYPOTHESIS_MISSING'), key);
  }
});

test('a supported revision does not complete an unresolved chief hypothesis', t => {
  const env = setup(t);
  const report = env.commit(env.submission(env.revised('SUPPORTED'), [env.original('INCONCLUSIVE')]));
  assert.equal(report.research_goal_met, false);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.current_hypothesis_verdict, 'SUPPORTED');
});

test('a measured refutation of the original hypothesis completes the goal without a submitted kernel', t => {
  const env = setup(t);
  const report = env.commit(env.submission(env.revised('SUPPORTED'), [env.original('REFUTED')]));
  assert.equal(report.research_goal_met, true);
  assert.equal(report.verdict, 'REFUTED');
  assert.equal(report.current_hypothesis_verdict, 'SUPPORTED');
  assert.equal(report.submitted_kernel_count, 0);
});

test('the latest preserved assessment of the unchanged original hypothesis determines completion', t => {
  const env = setup(t);
  const report = env.commit(env.submission(env.revised('INCONCLUSIVE'), [env.original('INCONCLUSIVE'), env.original('REFUTED')]));
  assert.equal(report.research_goal_met, true);
  assert.equal(report.verdict, 'REFUTED');
  assert.equal(report.current_hypothesis_verdict, 'INCONCLUSIVE');
});

test('a changed hypothesis cannot reuse the original hypothesis revision identity', t => {
  const env = setup(t);
  const revision = { ...env.revised('INCONCLUSIVE'), revision: 'h1' };
  assert.throws(() => prepareSubmission(env.project, env.submission(revision, [env.original()])), issueCode('ASSIGNED_HYPOTHESIS_REVISION_REQUIRED'));
});

test('a historical verdict for the chief hypothesis must have real verifiable evidence', t => {
  const env = setup(t);
  const original = env.original('REFUTED');
  original.counterevidence = ['A prose assertion without measured evidence'];
  assert.throws(() => prepareSubmission(env.project, env.submission(env.revised('INCONCLUSIVE'), [original])), issueCode('MISSING_REAL_MEASUREMENT'));
  writeJson(join(env.project.root, env.ref), { ...env.receipt, simulated: true });
  assert.throws(() => prepareSubmission(env.project, env.submission(env.revised('INCONCLUSIVE'), [env.original('REFUTED')])), issueCode('SIMULATION_MISMATCH'));
});

test('commit rechecks evidence for the chief hypothesis preserved in history', t => {
  const env = setup(t);
  const submission = env.submission(env.revised('INCONCLUSIVE'), [env.original('REFUTED')]);
  const prepared = prepareSubmission(env.project, submission);
  writeJson(join(env.project.root, env.ref), { ...env.receipt, simulated: true });
  assert.throws(() => commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id), issueCode('SIMULATION_MISMATCH'));
});

test('without a chief supplied hypothesis the current validated verdict retains its existing meaning', t => {
  const env = setup(t, null);
  const report = env.commit(env.submission(env.revised('SUPPORTED')));
  assert.equal(report.verdict, 'SUPPORTED');
  assert.equal(report.research_goal_met, true);
  assert.equal(report.current_hypothesis_verdict, undefined);
});
