import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project } from '../templates/project/tools/meteor/contracts.ts';
import { hashObject, inside, readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';

/** Materialize the shipped draft suite once; never replace a user's fixed suite. */
export async function prepareDefaultCases(project: Project, signal?: AbortSignal) {
  const wide = project.suite.revision === 'draft-qmq-v1-wide-0001';
  if (!wide && project.suite.revision !== 'mock-qmq-v1-suite-0001') return { changed: false };
  const driver = join(project.root, 'tools/meteor/runners/remote');
  const verifierHash = sha256(readFileSync(join(driver, 'verify_case.py')));
  const cases = [];
  for (const item of project.suite.cases) {
    signal?.throwIfAborted();
    const { seed, mode } = item.generation ?? { seed: 42, mode: 'random' };
    if (!Number.isSafeInteger(seed) || seed < 0 || !['random', 'zero-row', 'all-zero'].includes(mode)) throw new Error('Invalid case generation settings: ' + item.case_id);
    const dataRef = 'cases/' + item.case_id + '-seed' + seed + (mode === 'random' ? '' : '-' + mode);
    const directory = inside(project.root, dataRef);
    if (!existsSync(join(directory, 'case.json'))) {
      const parent = dirname(directory);
      mkdirSync(parent, { recursive: true });
      const staging = mkdtempSync(join(parent, '.meteor-case-'));
      try {
        await new Promise<void>((complete, fail) => {
          const child = spawn(process.env.METEOR_PYTHON ?? 'python', [join(driver, 'gen_case.py'),
            '--m', String(item.shape.m), '--n', String(item.shape.n), '--k', String(item.shape.k),
            '--seed', String(seed), '--mode', mode, '--output', staging],
          { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
          let diagnostic = '';
          let launchError: Error | undefined;
          child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
          // Abort reports an error before the process exits. Wait for close so
          // cleanup never races a generator still writing into the staging dir.
          child.on('error', error => { launchError = error; });
          child.on('close', code => launchError ? fail(launchError) : code === 0 ? complete()
            : fail(new Error('Case generation failed for ' + item.case_id + ': ' + diagnostic)));
        });
        signal?.throwIfAborted();
        if (!existsSync(directory)) {
          for (let attempt = 0; ; attempt++) {
            signal?.throwIfAborted();
            try { renameSync(staging, directory); break; }
            catch (error) {
              // Windows file indexers can briefly hold newly generated files.
              // Retry only transient rename locks, never remove the destination.
              const code = (error as NodeJS.ErrnoException).code;
              if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
              await delay(50 * (attempt + 1), undefined, { signal });
            }
          }
        }
      } finally {
        // Only the unique staging directory created above is eligible for cleanup.
        if (dirname(resolve(staging)) !== resolve(parent)) throw new Error('Unexpected case staging directory');
        rmSync(staging, { recursive: true, force: true });
      }
    }
    const meta = readJson(join(directory, 'case.json'));
    if (meta.m !== item.shape.m || meta.n !== item.shape.n || meta.k !== item.shape.k) throw new Error('Existing case metadata shape mismatch: ' + dataRef);
    if (meta.seed !== seed || meta.mode !== mode) throw new Error('Existing case generation metadata mismatch: ' + dataRef);
    const inputs: Record<string, string> = {}, golden: Record<string, string> = {};
    for (const [name, entry] of Object.entries(meta.files)) {
      const digest = sha256(readFileSync(inside(directory, name)));
      if (digest !== (entry as any).sha256) throw new Error('Existing case file hash mismatch: ' + dataRef + '/' + name);
      (name.startsWith('input/') ? inputs : golden)[name] = digest;
    }
    cases.push({ ...item, data_ref: dataRef, input_hash: hashObject(inputs), oracle_hash: hashObject({ verifier_sha256: verifierHash, golden }) });
  }
  project.suite = { ...project.suite, cases, revision: (wide ? 'qmq-v1-wide-' : 'qmq-v1-seed42-') + hashObject(cases).slice(0, 16) };
  writeJson(inside(project.root, project.config.case_suite), project.suite);
  return { changed: true, case_suite_revision: project.suite.revision, case_count: cases.length };
}
