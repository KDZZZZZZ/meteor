import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { BuildReceipt, KernelModule, Submission, TestReceipt } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel, buildReceiptPath, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel } from '../templates/project/tools/meteor/kernel-test.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission, SubmissionValidationError } from '../templates/project/tools/meteor/submit.ts';
import { writeJson } from '../templates/project/tools/meteor/util.ts';

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-submission-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' });
  const project = loadProject(root);
  const kernelPath = 'kernels/research_A/shared/r1';
  const module: KernelModule = {
    kernel_id: 'shared', revision: 'r1', operator_abi: project.suite.operator_abi,
    symbol_prefix: 'shared_', launcher: 'shared_launch',
    device_file: kernelPath + '/device.asc', host_file: kernelPath + '/host.asc',
    supported_case_ids: [project.suite.cases[0].case_id], dependencies: [],
    hardware_scope: 'mock', resource_constraints: [],
  };
  writeJson(join(root, kernelPath, 'kernel.json'), module);
  writeFileSync(join(root, module.device_file), '// shared reference kernel\n');
  writeFileSync(join(root, module.host_file), 'MeteorStatus shared_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  for (const id of ['research_A', 'research_B']) {
    createResearch(project, { research_id: id, agent_session_id: 'pending', chief_id: 'chief', goal: 'Check evidence ownership' });
    bindResearchSession(project, id, 'session_' + id);
  }
  async function measure(researchId: string) {
    const build = await buildKernel(project, { research_id: researchId, experiment_id: 'measured_1', kernel_path: kernelPath });
    const receipt = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full' });
    const ref = receiptRef(project, join(experimentDir(project, researchId, receipt.experiment_id), 'full-tests', receipt.run_id + '.json'));
    return { build, receipt, ref };
  }
  const original = await measure('research_A');
  function submission(researchId: string, receipt = original.receipt, ref = original.ref): Submission {
    const verified = receipt.rows.filter(row => row.status === 'PASS').map(row => row.case_id);
    return {
      research_id: researchId, agent_session_id: 'session_' + researchId, execution_backend: 'mock', termination_reason: 'Local verification complete',
      hypothesis: {
        hypothesis_id: 'hypothesis', revision: 'h1', statement: 'A referenced kernel can be independently measured', scope: 'Mock protocol',
        mechanism: 'Independent measurement', intervention: 'Measure the shared revision', controls: [], predictions: ['Complete evidence'],
        support_criteria: ['Controlled measurements'], refutation_criteria: ['Contradictory measurements'], confounders: ['Simulation'],
        measurement_plan: 'Full suite', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'],
      },
      hypothesis_history: [],
      experiments: [{
        experiment_id: 'later_analysis', hypothesis_revision: 'h1', question: 'Can prior measurements support this submission?',
        intervention: 'Review historical data', controls: [], kernel_revisions: [receipt.kernel_ref], environment_ref: receipt.environment_ref,
        full_size_test_refs: [ref, original.ref], profile_refs: [], analysis: 'Reference material remains readable', next_experiment: 'Real hardware',
      }],
      submitted_kernels: [{
        ...receipt.kernel_ref, source_hash: receipt.source_hash, artifact_refs: [kernelPath + '/kernel.json'], supported_domain: 'Measured cases',
        verified_case_ids: verified, recommended_domain: 'Measured cases', recommended_case_ids: verified, hardware_scope: 'mock',
        resource_constraints: [], unsupported_cases: receipt.rows.filter(row => row.status === 'UNSUPPORTED').map(row => row.case_id),
        case_suite_revision: receipt.case_suite_revision, environment_ref: receipt.environment_ref, measurement_protocol_ref: receipt.measurement_protocol_ref,
        full_size_test_ref: ref, test_status: 'COMPLETED', performance_data_ref: ref, data_hash: receipt.data_hash,
        measured_tradeoffs: 'Mock protocol only', limitations: ['Requires hardware measurement'],
      }],
      knowledge_updates: [{
        claim_id: 'reference', kind: 'observation', statement: 'Another research offers useful reference material', scope: 'Mock reference',
        evidence_refs: [original.ref], related_material_ids: [],
      }],
      chief_report: { summary: 'Evidence ownership checked', findings: ['Mock only'], unresolved: ['Hardware performance'], next_steps: ['Run hardware tests'] },
    };
  }
  function copiedReceipt(name: string, changes: Partial<TestReceipt>) {
    const receipt = { ...original.receipt, ...changes };
    const ref = receiptRef(project, join(project.dataRoot, 'research', receipt.research_id, 'drafts', name + '.json'));
    writeJson(join(root, ref), receipt);
    return { receipt, ref };
  }
  return { project, original, measure, submission, copiedReceipt };
}

function hasIssue(path: string, code: string) {
  return (error: unknown) => error instanceof SubmissionValidationError
    && error.issues.some(issue => issue.path === path && issue.code === code);
}

test('submission rejects another research full test even for the exact same kernel revision', async t => {
  const env = await setup(t);
  assert.throws(() => prepareSubmission(env.project, env.submission('research_B')),
    hasIssue('submitted_kernels.0.full_size_test_ref.research_id', 'RESEARCH_MISMATCH'));
});

test('relabeling a full test cannot reuse another research build', async t => {
  const env = await setup(t);
  const copied = env.copiedReceipt('relabelled', { research_id: 'research_B' });
  assert.throws(() => prepareSubmission(env.project, env.submission('research_B', copied.receipt, copied.ref)),
    hasIssue('submitted_kernels.0.full_size_test_ref.build_ref.research_id', 'RESEARCH_MISMATCH'));
});

