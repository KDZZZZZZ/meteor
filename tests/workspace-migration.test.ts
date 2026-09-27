import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.ts';
import { migrateProject, planMigration } from '../src/migrate.ts';
import type { KernelModule, Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { assertMigrationIdle, migrationLockRef, readOnlyLegacyCatalog, trustedLegacyCommit, trustedLegacySubmissions } from '../templates/project/tools/meteor/legacy.ts';
import { bindResearchSession, createResearch, researchPath } from '../templates/project/tools/meteor/research.ts';
import { buildKernel, buildReceiptPath, computeSourceHash, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel, testReceiptPath } from '../templates/project/tools/meteor/kernel-test.ts';
import { prepareSubmission, commitSubmission } from '../templates/project/tools/meteor/submit.ts';
import { processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { integrateSubmission } from '../templates/project/tools/meteor/integrate.ts';
import { ensureStore, listDbIntegrationEvents, storePaths } from '../templates/project/tools/meteor/store.ts';
import { selectInitialMaterials } from '../templates/project/tools/meteor/sampling.ts';
import { hashObject, readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';

const templates = fileURLToPath(new URL('../templates/project/', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(templates, root, { recursive: true });
  cpSync(join(templates, 'templates/qmq-v1/int8'), join(root, 'asc'), { recursive: true });
  cpSync(join(templates, 'contracts/qmq-v1/int8/operator.json'), join(root, 'asc/operator.json'));
  cpSync(join(templates, 'cases/qmq-v1/int8/default/suite.json'), join(root, 'asc/case-suite.json'));
  const config = readJson(join(root, 'meteor.config.json'));
  for (const key of ['workspace', 'targets', 'default_target', 'design']) delete config[key];
  Object.assign(config, { schema_version: 1, case_suite: 'asc/case-suite.json',
    execution: { backend: 'mock', profile_ref: 'mock-unit' }, environment: { environment_ref: 'mock-migration',
      hardware: 'mock-only', toolchain: 'none', measurement_protocol_ref: 'mock-median-5', simulated: true } });
  // Deliberately unusual formatting verifies backups preserve bytes, not JSON values.
  writeFileSync(join(root, 'meteor.config.json'), ' \r\n' + JSON.stringify(config, null, 3) + '\r\n');
  writeFileSync(join(root, '.meteor.local.json'), '{ "environment": {"hardware": "mock-only"} }\r\n');
  return { root, project: loadProject(root) };
}

function fileTree(root: string, ignoreCheckpoints = false): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), rel = relative(root, path).replaceAll('\\', '/');
      if (ignoreCheckpoints && rel.startsWith('.meteor/migrations')) continue;
      if (entry.isDirectory()) visit(path); else result[rel] = sha256(readFileSync(path));
    }
  }
  visit(root); return result;
}

