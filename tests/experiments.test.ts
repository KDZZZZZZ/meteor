import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { KernelModule, Project } from '../templates/project/tools/meteor/contracts.ts';
import { renderSingleKernel, renderVersion } from '../templates/project/tools/meteor/assemble.ts';
import { buildKernel } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel } from '../templates/project/tools/meteor/kernel-test.ts';
import { profileKernel } from '../templates/project/tools/meteor/kernel-profile.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { hashObject, sha256 } from '../templates/project/tools/meteor/util.ts';

function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function makeProject(backend: 'mock' | 'ssh' = 'mock'): Project {
  const root = mkdtempSync(join(tmpdir(), 'meteor-exp-'));
  cpSync(join(process.cwd(), 'templates/project/asc'), join(root, 'asc'), { recursive: true });
  const preamble = '#define METEOR_TEST_PREAMBLE 1\n';
  const shared = 'static inline int meteor_shared_answer() { return 42; }\n';
  write(join(root, 'common/preamble.inc'), preamble);
  write(join(root, 'common/shared.inc'), shared);
  write(join(root, 'kernels/demo/r1/device.asc'), '__global__ __aicore__ void demo_device() {}\n');
  write(join(root, 'kernels/demo/r1/host.asc'), [
    'MeteorStatus demo_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&)',
    '{',
    '    return MeteorStatus::Success;',
    '}',
    '',
  ].join('\n'));
  const module: KernelModule = {
    kernel_id: 'demo',
    revision: 'r1',
    operator_abi: 'qmq-v1',
    symbol_prefix: 'demo_',
    launcher: 'demo_launch',
    device_file: 'kernels/demo/r1/device.asc',
    host_file: 'kernels/demo/r1/host.asc',
    supported_case_ids: ['c1'],
    dependencies: [
      { id: 'preamble', path: 'common/preamble.inc', sha256: sha256(preamble), kind: 'preamble' },
      { id: 'shared', path: 'common/shared.inc', sha256: sha256(shared), kind: 'shared' },
    ],
    hardware_scope: 'mock',
    resource_constraints: [],
  };
  write(join(root, 'kernels/demo/r1/kernel.json'), JSON.stringify(module, null, 2) + '\n');
  return {
    root,
    dataRoot: join(root, 'reports/meteor', backend),
    config: {
      schema_version: 1,
      execution: { backend, profile_ref: backend === 'mock' ? 'mock-qmq-v1' : 'devenvc' },
      case_suite: 'suite-qmq-v1',
      environment: {
        environment_ref: backend === 'mock' ? 'mock-env-qmq-v1' : 'ssh-env-qmq-v1',
        hardware: backend,
        toolchain: 'mock-toolchain',
        measurement_protocol_ref: 'protocol-qmq-v1',
        simulated: backend === 'mock',
      },
      sampling: { epsilon: 0.1, lambda: 1, tau_hours: 24, count: 2 },
      budget: { max_experiments: 3, max_wall_time_seconds: 60 },
      integration: { min_relative_improvement: 0.01 },
    },
    suite: {
      revision: 'suite-rev-1',
      operator_abi: 'qmq-v1',
      cases: [
        { case_id: 'c1', shape: { m: 16, n: 32, k: 64 }, dtype: 'int8', layout: 'qmq-v1', input_hash: 'input-c1', oracle_hash: 'oracle-c1' },
        { case_id: 'c2', shape: { m: 32, n: 32, k: 64 }, dtype: 'int8', layout: 'qmq-v1', input_hash: 'input-c2', oracle_hash: 'oracle-c2' },
      ],
    },
  };
}

function activate(project: Project, researchId: string): void {
  createResearch(project, {
    research_id: researchId,
    chief_id: 'chief-test',
    agent_session_id: 'pending',
    goal: 'test kernel experiment lane',
  });
  bindResearchSession(project, researchId, 'session-test');
}

