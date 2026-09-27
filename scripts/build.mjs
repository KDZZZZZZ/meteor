import { stripTypeScriptTypes } from 'node:module';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DIRS = ['src', 'templates'];

function slash(path) { return path.split(sep).join('/'); }
function assertInside(base, target, message) {
  const within = relative(base, target);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error(message);
}
function assertNoSymlink(path, message) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(message + ': ' + path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
function ensureDirectory(base, dir) {
  const resolvedBase = resolve(base), resolvedDir = resolve(dir);
  assertInside(resolvedBase, resolvedDir, 'Invalid distribution destination');
  assertNoSymlink(resolvedBase, 'Distribution path must not be a symlink');
  mkdirSync(resolvedBase, { recursive: true });
  let current = resolvedBase;
  const parts = relative(resolvedBase, resolvedDir).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    assertNoSymlink(current, 'Distribution path must not be a symlink');
    if (existsSync(current)) {
      if (!lstatSync(current).isDirectory()) throw new Error('Distribution path must be a directory: ' + current);
    } else {
      mkdirSync(current);
    }
  }
}
function writeGeneratedText(rootDir, target, text, emitted) {
  const resolved = resolve(target);
  assertInside(rootDir, resolved, 'Invalid generated output path');
  ensureDirectory(rootDir, dirname(resolved));
  assertNoSymlink(resolved, 'Distribution file must not be a symlink');
  writeFileSync(resolved, text);
  emitted.add(slash(relative(rootDir, resolved)));
}
function copyGeneratedFile(rootDir, target, source, emitted) {
  const resolved = resolve(target);
  assertInside(rootDir, resolved, 'Invalid generated output path');
  ensureDirectory(rootDir, dirname(resolved));
  assertNoSymlink(resolved, 'Distribution file must not be a symlink');
  copyFileSync(source, resolved);
  emitted.add(slash(relative(rootDir, resolved)));
}
function emit(source, destination, emitted, emittedRoot = destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const src = join(source, entry.name), dst = join(destination, entry.name);
    if (entry.isDirectory()) { emit(src, dst, emitted, emittedRoot); continue; }
    if (entry.isSymbolicLink()) throw new Error('No symlinks in distribution: ' + src);
    const target = dst.endsWith('.ts') ? dst.slice(0, -3) + '.js' : dst;
    if (src.endsWith('.ts')) {
      const sourceText = readFileSync(src, 'utf8');
      if (entry.name === 'contracts.ts') writeGeneratedText(emittedRoot, join(dirname(target), 'contracts.md'),
        '# Runtime contracts\n\n```typescript\n' + sourceText + '\n```\n', emitted);
      const js = stripTypeScriptTypes(sourceText, { mode: 'strip', sourceUrl: undefined })
        .replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
        .replace(/(import\s*\(\s*['"][^'"]+)\.ts(['"]\s*\))/g, '$1.js$2');
      writeGeneratedText(emittedRoot, target, js, emitted);
    } else copyGeneratedFile(emittedRoot, target, src, emitted);
  }
}
function pruneObsolete(destination, emitted, current = destination) {
  if (!existsSync(current)) return;
  assertNoSymlink(current, 'Distribution path must not be a symlink');
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    assertNoSymlink(path, 'Distribution path must not be a symlink');
    if (entry.isDirectory()) {
      pruneObsolete(destination, emitted, path);
      if (path !== destination && readdirSync(path).length === 0) rmdirSync(path);
      continue;
    }
    const rel = slash(relative(destination, path));
    if (!emitted.has(rel)) unlinkSync(path);
  }
}
export function buildDistribution(projectRoot = root, distRoot = resolve(projectRoot, 'dist'), dirs = DEFAULT_DIRS) {
  const resolvedRoot = resolve(projectRoot), resolvedDist = resolve(distRoot);
  assertNoSymlink(resolvedDist, 'Distribution root must not be a symlink');
  mkdirSync(resolvedDist, { recursive: true });
  for (const dir of dirs) {
    const source = resolve(resolvedRoot, dir);
    assertInside(resolvedRoot, source, 'Invalid distribution source');
    const destination = resolve(resolvedDist, dir);
    assertInside(resolvedDist, destination, 'Invalid distribution destination');
    assertNoSymlink(destination, 'Distribution destination must not be a symlink');
    const emitted = new Set();
    ensureDirectory(resolvedDist, destination);
    emit(source, destination, emitted);
    pruneObsolete(destination, emitted);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDistribution();
  console.log('Built dependency-free JavaScript distribution in dist/');
}