// Simulated protocol fixtures only: these records make no hardware performance claim.
async function seed(project: Project, id: string, median: number) {
  const root = project.root, kernelPath = 'drafts/' + id, session = 'session-' + id;
  createResearch(project, { research_id: id, chief_id: 'chief', agent_session_id: 'pending', goal: 'Migration protocol fixture' });
  bindResearchSession(project, id, session);
  const module: KernelModule = { kernel_id: id, revision: 'r1', operator_abi: project.suite.operator_abi,
    symbol_prefix: id + '_', launcher: id + '_launch', device_file: kernelPath + '/device.asc', host_file: kernelPath + '/host.asc',
    supported_case_ids: project.suite.cases.map(item => item.case_id), dependencies: [], hardware_scope: 'mock-only', resource_constraints: [] };
  writeJson(join(root, kernelPath, 'kernel.json'), module);
  writeFileSync(join(root, module.device_file), '// Simulated migration test only\n');
  writeFileSync(join(root, module.host_file), `MeteorStatus ${id}_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n`);
  const build = await buildKernel(project, { research_id: id, experiment_id: 'e1', kernel_path: kernelPath, fixture: { fixture_id: 'migration-unit' } });
  const receipt = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full',
    fixture: { fixture_id: 'migration-unit', cases: Object.fromEntries(project.suite.cases.map(item => [item.case_id,
      { status: 'PASS', samples_us: [median, median, median, median, median] }])) } });
  const fullRef = receiptRef(project, testReceiptPath(project, receipt));
  const submission: Submission = {
    research_id: id, agent_session_id: session, execution_backend: 'mock', termination_reason: 'Protocol fixture completed',
    hypothesis: { hypothesis_id: 'h-' + id, revision: 'h1', statement: 'Tile choice may change memory behavior', scope: 'Mock fixture',
      mechanism: 'Tile reuse', intervention: 'Change tiles', controls: ['Same suite'], predictions: ['Different timing'],
      support_criteria: ['Real controlled evidence'], refutation_criteria: ['Contrary real evidence'], confounders: ['Simulation'],
      measurement_plan: 'Full independent tests', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'] },
    hypothesis_history: [], experiments: [{ experiment_id: 'e1', hypothesis_revision: 'h1', question: 'Preserve this fixture?', intervention: 'Record fixture',
      controls: ['Fixed suite'], kernel_revisions: [receipt.kernel_ref], environment_ref: receipt.environment_ref,
      full_size_test_refs: [fullRef], profile_refs: [], analysis: 'Mock protocol only', next_experiment: 'Real measurements' }],
    submitted_kernels: [{ ...receipt.kernel_ref, source_hash: receipt.source_hash, artifact_refs: [build.module_ref],
      supported_domain: 'Fixture cases', verified_case_ids: module.supported_case_ids, recommended_domain: 'Fixture cases',
      recommended_case_ids: module.supported_case_ids, hardware_scope: 'mock-only', resource_constraints: [], unsupported_cases: [],
      case_suite_revision: receipt.case_suite_revision, environment_ref: receipt.environment_ref, measurement_protocol_ref: receipt.measurement_protocol_ref,
      full_size_test_ref: fullRef, test_status: 'COMPLETED', performance_data_ref: fullRef, data_hash: receipt.data_hash,
      measured_tradeoffs: 'Simulated', limitations: ['Mock only'] }],
    knowledge_updates: [{ claim_id: 'claim-' + id, kind: 'observation', statement: 'Fixture observation', scope: 'Mock only', evidence_refs: [fullRef], related_material_ids: [] }],
    chief_report: { summary: 'Fixture', findings: ['Mock only'], unresolved: ['Hardware evidence'], next_steps: ['Real measurements'] },
  };
  const prepared = prepareSubmission(project, submission);
  const commit = commitSubmission(project, prepared.prepared_submission_id, session);
  await processIntegrationEvents(project);
  return { build, receipt, fullRef, commit, module: readJson<KernelModule>(join(root, build.module_ref)) };
}

test('migration dry-run does not write and recognizes ASSEMBLED/NO_CHANGE as terminal', async t => {
  const f = fixture(t); await seed(f.project, 'old', 10);
  writeJson(join(f.project.dataRoot, 'integration-events/no-change.json'), { integration_event_id: 'no-change', status: 'NO_CHANGE' });
  const before = fileTree(f.root);
  const plan = migrateProject(f.root);
  assert.equal(plan.state, 'ready', JSON.stringify(plan.blockers));
  assert.deepEqual(fileTree(f.root), before);
  assert.equal(existsSync(join(f.root, '.meteor/migrations')), false);
});

test('active or uncertain research and retryable integration prevent publication', t => {
  const f = fixture(t);
  const record = { research_id: 'active', run_status: 'ACTIVE', execution_backend: 'mock' };
  writeJson(join(f.project.dataRoot, 'research/active/manifest.json'), record);
  const original = readFileSync(join(f.root, 'meteor.config.json'));
  assert.equal(planMigration(f.root).state, 'blocked');
  assert.throws(() => migrateProject(f.root, { apply: true }), /Research active is ACTIVE/);
  assert.deepEqual(readFileSync(join(f.root, 'meteor.config.json')), original);
  writeJson(join(f.project.dataRoot, 'research/active/manifest.json'), { ...record, run_status: 'UNKNOWN_REMOTE' });
  assert.match(planMigration(f.root).blockers.join('\n'), /UNKNOWN_REMOTE/);
  writeJson(join(f.project.dataRoot, 'research/active/manifest.json'), { ...record, run_status: 'CLOSED' });
  writeJson(join(f.project.dataRoot, 'integration-events/pending.json'), { integration_event_id: 'pending', status: 'FAILED' });
  assert.match(planMigration(f.root).blockers.join('\n'), /pending is FAILED/);
});

