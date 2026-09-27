import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildReceipt, Project, Submission, TestReceipt } from '../contracts.ts';
import { hashObject, readJson, writeJson } from '../util.ts';
import { commitSubmission, prepareSubmission, SubmissionValidationError } from '../submit.ts';
import { compareDesign } from '../design/service.ts';
import { processIntegrationEvents } from '../integration-events.ts';
import { getEvidenceStatus, getIntegrationReport } from '../report.ts';
import { buildReceiptPath, computeSourceHash, experimentDir, receiptRef } from '../kernel-build.ts';
import type { KernelModule } from '../contracts.ts';
import { sampleMaterials } from '../sampling.ts';
import { claimDbIntegrationEvent, finishDbIntegrationEventWithToken, storePaths } from '../store.ts';
import { targetPath } from '../workspace.ts';

test('prepare rejects partial, corrupt, and stale full-size receipts', () => {
  const project = makeProject();
  const good = makeReceipt(project, 'k_bad', 'r1', [10, 20]);
  const missing = { ...good, rows: good.rows.slice(0, 1) };
  const notRun = { ...good, rows: good.rows.map((row, index) => index === 1 ? { ...row, status: 'NOT_RUN', samples_us: [], median_us: undefined } : row) };
  const stale = { ...good, source_hash: 'wrong', rows: good.rows.map(row => ({ ...row, source_hash: 'wrong' })) };

  for (const [name, receipt] of Object.entries({ missing, notRun, stale })) {
    const receiptPath = writeReceipt(project, `${name}.json`, receipt as TestReceipt);
    const submission = makeSubmission(project, {
      kernelId: 'k_bad',
      revision: 'r1',
      receiptPath,
      receipt: receipt as TestReceipt,
      verdict: 'INCONCLUSIVE',
    });
    if (name === 'stale') submission.submitted_kernels[0].source_hash = 'k_bad-r1-source';
    assert.throws(
      () => prepareSubmission(project, submission),
      (error: unknown) => error instanceof SubmissionValidationError && error.issues.length > 0,
    );
  }
});

test('mock verdict is independent from kernel ranking and cannot satisfy real goal', () => {
  const project = makeProject('mock');
  const receipt = makeReceipt(project, 'k_fast', 'r1', [1, 1]);
  const receiptPath = writeReceipt(project, 'fast.json', receipt);
  const supported = makeSubmission(project, {
    kernelId: 'k_fast',
    revision: 'r1',
    receiptPath,
    receipt,
    verdict: 'SUPPORTED',
  });
  assert.throws(() => prepareSubmission(project, supported), /mock runs cannot prove/);

  const submission = makeSubmission(project, {
    kernelId: 'k_fast',
    revision: 'r1',
    receiptPath,
    receipt,
    verdict: 'INCONCLUSIVE',
    simulatedVerdict: 'SUPPORTED',
  });
  const prepared = prepareSubmission(project, submission);
  const report = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.research_goal_met, false);
  assert.equal(report.submitted_kernel_count, 1);
});

test('prepare freezes submission without scheduling integration', () => {
  const project = makeProject();
  const receipt = makeReceipt(project, 'k_prepare', 'r1', [10, 10]);
  const receiptPath = writeReceipt(project, 'prepare.json', receipt);
  const submission = makeSubmission(project, { kernelId: 'k_prepare', revision: 'r1', receiptPath, receipt });
  prepareSubmission(project, submission);
  const status = getEvidenceStatus(project, submission.research_id);
  assert.equal(status.integration_events.length, 0);
  assert.equal(status.prepared_submissions, 1);
});

test('ssh design builds require comparison before formal kernel submission', () => {
  const project = makeProject('ssh');
  const receipt = makeReceipt(project, 'k_design_gate', 'r1', [10, 10]);
  const designRef = attachDesign(project, receipt);
  const receiptPath = writeReceipt(project, 'design-gate.json', receipt);
  const submission = makeSubmission(project, { kernelId: 'k_design_gate', revision: 'r1', receiptPath, receipt });

  assert.throws(
    () => prepareSubmission(project, submission),
    (error: unknown) => error instanceof SubmissionValidationError
      && error.issues.some(issue => issue.code === 'MISSING_DESIGN_COMPARISON'
        && /existing test\/profile receipt_refs/.test(issue.message)
        && /no new hardware run/.test(issue.message)),
  );

  const probeRef = writeProbeReceipt(project, receipt, 'design-gate-probe.json');
  expireResearch(project);
  compareDesign(project, { research_id: 'research_1', design_ref: designRef, receipt_refs: [probeRef],
    analysis: { matched: ['probe receipt belongs to the exact submitted build'], deviations: [], unknown: ['per-activity timing was not collected'] } });
  const prepared = prepareSubmission(project, submission);
  const report = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.submitted_kernel_count, 1);
});

