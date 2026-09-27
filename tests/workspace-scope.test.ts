import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { KernelModule, Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel, buildReceiptPath, computeSourceHash, loadBuildReceipt, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel, testReceiptPath } from '../templates/project/tools/meteor/kernel-test.ts';
import { profileKernel, profileReceiptPath } from '../templates/project/tools/meteor/kernel-profile.ts';
import { bindResearchSession, createResearch, getResearch, researchPath, updateResearch } from '../templates/project/tools/meteor/research.ts';
import { prepareSubmission, commitSubmission } from '../templates/project/tools/meteor/submit.ts';
import { processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { claimDbIntegrationEvent, ensureStore, listDbIntegrationEvents, listDbMaterials, storePaths } from '../templates/project/tools/meteor/store.ts';
import { sampleMaterials, selectInitialMaterials } from '../templates/project/tools/meteor/sampling.ts';
import { scopeKey, statePath, targetPath, targetRef } from '../templates/project/tools/meteor/workspace.ts';
import { readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';
import { configureAssemblyTemplate } from '../templates/project/tools/meteor/assembly-template.ts';

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-workspace-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' });
  const config = readJson<any>(join(root, 'meteor.config.json'));
  const base = config.targets[0];
  // All use the implemented int8 adapter. The dtype ID can distinguish registered
  // contracts; this tests namespace isolation, not additional hardware adapters.
  const targets = [base, { ...base, op_id: 'other-op' }, { ...base, dtype_id: 'int8-other-contract' }];
  for (const target of targets) {
    target.case_suite_ref = `cases/${target.op_id}/${target.dtype_id}/default/suite.json`;
    writeJson(join(root, target.case_suite_ref), { ...readJson<any>(join(root, base.case_suite_ref)), revision: 'same-suite',
      cases: [{ case_id: 'same-case', shape: { m: 1, n: 16, k: 32 }, dtype: 'int8', layout: 'qmq-v1', input_hash: 'input', oracle_hash: 'oracle' }] });
  }
  writeJson(join(root, 'meteor.config.json'), { ...config, targets });
  const projects = targets.map(target => loadProject(root, target));
  for (const [index, project] of projects.entries()) {
    const source = join(root, `assembly-template-${index}.asc.tmpl`);
    writeFileSync(source, readFileSync(join(process.cwd(), 'templates/project/templates/qmq-v1/int8/version.asc.tmpl'), 'utf8'));
    configureAssemblyTemplate(project, { source_path: source, template_id: `workspace-scope-${index}`, now: '2026-09-27T00:00:00.000Z' });
  }
  return { root, projects: targets.map(target => loadProject(root, target)) };
}

function sql(project: Project, query: string, params: unknown[] = []) {
  const script = 'import json,sqlite3,sys; p=json.load(sys.stdin); db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; rows=[dict(r) for r in db.execute(p["query"],p["params"])]; db.commit(); print(json.dumps(rows))';
  const result = spawnSync('python', ['-c', script, join(storePaths(project).knowledgeRoot, 'catalog.sqlite')], {
    encoding: 'utf8', windowsHide: true, input: JSON.stringify({ query, params }), env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function candidate(project: Project, marker: string) {
  const record = createResearch(project, { research_id: 'same-research', agent_session_id: 'pending', chief_id: 'chief', goal: 'Isolate target identities' });
  bindResearchSession(project, record.research_id, 'same-session');
  const draft = receiptRef(project, join(researchPath(project, record.research_id), 'drafts', 'candidate'));
  const module: KernelModule = { target: targetRef(project), kernel_id: 'same-kernel', revision: 'r1', operator_abi: project.suite.operator_abi,
    symbol_prefix: 'candidate_', launcher: 'candidate_launch', device_file: draft + '/device.asc', host_file: draft + '/host.asc',
    dependencies: [], supported_case_ids: ['same-case'], hardware_scope: 'mock', resource_constraints: [] };
  writeJson(join(project.root, draft, 'kernel.json'), module);
  writeFileSync(join(project.root, module.device_file), `// Explicit mock source ${marker}\n`);
  writeFileSync(join(project.root, module.host_file), 'MeteorStatus candidate_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  const draftHash = computeSourceHash(project, module);
  const build = await buildKernel(project, { research_id: record.research_id, experiment_id: 'same-experiment', kernel_path: draft, fixture: { fixture_id: 'scope-unit' } });
  assert.equal(build.draft_source_hash, draftHash);
  const full = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full' });
  const profile = await profileKernel(project, { build_ref: full.build_ref, case_ids: ['same-case'], metrics: ['memory_bytes'], fixture: { fixture_id: 'scope-unit' } });
  const fullRef = receiptRef(project, testReceiptPath(project, full));
  const submission: Submission = {
    research_id: record.research_id, agent_session_id: 'same-session', execution_backend: 'mock', termination_reason: 'Fixture complete',
    hypothesis: { hypothesis_id: 'same-hypothesis', revision: 'h1', statement: 'Target evidence is independent', scope: marker,
      mechanism: 'Separate target identity', intervention: 'Same local identifiers in different targets', controls: [], predictions: ['Independent records'],
      support_criteria: ['Independent observed identities'], refutation_criteria: ['Cross-target overwrite'], confounders: ['Mock'],
      measurement_plan: 'Explicit mock full test', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock protocol only'] },
    hypothesis_history: [], experiments: [{ experiment_id: 'same-experiment', hypothesis_revision: 'h1', question: 'Are records isolated?',
      intervention: marker, controls: [], kernel_revisions: [build.kernel_ref], environment_ref: full.environment_ref,
      full_size_test_refs: [fullRef], profile_refs: [], analysis: 'Mock protocol fixture', next_experiment: 'Real measurements' }],
    submitted_kernels: [{ ...build.kernel_ref, source_hash: build.source_hash, artifact_refs: [build.module_ref], supported_domain: 'same-case',
      verified_case_ids: ['same-case'], recommended_domain: 'same-case', recommended_case_ids: ['same-case'], hardware_scope: 'mock',
      resource_constraints: [], unsupported_cases: [], case_suite_revision: full.case_suite_revision, environment_ref: full.environment_ref,
      measurement_protocol_ref: full.measurement_protocol_ref, full_size_test_ref: fullRef, test_status: 'COMPLETED', performance_data_ref: fullRef,
      data_hash: full.data_hash, measured_tradeoffs: marker, limitations: ['Mock'] }],
    knowledge_updates: [{ claim_id: 'same-claim', kind: 'observation', statement: marker, scope: marker, evidence_refs: [fullRef], related_material_ids: [] }],
    chief_report: { summary: marker, findings: [marker], unresolved: ['Hardware evidence'], next_steps: ['Test hardware'] },
  };
  return { build, full, profile, submission, draft };
}

test('one catalog isolates identical local names across op and dtype targets, including routing and freshness', async t => {
  const { projects } = setup(t);
  const measured = [];
  for (const [index, project] of projects.entries()) {
    const item = await candidate(project, `target-${index}`);
    const prepared = prepareSubmission(project, item.submission);
    const committed = commitSubmission(project, prepared.prepared_submission_id, 'same-session');
    measured.push({ ...item, committed });
    assert.deepEqual(getResearch(project, 'same-research').target, targetRef(project));
    assert.deepEqual(readJson(testReceiptPath(project, item.full)).target, targetRef(project));
    assert.equal(item.profile.build_ref, item.full.build_ref);
    assert.ok(existsSync(profileReceiptPath(project, item.profile)));
    assert.ok(existsSync(statePath(project, 'kernel-source-registry', 'same-kernel', 'r1.json')));
  }
  assert.equal(new Set(projects.map(p => storePaths(p).knowledgeRoot)).size, 1);
  assert.equal(new Set(measured.map(m => m.build.source_hash)).size, 3);
  assert.equal(new Set(measured.map(m => m.committed.submission_id)).size, 3);
  assert.equal(sql(projects[0], 'SELECT * FROM research_runs').length, 3);
  assert.equal(sql(projects[0], 'SELECT * FROM hypotheses').length, 3);
  assert.equal(sql(projects[0], 'SELECT * FROM kernel_submissions').length, 3);
  assert.equal(sql(projects[0], 'SELECT * FROM case_measurements WHERE case_id=?', ['same-case']).length, 3);
  assert.equal(sql(projects[0], 'SELECT * FROM knowledge_claims WHERE claim_id=?', ['same-claim']).length, 3);
  for (const [index, project] of projects.entries()) {
    assert.equal(listDbMaterials(project).find(m => m.material_id === 'same-claim')?.statement, `target-${index}`);
    assert.equal(listDbIntegrationEvents(project).length, 1);
    assert.equal(claimDbIntegrationEvent(project, measured[(index + 1) % 3].committed.integration_event_id, 'foreign'), undefined);
    const integrated = await processIntegrationEvents(project);
    assert.equal(integrated.assembled, 1);
    assert.ok(integrated.results[0].version_spec_ref?.startsWith(targetPath(project, 'versions')));
    assert.deepEqual(readJson(integrated.results[0].version_spec_ref!).target, targetRef(project));
    const draw = sampleMaterials(project, { seed: 1, count: 20 });
    assert.equal(new Set(draw.selected.map(m => m.material_key)).size, 2);
    assert.ok(draw.selected.every(m => m.target?.op_id === project.scope!.op_id && m.target?.dtype_id === project.scope!.dtype_id),
      'default dtype knowledge and kernels remain scoped to their exact target');
    const selectedForeign = listDbMaterials(project, { all_targets: true }).find(m => m.target!.op_id !== project.scope!.op_id || m.target!.dtype_id !== project.scope!.dtype_id)!;
    const foreignRef = `sqlite://${selectedForeign.kind}/${encodeURIComponent(selectedForeign.material_key!)}`;
    const replay = selectInitialMaterials(project, { mode: 'specified', [selectedForeign.kind === 'kernel' ? 'kernel_refs' : 'knowledge_refs']: [foreignRef] });
    assert.equal(replay.selected[0].material_key, selectedForeign.material_key);
    assert.equal(replay.selected[0].usage, 'inspiration_only');
    const foreign = selectInitialMaterials(project, { mode: 'specified', kernel_refs: [measured[(index + 1) % 3].build.module_ref] });
    assert.equal(foreign.selected.length, 1, 'another target kernel remains readable as inspiration');
  }
  const before = listDbMaterials(projects[1]).find(m => m.material_id === 'same-claim')!.last_novelty_event_at;
  sql(projects[0], 'UPDATE novelty_events SET created_at=? WHERE target_key=? AND material_id=?', ['2000-01-01T00:00:00Z', scopeKey(projects[0]), 'same-claim']);
  assert.equal(listDbMaterials(projects[0]).find(m => m.material_id === 'same-claim')!.last_novelty_event_at, '2000-01-01T00:00:00Z');
  assert.equal(listDbMaterials(projects[1]).find(m => m.material_id === 'same-claim')!.last_novelty_event_at, before);
});

test('runtime target cannot be replaced by draft, submission, research update or foreign receipt', async t => {
  const { projects } = setup(t);
  const [first, second] = projects;
  const a = await candidate(first, 'first');
  const b = await candidate(second, 'second');
  assert.throws(() => loadBuildReceipt(first, b.full.build_ref), /target does not match/);
  await assert.rejects(testKernel(first, { build_ref: b.full.build_ref, mode: 'full' }), /target does not match/);
  assert.throws(() => prepareSubmission(first, { ...a.submission, target: targetRef(second) }), /target does not match/);
  assert.throws(() => updateResearch(first, 'same-research', { target: targetRef(second) }), /target does not match/);
  const draft = readJson(join(first.root, a.draft, 'kernel.json'));
  writeJson(join(first.root, a.draft, 'kernel.json'), { ...draft, target: targetRef(second), revision: 'r2' });
  await assert.rejects(buildKernel(first, { research_id: 'same-research', experiment_id: 'e2', kernel_path: a.draft, fixture: { fixture_id: 'scope-unit' } }), /target does not match/);
});

test('research snapshots freeze target resources and knowledge code without catalog, artifacts or binary cases', t => {
  const { root, projects: [project] } = setup(t);
  ensureStore(project);
  writeFileSync(join(root, 'knowledge', 'catalog.sqlite'), 'not a runtime input');
  mkdirSync(join(root, 'knowledge', 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'artifacts', 'sentinel.json'), '{}');
  const input = join(root, dirname(project.target!.case_suite_ref), 'large-case.bin');
  writeFileSync(input, Buffer.alloc(1024));
  createResearch(project, { research_id: 'snapshot', agent_session_id: 'session', chief_id: 'chief', goal: 'Freeze target runtime' });
  const snapshot = project.snapshotRoot!;
  assert.ok(existsSync(join(snapshot, project.target!.contract_ref)));
  assert.ok(existsSync(join(snapshot, project.target!.template_ref, 'version.asc.tmpl')));
  assert.ok(existsSync(join(snapshot, project.target!.case_suite_ref)));
  assert.ok(existsSync(join(snapshot, 'knowledge', 'store.py')));
  assert.ok(existsSync(join(snapshot, 'knowledge', 'migrations', '0002.sql')));
  assert.equal(existsSync(join(snapshot, 'knowledge', 'catalog.sqlite')), false);
  assert.equal(existsSync(join(snapshot, 'knowledge', 'artifacts')), false);
  assert.equal(existsSync(join(snapshot, dirname(project.target!.case_suite_ref), 'large-case.bin')), false);
});

test('catalog rejects future schemas without resetting metadata', t => {
  const { projects: [project] } = setup(t);
  ensureStore(project);
  sql(project, "UPDATE metadata SET value='999' WHERE key='schema_version'");
  assert.throws(() => ensureStore(project), /Unsupported catalog schema 999/);
  assert.equal(sql(project, "SELECT value FROM metadata WHERE key='schema_version'")[0].value, '999');
});

test('canonical source and dependency snapshots remain stable after an author draft changes', async t => {
  const { projects: [project] } = setup(t);
  const first = await candidate(project, 'immutable');
  const draftModule = readJson<KernelModule>(join(project.root, first.draft, 'kernel.json'));
  const dependency = `${first.draft}/shared.inc`;
  const content = 'static inline int fixture_shared() { return 1; }\n';
  writeFileSync(join(project.root, dependency), content);
  draftModule.revision = 'r2';
  draftModule.symbol_prefix = 'candidate_r2_';
  draftModule.launcher = 'candidate_r2_launch';
  draftModule.dependencies = [{ id: 'shared', kind: 'shared', path: dependency, sha256: sha256(content) }];
  writeJson(join(project.root, first.draft, 'kernel.json'), draftModule);
  writeFileSync(join(project.root, draftModule.host_file), 'MeteorStatus candidate_r2_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  const build = await buildKernel(project, { research_id: 'same-research', experiment_id: 'dependency', kernel_path: first.draft, fixture: { fixture_id: 'scope-unit' } });
  const archived = readJson<KernelModule>(join(project.root, build.module_ref));
  assert.equal(readFileSync(join(project.root, archived.dependencies[0].path), 'utf8'), content);
  writeFileSync(join(project.root, draftModule.device_file), '// changed unsubmitted draft\n');
  writeFileSync(join(project.root, dependency), '// changed dependency\n');
  const receipt = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full' });
  assert.equal(receipt.source_hash, build.source_hash);
  assert.equal(computeSourceHash(project, archived), build.source_hash);
  await assert.rejects(buildKernel(project, { research_id: 'same-research', experiment_id: 'changed', kernel_path: first.draft, fixture: { fixture_id: 'scope-unit' } }), /Immutable/);
  const rebuilt = await buildKernel(project, { research_id: 'same-research', experiment_id: 'canonical-reuse', kernel_path: build.source_ref, fixture: { fixture_id: 'scope-unit' } });
  assert.equal(rebuilt.source_hash, build.source_hash, 'canonical dependencies must not be renamed again');
});

test('hardware prediction rules and IR techniques are catalog views with shared readable provenance', async t => {
  const { projects } = setup(t);
  const a = await candidate(projects[0], 'mock prediction classification fixture');
  const b = await candidate(projects[1], 'mock IR technique classification fixture');
  a.submission.knowledge_updates[0].category = 'prediction_rule';
  a.submission.knowledge_updates[0].applicability = 'hardware';
  b.submission.knowledge_updates[0].category = 'ir_technique';
  for (const [index, item] of [a, b].entries()) {
    const unchanged = JSON.stringify(item.submission);
    const prepared = prepareSubmission(projects[index], item.submission);
    commitSubmission(projects[index], prepared.prepared_submission_id, 'same-session');
    assert.equal(JSON.stringify(item.submission), unchanged, 'catalog views must not rewrite authoritative submission objects');
  }
  assert.equal(sql(projects[0], 'SELECT * FROM prediction_rules')[0].target_key, scopeKey(projects[0]));
  assert.equal(sql(projects[0], 'SELECT * FROM ir_techniques')[0].target_key, scopeKey(projects[1]));
  assert.equal(sql(projects[0], 'SELECT * FROM hardware_knowledge').length, 1);
  const draw = sampleMaterials(projects[2], { count: 20, seed: 8 });
  assert.ok(draw.selected.some(m => m.category === 'prediction_rule' && m.applicability === 'hardware'));
  assert.equal(draw.selected.some(m => m.category === 'ir_technique' && m.applicability === 'target'), false);
  for (const item of draw.selected) for (const ref of item.source_refs) assert.ok(existsSync(ref));
  const localDefault = sql(projects[0], "SELECT applicability FROM ir_techniques")[0].applicability;
  assert.equal(localDefault, 'target', 'missing legacy classification fields use catalog defaults');
});

test('concurrent first-use initialization preserves every registered target in one catalog', async t => {
  const { root, projects } = setup(t);
  const results = await Promise.all(Array.from({ length: 9 }, (_, index) => new Promise<{ code: number | null; error: string }>((resolve, reject) => {
    const child = spawn('python', [join(root, 'knowledge', 'store.py'), 'init', storePaths(projects[0]).knowledgeRoot], { windowsHide: true });
    let error = '';
    child.stderr.on('data', data => { error += data.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, error }));
    child.stdin.end(JSON.stringify({ target: targetRef(projects[index % projects.length]) }));
  })));
  for (const result of results) assert.equal(result.code, 0, result.error);
  assert.equal(sql(projects[0], "SELECT * FROM targets WHERE target_key <> ''").length, 3);
  assert.equal(sql(projects[0], "SELECT value FROM metadata WHERE key='schema_version'")[0].value, '3');
});

test('new progress on qualified cross-target materials refreshes their origin without rewriting evidence', async t => {
  const { projects } = setup(t);
  const measured = [];
  for (const [index, project] of projects.entries()) measured.push(await candidate(project, `progress-${index}`));
  const commits = [];
  for (const index of [0, 2]) {
    const prepared = prepareSubmission(projects[index], measured[index].submission);
    commits.push({ index, report: commitSubmission(projects[index], prepared.prepared_submission_id, 'same-session') });
  }
  const originMaterial = listDbMaterials(projects[0]);
  const kernelKey = originMaterial.find(item => item.kind === 'kernel')!.material_key!;
  const claimKey = originMaterial.find(item => item.material_id === 'same-claim')!.material_key!;
  const originalCommit = join(storePaths(projects[0]).commitRoot, commits[0].report.submission_id + '.json');
  const originalBytes = readFileSync(originalCommit);
  sql(projects[0], "UPDATE novelty_events SET created_at='2000-01-01T00:00:00Z'");
  const invalid = structuredClone(measured[1].submission);
  invalid.knowledge_updates[0].related_material_ids = ['other-workspace/op/int8#kernel/same-kernel@r1'];
  const rejected = prepareSubmission(projects[1], invalid);
  assert.throws(() => commitSubmission(projects[1], rejected.prepared_submission_id, 'same-session'), /same hardware workspace/);
  measured[1].submission.knowledge_updates[0].related_material_ids = [kernelKey, `sqlite://observation/${encodeURIComponent(claimKey)}`];
  const prepared = prepareSubmission(projects[1], measured[1].submission);
  commitSubmission(projects[1], prepared.prepared_submission_id, 'same-session');
  const updated = listDbMaterials(projects[0]);
  for (const material of updated) assert.ok(Date.parse(material.last_novelty_event_at) > Date.parse('2000-01-01T00:00:00Z'));
  for (const material of listDbMaterials(projects[2])) assert.equal(material.last_novelty_event_at, '2000-01-01T00:00:00Z');
  assert.deepEqual(readFileSync(originalCommit), originalBytes);
  assert.equal(sql(projects[0], 'SELECT statement FROM knowledge_claims WHERE target_key=?', [scopeKey(projects[0])])[0].statement, 'progress-0');
  assert.equal(sql(projects[0], "SELECT * FROM novelty_events WHERE target_key=? AND reason='related_progress'", [scopeKey(projects[0])]).length, 2);
  commitSubmission(projects[1], prepared.prepared_submission_id, 'same-session');
  assert.deepEqual(listDbMaterials(projects[0]).map(item => item.last_novelty_event_at), updated.map(item => item.last_novelty_event_at));
});