test('database-only pending events and nonempty WAL cannot be hidden by terminal JSON files', async t => {
  const f = fixture(t); await seed(f.project, 'old', 10);
  const catalog = join(storePaths(f.project).knowledgeRoot, 'catalog.sqlite');
  const result = spawnSync('python', ['-c', 'import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute("UPDATE integration_events SET status=\'QUEUED\'"); d.commit(); d.close()', catalog], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const before = fileTree(f.root);
  assert.match(planMigration(f.root).blockers.join('\n'), /Catalog integration event .* QUEUED/);
  assert.deepEqual(fileTree(f.root), before);
  writeFileSync(catalog + '-wal', 'Uncheckpointed WAL protocol fixture');
  const withWal = fileTree(f.root);
  assert.match(planMigration(f.root).blockers.join('\n'), /nonempty WAL/);
  assert.deepEqual(fileTree(f.root), withWal);
});

test('apply preserves old evidence/source and novelty while creating a scoped detached catalog; repeat is idempotent', async t => {
  const f = fixture(t), old = await seed(f.project, 'old', 10);
  const oldRoot = f.project.dataRoot, evidenceBefore = fileTree(oldRoot), rawConfig = readFileSync(join(f.root, 'meteor.config.json'));
  const catalogBefore = readOnlyLegacyCatalog(join(oldRoot, 'knowledge'))!;
  const result = migrateProject(f.root, { apply: true });
  assert.equal(result.state, 'COMPLETED');
  const project = loadProject(f.root);
  assert.deepEqual(readFileSync(join(f.root, project.config.legacy!.config_ref)), rawConfig);
  assert.deepEqual(fileTree(oldRoot), evidenceBefore);
  assert.equal(computeSourceHash(f.project, old.module), old.receipt.source_hash);
  const catalogAfter = readOnlyLegacyCatalog(storePaths(project).knowledgeRoot)!;
  assert.deepEqual(catalogAfter.counts, catalogBefore.counts);
  assert.deepEqual(catalogAfter.events, catalogBefore.events);
  assert.deepEqual(catalogAfter.commits, catalogBefore.commits);
  const query = 'import json,sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(json.dumps([list(r) for r in d.execute("SELECT novelty_event_id,created_at,content_hash FROM novelty_events ORDER BY novelty_event_id")]))';
  const rows = (path: string) => spawnSync('python', ['-c', query, path], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  assert.equal(rows(catalogAfter.path), rows(catalogBefore.path));
  const groups = trustedLegacySubmissions(project);
  assert.equal(groups.length, 1); assert.equal(groups[0].project.config.schema_version, 1);
  assert.equal(groups[0].project.scope, undefined); assert.equal(groups[0].project.target, undefined);
  assert.equal(groups[0].project.snapshotRoot, join(researchPath(f.project, 'old'), 'snapshot'));
  assert.equal(groups[0].commits[0].submission_id, old.commit.submission_id);
  assert.throws(() => ensureStore(groups[0].project), /read-only/);
  const filesAfter = fileTree(f.root);
  assert.equal(migrateProject(f.root, { apply: true }).state, 'already_current');
  assert.deepEqual(fileTree(f.root), filesAfter);
  assert.equal((await processIntegrationEvents(project)).processed, 0, 'historical integration must not be replayed');
});

test('failure after config publication restores every managed file using exact backup bytes and allows a fresh retry', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'tools/meteor/research.ts'), '// Custom old runtime bytes\r\n');
  const before = fileTree(f.root, true);
  assert.throws(() => migrateProject(f.root, { apply: true, afterPublishFile(path) {
    assert.throws(() => assertMigrationIdle(f.root), /migration is in progress/);
    if (path === 'meteor.config.json') throw new Error('injected publication failure');
  } }), /injected publication failure/);
  assert.deepEqual(fileTree(f.root, true), before);
  assert.equal(existsSync(join(f.root, migrationLockRef)), false);
  const checkpoints = readdirSync(join(f.root, '.meteor/migrations'));
  const journal = readJson(join(f.root, '.meteor/migrations', checkpoints[0], 'journal.json'));
  assert.equal(journal.state, 'ROLLED_BACK');
  assert.equal(migrateProject(f.root, { apply: true }).state, 'COMPLETED');
});