test('commit rechecks design comparison integrity and exact build identity', () => {
  for (const mode of ['removed', 'corrupted', 'foreign', 'wrong-name', 'wrong-measurement'] as const) {
    const project = makeProject('ssh');
    const receipt = makeReceipt(project, `k_${mode}`, 'r1', [10, 10]);
    const designRef = attachDesign(project, receipt);
    const receiptPath = writeReceipt(project, `${mode}.json`, receipt);
    const probeRef = writeProbeReceipt(project, receipt, `${mode}-probe.json`);
    const comparison = compareDesign(project, { research_id: 'research_1', design_ref: designRef, receipt_refs: [probeRef],
      analysis: { matched: ['probe receipt belongs to the exact submitted build'], deviations: [], unknown: ['per-activity timing was not collected'] } });
    const submission = makeSubmission(project, { kernelId: `k_${mode}`, revision: 'r1', receiptPath, receipt });
    const prepared = prepareSubmission(project, submission);
    const comparisonPath = join(project.root, comparison.comparison_ref);

    if (mode === 'removed') rmSync(comparisonPath);
    else {
      const stored = readJson<any>(comparisonPath);
      if (mode === 'corrupted') writeJson(comparisonPath, { ...stored, content_hash: 'not-the-canonical-hash' });
      else if (mode === 'foreign') {
        stored.value.design_ref = 'ir/research_1/foreign/design.json';
        rewriteComparison(comparisonPath, stored.value);
      } else if (mode === 'wrong-name') {
        rmSync(comparisonPath);
        writeJson(join(dirname(comparisonPath), 'wrong-name.json'), stored);
      } else {
        const other = makeReceipt(project, `k_${mode}_other`, 'r1', [20, 20]);
        attachDesign(project, other);
        const otherProbeRef = writeProbeReceipt(project, other, `${mode}-other-probe.json`);
        const otherProbe = readJson(otherProbeRef);
        stored.value.evidence[0] = { ...stored.value.evidence[0], receipt_ref: otherProbeRef,
          content_hash: hashObject(otherProbe), receipt: otherProbe };
        rewriteComparison(comparisonPath, stored.value);
      }
    }

    assert.throws(
      () => commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id),
      (error: unknown) => error instanceof SubmissionValidationError
        && error.issues.some(issue => issue.code === 'MISSING_DESIGN_COMPARISON'),
      mode,
    );
  }
});

test('commit and event processing are idempotent', async () => {
  const project = makeProject();
  const receipt = makeReceipt(project, 'k_idem', 'r1', [5, 6]);
  const receiptPath = writeReceipt(project, 'idem.json', receipt);
  const submission = makeSubmission(project, { kernelId: 'k_idem', revision: 'r1', receiptPath, receipt });
  const prepared = prepareSubmission(project, submission);
  const first = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  const second = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(first.submission_id, second.submission_id);
  assert.equal(getEvidenceStatus(project, submission.research_id).integration_events.length, 1);

  const processed = await processIntegrationEvents(project);
  const processedAgain = await processIntegrationEvents(project);
  assert.equal(processed.processed, 1);
  assert.equal(processedAgain.processed, 0);
  assert.equal(getEvidenceStatus(project, submission.research_id).integration_events.length, 1);
});

test('zero submitted kernels commit and auto-skip integration', async () => {
  const project = makeProject();
  const submission = makeSubmission(project, { kernels: [] });
  const prepared = prepareSubmission(project, submission);
  const report = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  assert.equal(report.submitted_kernel_count, 0);
  const processed = await processIntegrationEvents(project);
  assert.equal(processed.skipped, 1);
  const integration = getIntegrationReport(project, report.integration_event_id) as any;
  assert.equal(integration.status, 'SKIPPED');
  assert.equal(integration.integration_validation, 'NOT_RUN');
});

