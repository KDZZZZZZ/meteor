import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { KernelModule, Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel, buildReceiptPath, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel, testReceiptPath } from '../templates/project/tools/meteor/kernel-test.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission } from '../templates/project/tools/meteor/submit.ts';
import { integrateSubmission } from '../templates/project/tools/meteor/integrate.ts';
import { getIntegrationEvent, processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { claimDbIntegrationEvent, listDbIntegrationEvents, storePaths } from '../templates/project/tools/meteor/store.ts';
import { readJson } from '../templates/project/tools/meteor/util.ts';
import { configureAssemblyTemplate } from '../templates/project/tools/meteor/assembly-template.ts';

function queuedResearch(project: Project, id: string) {
  const session = `session-${id}`;
  createResearch(project, { research_id: id, chief_id: 'chief', agent_session_id: session, goal: 'Preserve untested research evidence' });
  const submission: Submission = {
    research_id: id, agent_session_id: session, execution_backend: project.config.execution.backend,
    termination_reason: 'No measured kernel is available',
    hypothesis: {
      hypothesis_id: `hypothesis-${id}`, revision: 'h1', statement: 'Tiling could reduce latency', scope: 'Fixed case suite',
      mechanism: 'Data reuse', intervention: 'Change tiling', controls: [], predictions: ['Latency decreases'],
      support_criteria: ['Controlled measurements agree'], refutation_criteria: ['Controlled measurements disagree'],
      confounders: [], measurement_plan: 'Measure independent kernels', verdict: 'INCONCLUSIVE',
      supporting_evidence: [], counterevidence: [], limitations: ['No real measurements'],
    },
    hypothesis_history: [],
    experiments: [{ experiment_id: 'planning', hypothesis_revision: 'h1', question: 'Can tiling help?', intervention: 'Plan tiling',
      controls: [], kernel_revisions: [], environment_ref: project.config.environment.environment_ref,
      full_size_test_refs: [], profile_refs: [], analysis: 'No execution was attempted', next_experiment: 'Measure a kernel' }],
    submitted_kernels: [], knowledge_updates: [],
    chief_report: { summary: 'Evidence is inconclusive', findings: [], unresolved: ['Measurements'], next_steps: ['Run the planned experiment'] },
  };
  const prepared = prepareSubmission(project, submission);
  return commitSubmission(project, prepared.prepared_submission_id, session);
}

function projectFixture(): Project {
  const root = mkdtempSync(join(tmpdir(), 'meteor-integration-channels-'));
  initProject(root, { git: false, backend: 'mock' });
  const project = loadProject(root);
  const source = join(root, 'test-version-template.asc.tmpl');
  writeFileSync(source, readFileSync(join(process.cwd(), 'templates/project/templates/qmq-v1/int8/version.asc.tmpl'), 'utf8'));
  configureAssemblyTemplate(project, { source_path: source, template_id: 'test-version-template', now: '2026-09-27T00:00:00.000Z' });
  return loadProject(root);
}

function scopedProjectFixture(t: TestContext): Project {
  const project = projectFixture();
  t.after(() => rmSync(project.root, { recursive: true, force: true }));
  return project;
}

async function measuredSubmission(project: Project, id: string, recommendedCaseIds: string[], samplesByCase: Record<string, number[]>) {
  const root = project.root;
  const kernelPath = `kernels/${id}/r1`;
  const session = `session-${id}`;
  createResearch(project, { research_id: id, chief_id: 'chief', agent_session_id: 'pending', goal: 'Integration selection fixture' });
  bindResearchSession(project, id, session);
  const module: KernelModule = {
    kernel_id: id,
    revision: 'r1',
    operator_abi: project.suite.operator_abi,
    symbol_prefix: `${id}_`,
    launcher: `${id}_launch`,
    device_file: `${kernelPath}/device.asc`,
    host_file: `${kernelPath}/host.asc`,
    supported_case_ids: project.suite.cases.map(item => item.case_id),
    dependencies: [],
    hardware_scope: 'mock',
    resource_constraints: [],
  };
  mkdirSync(join(root, kernelPath), { recursive: true });
  writeFileSync(join(root, kernelPath, 'kernel.json'), JSON.stringify(module, null, 2) + '\n');
  writeFileSync(join(root, module.device_file), '// Integration selection fixture\n');
  writeFileSync(join(root, module.host_file), `MeteorStatus ${id}_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n`);
  const build = await buildKernel(project, { research_id: id, experiment_id: 'e1', kernel_path: kernelPath, fixture: { fixture_id: `build-${id}` } });
  const cases = Object.fromEntries(project.suite.cases.map(item => [item.case_id, {
    status: 'PASS' as const,
    samples_us: samplesByCase[item.case_id] ?? [100, 100, 100, 100, 100],
  }]));
  const receipt = await testKernel(project, {
    build_ref: receiptRef(project, buildReceiptPath(project, build)),
    mode: 'full',
    fixture: { fixture_id: `test-${id}`, cases },
  });
  const fullRef = receiptRef(project, testReceiptPath(project, receipt));
  const submission: Submission = {
    research_id: id,
    agent_session_id: session,
    execution_backend: 'mock',
    termination_reason: 'Fixture completed',
    hypothesis: {
      hypothesis_id: `hypothesis-${id}`, revision: 'h1', statement: 'Routing choice can be observed', scope: 'Mock fixture',
      mechanism: 'Fixture timings', intervention: 'Measure a kernel', controls: ['Same suite'], predictions: ['Routing follows timings'],
      support_criteria: ['Receipt rows are complete'], refutation_criteria: ['Receipt rows are stale'], confounders: ['Simulation'],
      measurement_plan: 'Full mock measurements', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'],
    },
    hypothesis_history: [],
    experiments: [{ experiment_id: 'e1', hypothesis_revision: 'h1', question: 'Which cases should this kernel serve?', intervention: 'Record fixture',
      controls: ['Same suite'], kernel_revisions: [receipt.kernel_ref], environment_ref: receipt.environment_ref,
      full_size_test_refs: [fullRef], profile_refs: [], analysis: 'Mock protocol only', next_experiment: 'Real measurements' }],
    submitted_kernels: [{
      ...receipt.kernel_ref,
      source_hash: receipt.source_hash,
      artifact_refs: [build.module_ref],
      supported_domain: 'Fixture cases',
      verified_case_ids: receipt.rows.filter(row => row.status === 'PASS').map(row => row.case_id),
      recommended_domain: 'Recommended fixture cases',
      recommended_case_ids: recommendedCaseIds,
      hardware_scope: 'mock',
      resource_constraints: [],
      unsupported_cases: [],
      case_suite_revision: receipt.case_suite_revision,
      environment_ref: receipt.environment_ref,
      measurement_protocol_ref: receipt.measurement_protocol_ref,
      full_size_test_ref: fullRef,
      test_status: 'COMPLETED',
      performance_data_ref: fullRef,
      data_hash: receipt.data_hash,
      measured_tradeoffs: 'Simulated timings',
      limitations: ['Mock only'],
    }],
    knowledge_updates: [],
    chief_report: { summary: 'Fixture submission', findings: ['Mock only'], unresolved: ['Hardware evidence'], next_steps: ['Real measurements'] },
  };
  const prepared = prepareSubmission(project, submission);
  return commitSubmission(project, prepared.prepared_submission_id, session);
}

test('integration leaves other channels queued for their original research snapshots', async () => {
  const original = projectFixture();
  const prior = queuedResearch(original, 'original');
  const variants: Array<[string, (project: Project) => void]> = [
    ['environment', project => { project.config.environment.environment_ref += '-new'; }],
    ['suite', project => { project.suite.revision += '-new'; }],
    ['protocol', project => { project.config.environment.measurement_protocol_ref += '-new'; }],
  ];
  for (const [name, change] of variants) {
    const current = loadProject(original.root);
    change(current);
    const next = queuedResearch(current, name);
    const processed = await processIntegrationEvents(current);
    assert.equal(processed.processed, 1, `${name} processor must consume only its own channel`);
    assert.equal(getIntegrationEvent(current, next.integration_event_id)?.status, 'SKIPPED');
    assert.equal(getIntegrationEvent(current, prior.integration_event_id)?.status, 'QUEUED');
    assert.equal(listDbIntegrationEvents(current).find(event => event.integration_event_id === prior.integration_event_id)?.status, 'QUEUED');
    assert.equal(existsSync(join(storePaths(current).integrationRoot, prior.integration_event_id)), false);
  }
  const restored: Project = {
    ...loadProject(original.root), snapshotRoot: original.snapshotRoot,
    config: readJson(join(original.snapshotRoot!, 'meteor.config.json')),
    suite: readJson(join(original.snapshotRoot!, 'case-suite.json')),
  };
  const recovered = await processIntegrationEvents(restored);
  assert.equal(recovered.processed, 1);
  assert.equal(getIntegrationEvent(restored, prior.integration_event_id)?.status, 'SKIPPED');
});

test('a claim cannot lease an integration event from a different project channel', async () => {
  const original = projectFixture();
  const prior = queuedResearch(original, 'original');
  const current = loadProject(original.root);
  current.config.environment.environment_ref += '-new';
  assert.equal(claimDbIntegrationEvent(current, prior.integration_event_id, 'foreign-token'), undefined);
  assert.equal(listDbIntegrationEvents(current).find(event => event.integration_event_id === prior.integration_event_id)?.status, 'QUEUED');
  const recovered = await processIntegrationEvents(original);
  assert.equal(recovered.processed, 1);
});

test('integration selects the fastest recommended PASS kernel for each measured shape', async t => {
  const project = scopedProjectFixture(t);
  const [case1, case2] = project.suite.cases.map(item => item.case_id);
  await measuredSubmission(project, 'historical_case1', [case1], {
    [case1]: [100, 100, 100, 100, 100],
  });
  const current = await measuredSubmission(project, 'submitted_case1_near_tie', [case1], {
    [case1]: [99, 99, 99, 99, 99],
    [case2]: [10, 10, 10, 10, 10],
  });
  const result = await integrateSubmission(project, current.submission_id, 'strict-fastest-selection');
  assert.equal(result.status, 'ASSEMBLED');
  assert.equal(result.route_rule_count, 1);
  const selections = readJson(result.selections_ref);
  assert.equal(selections.usesSubmitted, true);
  assert.deepEqual(selections.rules.map((rule: any) => ({
    case_id: rule.case_id,
    kernel_id: rule.kernel_id,
    source: rule.source,
    median_us: rule.median_us,
  })), [{ case_id: case1, kernel_id: 'submitted_case1_near_tie', source: 'submitted', median_us: 99 }]);
  assert.equal(selections.rules.some((rule: any) => rule.case_id === case2), false);
  assert.deepEqual(selections.kernels.map((item: any) => item.submission.kernel_id), ['submitted_case1_near_tie']);
  assert.ok(existsSync(result.version_spec_ref!));
  assert.ok(existsSync(result.version_asc_ref!));
});

test('NO_CHANGE preserves incumbent only for deterministic equal-median ties', async t => {
  const project = scopedProjectFixture(t);
  const case1 = project.suite.cases[0].case_id;
  await measuredSubmission(project, 'historical_case1', [case1], {
    [case1]: [100, 100, 100, 100, 100],
  });
  const current = await measuredSubmission(project, 'submitted_case1_equal_tie', [case1], {
    [case1]: [100, 100, 100, 100, 100],
  });
  const result = await integrateSubmission(project, current.submission_id, 'equal-tie-selection-preserved');
  assert.equal(result.status, 'NO_CHANGE');
  assert.equal(result.route_rule_count, 0);
  assert.match(result.reason!, /not the fastest/);
  const selections = readJson(result.selections_ref);
  assert.equal(selections.usesSubmitted, false);
  assert.deepEqual(selections.rules.map((rule: any) => ({
    case_id: rule.case_id,
    kernel_id: rule.kernel_id,
    source: rule.source,
    median_us: rule.median_us,
  })), [{ case_id: case1, kernel_id: 'historical_case1', source: 'historical', median_us: 100 }]);
});

test('integration assembles a newly recommended PASS case without changing historical incumbent routing', async t => {
  const project = scopedProjectFixture(t);
  const [case1, case2] = project.suite.cases.map(item => item.case_id);
  await measuredSubmission(project, 'historical_case1', [case1], {
    [case1]: [100, 100, 100, 100, 100],
  });
  const current = await measuredSubmission(project, 'submitted_case2', [case2], {
    [case1]: [99, 99, 99, 99, 99],
    [case2]: [10, 10, 10, 10, 10],
  });
  const result = await integrateSubmission(project, current.submission_id, 'new-pass-case-assembled');
  assert.equal(result.status, 'ASSEMBLED');
  assert.equal(result.route_rule_count, 2);
  const selections = readJson(result.selections_ref);
  assert.equal(selections.usesSubmitted, true);
  assert.deepEqual(selections.rules.map((rule: any) => ({
    case_id: rule.case_id,
    kernel_id: rule.kernel_id,
    source: rule.source,
  })), [
    { case_id: case1, kernel_id: 'historical_case1', source: 'historical' },
    { case_id: case2, kernel_id: 'submitted_case2', source: 'submitted' },
  ]);
  assert.ok(existsSync(result.version_spec_ref!));
  assert.ok(existsSync(result.version_asc_ref!));
});

test('retry resumes frozen selections after a render interruption despite newer historical candidates', async t => {
  const project = scopedProjectFixture(t);
  const caseId = project.suite.cases[0].case_id;
  const original = await measuredSubmission(project, 'original_route', [caseId], { [caseId]: [100, 100, 100, 100, 100] });
  const integrationId = 'frozen-selection-retry';
  const outRoot = join(storePaths(project).integrationRoot, integrationId);
  const blockedAsc = join(outRoot, project.config.schema_version === 2 ? 'kernel.asc' : `${integrationId}.asc`);
  mkdirSync(blockedAsc, { recursive: true });
  await assert.rejects(integrateSubmission(project, original.submission_id, integrationId), /EISDIR|EPERM|illegal operation on a directory/);
  const selectionRef = join(outRoot, 'selections.json');
  const specRef = join(outRoot, 'spec.json');
  const frozenBytes = readFileSync(selectionRef);
  const frozenSpec = readJson(specRef);
  const newer = await measuredSubmission(project, 'newer_faster_route', [caseId], { [caseId]: [10, 10, 10, 10, 10] });
  const changedSource = join(project.root, 'changed-version-template.asc.tmpl');
  writeFileSync(changedSource, readFileSync(join(process.cwd(), 'templates/project/templates/qmq-v1/int8/version.asc.tmpl'), 'utf8') + '\n// new-template-after-freeze\n');
  configureAssemblyTemplate(loadProject(project.root), { source_path: changedSource, template_id: 'changed-after-freeze', now: '2026-09-27T00:01:00.000Z' });
  assert.notEqual(loadProject(project.root).target?.assembly_template_ref, frozenSpec.assembly_template.ref);
  rmdirSync(blockedAsc);

  const retried = await integrateSubmission(loadProject(project.root), original.submission_id, integrationId);
  assert.equal(retried.status, 'ASSEMBLED');
  assert.deepEqual(readFileSync(selectionRef), frozenBytes);
  assert.equal(readJson(selectionRef).rules[0].kernel_id, 'original_route');
  const generated = readFileSync(retried.version_asc_ref!, 'utf8');
  assert.doesNotMatch(generated, /new-template-after-freeze/);
  const savedReport = readFileSync(retried.report_ref);
  assert.deepEqual(await integrateSubmission(project, original.submission_id, integrationId), JSON.parse(savedReport.toString('utf8')));
  assert.deepEqual(readFileSync(retried.report_ref), savedReport);
  assert.equal(readFileSync(retried.version_asc_ref!, 'utf8'), generated);

  const latest = await integrateSubmission(project, newer.submission_id, 'new-candidates-new-event');
  assert.equal(latest.status, 'ASSEMBLED');
  assert.equal(readJson(latest.selections_ref).rules[0].kernel_id, 'newer_faster_route');
});
