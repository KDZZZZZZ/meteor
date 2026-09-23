import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { BuildReceipt, KernelModule, ProfileReceipt, Submission, TestReceipt, Verdict } from '../templates/project/tools/meteor/contracts.ts';
import { buildReceiptPath, computeSourceHash, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission, SubmissionValidationError } from '../templates/project/tools/meteor/submit.ts';
import { hashObject, writeJson } from '../templates/project/tools/meteor/util.ts';

// These are protocol fixtures, not hardware measurements. No runner or SSH connection is used.
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-hypothesis-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false });
  const initial = loadProject(root);
  writeJson(join(root, 'meteor.config.json'), {
    ...initial.config,
    execution: { backend: 'ssh', profile_ref: 'fixture-only-no-connection' },
    environment: {
      environment_ref: 'fixture-ascend-env', hardware: 'fixture-ascend', toolchain: 'fixture-cann',
      measurement_protocol_ref: 'fixture-median-5', simulated: false,
    },
  });
  writeJson(join(root, initial.config.case_suite), {
    ...initial.suite, revision: 'fixture-suite-v1',
    cases: initial.suite.cases.slice(0, 2).map(item => ({
      ...item, input_hash: hashObject(['input', item.case_id]), oracle_hash: hashObject(['oracle', item.case_id]),
    })),
  });
  const project = loadProject(root);
  const researchId = 'research_evidence';
  const experimentId = 'experiment_1';
  function startResearch(id: string) {
    createResearch(project, { research_id: id, agent_session_id: 'pending', chief_id: 'chief', goal: 'Test a shape-scaling hypothesis' });
    bindResearchSession(project, id, 'session_' + id);
  }
  startResearch(researchId);

  function measurement(id = researchId, kernelId = 'candidate', times = [100, 120]) {
    const kernelPath = `kernels/${id}/${kernelId}/r1`;
    const module: KernelModule = {
      kernel_id: kernelId, revision: 'r1', operator_abi: project.suite.operator_abi,
      symbol_prefix: kernelId + '_', launcher: kernelId + '_launch',
      device_file: kernelPath + '/device.asc', host_file: kernelPath + '/host.asc',
      supported_case_ids: project.suite.cases.map(item => item.case_id), dependencies: [],
      hardware_scope: project.config.environment.hardware, resource_constraints: [],
    };
    writeJson(join(root, kernelPath, 'kernel.json'), module);
    writeFileSync(join(root, module.device_file), '// Unit-test kernel fixture\n');
    writeFileSync(join(root, module.host_file), `MeteorStatus ${module.launcher}(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n`);
    const sourceHash = computeSourceHash(project, module);
    const build: BuildReceipt = {
      build_id: 'build_' + kernelId, research_id: id, experiment_id: experimentId,
      kernel_ref: { kernel_id: kernelId, revision: 'r1' }, source_hash: sourceHash,
      artifact_hash: hashObject(['artifact', id, kernelId]), environment_ref: project.config.environment.environment_ref,
      execution_backend: 'ssh', simulated: false, status: 'COMPLETED', source_ref: kernelPath, module_ref: kernelPath + '/kernel.json',
    };
    const buildRef = receiptRef(project, buildReceiptPath(project, build));
    writeJson(join(root, buildRef), build);
    const rows: TestReceipt['rows'] = project.suite.cases.map((item, index) => ({
      case_id: item.case_id, status: 'PASS', samples_us: Array(5).fill(times[index]), median_us: times[index],
      actual_kernel_ref: build.kernel_ref, source_hash: sourceHash, input_hash: item.input_hash, oracle_hash: item.oracle_hash,
    }));
    const receipt: TestReceipt = {
      run_id: 'run_' + kernelId, research_id: id, experiment_id: experimentId, kernel_ref: build.kernel_ref,
      build_ref: buildRef, source_hash: sourceHash, artifact_hash: build.artifact_hash,
      execution_backend: 'ssh', simulated: false, case_suite_revision: project.suite.revision,
      environment_ref: build.environment_ref, measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
      mode: 'full', status: 'COMPLETED', rows, accounting_complete: true,
      supported_correct_count: rows.length, timed_case_count: rows.length, data_hash: hashObject(rows),
    };
    const ref = receiptRef(project, join(experimentDir(project, id, experimentId), 'full-tests', receipt.run_id + '.json'));
    writeJson(join(root, ref), receipt);
    return { build, buildRef, receipt, ref };
  }
  const measured = measurement();
  function profile(changes: Partial<ProfileReceipt> = {}) {
    const receipt: ProfileReceipt = {
      profile_id: 'profile_candidate', research_id: researchId, experiment_id: experimentId,
      kernel_ref: measured.build.kernel_ref, source_hash: measured.build.source_hash,
      environment_ref: measured.build.environment_ref, execution_backend: 'ssh', simulated: false, instrumented: true,
      observations: measured.receipt.rows.map(row => ({ case_id: row.case_id, metric: 'kernel_time_us', value: row.median_us!, unit: 'us' })),
      ...changes,
    };
    const ref = receiptRef(project, join(experimentDir(project, researchId, experimentId), 'profiles', receipt.profile_id + '.json'));
    writeJson(join(root, ref), receipt);
    return { receipt, ref };
  }
  function submission(verdict: Verdict = 'SUPPORTED'): Submission {
    return {
      research_id: researchId, agent_session_id: 'session_' + researchId, execution_backend: 'ssh', termination_reason: 'Hypothesis investigation complete',
      hypothesis: {
        hypothesis_id: 'shape_scaling', revision: 'h1', statement: 'The selected tile gives a large-to-small shape time ratio below 1.5',
        scope: 'The two fixed suite shapes and pinned environment', mechanism: 'Tile changes can alter shape scaling independently of absolute latency',
        intervention: 'Use the candidate tile', controls: ['Identical inputs, compiler, device, and measurement protocol'],
        predictions: ['The candidate large-to-small time ratio is below 1.5'], support_criteria: ['Controlled ratio below 1.5'],
        refutation_criteria: ['Controlled ratio at least 1.5'], confounders: ['Timing noise and compiler differences'],
        measurement_plan: 'Measure both shapes with the same timing protocol', verdict,
        supporting_evidence: verdict === 'SUPPORTED' ? [experimentId] : [],
        counterevidence: verdict === 'REFUTED' ? [experimentId] : [],
        limitations: ['This unit fixture checks evidence provenance, not a real scientific result'],
      },
      hypothesis_history: [],
      experiments: [{
        experiment_id: experimentId, hypothesis_revision: 'h1', question: 'Does the candidate meet the predicted shape-scaling ratio?',
        intervention: 'Change tile size', controls: ['Pinned inputs and environment'], kernel_revisions: [measured.receipt.kernel_ref],
        environment_ref: project.config.environment.environment_ref, full_size_test_refs: [measured.ref], profile_refs: [],
        analysis: 'Assess the shape ratio separately from absolute latency or kernel selection', next_experiment: 'Repeat on another shape pair',
      }],
      submitted_kernels: [], knowledge_updates: [],
      chief_report: { summary: 'Hypothesis evidence recorded without offering a kernel', findings: ['Scope is the measured shape pair'], unresolved: ['Other shapes'], next_steps: ['Test another shape pair'] },
    };
  }
  function saveReceipt(receipt: TestReceipt) { writeJson(join(root, measured.ref), receipt); }
  function saveBuild(build: BuildReceipt) { writeJson(join(root, measured.buildRef), build); }
  return { project, researchId, experimentId, startResearch, measurement, measured, profile, submission, saveReceipt, saveBuild };
}

