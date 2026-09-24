import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '../templates/project/tools/meteor/contracts.ts';
import { hashObject, inside, readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';

/** Materialize the shipped draft suite once; never replace a user's fixed suite. */
export function prepareDefaultCases(project: Project) {
  if (project.suite.revision !== 'mock-qmq-v1-suite-0001') return { changed: false };
  const driver = join(project.root, 'tools/meteor/runners/remote');
  const verifierHash = sha256(readFileSync(join(driver, 'verify_case.py')));
  const cases = project.suite.cases.map(item => {
    const dataRef = 'cases/' + item.case_id + '-seed42';
    const directory = inside(project.root, dataRef);
    if (!existsSync(join(directory, 'case.json'))) {
      const result = spawnSync(process.env.METEOR_PYTHON ?? 'python', [join(driver, 'gen_case.py'),
        '--m', String(item.shape.m), '--n', String(item.shape.n), '--k', String(item.shape.k), '--seed', '42', '--output', directory],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      if (result.status !== 0) throw new Error('Case generation requires the configured Python with NumPy: ' + (result.error?.message ?? result.stderr));
    }
    const meta = readJson(join(directory, 'case.json'));
    if (meta.m !== item.shape.m || meta.n !== item.shape.n || meta.k !== item.shape.k) throw new Error('Existing case metadata shape mismatch: ' + dataRef);
    const inputs: Record<string, string> = {}, golden: Record<string, string> = {};
    for (const [name, entry] of Object.entries(meta.files)) {
      const digest = sha256(readFileSync(inside(directory, name)));
      if (digest !== (entry as any).sha256) throw new Error('Existing case file hash mismatch: ' + dataRef + '/' + name);
      (name.startsWith('input/') ? inputs : golden)[name] = digest;
    }
    return { ...item, data_ref: dataRef, input_hash: hashObject(inputs), oracle_hash: hashObject({ verifier_sha256: verifierHash, golden }) };
  });
  project.suite = { ...project.suite, cases, revision: 'qmq-v1-seed42-' + hashObject(cases).slice(0, 16) };
  writeJson(inside(project.root, project.config.case_suite), project.suite);
  return { changed: true, case_suite_revision: project.suite.revision, case_count: cases.length };
}
