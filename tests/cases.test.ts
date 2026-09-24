import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { prepareDefaultCases } from '../src/cases.ts';
import { hashObject, sha256 } from '../templates/project/tools/meteor/util.ts';

test('default draft cases become reproducible pinned inputs without replacing an existing suite', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-cases-'));
  initProject(root, { git: false });
  const project = loadProject(root);
  assert.equal(prepareDefaultCases(project).changed, true);
  for (const item of project.suite.cases) {
    const meta = JSON.parse(readFileSync(join(root, item.data_ref!, 'case.json'), 'utf8'));
    const inputs = Object.fromEntries(Object.keys(meta.files).filter(name => name.startsWith('input/'))
      .map(name => [name, sha256(readFileSync(join(root, item.data_ref!, name)))]));
    assert.equal(item.input_hash, hashObject(inputs));
    assert.match(item.oracle_hash, /^[a-f0-9]{64}$/);
  }
  const before = readFileSync(join(root, project.config.case_suite));
  assert.equal(prepareDefaultCases(project).changed, false);
  assert.deepEqual(readFileSync(join(root, project.config.case_suite)), before);
});
