import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProject } from './project.ts';

export function initProject(root: string, options: { git?: boolean } = {}) {
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
  const backend = loadProject(root).config.execution.backend;
  return { root, state: `ready_${backend}`, execution_backend: backend, git_root: gitRoot, created, unchanged, conflicts,
    note: 'Existing edits are preserved. Conflicts list template differences; no remote or commit is created.' };
}
