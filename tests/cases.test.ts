import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { prepareDefaultCases } from '../src/cases.ts';
import { hashObject, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';

test('default full-size matrix covers route boundaries and large shapes within its transport budget', () => {
  const suite = JSON.parse(readFileSync(new URL('../templates/project/asc/case-suite.json', import.meta.url), 'utf8'));
  assert.equal(suite.cases.length, 192);
  const shapes = new Set(suite.cases.map((item: any) => Object.values(item.shape).join('x')));
  assert.equal(shapes.size, 192);
  for (const shape of ['16x32x64', '32x32x64', '64x64x128', '128x64x256',
    '1x1x1', '4096x4096x4096', '8192x64x64', '16x32769x128', '16x128x8192']) assert.ok(shapes.has(shape), shape);
  for (const n of [2047, 2048, 2049, 4095, 4096, 4097, 16383, 16384, 16385]) assert.ok(shapes.has(`16x${n}x128`));
  for (const k of [31, 32, 33, 127, 128, 129, 1023, 1024, 1025, 4095, 4096, 4097]) assert.ok(shapes.has(`16x128x${k}`));
  for (const axis of ['m', 'n', 'k']) {
    const values = suite.cases.map((item: any) => item.shape[axis]);
    assert.deepEqual([Math.min(...values), Math.max(...values)], suite.coverage.bounds[axis]);
  }
  const bytes = suite.cases.reduce((total: number, {shape: {m,n,k}}: any) => total + m*k + n*k + m*n + 8*m + 4*n, 0);
  assert.equal(bytes, suite.coverage.pinned_binary_bytes);
  assert.ok(bytes <= 256 * 2**20);
  assert.deepEqual(new Set(suite.cases.map((item: any) => item.generation.mode)), new Set(['random', 'zero-row', 'all-zero']));
});

function smallProject() {
  const root = mkdtempSync(join(tmpdir(), 'meteor-cases-'));
  initProject(root, { git: false });
  const project = loadProject(root);
  // Exercise all generation modes without regenerating the wide matrix in each unit run.
  project.suite.cases = project.suite.cases.filter(item => ['qmq_i8_001x001x001', 'qmq_i8_002x002x002', 'qmq_i8_003x005x007'].includes(item.case_id));
  writeJson(join(root, project.config.case_suite), project.suite);
  return project;
}

test('default draft cases become reproducible pinned inputs without replacing an existing suite', async () => {
  const project = smallProject(), root = project.root;
  assert.equal((await prepareDefaultCases(project)).changed, true);
  for (const item of project.suite.cases) {
    const meta = JSON.parse(readFileSync(join(root, item.data_ref!, 'case.json'), 'utf8'));
    const inputs = Object.fromEntries(Object.keys(meta.files).filter(name => name.startsWith('input/'))
      .map(name => [name, sha256(readFileSync(join(root, item.data_ref!, name)))]));
    assert.equal(item.input_hash, hashObject(inputs));
    assert.match(item.oracle_hash, /^[a-f0-9]{64}$/);
    assert.equal(meta.seed, item.generation!.seed);
    assert.equal(meta.mode, item.generation!.mode);
  }
  const before = readFileSync(join(root, project.config.case_suite));
  assert.equal((await prepareDefaultCases(project)).changed, false);
  assert.deepEqual(readFileSync(join(root, project.config.case_suite)), before);
});

test('cancelled generation leaves the fixed suite unchanged and no partial case destination', async () => {
  const project = smallProject(), root = project.root;
  const before = readFileSync(join(root, project.config.case_suite));
  writeFileSync(join(root, 'tools/meteor/runners/remote/gen_case.py'), [
    'import pathlib, sys, time',
    'directory = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])',
    '(directory / "partial.bin").write_bytes(b"partial")',
    'with (directory / "partial.bin").open("rb") as held_file: time.sleep(30)',
  ].join('\n'));
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 5000);
  const monitor = setInterval(() => {
    const parent = join(root, 'cases');
    if (existsSync(parent) && readdirSync(parent).some(name => existsSync(join(parent, name, 'partial.bin')))) controller.abort();
  }, 20);
  try {
    await assert.rejects(prepareDefaultCases(project, controller.signal), { name: 'AbortError' });
  } finally { clearTimeout(watchdog); clearInterval(monitor); }
  assert.deepEqual(readFileSync(join(root, project.config.case_suite)), before);
  assert.deepEqual(readdirSync(join(root, 'cases')), []);
});

test('existing case inputs cannot be silently reused with different generation metadata', async () => {
  const project = smallProject(), draft = structuredClone(project.suite);
  await prepareDefaultCases(project);
  const dataRef = project.suite.cases[0].data_ref!;
  const path = join(project.root, dataRef, 'case.json');
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  writeJson(path, { ...meta, seed: 99 });
  project.suite = draft;
  await assert.rejects(prepareDefaultCases(project), /generation metadata mismatch/);
});