test('submission requires the linked build to match the tested revision, source, and artifact', async t => {
  const env = await setup(t);
  const variants: Array<{ name: string; changes: Partial<BuildReceipt>; code: string }> = [
    { name: 'kernel_ref', changes: { kernel_ref: { ...env.original.build.kernel_ref, revision: 'r2' } }, code: 'KERNEL_MISMATCH' },
    { name: 'source_hash', changes: { source_hash: 'different-source' }, code: 'SOURCE_MISMATCH' },
    { name: 'artifact_hash', changes: { artifact_hash: 'different-artifact' }, code: 'ARTIFACT_MISMATCH' },
  ];
  for (const variant of variants) {
    const buildRef = receiptRef(env.project, join(env.project.dataRoot, 'raw', 'build-' + variant.name + '.json'));
    writeJson(join(env.project.root, buildRef), { ...env.original.build, ...variant.changes });
    const copied = env.copiedReceipt('full-' + variant.name, { build_ref: buildRef });
    assert.throws(() => prepareSubmission(env.project, env.submission('research_A', copied.receipt, copied.ref)),
      hasIssue('submitted_kernels.0.full_size_test_ref.build_ref.' + variant.name, variant.code));
  }
});

test('submission rejects a full test with no verifiable build receipt', async t => {
  const env = await setup(t);
  const copied = env.copiedReceipt('missing-build', { build_ref: 'missing-build.json' });
  assert.throws(() => prepareSubmission(env.project, env.submission('research_A', copied.receipt, copied.ref)),
    hasIssue('submitted_kernels.0.full_size_test_ref.build_ref', 'MISSING_BUILD'));
});

test('submission rejects an otherwise identical full receipt copied into agent-writable drafts', async t => {
  const env = await setup(t);
  const copied = env.copiedReceipt('forged-full', {});
  assert.throws(() => prepareSubmission(env.project, env.submission('research_A', copied.receipt, copied.ref)),
    hasIssue('submitted_kernels.0.full_size_test_ref', 'UNTRUSTED_RECEIPT'));
});

test('submission rejects a linked build copied into agent-writable drafts', async t => {
  const env = await setup(t);
  const buildRef = receiptRef(env.project, join(env.project.dataRoot, 'research/research_A/drafts/build.json'));
  writeJson(join(env.project.root, buildRef), env.original.build);
  const copied = env.copiedReceipt('forged-build', { build_ref: buildRef });
  assert.throws(() => prepareSubmission(env.project, env.submission('research_A', copied.receipt, copied.ref)),
    hasIssue('submitted_kernels.0.full_size_test_ref.build_ref', 'UNTRUSTED_RECEIPT'));
});

test('submission recomputes the full receipt row hash', async t => {
  const env = await setup(t);
  const receipt = { ...env.original.receipt, rows: env.original.receipt.rows.map(row => row.status === 'PASS'
    ? { ...row, samples_us: [1, 1, 1, 1, 1], median_us: 1 } : row) };
  writeJson(join(env.project.root, env.original.ref), receipt);
  assert.throws(() => prepareSubmission(env.project, env.submission('research_A', receipt)),
    hasIssue('submitted_kernels.0.full_size_test_ref.data_hash', 'DATA_HASH_MISMATCH'));
});

test('SSH submissions reject simulated or unmarked full receipts', async t => {
  const env = await setup(t);
  env.project.config.execution.backend = 'ssh';
  env.project.config.environment.simulated = false;
  for (const simulated of [true, undefined]) {
    const receipt = { ...env.original.receipt, execution_backend: 'ssh' as const, simulated } as TestReceipt;
    writeJson(join(env.project.root, env.original.ref), receipt);
    const submission = { ...env.submission('research_A', receipt), execution_backend: 'ssh' as const };
    assert.throws(() => prepareSubmission(env.project, submission),
      hasIssue('submitted_kernels.0.full_size_test_ref.simulated', 'SIMULATION_MISMATCH'));
  }
});

test('submission requires the measured module artifact and unchanged source', async t => {
  const env = await setup(t);
  for (const refs of [[], ['asc/operator.json']]) {
    const submission = env.submission('research_A');
    submission.submitted_kernels[0].artifact_refs = refs;
    assert.throws(() => prepareSubmission(env.project, submission),
      hasIssue('submitted_kernels.0.artifact_refs', 'MISSING_MODULE'));
  }
  writeFileSync(join(env.project.root, env.original.build.source_ref, 'device.asc'), '// changed after testing\n');
  assert.throws(() => prepareSubmission(env.project, env.submission('research_A')),
    hasIssue('submitted_kernels.0.artifact_refs', 'STALE_SOURCE'));
});

test('the original session can reuse its historical measurements and independently test a referenced kernel', async t => {
  const env = await setup(t);
  const own = await env.measure('research_B');
  const submission = env.submission('research_B', own.receipt, own.ref);
  assert.notEqual(submission.experiments[0].experiment_id, own.receipt.experiment_id);
  assert.equal(own.build.source_ref, env.original.build.source_ref);
  assert.throws(() => prepareSubmission(env.project, { ...submission, agent_session_id: 'replacement-session' }),
    hasIssue('agent_session_id', 'SESSION_MISMATCH'));
  const prepared = prepareSubmission(env.project, submission);
  assert.equal(prepareSubmission(env.project, submission).prepared_submission_id, prepared.prepared_submission_id);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.research_id, 'research_B');
  assert.equal(report.submitted_kernel_count, 1);
});

test('foreign research evidence remains available as reference material without submitting its kernel', async t => {
  const env = await setup(t);
  const submission = env.submission('research_B');
  submission.submitted_kernels = [];
  assert.ok(prepareSubmission(env.project, submission).prepared_submission_id);
});
