import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildReceipt, KernelModule, Project, Submission, TestReceipt } from '../templates/project/tools/meteor/contracts.ts';
import { computeSourceHash, buildReceiptPath, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { getIntegrationStatus, processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { prepareSubmission, commitSubmission } from '../templates/project/tools/meteor/submit.ts';
import { claimDbIntegrationEvent, listDbIntegrationEvents, storePaths } from '../templates/project/tools/meteor/store.ts';
import { hashObject, readJson, writeJson } from '../templates/project/tools/meteor/util.ts';

function projectFixture(t: TestContext): Project {
  const root = mkdtempSync(join(tmpdir(), 'meteor-integration-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'reports', 'meteor', 'mock');
  const project: Project = {
    root,
    dataRoot,
    config: {
      schema_version: 1,
      execution: { backend: 'mock', profile_ref: 'mock-profile' },
      case_suite: 'suite-qmq-v1',
      environment: {
        environment_ref: 'mock-env',
        hardware: 'mock',
        toolchain: 'mock-toolchain',
        measurement_protocol_ref: 'protocol-v1',
        simulated: true,
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
  const templateRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'project', 'templates', 'qmq-v1', 'int8');
  mkdirSync(join(root, 'asc'), { recursive: true });
  copyFileSync(join(templateRoot, 'version.asc.tmpl'), join(root, 'asc', 'version.asc.tmpl'));
  copyFileSync(join(templateRoot, 'host_context.asc.inc'), join(root, 'asc', 'host_context.asc.inc'));
  return project;
}

function activate(project: Project, researchId: string, sessionId: string): void {
  writeJson(join(project.dataRoot, 'research', researchId, 'manifest.json'), {
    research_id: researchId,
    agent_session_id: sessionId,
    chief_id: 'chief',
    execution_backend: 'mock',
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    goal: 'test integration failure handling',
    run_status: 'ACTIVE',
    created_at: new Date().toISOString(),
    budget: project.config.budget,
    research_goal_met: false,
  });
}

function moduleFixture(project: Project, kernelId: string, revision: string, symbolPrefix: string): { module: KernelModule; sourceHash: string } {
  const kernelPath = join(project.root, 'kernels', kernelId, revision);
  mkdirSync(kernelPath, { recursive: true });
  const module: KernelModule = {
    kernel_id: kernelId,
    revision,
    operator_abi: project.suite.operator_abi,
    symbol_prefix: symbolPrefix,
    launcher: `${symbolPrefix}launch`,
    device_file: `kernels/${kernelId}/${revision}/device.asc`,
    host_file: `kernels/${kernelId}/${revision}/host.asc`,
    supported_case_ids: project.suite.cases.map(item => item.case_id),
    dependencies: [],
    hardware_scope: 'mock',
    resource_constraints: [],
  };
  writeJson(join(kernelPath, 'kernel.json'), module);
  writeFileSync(join(project.root, module.device_file), `// ${kernelId} ${revision}\n`);
  writeFileSync(join(project.root, module.host_file), `MeteorStatus ${module.launcher}(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n`);
  return { module, sourceHash: computeSourceHash(project, module) };
}

function measuredKernel(project: Project, researchId: string, kernelId: string, medians: number[], recommendedCaseIds: string[], symbolPrefix = `${kernelId}_`) {
  const revision = 'r1';
  const { sourceHash } = moduleFixture(project, kernelId, revision, symbolPrefix);
  const kernelRef = { kernel_id: kernelId, revision };
  const build: BuildReceipt = {
    build_id: `build_${kernelId}_${revision}`,
    research_id: researchId,
    experiment_id: 'experiment_1',
    kernel_ref: kernelRef,
    source_hash: sourceHash,
    artifact_hash: hashObject({ kernelId, revision, artifact: true }),
    environment_ref: project.config.environment.environment_ref,
    execution_backend: 'mock',
    simulated: true,
    status: 'COMPLETED',
    source_ref: `kernels/${kernelId}/${revision}`,
    module_ref: `kernels/${kernelId}/${revision}/kernel.json`,
  };
  const buildPath = buildReceiptPath(project, build);
  writeJson(buildPath, build);
  const rows = project.suite.cases.map((testCase, index) => ({
    case_id: testCase.case_id,
    status: 'PASS' as const,
    samples_us: [medians[index], medians[index], medians[index]],
    median_us: medians[index],
    actual_kernel_ref: kernelRef,
    source_hash: sourceHash,
    input_hash: testCase.input_hash,
    oracle_hash: testCase.oracle_hash,
  }));
  const receipt: TestReceipt = {
    run_id: `run_${kernelId}_${revision}`,
    research_id: researchId,
    experiment_id: 'experiment_1',
    kernel_ref: kernelRef,
    build_ref: receiptRef(project, buildPath),
    source_hash: sourceHash,
    artifact_hash: build.artifact_hash,
    execution_backend: 'mock',
    simulated: true,
    fixture_id: 'fixture',
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    mode: 'full',
    status: 'COMPLETED',
    rows,
    accounting_complete: true,
    supported_correct_count: rows.length,
    timed_case_count: rows.length,
    data_hash: hashObject(rows),
  };
  const receiptPath = join(experimentDir(project, researchId, 'experiment_1'), 'full-tests', `${receipt.run_id}.json`);
  writeJson(receiptPath, receipt);
  return {
    kernel_id: kernelId,
    revision,
    source_hash: sourceHash,
    artifact_refs: [build.module_ref],
    supported_domain: 'measured full suite only',
    verified_case_ids: receipt.rows.map(row => row.case_id),
    recommended_domain: 'recommended measured cases only',
    recommended_case_ids: recommendedCaseIds,
    hardware_scope: 'mock',
    resource_constraints: [],
    unsupported_cases: [],
    case_suite_revision: receipt.case_suite_revision,
    environment_ref: receipt.environment_ref,
    measurement_protocol_ref: receipt.measurement_protocol_ref,
    full_size_test_ref: receiptRef(project, receiptPath),
    test_status: 'COMPLETED' as const,
    performance_data_ref: receiptRef(project, receiptPath),
    data_hash: receipt.data_hash,
    measured_tradeoffs: 'mock measured',
    limitations: ['mock evidence only'],
  };
}

function submission(project: Project, researchId: string, sessionId: string, kernels: Submission['submitted_kernels']): Submission {
  return {
    research_id: researchId,
    agent_session_id: sessionId,
    execution_backend: 'mock',
    termination_reason: 'test complete',
    hypothesis: {
      hypothesis_id: `hypothesis_${researchId}`,
      revision: 'h1',
      statement: 'Integration should handle failures durably',
      scope: 'fixed qmq suite',
      mechanism: 'routing and retry metadata',
      intervention: 'submit kernels',
      controls: ['baseline'],
      predictions: ['integration settles'],
      support_criteria: ['catalog records outcome'],
      refutation_criteria: ['catalog loses first failure'],
      confounders: ['mock data'],
      measurement_plan: 'full suite plus integration',
      verdict: 'INCONCLUSIVE',
      supporting_evidence: [],
      counterevidence: [],
      limitations: ['mock cannot prove hardware hypothesis'],
    },
    hypothesis_history: [],
    experiments: [{
      experiment_id: 'experiment_1',
      hypothesis_revision: 'h1',
      question: 'does integration settle',
      intervention: 'kernel change',
      controls: ['baseline'],
      kernel_revisions: kernels.map(kernel => ({ kernel_id: kernel.kernel_id, revision: kernel.revision })),
      environment_ref: project.config.environment.environment_ref,
      full_size_test_refs: kernels.map(kernel => kernel.full_size_test_ref),
      profile_refs: [],
      analysis: 'integration behavior is recorded separately',
      next_experiment: 'none',
    }],
    submitted_kernels: kernels,
    knowledge_updates: [{
      claim_id: `claim_${researchId}`,
      kind: 'observation',
      statement: 'mock evidence was recorded',
      scope: 'mock',
      evidence_refs: kernels.length ? kernels.map(kernel => kernel.full_size_test_ref) : ['experiment_1'],
      related_material_ids: [],
    }],
    chief_report: {
      summary: 'test report',
      findings: ['integration failure metadata is durable'],
      unresolved: ['real hardware'],
      next_steps: ['run on configured ssh backend'],
    },
  };
}

function commit(project: Project, researchId: string, kernels: Submission['submitted_kernels']) {
  const sessionId = `session_${researchId}`;
  activate(project, researchId, sessionId);
  const prepared = prepareSubmission(project, submission(project, researchId, sessionId, kernels));
  return commitSubmission(project, prepared.prepared_submission_id, sessionId);
}

function dbRows(project: Project, sql: string) {
  const script = 'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in db.execute(sys.argv[2])]))';
  const result = spawnSync('python', ['-c', script, join(storePaths(project).knowledgeRoot, 'catalog.sqlite'), sql], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function dbExec(project: Project, sql: string): void {
  const script = 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(sys.argv[2]); db.commit()';
  const result = spawnSync('python', ['-c', script, join(storePaths(project).knowledgeRoot, 'catalog.sqlite'), sql], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function attemptFiles(project: Project, eventId: string): string[] {
  return readdirSync(storePaths(project).integrationEventRoot)
    .filter(name => name.startsWith(`${eventId}.attempt_`) && name.endsWith('.json'))
    .sort();
}

test('permanent integration failure records one attempt and is not reclaimed', async t => {
  const project = projectFixture(t);
  const kernels = [
    measuredKernel(project, 'permanent', 'perm_a', [1, 100], ['case_a'], 'shared_'),
    measuredKernel(project, 'permanent', 'perm_b', [100, 1], ['case_b'], 'shared_'),
  ];
  const report = commit(project, 'permanent', kernels);
  const first = await processIntegrationEvents(project);
  assert.equal(first.failed, 1);
  const event = listDbIntegrationEvents(project).find(item => item.integration_event_id === report.integration_event_id)!;
  assert.equal(event.status, 'FAILED');
  assert.equal(event.retryable, false);
  assert.equal(event.failure_count, 1);
  assert.match(event.error, /Duplicate module symbol prefix/);
  assert.equal(claimDbIntegrationEvent(project, report.integration_event_id, 'token-after-permanent'), undefined);
  assert.equal((await processIntegrationEvents(project)).processed, 0);
  assert.equal(attemptFiles(project, report.integration_event_id).length, 1);
  assert.equal(dbRows(project, 'SELECT COUNT(*) AS count FROM integration_attempts')[0].count, 1);
});

test('new zero-kernel integration does not overwrite an older permanent failure event', async t => {
  const project = projectFixture(t);
  const kernels = [
    measuredKernel(project, 'permanent', 'perm_a', [1, 100], ['case_a'], 'shared_'),
    measuredKernel(project, 'permanent', 'perm_b', [100, 1], ['case_b'], 'shared_'),
  ];
  const failed = commit(project, 'permanent', kernels);
  await processIntegrationEvents(project);
  const failedPath = join(storePaths(project).integrationEventRoot, `${failed.integration_event_id}.json`);
  const before = readFileSync(failedPath, 'utf8');
  const zero = commit(project, 'zero', []);
  const processed = await processIntegrationEvents(project);
  assert.equal(processed.processed, 1);
  assert.equal(processed.skipped, 1);
  assert.equal(readJson(join(storePaths(project).integrationEventRoot, `${zero.integration_event_id}.json`)).status, 'SKIPPED');
  assert.equal(readFileSync(failedPath, 'utf8'), before);
});

test('transient integration failures retry up to three attempts and preserve the first reason', async t => {
  const project = projectFixture(t);
  const report = commit(project, 'transient', []);
  unlinkSync(join(storePaths(project).commitRoot, `${report.submission_id}.json`));
  for (const expectedCount of [1, 2, 3]) {
    const processed = await processIntegrationEvents(project);
    assert.equal(processed.failed, 1);
    const event = listDbIntegrationEvents(project).find(item => item.integration_event_id === report.integration_event_id)!;
    assert.equal(event.failure_count, expectedCount);
    assert.match(event.error, /Committed submission not found/);
  }
  const event = listDbIntegrationEvents(project).find(item => item.integration_event_id === report.integration_event_id)!;
  assert.equal(event.retryable, false);
  assert.equal(claimDbIntegrationEvent(project, report.integration_event_id, 'token-after-cap'), undefined);
  assert.equal((await processIntegrationEvents(project)).processed, 0);
  assert.equal(dbRows(project, 'SELECT COUNT(*) AS count FROM integration_attempts')[0].count, 3);
});

test('retry after an orphaned attempt file records a new stable claim attempt without overwriting', async t => {
  const project = projectFixture(t);
  const report = commit(project, 'orphan', []);
  unlinkSync(join(storePaths(project).commitRoot, `${report.submission_id}.json`));
  assert.equal((await processIntegrationEvents(project)).failed, 1);
  const firstAttempts = attemptFiles(project, report.integration_event_id);
  assert.equal(firstAttempts.length, 1);
  dbExec(project, `UPDATE integration_events SET status='FAILED', retryable=1, failure_count=0, claim_token=NULL, lease_expires_at=NULL WHERE integration_event_id='${report.integration_event_id}'`);
  assert.equal((await processIntegrationEvents(project)).failed, 1);
  const secondAttempts = attemptFiles(project, report.integration_event_id);
  assert.equal(secondAttempts.length, 2);
  assert.notEqual(secondAttempts[0], secondAttempts[1]);
  for (const file of secondAttempts) {
    const attempt = readJson(join(storePaths(project).integrationEventRoot, file));
    assert.match(attempt.attempt_id, /^attempt_[a-f0-9]{24}$/);
    assert.doesNotMatch(attempt.error, /\r|\n/);
  }
});

function restoreOldRetrySchema(project: Project): void {
  for (const sql of [
    'DROP TABLE integration_attempts',
    ...['retryable', 'failure_count', 'first_error', 'last_error'].map(name => `ALTER TABLE integration_events DROP COLUMN ${name}`),
    "DELETE FROM metadata WHERE key='integration_retry_schema'",
  ]) dbExec(project, sql);
}

test('old permanent failure is upgraded without a replay or fabricated attempts despite stale event JSON', async t => {
  const project = projectFixture(t);
  const report = commit(project, 'old-permanent', []);
  const eventPath = join(storePaths(project).integrationEventRoot, `${report.integration_event_id}.json`);
  const message = 'Duplicate module symbol prefix: legacy_';
  writeJson(eventPath, { ...readJson<Record<string, unknown>>(eventPath), status: 'FAILED', error: message });
  const bytes = readFileSync(eventPath);
  dbExec(project, `UPDATE integration_events SET status='FAILED', error='${message}' WHERE integration_event_id='${report.integration_event_id}'`);
  restoreOldRetrySchema(project);
  const status = getIntegrationStatus(project, report.integration_event_id)!;
  assert.equal(status.retryable, false);
  assert.equal(status.first_error, message);
  assert.equal(status.last_error, message);
  assert.equal(status.failure_count, 0);
  assert.equal(claimDbIntegrationEvent(project, report.integration_event_id, 'legacy-claim'), undefined);
  assert.equal((await processIntegrationEvents(project)).processed, 0);
  assert.equal(dbRows(project, 'SELECT COUNT(*) AS count FROM integration_attempts')[0].count, 0);
  assert.deepEqual(readFileSync(eventPath), bytes);
});

test('old retry schema upgrades atomically and concurrent connections serialize DDL', t => {
  const project = projectFixture(t);
  commit(project, 'old-schema', []);
  restoreOldRetrySchema(project);
  const script = `import importlib.util,json,sqlite3,sys,threading
from concurrent.futures import ThreadPoolExecutor
spec=importlib.util.spec_from_file_location('meteor_store',sys.argv[1])
store=importlib.util.module_from_spec(spec); spec.loader.exec_module(store)
root=sys.argv[2]
original_connect=store.sqlite3.connect
def failing_connect(*args,**kwargs):
 db=original_connect(*args,**kwargs)
 db.set_authorizer(lambda action,name,*rest: sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_TABLE and name=='integration_attempts' else sqlite3.SQLITE_OK)
 return db
store.sqlite3.connect=failing_connect
try:
 store.connect(root)
 raise AssertionError('fault injection did not fail')
except sqlite3.DatabaseError: pass
finally: store.sqlite3.connect=original_connect
with original_connect(root+'/catalog.sqlite') as db:
 columns=[r[1] for r in db.execute('PRAGMA table_info(integration_events)')]
 assert 'retryable' not in columns, 'failed migration left a partial schema'
barrier=threading.Barrier(2)
original_columns=store.table_columns
seen=threading.local()
def overlapping_columns(db,table):
 result=original_columns(db,table)
 if table=='integration_events' and not getattr(seen,'ready',False):
  seen.ready=True
  try: barrier.wait(timeout=0.3)
  except threading.BrokenBarrierError: pass
 return result
store.table_columns=overlapping_columns
def open_catalog(_):
 db=store.connect(root)
 try: return sorted(store.table_columns(db,'integration_events'))
 finally: db.close()
with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(open_catalog,range(2)))
assert results[0]==results[1]
assert all(name in results[0] for name in ['retryable','failure_count','first_error','last_error'])
print(json.dumps({'ok':True}))
`;
  const storeScript = fileURLToPath(new URL('../templates/project/knowledge/store.py', import.meta.url));
  const result = spawnSync('python', ['-B', '-c', script, storeScript, storePaths(project).knowledgeRoot], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