test('automatic integration routes exact measured shapes and keeps mock data isolated', async () => {
  const project = makeProject('mock');
  const a = makeReceipt(project, 'k_a', 'r1', [3, 20]);
  const b = makeReceipt(project, 'k_b', 'r1', [10, 2]);
  const aPath = writeReceipt(project, 'a.json', a);
  const bPath = writeReceipt(project, 'b.json', b);
  const submission = makeSubmission(project, {
    kernels: [
      kernelSubmission(project, 'k_a', 'r1', aPath, a, ['case_a', 'case_b']),
      kernelSubmission(project, 'k_b', 'r1', bPath, b, ['case_a', 'case_b']),
    ],
  });
  const prepared = prepareSubmission(project, submission);
  const committed = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  const processed = await processIntegrationEvents(project);
  assert.equal(processed.assembled, 1);
  const integration = getIntegrationReport(project, committed.integration_event_id) as any;
  assert.equal(integration.status, 'ASSEMBLED');
  assert.equal(integration.integration_validation, 'NOT_RUN');

  const selections = (await import('../util.ts')).readJson<any>(integration.selections_ref);
  assert.deepEqual(selections.rules.map((rule: any) => [rule.case_id, rule.kernel_id]), [['case_a', 'k_a'], ['case_b', 'k_b']]);
  assert.deepEqual(selections.rules.map((rule: any) => rule.shape), project.suite.cases.map(item => item.shape));

  const sshProject = makeProject('ssh', project.root);
  assert.equal(getEvidenceStatus(sshProject).committed_submissions, 0);
});

test('sampling uses SQLite materials and duplicate commit does not refresh novelty', () => {
  const project = makeProject();
  const receipt = makeReceipt(project, 'k_sample', 'r1', [7, 8]);
  const receiptPath = writeReceipt(project, 'sample.json', receipt);
  const submission = makeSubmission(project, { kernelId: 'k_sample', revision: 'r1', receiptPath, receipt });
  const prepared = prepareSubmission(project, submission);
  commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);

  const draw = sampleMaterials(project, { seed: 1234, count: 10, now: '2026-09-23T00:00:00.000Z' });
  assert.ok(draw.candidates.some(candidate => candidate.material_id === 'claim_1'));
  assert.ok(draw.candidates.some(candidate => candidate.material_id === 'k_sample@r1'));
  assert.equal(draw.candidates.find(candidate => candidate.material_id === 'claim_1')?.ref, 'sqlite://observation/claim_1');
  assert.equal(sqliteScalar(project, 'SELECT COUNT(*) FROM novelty_events WHERE material_id = "claim_1"'), 1);
});

test('integration event lease cannot be stolen and finish is token-CAS', () => {
  const project = makeProject();
  const submission = makeSubmission(project, { kernels: [] });
  const prepared = prepareSubmission(project, submission);
  const report = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  const claimed = claimDbIntegrationEvent(project, report.integration_event_id, 'token-a');
  assert.equal(claimed?.integration_event_id, report.integration_event_id);
  assert.equal(claimDbIntegrationEvent(project, report.integration_event_id, 'token-b'), undefined);
  assert.throws(() => finishDbIntegrationEventWithToken(project, report.integration_event_id, 'token-b', 'SKIPPED', 'x'), /lease token mismatch/);
  finishDbIntegrationEventWithToken(project, report.integration_event_id, 'token-a', 'SKIPPED', 'x');
});

