import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadProject, loadWorkspace } from './project.ts';
import { assertHardwareReady } from '../templates/project/tools/meteor/hardware.ts';
import { loadExecutionModel } from '../templates/project/tools/meteor/hardware-model.ts';
import { listSshProfiles } from '../templates/project/tools/meteor/profiles.ts';
import { readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';
import { targetPath, knowledgePath } from '../templates/project/tools/meteor/workspace.ts';
import { ensureStore } from '../templates/project/tools/meteor/store.ts';

export function initProject(root: string, options: { git?: boolean; backend?: 'mock' } = {}) {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const templateRoot = fileURLToPath(new URL('../templates/project/', import.meta.url));
  const configPath = join(root, 'meteor.config.json');
  if (existsSync(configPath) && readJson(configPath).schema_version === 1) {
    return { root, state: 'migration_required', created: [], unchanged: [], conflicts: [], template_root: resolve(templateRoot),
      next_action: 'Run meteor migrate with a dry-run first. Preserve legacy snapshots and evidence; initialization does not mix new runtime files into a legacy instance.' };
  }
  const inventoryPath = join(root, '.meteor', 'template-manifest.json');
  const inventory = existsSync(inventoryPath) ? readJson(inventoryPath) : { schema_version: 1, files: {} };
  const nextInventory = { schema_version: 1, files: { ...inventory.files } };
  const created: string[] = [], unchanged: string[] = [], conflicts: string[] = [];
  function visit(dir: string, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const local = join(rel, entry.name), source = join(dir, entry.name), target = join(root, local);
      const key = local.replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw new Error('Template symlinks are not supported: ' + local);
      if (entry.isDirectory()) { visit(source, local); continue; }
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
      const templateHash = sha256(readFileSync(source));
      if (existsSync(target)) {
        const currentHash = sha256(readFileSync(target));
        const recorded = inventory.files[key];
        (currentHash === templateHash || (recorded?.template_hash === templateHash && recorded.installed_hash === currentHash)
          ? unchanged : conflicts).push(local);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        created.push(local);
        nextInventory.files[key] = { template_hash: templateHash, installed_hash: templateHash };
      }
    }
  }
  visit(templateRoot);
  if (created.includes('meteor.config.json')) {
    const config = readJson(configPath);
    config.workspace.workspace_id = 'workspace-' + randomUUID();
    writeJson(configPath, config);
  }
  // Mock is opt-in for tests/demos and never overwrites a configured project.
  if (options.backend === 'mock' && created.includes('meteor.config.json')) {
    const path = join(root, 'meteor.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.execution = { backend: 'mock', profile_ref: 'mock-qmq-v1' };
    config.environment = { environment_ref: 'mock-ascend-qmq-v1', hardware: 'simulated-ascend',
      toolchain: 'mock-no-compiler', measurement_protocol_ref: 'mock-median-5-v1', simulated: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }
  if (created.includes('meteor.config.json')) nextInventory.files['meteor.config.json'].installed_hash = sha256(readFileSync(configPath));
  writeJson(inventoryPath, nextInventory);
  let gitRoot: string | null = null;
  if (options.git !== false) {
    const found = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    if (found.status === 0 && resolve(found.stdout.trim()).toLowerCase() === root.toLowerCase()) gitRoot = root;
    else {
      const initialized = spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8', windowsHide: true });
      if (initialized.status !== 0) throw new Error('Files initialized, but Git initialization failed: ' + (initialized.error?.message ?? initialized.stderr));
      gitRoot = root;
    }
  }
  const workspace = loadWorkspace(root);
  const project = loadProject(root, workspace.targets?.[0]), backend = project.config.execution.backend;
  for (const target of workspace.targets ?? [undefined]) {
    const current = target ? loadProject(root, target) : project;
    for (const kind of ['kernels', 'ir', 'experiments', 'builds', 'measurements', 'comparisons', 'versions', 'reports', 'research']) {
      mkdirSync(targetPath(current, kind), { recursive: true });
    }
    if (current.scope) mkdirSync(knowledgePath(current, current.scope.op_id, current.scope.dtype_id), { recursive: true });
  }
  for (const rel of ['hardware/reports', 'hardware/experiments', 'hardware/execution-models', 'knowledge', '.meteor/state', '.meteor/migrations']) {
    mkdirSync(join(root, rel), { recursive: true });
  }
  ensureStore(project);
  let state = backend === 'mock' ? 'ready_mock' : 'setup_required';
  const setup: Record<string, unknown> = { hardware: false, execution_model: false, targets: [] };
  if (backend === 'ssh') {
    try { assertHardwareReady(project); setup.hardware = true; } catch { /* Keep the setup checklist explicit. */ }
    try { loadExecutionModel(project); setup.execution_model = true; } catch { /* Model may be absent or stale. */ }
    setup.targets = (workspace.targets ?? []).map(target => ({ op_id: target.op_id, dtype_id: target.dtype_id, assembly_template: !!target.assembly_template_ref }));
    if (setup.hardware && setup.execution_model && (setup.targets as any[]).every(target => target.assembly_template)) state = 'ready_ssh';
  }
  const next_action = backend === 'mock' ? 'Explicit mock demo only; results are simulated.'
    : state === 'ready_ssh' ? `Existing hardware report is ready at ${project.config.environment.hardware_report_ref}; the execution model and target templates are selected. Start research without re-probing unless the profile, device, compiler/runtime, or protocol changed.`
      : 'Load skill meteor-hardware-prepare. Use meteor_hardware_probe for missing/stale device validation, official searches and meteor_hardware_experiment to establish the execution model, then meteor_hardware_model publish and meteor_configure_assembly_template for each target. Reuse valid preparation; do not invent profiles, hardware capabilities or template choices.';
  return { root, state, execution_backend: backend, git_root: gitRoot, created, unchanged, conflicts,
    workspace_id: project.scope?.workspace_id, targets: project.config.targets, design: project.config.design,
    template_root: resolve(templateRoot),
    hardware_report_ref: project.config.environment.hardware_report_ref, setup,
    available_profiles: listSshProfiles(),
    next_action,
    note: 'Existing edits are preserved. Conflicts list template differences; no remote or commit is created.' };
}