test('migration lock prevents concurrent entry, and dead-owner journal recovers a partial publication', t => {
  const f = fixture(t), lock = join(f.root, migrationLockRef);
  mkdirSync(dirname(lock), { recursive: true });
  writeJson(lock, { token: 'concurrent', pid: process.pid });
  assert.throws(() => migrateProject(f.root, { apply: true }), /Another migration/);
  rmSync(lock);
  assert.throws(() => migrateProject(f.root, { apply: true, afterPublishFile(path) { if (path === 'meteor.config.json') throw new Error('fixture'); } }), /fixture/);
  const name = readdirSync(dirname(lock))[0], checkpoint = join(dirname(lock), name), journalPath = join(checkpoint, 'journal.json');
  const journal = readJson(journalPath), entry = journal.files.find((item: any) => item.path === 'meteor.config.json');
  cpSync(join(checkpoint, 'staged', entry.path), join(f.root, entry.path));
  writeJson(journalPath, { ...journal, state: 'PUBLISHING' });
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  writeJson(lock, { token: journal.token, pid: dead.pid, journal_ref: relative(f.root, journalPath).replaceAll('\\', '/') });
  assert.equal(migrateProject(f.root, { apply: true }).state, 'COMPLETED');
  assert.equal(readJson(journalPath).state, 'ROLLED_BACK');
  assert.equal(existsSync(lock), false);
});

test('legacy provenance rejects changed evidence and foreign workspace, and is absent on other targets', async t => {
  const f = fixture(t), old = await seed(f.project, 'old', 10);
  migrateProject(f.root, { apply: true });
  const project = loadProject(f.root);
  assert.ok(trustedLegacyCommit(project, old.commit.submission_id));
  assert.deepEqual(trustedLegacySubmissions({ ...project, scope: { ...project.scope!, op_id: 'other-op' } }), []);
  const foreign = structuredClone(project); foreign.config.workspace!.workspace_id = 'foreign'; foreign.scope!.workspace_id = 'foreign';
  assert.throws(() => trustedLegacySubmissions(foreign), /different workspace/);
  const path = join(f.root, old.fullRef), changed = readJson(path);
  changed.rows[0].median_us = 0.1; changed.data_hash = hashObject(changed.rows); writeJson(path, changed);
  assert.throws(() => trustedLegacySubmissions(project), /Legacy evidence changed/);
});

test('trusted old kernels remain sampling material and historical winners against slower new kernels', async t => {
  const f = fixture(t), old = await seed(f.project, 'old', 10);
  migrateProject(f.root, { apply: true });
  const project = loadProject(f.root);
  const initial = selectInitialMaterials(project, { mode: 'specified', kernel_refs: ['old@r1'], knowledge_refs: ['claim-old'] });
  assert.equal(initial.selected[0].source_hash, old.receipt.source_hash);
  const next = await seed(project, 'next', 20);
  const integrated = await integrateSubmission(project, next.commit.submission_id, 'migration-check-incumbent');
  assert.equal(integrated.status, 'NO_CHANGE');
  assert.equal(readOnlyLegacyCatalog(join(f.project.dataRoot, 'knowledge'))!.counts.research_commits, 1);
  assert.equal(listDbIntegrationEvents(project).length, 2);
});