test('mock full test writes deterministic complete receipt with explicit unsupported rows', async () => {
  const project = makeProject();
  activate(project, 'rA');
  const build = await buildKernel(project, { research_id: 'rA', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rA/experiments/e1/builds', `${build.build_id}.json`)));
  const receipt = await testKernel(project, { build_ref: buildRef, mode: 'full' });

  assert.equal(build.execution_backend, 'mock');
  assert.equal(build.simulated, true);
  assert.equal(receipt.rows.length, 2);
  assert.equal(receipt.accounting_complete, true);
  assert.equal(receipt.rows[0].status, 'PASS');
  assert.equal(receipt.rows[0].samples_us.length, 5);
  assert.equal(receipt.rows[1].status, 'UNSUPPORTED');
  assert.equal(receipt.rows[0].input_hash, 'input-c1');
  assert.equal(receipt.rows[0].oracle_hash, 'oracle-c1');
  assert.equal(receipt.data_hash, hashObject(receipt.rows));
  assert.equal(receipt.build_ref, buildRef);
});

test('missing candidate manifest reports how to create it without consuming an experiment', async () => {
  const project = makeProject();
  project.config.budget.max_experiments = 1;
  activate(project, 'repair-missing-manifest');
  const manifestPath = join(project.root, 'kernels/demo/r1/kernel.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  rmSync(manifestPath);
  const input = { research_id: 'repair-missing-manifest', experiment_id: 'e1', kernel_path: 'kernels/demo/r1/kernel.json' };
  await assert.rejects(buildKernel(project, input), /manifest missing:.*kernel\.json.*Create kernel\.json.*retry this experiment/);
  assert.equal(existsSync(join(project.dataRoot, 'research', input.research_id, 'experiments')), false);
  writeFileSync(manifestPath, manifest);
  assert.equal((await buildKernel(project, input)).status, 'COMPLETED');
});

test('missing candidate sources report how to repair without consuming an experiment', async () => {
  const project = makeProject();
  project.config.budget.max_experiments = 1;
  activate(project, 'repair-missing-source');
  const hostPath = join(project.root, 'kernels/demo/r1/host.asc');
  const hostSource = readFileSync(hostPath, 'utf8');
  rmSync(hostPath);
  const input = { research_id: 'repair-missing-source', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' };
  await assert.rejects(buildKernel(project, input), /source files missing:.*host\.asc.*retry this experiment/);
  assert.equal(existsSync(join(project.dataRoot, 'research', input.research_id, 'experiments')), false);
  writeFileSync(hostPath, hostSource);
  assert.equal((await buildKernel(project, input)).status, 'COMPLETED');
});

test('missing candidate dependency reports how to repair without consuming an experiment', async () => {
  const project = makeProject();
  project.config.budget.max_experiments = 1;
  activate(project, 'repair-missing-dependency');
  const dependencyPath = join(project.root, 'common/shared.inc');
  const dependencySource = readFileSync(dependencyPath, 'utf8');
  rmSync(dependencyPath);
  const input = { research_id: 'repair-missing-dependency', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' };
  await assert.rejects(buildKernel(project, input), /source files missing:.*common\/shared\.inc.*dependency sources.*retry this experiment/);
  assert.equal(existsSync(join(project.dataRoot, 'research', input.research_id, 'experiments')), false);
  writeFileSync(dependencyPath, dependencySource);
  assert.equal((await buildKernel(project, input)).status, 'COMPLETED');
});

test('probe mode never masquerades as full accounting', async () => {
  const project = makeProject();
  activate(project, 'rA');
  const build = await buildKernel(project, { research_id: 'rA', experiment_id: 'e2', kernel_path: 'kernels/demo/r1' });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rA/experiments/e2/builds', `${build.build_id}.json`)));
  const receipt = await testKernel(project, { build_ref: buildRef, mode: 'probe', case_ids: ['c1'] });

  assert.equal(receipt.mode, 'probe');
  assert.equal(receipt.rows.length, 1);
  assert.equal(receipt.accounting_complete, false);
});

test('stale build_ref is rejected after kernel source changes', async () => {
  const project = makeProject();
  activate(project, 'rB');
  const build = await buildKernel(project, { research_id: 'rB', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rB/experiments/e1/builds', `${build.build_id}.json`)));
  write(join(project.root, 'kernels/demo/r1/host.asc'), 'MeteorStatus demo_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Unsupported; }\n');

  await assert.rejects(() => testKernel(project, { build_ref: buildRef, mode: 'full' }), /Stale build_ref/);
  await assert.rejects(() => buildKernel(project, { research_id: 'rB', experiment_id: 'e2', kernel_path: 'kernels/demo/r1' }), /assign a new revision/);
});

test('kernel.json path and module directory produce the same immutable build identity', async () => {
  const project = makeProject();
  activate(project, 'rPath');
  const input = { research_id: 'rPath', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' };
  const directory = await buildKernel(project, input);
  const file = await buildKernel(project, { ...input, kernel_path: input.kernel_path + '/kernel.json' });
  assert.deepEqual(file, directory);
  assert.equal(file.module_ref, 'kernels/demo/r1/kernel.json');
});

test('failed mock build records NOT_RUN test rows instead of passing', async () => {
  const project = makeProject();
  activate(project, 'rFail');
  const build = await buildKernel(project, {
    research_id: 'rFail',
    experiment_id: 'e1',
    kernel_path: 'kernels/demo/r1',
    fixture: { fixture_id: 'failed-build', build_status: 'FAILED' },
  });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rFail/experiments/e1/builds', `${build.build_id}.json`)));
  const receipt = await testKernel(project, { build_ref: buildRef, mode: 'full' });

  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.accounting_complete, false);
  assert.equal(receipt.rows.every(row => row.status === 'NOT_RUN'), true);
});

test('fixture cannot force PASS for unsupported case', async () => {
  const project = makeProject();
  activate(project, 'rUnsupported');
  const build = await buildKernel(project, { research_id: 'rUnsupported', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rUnsupported/experiments/e1/builds', `${build.build_id}.json`)));
  const receipt = await testKernel(project, {
    build_ref: buildRef,
    mode: 'probe',
    case_ids: ['c2'],
    fixture: { fixture_id: 'bad-pass', cases: { c2: { status: 'PASS', samples_us: [1, 2, 3, 4, 5] } } },
  });

  assert.equal(receipt.rows[0].status, 'UNSUPPORTED');
  assert.equal(receipt.rows[0].samples_us.length, 0);
});

test('immutable build receipts detect corruption on idempotent rebuild', async () => {
  const project = makeProject();
  activate(project, 'rC');
  const build = await buildKernel(project, { research_id: 'rC', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  const buildPath = join(project.dataRoot, 'research/rC/experiments/e1/builds', `${build.build_id}.json`);
  const corrupted = JSON.parse(readFileSync(buildPath, 'utf8'));
  corrupted.artifact_hash = 'corrupted';
  writeFileSync(buildPath, JSON.stringify(corrupted, null, 2) + '\n');

  await assert.rejects(() => buildKernel(project, { research_id: 'rC', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' }), /Immutable record conflict/);
});

test('profile receipts bind exact cases and metrics', async () => {
  const project = makeProject();
  activate(project, 'rD');
  const build = await buildKernel(project, { research_id: 'rD', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  const buildRef = slash(relative(project.root, join(project.dataRoot, 'research/rD/experiments/e1/builds', `${build.build_id}.json`)));
  const receipt = await profileKernel(project, { build_ref: buildRef, case_ids: ['c1'], metrics: ['l2_transactions'] });

  assert.equal(receipt.simulated, true);
  assert.deepEqual(receipt.observations.map(item => [item.case_id, item.metric]), [['c1', 'l2_transactions']]);
  await assert.rejects(() => profileKernel(project, { build_ref: buildRef, case_ids: ['c2'], metrics: ['l2_transactions'] }), /unsupported case/);
  await assert.rejects(() => profileKernel(project, { build_ref: buildRef, case_ids: ['c1'], metrics: ['bad metric'] }), /Invalid profile metric/);
});

test('assembly renders template slots without rewriting module symbols', () => {
  const project = makeProject();
  const module = JSON.parse(readFileSync(join(project.root, 'kernels/demo/r1/kernel.json'), 'utf8')) as KernelModule;
  const single = renderSingleKernel(project, module);
  assert.match(single, /MeteorStatus demo_launch/);
  assert.match(single, /const int64_t m64 = call\.info_x1\.tensors\[0\]\.shape\[0\];/);
  assert.match(single, /status = demo_launch\(call, shape, resources\);/);
  assert.doesNotMatch(single, /\{\{/);
  assert.throws(() => renderSingleKernel(project, { ...module, symbol_prefix: 'demo' }),
    /symbol_prefix "demo" requires launcher "demolaunch", got "demo_launch"/);

  const version = renderVersion(project, {
    assembly_key: 'version-test',
    implementations: [{ implementation_id: 1, module }],
    routes: [{ rule_id: 7, implementation_id: 1, case_ids: ['c1'] }],
  });
  assert.match(version, /return \{7U, 1U\};/);
  assert.match(version, /case 1U:/);
  assert.match(version, /status = demo_launch\(call, shape, resources\);/);
  assert.throws(() => renderVersion(project, {
    assembly_key: 'partial-shape',
    implementations: [{ implementation_id: 1, module }],
    routes: [{ rule_id: 8, implementation_id: 1, shape: { m: 16 } }],
  }), /explicit measured case_ids/);
  assert.throws(() => renderVersion(project, {
    assembly_key: 'unsupported-route',
    implementations: [{ implementation_id: 1, module }],
    routes: [{ rule_id: 8, implementation_id: 1, case_ids: ['c2'] }],
  }), /untested or unsupported/);
  assert.throws(() => renderVersion(project, {
    assembly_key: 'overlap-route',
    implementations: [{ implementation_id: 1, module }],
    routes: [
      { rule_id: 8, implementation_id: 1, case_ids: ['c1'] },
      { rule_id: 9, implementation_id: 1, case_ids: ['c1'] },
    ],
  }), /Duplicate or overlapping/);
});

test('mock backend does not write ssh evidence or fabricate real execution', async () => {
  const project = makeProject('mock');
  activate(project, 'rE');
  const build = await buildKernel(project, { research_id: 'rE', experiment_id: 'e1', kernel_path: 'kernels/demo/r1' });
  assert.equal(build.execution_backend, 'mock');
  assert.equal(build.simulated, true);
  assert.equal(slash(project.dataRoot).endsWith('reports/meteor/mock'), true);
});

test('ssh backend rejects research before execution when device setup is missing', () => {
  const project = makeProject('ssh');
  assert.throws(() => activate(project, 'rF'), /Device setup required/);
  assert.equal(project.config.environment.simulated, false);
});

test('abort signal is observed before mock build starts', async () => {
  const project = makeProject();
  activate(project, 'rAbort');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => buildKernel(project, {
    research_id: 'rAbort',
    experiment_id: 'e1',
    kernel_path: 'kernels/demo/r1',
    signal: controller.signal,
  }), /aborted/i);
});