function makeProject(backend: 'mock' | 'ssh' = 'mock', root = mkdtempSync(join(tmpdir(), 'meteor-evidence-'))): Project {
  const dataRoot = join(root, 'reports', 'meteor', backend);
  const project: Project = {
    root,
    dataRoot,
    config: {
      schema_version: 1,
      execution: { backend, profile_ref: `${backend}-profile` },
      case_suite: 'suite-qmq-v1',
      environment: {
        environment_ref: backend === 'mock' ? 'mock-env' : 'ssh-env',
        hardware: backend === 'mock' ? 'mock' : 'Ascend',
        toolchain: 'mock-toolchain',
        measurement_protocol_ref: 'protocol-v1',
        simulated: backend === 'mock',
      },
      sampling: { epsilon: 0.05, lambda: 2, tau_hours: 72, count: 2 },
      budget: { max_experiments: 3, max_wall_time_seconds: 3600 },
      integration: { min_relative_improvement: 0.02 },
    },
    suite: {
      revision: 'suite-rev-1',
      operator_abi: 'qmq-v1',
      cases: [
        { case_id: 'case_a', shape: { m: 16, n: 16, k: 64 }, dtype: 'fp16', layout: 'ND', input_hash: 'input-a', oracle_hash: 'oracle-a' },
        { case_id: 'case_b', shape: { m: 32, n: 16, k: 64 }, dtype: 'fp16', layout: 'ND', input_hash: 'input-b', oracle_hash: 'oracle-b' },
      ],
    },
  };
  const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'qmq-v1', 'int8');
  mkdirSync(join(root, 'asc'), { recursive: true });
  copyFileSync(join(templateRoot, 'version.asc.tmpl'), join(root, 'asc', 'version.asc.tmpl'));
  copyFileSync(join(templateRoot, 'host_context.asc.inc'), join(root, 'asc', 'host_context.asc.inc'));
  writeJson(join(root, 'asc', 'operator.json'), { inputs: { x: 'int8' }, outputs: { y: 'int8' }, semantics: ['fixture'] });
  writeJson(join(dataRoot, 'research', 'research_1', 'manifest.json'), {
    research_id: 'research_1',
    agent_session_id: 'session_1',
    chief_id: 'chief_1',
    execution_backend: backend,
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    goal: 'test',
    run_status: 'ACTIVE',
    created_at: new Date().toISOString(),
    budget: project.config.budget,
    research_goal_met: false,
  });
  return project;
}

function makeReceipt(project: Project, kernelId: string, revision: string, medians: number[]): TestReceipt {
  const kernelRef = { kernel_id: kernelId, revision };
  const sourceHash = ensureModule(project, kernelId, revision);
  const build: BuildReceipt = {
    build_id: `build_${kernelId}_${revision}`, research_id: 'research_1', experiment_id: 'experiment_1', kernel_ref: kernelRef,
    source_hash: sourceHash, artifact_hash: hashObject({ kernelId, revision, artifact: true }),
    environment_ref: project.config.environment.environment_ref, execution_backend: project.config.execution.backend,
    simulated: project.config.environment.simulated, status: 'COMPLETED',
    source_ref: `kernels/${kernelId}/${revision}`, module_ref: `kernels/${kernelId}/${revision}/kernel.json`,
  };
  const buildPath = buildReceiptPath(project, build);
  writeJson(buildPath, build);
  const rows = project.suite.cases.map((testCase, index) => ({
    case_id: testCase.case_id,
    status: 'PASS' as const,
    samples_us: [medians[index], medians[index] + 1],
    median_us: medians[index],
    actual_kernel_ref: kernelRef,
    source_hash: sourceHash,
    input_hash: testCase.input_hash,
    oracle_hash: testCase.oracle_hash,
    ...(project.config.execution.backend === 'ssh' ? { device_execution: { status: 'CONFIRMED' as const,
      matched_tasks: [{ device_id: 0, task_type: 'AI_CORE', op_name: `${kernelId}_${revision}_kernel` }] } } : {}),
  }));
  const receipt: TestReceipt = {
    run_id: `run_${kernelId}_${revision}`,
    research_id: 'research_1',
    experiment_id: 'experiment_1',
    kernel_ref: kernelRef,
    build_ref: receiptRef(project, buildPath),
    source_hash: sourceHash,
    artifact_hash: build.artifact_hash,
    execution_backend: project.config.execution.backend,
    simulated: project.config.environment.simulated,
    fixture_id: project.config.execution.backend === 'mock' ? 'fixture' : undefined,
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    mode: 'full',
    status: 'COMPLETED',
    rows,
    accounting_complete: true,
    supported_correct_count: rows.length,
    timed_case_count: rows.length,
    data_hash: '',
  };
  receipt.data_hash = hashObject(receipt.rows);
  return receipt;
}

function writeReceipt(project: Project, name: string, receipt: TestReceipt): string {
  const stored = { ...receipt, run_id: receipt.run_id + '_' + name.replace(/\.json$/, '') };
  const path = join(experimentDir(project, stored.research_id, stored.experiment_id), 'full-tests', stored.run_id + '.json');
  writeJson(path, stored);
  return path;
}

