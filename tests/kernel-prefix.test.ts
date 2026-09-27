import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { KernelModule, Project, TargetRegistration } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel } from '../templates/project/tools/meteor/kernel-build.ts';
import { bindResearchSession, createResearch, researchPath } from '../templates/project/tools/meteor/research.ts';
import { targetPath } from '../templates/project/tools/meteor/workspace.ts';
import { readJson, writeJson } from '../templates/project/tools/meteor/util.ts';

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-kernel-prefix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' });
  return { root };
}

function withSecondTarget(root: string): { first: Project; second: Project } {
  const configPath = join(root, 'meteor.config.json');
  const config = readJson<any>(configPath);
  const base = config.targets[0] as TargetRegistration;
  const second = { ...base, op_id: 'other-op' };
  second.case_suite_ref = `cases/${second.op_id}/${second.dtype_id}/default/suite.json`;
  writeJson(join(root, second.case_suite_ref), {
    ...readJson<any>(join(root, base.case_suite_ref)),
    revision: 'other-op-suite',
  });
  writeJson(configPath, { ...config, targets: [base, second] });
  return {
    first: loadProject(root, base),
    second: loadProject(root, second),
  };
}

function activate(project: Project, researchId: string): void {
  createResearch(project, {
    research_id: researchId,
    chief_id: 'chief-test',
    agent_session_id: 'pending',
    goal: 'check immutable symbol prefix ownership',
  });
  bindResearchSession(project, researchId, 'session-test');
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeCandidate(project: Project, researchId: string, kernelId: string, revision: string, prefix: string): string {
  const rel = relative(project.root, join(researchPath(project, researchId), 'drafts', kernelId, revision)).replace(/\\/g, '/');
  const module: KernelModule = {
    kernel_id: kernelId,
    revision,
    operator_abi: project.suite.operator_abi,
    symbol_prefix: prefix,
    launcher: `${prefix}launch`,
    device_file: `${rel}/device.asc`,
    host_file: `${rel}/host.asc`,
    dependencies: [],
    supported_case_ids: [project.suite.cases[0].case_id],
    hardware_scope: 'mock',
    resource_constraints: [],
  };
  write(join(project.root, module.device_file), `__global__ __aicore__ void ${kernelId}_${revision}_device() {}\n`);
  write(join(project.root, module.host_file), `MeteorStatus ${prefix}launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n`);
  writeJson(join(project.root, rel, 'kernel.json'), module);
  return rel;
}

function countNamedFiles(root: string, name: string): number {
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).reduce((count, entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return count + countNamedFiles(path, name);
    return count + (entry.isFile() && entry.name === name ? 1 : 0);
  }, 0);
}

test('build rejects a new revision that reuses an archived target symbol prefix before archiving or running', async t => {
  const { root } = setup(t);
  const project = loadProject(root);
  activate(project, 'prefix-conflict');
  const first = writeCandidate(project, 'prefix-conflict', 'qmqv1-bl', 'r1', 'sharedprefix_');
  const built = await buildKernel(project, {
    research_id: 'prefix-conflict',
    experiment_id: 'e1',
    kernel_path: first,
    fixture: { fixture_id: 'prefix-unit' },
  });

  const second = writeCandidate(project, 'prefix-conflict', 'qmqv1-bl', 'r2', 'sharedprefix_');
  await assert.rejects(
    buildKernel(project, {
      research_id: 'prefix-conflict',
      experiment_id: 'e2',
      kernel_path: second,
      fixture: { fixture_id: 'prefix-unit' },
    }),
    /symbol_prefix sharedprefix_.*qmqv1-bl@r1.*qmqv1-bl@r2.*unique symbol_prefix.*launcher/,
  );
  assert.equal(existsSync(targetPath(project, 'kernels', 'qmqv1-bl', 'r2', 'kernel.json')), false);
  assert.equal(existsSync(targetPath(project, 'experiments', 'prefix-conflict', 'e2')), false);

  const rebuilt = await buildKernel(project, {
    research_id: 'prefix-conflict',
    experiment_id: 'e3',
    kernel_path: built.source_ref,
    fixture: { fixture_id: 'prefix-unit' },
  });
  assert.equal(rebuilt.kernel_ref.kernel_id, 'qmqv1-bl');
  assert.equal(rebuilt.source_hash, built.source_hash);
});

test('concurrent builds that race for one fresh prefix allow only one archive and runner receipt', async t => {
  const { root } = setup(t);
  const project = loadProject(root);
  activate(project, 'prefix-race');
  const first = writeCandidate(project, 'prefix-race', 'race-a', 'r1', 'racingprefix_');
  const second = writeCandidate(project, 'prefix-race', 'race-b', 'r1', 'racingprefix_');

  const results = await Promise.allSettled([
    buildKernel(project, {
      research_id: 'prefix-race',
      experiment_id: 'race-a',
      kernel_path: first,
      fixture: { fixture_id: 'prefix-unit' },
    }),
    buildKernel(project, {
      research_id: 'prefix-race',
      experiment_id: 'race-b',
      kernel_path: second,
      fixture: { fixture_id: 'prefix-unit' },
    }),
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejection.reason?.message ?? rejection.reason), /symbol_prefix racingprefix_.*already owned.*unique symbol_prefix/);
  const archived = ['race-a', 'race-b'].filter(kernelId => existsSync(targetPath(project, 'kernels', kernelId, 'r1', 'kernel.json')));
  assert.equal(archived.length, 1);
  const experimentDirs = ['race-a', 'race-b'].filter(experimentId => existsSync(targetPath(project, 'experiments', 'prefix-race', experimentId)));
  assert.deepEqual(experimentDirs, archived);
  assert.equal(countNamedFiles(targetPath(project, 'builds'), 'receipt.json'), 1);
});

test('symbol prefix ownership is isolated across workspace targets', async t => {
  const { root } = setup(t);
  const { first, second } = withSecondTarget(root);
  for (const [project, marker] of [[first, 'first'], [second, 'second']] as const) {
    activate(project, `prefix-${marker}`);
    const draft = writeCandidate(project, `prefix-${marker}`, 'same-local-name', 'r1', 'targetlocal_');
    const build = await buildKernel(project, {
      research_id: `prefix-${marker}`,
      experiment_id: 'e1',
      kernel_path: draft,
      fixture: { fixture_id: 'prefix-unit' },
    });
    assert.equal(build.kernel_ref.kernel_id, 'same-local-name');
    assert.ok(existsSync(join(project.root, build.module_ref)));
  }
});
