import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProject } from './project.ts';
import { assertHardwareReady } from '../templates/project/tools/meteor/hardware.ts';
import { listSshProfiles } from '../templates/project/tools/meteor/profiles.ts';

export function initProject(root: string, options: { git?: boolean; backend?: 'mock' } = {}) {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const templateRoot = fileURLToPath(new URL('../templates/project/', import.meta.url));
  const created: string[] = [], unchanged: string[] = [], conflicts: string[] = [];
  function visit(dir: string, rel = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const local = join(rel, entry.name), source = join(dir, entry.name), target = join(root, local);
      if (entry.isSymbolicLink()) throw new Error('Template symlinks are not supported: ' + local);
      if (entry.isDirectory()) { visit(source, local); continue; }
      if (existsSync(target)) {
        (readFileSync(source).equals(readFileSync(target)) ? unchanged : conflicts).push(local);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        created.push(local);
      }
    }
  }
  visit(templateRoot);
  // Mock is opt-in for tests/demos and never overwrites a configured project.
  if (options.backend === 'mock' && created.includes('meteor.config.json')) {
    const path = join(root, 'meteor.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.execution = { backend: 'mock', profile_ref: 'mock-qmq-v1' };
    config.environment = { environment_ref: 'mock-ascend-qmq-v1', hardware: 'simulated-ascend',
      toolchain: 'mock-no-compiler', measurement_protocol_ref: 'mock-median-5-v1', simulated: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }
  let gitRoot: string | null = null;
  if (options.git !== false) {
    const found = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    if (found.status === 0) gitRoot = found.stdout.trim();
    else {
      const initialized = spawnSync('git', ['-C', root, 'init', '-b', 'main'], { encoding: 'utf8', windowsHide: true });
      if (initialized.status !== 0) throw new Error('Files initialized, but Git initialization failed: ' + (initialized.error?.message ?? initialized.stderr));
      gitRoot = root;
    }
  }
  const project = loadProject(root), backend = project.config.execution.backend;
  let state = backend === 'mock' ? 'ready_mock' : 'setup_required';
  if (backend === 'ssh') {
    try { assertHardwareReady(project); state = 'ready_ssh'; } catch { /* Chief receives setup instructions below. */ }
  }
  const next_action = backend === 'mock' ? 'Explicit mock demo only; results are simulated.'
    : state === 'ready_ssh' ? `Existing hardware report is ready at ${project.config.environment.hardware_report_ref}; chief can start hypothesis research without re-probing unless the SSH profile, device, compiler/runtime, or measurement protocol changed.`
      : project.config.environment.hardware_report_ref ? `Existing hardware report at ${project.config.environment.hardware_report_ref} is not ready for research. Chief should inspect it, resolve diagnostics and call meteor_hardware_probe again.`
        : 'Chief must call meteor_hardware_probe with no arguments to discover the existing central profile automatically. Do not invent a profile name or ask the user to repeat available configuration. Resolve diagnostics and read the hardware report before research.';
  return { root, state, execution_backend: backend, git_root: gitRoot, created, unchanged, conflicts,
    template_root: resolve(templateRoot),
    hardware_report_ref: project.config.environment.hardware_report_ref,
    available_profiles: listSshProfiles(),
    next_action,
    note: 'Existing edits are preserved. Conflicts list template differences; no remote or commit is created.' };
}
