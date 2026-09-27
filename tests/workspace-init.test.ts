import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/init.ts';
import { loadProject, loadWorkspace } from '../src/project.ts';
import { bindWorkspaceHardware } from '../templates/project/tools/meteor/hardware.ts';
import { targetFile, targetPath, knowledgePath, assertTarget } from '../templates/project/tools/meteor/workspace.ts';
import { readJson, writeJson } from '../templates/project/tools/meteor/util.ts';
import { readyHardwareResult } from './helpers/hardware.ts';

test('fresh init creates one unconfigured HW workspace and categorized artifacts, consistently on repeat', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-workspace-init-'));
  const first = initProject(root, { git: false });
  const project = loadProject(root);
  assert.equal(project.config.schema_version, 2);
  assert.match(project.scope!.workspace_id, /^workspace-/);
  assert.equal(readJson(join(root, 'hardware/target.json')).state, 'unconfigured');
  assert.equal(project.config.environment.hardware, '');
  assert.equal(existsSync(join(root, 'asc')), false);
  for (const kind of ['kernels','ir','experiments','builds','measurements','comparisons','versions','reports','research']) {
    assert.equal(targetPath(project, kind), join(root, kind, 'qmq-v1', 'int8'));
    assert(existsSync(targetPath(project, kind)));
  }
  for (const key of ['contract_ref','oracle_ref','adapter_ref','template_ref','case_suite_ref'] as const) assert(existsSync(targetFile(project, key)));
  assert(existsSync(join(knowledgePath(project), 'catalog.sqlite')));
  const repeated = initProject(root, { git: false });
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(repeated.created, []);
  assert.equal(repeated.workspace_id, first.workspace_id);
  writeFileSync(join(root, 'prompts/meteor.md'), 'human research instructions');
  assert(initProject(root, { git: false }).conflicts.some(path => path.replaceAll('\\', '/') === 'prompts/meteor.md'));
  assert.equal(readFileSync(join(root, 'prompts/meteor.md'), 'utf8'), 'human research instructions');
});

test('multiple targets require a choice, share HW and catalog, and isolate artifacts with identical local IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-workspace-targets-'));
  initProject(root, { git: false });
  const config = loadWorkspace(root);
  config.targets!.push({ ...config.targets![0], op_id: 'fixture-qmq-alias' });
  writeJson(join(root, 'meteor.config.json'), config);
  assert.throws(() => loadProject(root), /Choose target/);
  const a = loadProject(root, config.targets![0]), b = loadProject(root, config.targets![1]);
  assert.equal(a.scope!.workspace_id, b.scope!.workspace_id);
  assert.equal(knowledgePath(a), knowledgePath(b));
  assert.notEqual(targetPath(a, 'kernels', 'same', 'r1'), targetPath(b, 'kernels', 'same', 'r1'));
  assert.throws(() => assertTarget(a, b.scope), /target does not match/);
  assert.throws(() => loadProject(root, { op_id: 'unknown', dtype_id: 'int8' }), /Unknown workspace target/);
});

test('hardware binding rejects a different device architecture without replacing the original binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-workspace-hw-'));
  initProject(root, { git: false });
  const project = loadProject(root);
  bindWorkspaceHardware(project, readyHardwareResult(), 'unit-fixture-only');
  const before = readFileSync(join(root, 'hardware/target.json'));
  assert.throws(() => bindWorkspaceHardware(project, readyHardwareResult({ selected_device: {
    device_id: 0, soc_version: 'other-hardware-unit-fixture', npu_arch: 'dav-other',
  } }), 'different-unit-fixture'), /different HW/);
  assert.deepEqual(readFileSync(join(root, 'hardware/target.json')), before);
});

test('initialization does not partially update a legacy instance or overwrite its config', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-workspace-legacy-'));
  const legacy = '{"schema_version":1,"note":"preserve legacy evidence"}\n';
  writeFileSync(join(root, 'meteor.config.json'), legacy);
  const result = initProject(root, { git: false });
  assert.equal(result.state, 'migration_required');
  assert.equal(readFileSync(join(root, 'meteor.config.json'), 'utf8'), legacy);
  assert.equal(existsSync(join(root, 'tools')), false);
});
