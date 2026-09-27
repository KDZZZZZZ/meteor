import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDistribution } from '../scripts/build.mjs';

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'meteor-build-distribution-'));
  write(join(root, 'src/contracts.ts'), 'export const value: number = 41;\n');
  write(join(root, 'src/index.ts'), "import { value } from './contracts.ts';\nexport const answer: number = value;\n");
  write(join(root, 'src/nested/stale.ts'), 'export const stale: string = "remove me";\n');
  write(join(root, 'templates/project/tool.ts'), 'export const templateValue: number = 1;\n');
  write(join(root, 'templates/project/old.txt'), 'remove me\n');
  write(join(root, 'templates/project/__pycache__/ignored.pyc'), 'bytecode\n');
  return root;
}

test('distribution build updates generated files in place and prunes stale output', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');

  buildDistribution(root, dist);
  const output = join(dist, 'src/index.js');
  const hardLink = join(root, 'linked-index.js');
  linkSync(output, hardLink);
  assert.match(readFileSync(output, 'utf8'), /from '\.\/contracts\.js'/);
  assert.match(readFileSync(join(dist, 'src/contracts.md'), 'utf8'), /export const value: number = 41/);
  assert(existsSync(join(dist, 'src/nested/stale.js')));
  assert(existsSync(join(dist, 'templates/project/old.txt')));
  assert.equal(existsSync(join(dist, 'templates/project/__pycache__')), false);

  write(join(root, 'src/index.ts'), "import { value } from './contracts.ts';\nexport const answer: number = value + 1;\n");
  rmSync(join(root, 'src/nested'), { recursive: true, force: true });
  rmSync(join(root, 'templates/project/old.txt'));
  buildDistribution(root, dist);

  assert.match(readFileSync(output, 'utf8'), /value \+ 1/);
  assert.equal(readFileSync(hardLink, 'utf8'), readFileSync(output, 'utf8'));
  assert.equal(existsSync(join(dist, 'src/nested/stale.js')), false);
  assert.equal(existsSync(join(dist, 'src/nested')), false);
  assert.equal(existsSync(join(dist, 'templates/project/old.txt')), false);
});

function symlinkOrSkip(t: TestContext, target: string, path: string, type: 'file' | 'dir' | 'junction' = 'junction'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error: any) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      t.skip('symlink creation is not supported in this test environment: ' + error.code);
      return false;
    }
    throw error;
  }
}

test('distribution build refuses escaped and symlinked output destinations', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  assert.throws(() => buildDistribution(root, dist, ['../escape']), /Invalid distribution source|Invalid distribution destination/);

  mkdirSync(dist, { recursive: true });
  const outside = join(root, 'outside');
  mkdirSync(outside);
  if (!symlinkOrSkip(t, outside, join(dist, 'src'), 'junction')) return;
  assert.throws(() => buildDistribution(root, dist), /Distribution destination must not be a symlink|Distribution path must not be a symlink/);
});

test('distribution build refuses dangling output symlinks before writing', t => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'src'), { recursive: true });
  if (!symlinkOrSkip(t, join(root, 'missing-target'), join(dist, 'src/index.js'), 'file')) return;

  assert.throws(() => buildDistribution(root, dist), /Distribution file must not be a symlink|Distribution path must not be a symlink/);
  assert.equal(existsSync(join(root, 'missing-target')), false);
});