function rejected(action: () => unknown, message: string) {
  assert.throws(action, (error: unknown) => error instanceof SubmissionValidationError, message);
}

test('zero-kernel SSH conclusions require traceable measurements instead of prose or missing references', t => {
  const env = setup(t);
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    for (const evidence of ['I observed that the hypothesis is correct', 'missing-evidence.json', env.experimentId]) {
      const submission = env.submission(verdict);
      const key = verdict === 'SUPPORTED' ? 'supporting_evidence' : 'counterevidence';
      submission.hypothesis[key] = [evidence];
      submission.experiments[0].kernel_revisions = [];
      submission.experiments[0].full_size_test_refs = evidence === 'missing-evidence.json' ? [evidence] : [];
      rejected(() => prepareSubmission(env.project, submission), `${verdict}: ${evidence} must not substitute for an actual experiment`);
    }
  }
});

test('zero-kernel SSH conclusions reject mock, simulated, and unmarked measurements', t => {
  const env = setup(t);
  const variants: Array<Partial<TestReceipt>> = [
    { execution_backend: 'mock', simulated: true }, { simulated: true }, { simulated: undefined },
  ];
  for (const changes of variants) {
    env.saveReceipt({ ...env.measured.receipt, ...changes });
    for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
      rejected(() => prepareSubmission(env.project, env.submission(verdict)), `${verdict} must not use simulated evidence: ${JSON.stringify(changes)}`);
    }
  }
});

