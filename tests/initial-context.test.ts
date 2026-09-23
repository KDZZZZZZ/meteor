import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { InitialContext, KernelModule, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel, buildReceiptPath, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel } from '../templates/project/tools/meteor/kernel-test.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { normalizeInitialContext, sampleMaterials, selectInitialMaterials } from '../templates/project/tools/meteor/sampling.ts';
import { listJsonFiles, storePaths } from '../templates/project/tools/meteor/store.ts';
import { commitSubmission, prepareSubmission } from '../templates/project/tools/meteor/submit.ts';
import { readJson, writeJson } from '../templates/project/tools/meteor/util.ts';

function tempRoot(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-initial-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  const root = tempRoot(t);
  initProject(root, { git: false });
  const project = loadProject(root);
  const kernelPath = 'kernels/seed_kernel/r1';
  const module: KernelModule = {
    kernel_id: 'seed_kernel', revision: 'r1', operator_abi: project.suite.operator_abi,
    symbol_prefix: 'seed_', launcher: 'seed_launch', device_file: kernelPath + '/device.asc', host_file: kernelPath + '/host.asc',
    supported_case_ids: project.suite.cases.map(item => item.case_id), dependencies: [], hardware_scope: 'mock', resource_constraints: [],
  };
  writeJson(join(root, kernelPath, 'kernel.json'), module);
  writeFileSync(join(root, module.device_file), '// Initial-context kernel fixture\n');
  writeFileSync(join(root, module.host_file), 'MeteorStatus seed_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  const knowledgePath = 'knowledge/tile-note.md';
  writeFileSync(join(root, knowledgePath), '# Tile note\nThis is an inspiration, not a restriction.\n');
  const researchId = 'seed_research';
  createResearch(project, { research_id: researchId, agent_session_id: 'pending', chief_id: 'chief', goal: 'Populate reusable material fixtures' });
  bindResearchSession(project, researchId, 'seed_session');
  const build = await buildKernel(project, { research_id: researchId, experiment_id: 'experiment_1', kernel_path: kernelPath });
  const receipt = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full' });
  const testRef = receiptRef(project, join(experimentDir(project, researchId, receipt.experiment_id), 'full-tests', receipt.run_id + '.json'));
  const verified = receipt.rows.filter(row => row.status === 'PASS').map(row => row.case_id);
  const submission: Submission = {
    research_id: researchId, agent_session_id: 'seed_session', execution_backend: 'mock', termination_reason: 'Fixture complete',
    hypothesis: {
      hypothesis_id: 'seed_hypothesis', revision: 'h1', statement: 'Tile choice may change memory behavior', scope: 'Mock fixture',
      mechanism: 'Tile reuse', intervention: 'Change tile size', controls: ['Same suite'], predictions: ['Different timing'],
      support_criteria: ['Controlled real evidence'], refutation_criteria: ['Valid contradictory evidence'], confounders: ['Simulation'],
      measurement_plan: 'Independent full tests', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'],
    },
    hypothesis_history: [],
    experiments: [{
      experiment_id: 'experiment_1', hypothesis_revision: 'h1', question: 'What observations are reusable?', intervention: 'Record a tile fixture',
      controls: ['Same suite'], kernel_revisions: [receipt.kernel_ref], environment_ref: receipt.environment_ref,
      full_size_test_refs: [testRef], profile_refs: [], analysis: 'Simulated records are reusable only as inspiration', next_experiment: 'Real hardware',
    }],
    submitted_kernels: [{
      ...receipt.kernel_ref, source_hash: receipt.source_hash, artifact_refs: [kernelPath + '/kernel.json'], supported_domain: 'Fixture cases',
      verified_case_ids: verified, recommended_domain: 'Fixture cases', recommended_case_ids: verified, hardware_scope: 'mock',
      resource_constraints: [], unsupported_cases: [], case_suite_revision: receipt.case_suite_revision, environment_ref: receipt.environment_ref,
      measurement_protocol_ref: receipt.measurement_protocol_ref, full_size_test_ref: testRef, test_status: 'COMPLETED',
      performance_data_ref: testRef, data_hash: receipt.data_hash, measured_tradeoffs: 'Simulated', limitations: ['Mock only'],
    }],
    knowledge_updates: ['primary', 'secondary', 'third'].map(name => ({
      claim_id: 'claim_' + name, kind: 'observation', statement: 'Recorded tile observation: ' + name, scope: 'Mock fixture',
      evidence_refs: [testRef], related_material_ids: [],
    })),
    chief_report: { summary: 'Reusable fixture materials', findings: ['Mock only'], unresolved: ['Hardware evidence'], next_steps: ['Run hardware experiments'] },
  };
  const prepared = prepareSubmission(project, submission);
  const committed = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
  return { root, project, kernelPath, module, knowledgePath, testRef, committed };
}

test('initial context defaults to random and normalizes a detached specified selection', () => {
  assert.deepEqual(normalizeInitialContext(), { mode: 'random' });
  assert.deepEqual(normalizeInitialContext({}), { mode: 'random' });
  const input = { mode: 'specified', kernel_refs: [' seed_kernel@r1 ', 'seed_kernel@r1'], knowledge_refs: ['claim_primary'] };
  const result = normalizeInitialContext(input);
  assert.deepEqual(result, { mode: 'specified', kernel_refs: ['seed_kernel@r1'], knowledge_refs: ['claim_primary'] });
  result.knowledge_refs!.push('another_claim');
  assert.deepEqual(input.knowledge_refs, ['claim_primary']);
  assert.deepEqual(normalizeInitialContext({ mode: 'specified' }), { mode: 'specified' });
});

test('initial context rejects conflicting modes, unknown options, and invalid sampling values', () => {
  const invalid: unknown[] = [
    null, [], 'random', { mode: 'other' }, { mode: 'random', kernel_refs: [] }, { mode: 'random', knowledge_refs: ['claim_primary'] },
    { mode: 'specified', sampling: {} }, { mode: 'specified', kernel_refs: [42] }, { mode: 'specified', knowledge_refs: [' '] },
    { mode: 'random', typo: true }, { mode: 'random', sampling: null }, { mode: 'random', sampling: { typo: 1 } },
    ...[{ count: -1 }, { count: 1.5 }, { seed: -1 }, { seed: 0x100000000 }, { seed: 1.5 }, { epsilon: -0.1 }, { epsilon: 1.1 },
      { lambda: -1 }, { lambda: Infinity }, { tau_hours: 0 }, { tau_hours: NaN }, { count: '2' }].map(sampling => ({ mode: 'random', sampling })),
  ];
  for (const value of invalid) assert.throws(() => normalizeInitialContext(value), JSON.stringify(value));
});

test('random selections replay from the same library and history without changing project sampling', async t => {
  const env = await setup(t);
  const replayRoot = tempRoot(t);
  cpSync(env.root, replayRoot, { recursive: true });
  const replayProject = loadProject(replayRoot);
  const originalSampling = structuredClone(env.project.config.sampling);
  const originalConfig = readFileSync(join(env.root, 'meteor.config.json'), 'utf8');
  const context: InitialContext = { mode: 'random', sampling: { count: 3, seed: 197, epsilon: 0.2, lambda: 7, tau_hours: 6 } };
  const first = selectInitialMaterials(env.project, context);
  assert.equal(first.mode, 'random');
  if (first.mode !== 'random') throw new Error('Expected a random record');
  const replay = sampleMaterials(replayProject, { ...context.sampling, now: first.drawn_at });
  assert.deepEqual(first.candidates, replay.candidates);
  assert.deepEqual(first.selected.map(item => item.material_id), replay.selected.map(item => item.material_id));
  assert.deepEqual(first.sampling, { count: 3, epsilon: 0.2, lambda: 7, tau_hours: 6 });
  assert.equal(first.seed, 197);
  assert.equal(first.candidates.length, 4);
  assert.equal(first.selected.length, 3);
  assert.deepEqual(env.project.config.sampling, originalSampling);
  assert.equal(readFileSync(join(env.root, 'meteor.config.json'), 'utf8'), originalConfig);
  assert.deepEqual(context.sampling, { count: 3, seed: 197, epsilon: 0.2, lambda: 7, tau_hours: 6 });
  const stored = listJsonFiles(join(storePaths(env.project).knowledgeRoot, 'sampling-draws')).map(path => readJson(path));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].selected, first.selected);
  assert.deepEqual(stored[0].sampling, first.sampling);
  for (const selected of first.selected) {
    assert.ok(selected.source_refs.length > 0);
    assert.ok(selected.content_hash);
    for (const ref of selected.source_refs) assert.ok(readFileSync(ref).length > 0);
  }
});