function expireResearch(project: Project): void {
  const path = join(project.dataRoot, 'research', 'research_1', 'manifest.json');
  const record = readJson<any>(path);
  writeJson(path, { ...record, created_at: '2000-01-01T00:00:00.000Z', budget: { ...record.budget, max_wall_time_seconds: 1 } });
}

function projectRef(project: Project, path: string): string {
  return relative(project.root, path).replaceAll('\\', '/');
}

function writeDesignArtifact(path: string, value: unknown): void {
  writeJson(path, { value, content_hash: hashObject(value) });
}

function rewriteComparison(previousPath: string, value: unknown): string {
  const nextPath = join(dirname(previousPath), `${hashObject(value)}.json`);
  if (nextPath !== previousPath) rmSync(previousPath);
  writeJson(nextPath, { value, content_hash: hashObject(value) });
  return nextPath;
}

function attachDesign(project: Project, receipt: TestReceipt): string {
  const buildPath = join(project.root, receipt.build_ref);
  const build = readJson<BuildReceipt>(buildPath);
  const module = readJson<KernelModule>(join(project.root, build.module_ref));
  const designId = `design_${build.kernel_ref.kernel_id}_${build.kernel_ref.revision}`;
  const designPath = targetPath(project, 'ir', build.research_id, designId, 'design.json');
  const designRef = projectRef(project, designPath);
  const formulaPath = join(project.root, 'asc', 'operator.json');
  const design = {
    schema_version: 1,
    design_id: designId,
    research_id: build.research_id,
    experiment_id: build.experiment_id,
    strategy: 'layered-ir@1',
    kernel_path: build.source_ref,
    kernel_ref: build.kernel_ref,
    module_hash: hashObject(module),
    formula_ref: projectRef(project, formulaPath),
    formula_hash: hashObject(readJson(formulaPath)),
    environment_ref: build.environment_ref,
    case_suite_revision: project.suite.revision,
  };
  writeDesignArtifact(designPath, design);
  writeDesignArtifact(join(dirname(designPath), 'frozen.json'), { status: 'READY', source_hash: build.source_hash });
  writeJson(buildPath, { ...build, design_ref: designRef });
  return designRef;
}

function writeProbeReceipt(project: Project, receipt: TestReceipt, name: string): string {
  const probe: TestReceipt = {
    ...receipt,
    run_id: receipt.run_id + '_' + name.replace(/\.json$/, ''),
    mode: 'probe',
    rows: receipt.rows.slice(0, 1),
    accounting_complete: false,
  };
  probe.data_hash = hashObject(probe.rows);
  const path = join(experimentDir(project, probe.research_id, probe.experiment_id), 'full-tests', probe.run_id + '.json');
  writeJson(path, probe);
  return path;
}

function kernelSubmission(project: Project, kernelId: string, revision: string, receiptPath: string, receipt: TestReceipt, recommendedCaseIds = ['case_a', 'case_b']) {
  const passCases = receipt.rows.filter(row => row.status === 'PASS').map(row => row.case_id);
  return {
    kernel_id: kernelId,
    revision,
    source_hash: receipt.source_hash,
    artifact_refs: [`kernels/${kernelId}/${revision}/kernel.json`],
    supported_domain: 'measured full suite only',
    verified_case_ids: passCases,
    recommended_domain: 'recommended measured cases only',
    recommended_case_ids: recommendedCaseIds,
    hardware_scope: project.config.environment.hardware,
    resource_constraints: [],
    unsupported_cases: [],
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    full_size_test_ref: receiptPath,
    test_status: 'COMPLETED' as const,
    performance_data_ref: receiptPath,
    data_hash: receipt.data_hash,
    measured_tradeoffs: 'mock measured',
    limitations: ['mock evidence only'],
  };
}