test('zero-kernel SSH conclusions need evidence belonging to the current research', t => {
  const env = setup(t);
  env.startResearch('other_research');
  const foreign = env.measurement('other_research');
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    const submission = env.submission(verdict);
    submission.experiments[0].full_size_test_refs = [foreign.ref];
    rejected(() => prepareSubmission(env.project, submission), `${verdict} cannot be established entirely by another research's measurements`);
  }
});

test('zero-kernel SSH conclusions reject mismatched environment, suite, and measurement protocol', t => {
  const env = setup(t);
  for (const changes of [
    { environment_ref: 'other-device-environment' }, { case_suite_revision: 'other-suite' }, { measurement_protocol_ref: 'other-protocol' },
  ]) {
    env.saveReceipt({ ...env.measured.receipt, ...changes });
    for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
      rejected(() => prepareSubmission(env.project, env.submission(verdict)), `${verdict} requires compatible measurements: ${JSON.stringify(changes)}`);
    }
  }
});

test('zero-kernel SSH conclusions reject receipts copied into an agent draft', t => {
  const env = setup(t);
  const ref = receiptRef(env.project, join(env.project.dataRoot, 'research', env.researchId, 'drafts', 'claimed-test.json'));
  writeJson(join(env.project.root, ref), env.measured.receipt);
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    const submission = env.submission(verdict);
    submission.experiments[0].full_size_test_refs = [ref];
    rejected(() => prepareSubmission(env.project, submission), `${verdict} requires a tool-owned receipt`);
  }
});

test('zero-kernel SSH conclusions require verifiable real build provenance for test receipts', t => {
  const env = setup(t);
  env.saveReceipt({ ...env.measured.receipt, build_ref: 'missing-build.json' });
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    rejected(() => prepareSubmission(env.project, env.submission(verdict)), `${verdict} requires a linked build`);
  }
  env.saveReceipt(env.measured.receipt);
  env.saveBuild({ ...env.measured.build, execution_backend: 'mock', simulated: true });
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    rejected(() => prepareSubmission(env.project, env.submission(verdict)), `${verdict} cannot relabel a mock build as a real measurement`);
  }
});

test('build success, failed tests, and empty measurements cannot settle a performance hypothesis', t => {
  const env = setup(t);
  const failures: Array<TestReceipt> = [
    { ...env.measured.receipt, status: 'FAILED' },
    { ...env.measured.receipt, rows: [], data_hash: hashObject([]), supported_correct_count: 0, timed_case_count: 0 },
    (() => {
      const rows = env.measured.receipt.rows.map(row => ({ ...row, samples_us: [], median_us: undefined }));
      return { ...env.measured.receipt, rows, data_hash: hashObject(rows), timed_case_count: 0 };
    })(),
  ];
  for (const receipt of failures) {
    env.saveReceipt(receipt);
    for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
      rejected(() => prepareSubmission(env.project, env.submission(verdict)), `${verdict} needs actual usable measurements`);
    }
  }
  env.saveReceipt(env.measured.receipt);
  for (const verdict of ['SUPPORTED', 'REFUTED'] as const) {
    const submission = env.submission(verdict);
    submission.experiments[0].full_size_test_refs = [];
    submission.hypothesis[verdict === 'SUPPORTED' ? 'supporting_evidence' : 'counterevidence'] = [env.measured.buildRef];
    rejected(() => prepareSubmission(env.project, submission), `${verdict} is not proved by compiling a kernel`);
  }
});