test('specified database IDs and sqlite refs select exactly those readable committed materials', async t => {
  const env = await setup(t);
  const selected = selectInitialMaterials(env.project, {
    mode: 'specified', kernel_refs: ['seed_kernel@r1'], knowledge_refs: ['sqlite://observation/claim_primary'],
  });
  assert.equal(selected.mode, 'specified');
  assert.deepEqual(selected.selected.map(item => item.material_id), ['seed_kernel@r1', 'claim_primary']);
  assert.equal(listJsonFiles(join(storePaths(env.project).knowledgeRoot, 'sampling-draws')).length, 0);
  const [kernel, knowledge] = selected.selected;
  assert.equal(kernel.ref, 'sqlite://kernel/seed_kernel@r1');
  assert.equal(kernel.revision, 'r1');
  assert.match(kernel.source_hash!, /^[a-f0-9]{64}$/);
  for (const ref of [join(env.root, env.kernelPath, 'kernel.json'), join(env.root, env.module.device_file), join(env.root, env.module.host_file)]) {
    assert.ok(kernel.source_refs.includes(ref));
  }
  assert.ok(knowledge.source_refs.includes(join(env.root, env.testRef)));
  const commitRef = knowledge.source_refs.find(ref => ref.endsWith(env.committed.submission_id + '.json'))!;
  assert.ok(readJson(commitRef).submission.knowledge_updates.some((claim: any) => claim.claim_id === 'claim_primary'));
  assert.equal(knowledge.submission_hash, env.committed.submission_hash);
  const seedPath = join(env.root, 'seed.json');
  writeJson(seedPath, selected);
  for (const material of readJson(seedPath).selected) for (const ref of material.source_refs) assert.ok(statSync(ref).isFile());
  assert.deepEqual(selectInitialMaterials(env.project, { mode: 'specified' }).selected, []);
});

