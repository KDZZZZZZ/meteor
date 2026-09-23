import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function emit(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const src = join(source, entry.name), dst = join(destination, entry.name);
    if (entry.isDirectory()) { emit(src, dst); continue; }
    if (entry.isSymbolicLink()) throw new Error('No symlinks in distribution: ' + src);
    const target = dst.endsWith('.ts') ? dst.slice(0, -3) + '.js' : dst;
    mkdirSync(dirname(target), { recursive: true });
    if (src.endsWith('.ts')) {
      if (entry.name === 'contracts.ts') writeFileSync(join(dirname(target), 'contracts.md'), '# Runtime contracts\n\n```typescript\n' + readFileSync(src, 'utf8') + '\n```\n');
      const js = stripTypeScriptTypes(readFileSync(src, 'utf8'), { mode: 'strip', sourceUrl: undefined })
        .replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
        .replace(/(import\s*\(\s*['"][^'"]+)\.ts(['"]\s*\))/g, '$1.js$2');
      writeFileSync(target, js);
    } else copyFileSync(src, target);
  }
}
for (const dir of ['src', 'templates']) emit(resolve(root, dir), resolve(root, 'dist', dir));
console.log('Built dependency-free JavaScript distribution in dist/');
