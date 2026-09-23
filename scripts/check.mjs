import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots = ['src', 'templates/project/tools/meteor', 'scripts', 'tests', 'examples'];
let count = 0;
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { check(path); continue; }
    if (!/\.(ts|mjs|js)$/.test(path)) continue;
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    if (/\s+$/m.test(readFileSync(path, 'utf8').split('\n').filter(line => /[^\r\n][ \t]+$/.test(line)).join('\n'))) { console.error('Trailing whitespace: ' + path); process.exitCode = 1; }
    count++;
  }
}
for (const root of roots) check(root);
console.log(`Checked syntax of ${count} source files`);