test('specified kernel directories and knowledge files preserve readable sources and content identity', async t => {
  const env = await setup(t);
  const selection = selectInitialMaterials(env.project, { mode: 'specified', kernel_refs: [env.kernelPath], knowledge_refs: [env.knowledgePath] });
  const [kernel, knowledge] = selection.selected;
  assert.equal(kernel.material_id, 'seed_kernel@r1');
  assert.equal(kernel.ref, join(env.root, env.kernelPath, 'kernel.json'));
  assert.equal(kernel.source_refs.length, 3);
  assert.equal(knowledge.kind, 'document');
  assert.equal(knowledge.ref, join(env.root, env.knowledgePath));
  assert.deepEqual(knowledge.source_refs, [knowledge.ref]);
  assert.match(kernel.content_hash, /^[a-f0-9]{64}$/);
  assert.match(knowledge.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(listJsonFiles(join(storePaths(env.project).knowledgeRoot, 'sampling-draws')).length, 0);
  for (const material of selection.selected) for (const ref of material.source_refs) assert.ok(readFileSync(ref).length > 0);
});

test('specified selections reject missing references and kernel/knowledge type mismatches', async t => {
  const env = await setup(t);
  const invalid: InitialContext[] = [
    { mode: 'specified', kernel_refs: ['missing-kernel'] },
    { mode: 'specified', knowledge_refs: ['missing-note.md'] },
    { mode: 'specified', knowledge_refs: ['sqlite://observation/missing-claim'] },
    { mode: 'specified', kernel_refs: ['claim_primary'] },
    { mode: 'specified', knowledge_refs: ['sqlite://kernel/seed_kernel@r1'] },
    { mode: 'specified', kernel_refs: [env.knowledgePath] },
    { mode: 'specified', knowledge_refs: [env.kernelPath] },
    { mode: 'specified', knowledge_refs: [env.kernelPath + '/kernel.json'] },
  ];
  for (const context of invalid) assert.throws(() => selectInitialMaterials(env.project, context), JSON.stringify(context));
});

test('legacy sampleMaterials keeps its API and uses configured sampling defaults', async t => {
  const env = await setup(t);
  const draw = sampleMaterials(env.project, { count: 10, seed: 1234, now: '2030-01-01T00:00:00.000Z' });
  assert.equal(draw.algorithm, 'meteor-freshness-v1');
  assert.equal(draw.seed, 1234);
  assert.equal(draw.selected.length, 4);
  assert.equal(draw.candidates.find(item => item.material_id === 'claim_primary')?.ref, 'sqlite://observation/claim_primary');
  assert.equal(draw.sampling.epsilon, env.project.config.sampling.epsilon);
  assert.equal(draw.sampling.lambda, env.project.config.sampling.lambda);
  assert.equal(draw.sampling.tau_hours, env.project.config.sampling.tau_hours);
  assert.equal(sampleMaterials(env.project, { count: 0, seed: 1 }).selected.length, 0);
});