function ensureModule(project: Project, kernelId: string, revision: string): string {
  const kernelPath = join(project.root, 'kernels', kernelId, revision);
  mkdirSync(kernelPath, { recursive: true });
  const prefix = `${kernelId}_${revision}_`.replace(/[^A-Za-z0-9_]/g, '_');
  const module: KernelModule = {
    kernel_id: kernelId,
    revision,
    operator_abi: project.suite.operator_abi,
    symbol_prefix: prefix,
    launcher: `${prefix}launch`,
    device_file: `kernels/${kernelId}/${revision}/device.asc`,
    host_file: `kernels/${kernelId}/${revision}/host.asc`,
    supported_case_ids: project.suite.cases.map(item => item.case_id),
    dependencies: [],
    hardware_scope: project.config.environment.hardware,
    resource_constraints: [],
  };
  writeJson(join(kernelPath, 'kernel.json'), module);
  writeFileSync(join(project.root, module.device_file), `// ${kernelId} ${revision}\n`);
  writeFileSync(join(project.root, module.host_file), `MeteorStatus ${module.launcher}(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Unsupported; }\n`);
  return computeSourceHash(project, module);
}

function makeSubmission(project: Project, options: any = {}): Submission {
  const kernels = options.kernels ?? (options.kernelId ? [
    kernelSubmission(project, options.kernelId, options.revision, options.receiptPath, options.receipt, options.recommendedCaseIds),
  ] : []);
  return {
    research_id: 'research_1',
    agent_session_id: 'session_1',
    execution_backend: project.config.execution.backend,
    termination_reason: 'test complete',
    hypothesis: {
      hypothesis_id: 'hypothesis_1',
      revision: 'h1',
      statement: 'A measured intervention may improve selected cases',
      scope: 'fixed qmq suite',
      mechanism: 'changes data movement',
      intervention: 'change kernel body',
      controls: ['baseline'],
      predictions: ['measured cases change'],
      support_criteria: ['controlled evidence supports mechanism'],
      refutation_criteria: ['controlled evidence contradicts mechanism'],
      confounders: ['mock data'],
      measurement_plan: 'full suite plus analysis',
      verdict: options.verdict ?? 'INCONCLUSIVE',
      supporting_evidence: options.verdict === 'SUPPORTED' ? ['experiment_1'] : [],
      counterevidence: options.verdict === 'REFUTED' ? ['experiment_1'] : [],
      limitations: ['mock cannot prove hardware hypothesis'],
      simulated_verdict: options.simulatedVerdict,
    },
    hypothesis_history: [{
      hypothesis: {
        hypothesis_id: 'hypothesis_1',
        revision: 'h1',
        statement: 'A measured intervention may improve selected cases',
        scope: 'fixed qmq suite',
        mechanism: 'changes data movement',
        intervention: 'change kernel body',
        controls: ['baseline'],
        predictions: ['measured cases change'],
        support_criteria: ['controlled evidence supports mechanism'],
        refutation_criteria: ['controlled evidence contradicts mechanism'],
        confounders: ['mock data'],
        measurement_plan: 'full suite plus analysis',
        verdict: options.verdict ?? 'INCONCLUSIVE',
        supporting_evidence: [],
        counterevidence: [],
        limitations: ['initial'],
      },
      reason: 'initial hypothesis',
    }],
    experiments: [{
      experiment_id: 'experiment_1',
      hypothesis_revision: 'h1',
      question: 'does the intervention change performance',
      intervention: 'kernel change',
      controls: ['baseline'],
      kernel_revisions: kernels.map((kernel: any) => ({ kernel_id: kernel.kernel_id, revision: kernel.revision })),
      environment_ref: project.config.environment.environment_ref,
      full_size_test_refs: kernels.map((kernel: any) => kernel.full_size_test_ref),
      profile_refs: [],
      analysis: 'rank is recorded separately from hypothesis verdict',
      next_experiment: 'none',
    }],
    submitted_kernels: kernels,
    knowledge_updates: [{
      claim_id: 'claim_1',
      kind: 'observation',
      statement: 'mock evidence was recorded',
      scope: 'mock',
      evidence_refs: kernels.length ? kernels.map((kernel: any) => kernel.full_size_test_ref) : ['experiment_1'],
      related_material_ids: [],
    }],
    chief_report: {
      summary: 'test report',
      findings: ['verdict and ranking are separate'],
      unresolved: ['real hardware'],
      next_steps: ['run on configured ssh backend'],
    },
  };
}

function sqliteScalar(project: Project, sql: string): number {
  const script = [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'print(db.execute(sys.argv[2]).fetchone()[0])',
  ].join('; ');
  const result = spawnSync('python', ['-c', script, join(storePaths(project).knowledgeRoot, 'catalog.sqlite'), sql], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}