for (const [verdict, candidateTimes] of [['SUPPORTED', [100, 120]], ['REFUTED', [1, 2]]] as const) {
  test(`a ${verdict} conclusion can commit with zero kernels regardless of absolute performance rank`, t => {
    const env = setup(t);
    const candidate = env.measurement(env.researchId, 'candidate', [...candidateTimes]);
    const control = env.measurement(env.researchId, 'control', [10, 40]);
    env.startResearch('background_research');
    const background = env.measurement('background_research', 'background', [4, 8]);
    const submission = env.submission(verdict);
    submission.experiments[0].kernel_revisions.push(control.receipt.kernel_ref);
    submission.experiments[0].full_size_test_refs = [candidate.ref, control.ref];
    submission.experiments[0].analysis = verdict === 'SUPPORTED'
      ? 'The candidate is slower on every case, but its shape ratio is 1.2, supporting the stated prediction.'
      : 'The candidate is faster on every case, but its shape ratio is 2, contradicting the stated prediction.';
    submission.hypothesis[verdict === 'SUPPORTED' ? 'supporting_evidence' : 'counterevidence'].push('Shared prior research motivated the tile choice; it is background, not this experiment.');
    submission.knowledge_updates = [{
      claim_id: 'scaling_observation', kind: 'observation', statement: 'Shape scaling and absolute latency answer different questions',
      scope: submission.hypothesis.scope, evidence_refs: [candidate.ref, background.ref], related_material_ids: ['prior_tile_knowledge'],
    }];
    assert.ok(candidateTimes.every((time, index) => verdict === 'SUPPORTED'
      ? time > control.receipt.rows[index].median_us! : time < control.receipt.rows[index].median_us!));
    const prepared = prepareSubmission(env.project, submission);
    const report = commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id);
    assert.equal(report.research_goal_met, true);
    assert.equal(report.verdict, verdict);
    assert.equal(report.submitted_kernel_count, 0);
  });
}

test('same-research historical measurements remain usable in later analysis and as direct evidence refs', t => {
  const env = setup(t);
  const submission = env.submission();
  submission.experiments[0].experiment_id = 'later_analysis';
  submission.hypothesis.supporting_evidence = [env.measured.ref];
  const prepared = prepareSubmission(env.project, submission);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.research_goal_met, true);
  assert.equal(report.submitted_kernel_count, 0);
});

test('a real profile with a matching experiment build supports a zero-kernel conclusion', t => {
  const env = setup(t);
  const profile = env.profile();
  const submission = env.submission();
  submission.experiments[0].full_size_test_refs = [];
  submission.experiments[0].profile_refs = [profile.ref];
  const prepared = prepareSubmission(env.project, submission);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.research_goal_met, true);
  assert.equal(report.verdict, 'SUPPORTED');
  assert.equal(report.submitted_kernel_count, 0);
});

const invalidProfiles: Array<{ name: string; changes: Partial<ProfileReceipt> }> = [
  { name: 'simulated', changes: { simulated: true } },
  { name: 'different build source', changes: { source_hash: hashObject('unmeasured-source') } },
  { name: 'different build revision', changes: { kernel_ref: { kernel_id: 'candidate', revision: 'r2' } } },
];
for (const { name, changes } of invalidProfiles) {
  test(`a zero-kernel conclusion rejects profile evidence with ${name}`, t => {
    const env = setup(t);
    const profile = env.profile(changes);
    const submission = env.submission();
    submission.experiments[0].full_size_test_refs = [];
    submission.experiments[0].profile_refs = [profile.ref];
    rejected(() => prepareSubmission(env.project, submission), 'Profile evidence must match a real build in its experiment');
  });
}

test('commit rechecks the real evidence used by a prepared zero-kernel conclusion', t => {
  const env = setup(t);
  const submission = env.submission();
  const prepared = prepareSubmission(env.project, submission);
  env.saveReceipt({ ...env.measured.receipt, simulated: true });
  rejected(() => commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id), 'Preparation must not bypass evidence validation at commit');
});

test('an inconclusive SSH investigation can close with background knowledge and no kernels', t => {
  const env = setup(t);
  const submission = env.submission('INCONCLUSIVE');
  submission.termination_reason = 'No usable hardware observation was obtained';
  submission.experiments[0].full_size_test_refs = [];
  submission.experiments[0].kernel_revisions = [];
  submission.hypothesis.supporting_evidence = ['A shared knowledge entry suggests the tile may improve scaling'];
  submission.hypothesis.limitations = ['No valid experiment was completed'];
  const prepared = prepareSubmission(env.project, submission);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.research_goal_met, false);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal(report.submitted_kernel_count, 0);
});
