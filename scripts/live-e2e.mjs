// Explicitly invoked live test runner. Web mode uses DSH's editable configuration.
// Optional test secrets enter through stdin or environment and stay out of reports.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
const [rootArg, dshEntry, patch, promptFile, ...extraArgs] = process.argv.slice(2);
if (!rootArg || !dshEntry || !patch || !promptFile) throw new Error('Usage: live-e2e.mjs root dshEntry patch promptFile|--web');
const root = resolve(rootArg);
mkdirSync(join(root, 'reports', 'live-dsh'), { recursive: true });
const web = promptFile === '--web';
let key = process.env.METEOR_E2E_API_KEY;
if (!key && !web) {
  if (!process.stdin.isTTY) throw new Error('Use a TTY for hidden key input, or set METEOR_E2E_API_KEY');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('METEOR_API_KEY_INPUT_READY\n');
  key = await new Promise(resolveKey => {
    let value = '';
    const receive = chunk => {
      const text = chunk.toString();
      if (text.includes('\u0003')) process.exit(130);
      value += text;
      if (/\r|\n/.test(value)) {
        process.stdin.off('data', receive);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolveKey(value.replace(/[\r\n]+$/, ''));
      }
    };
    process.stdin.on('data', receive);
  });
}
const clean = text => (key ? text.split(key).join('[redacted]') : text).replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').replace(/([?&]token=)[^\s]+/g, '$1[redacted]');
const args = web
  ? [resolve(dshEntry), '--profile', 'web', '--patch', resolve(patch), ...extraArgs]
  : [resolve(dshEntry), '--profile', 'headless', '--patch', resolve(patch), readFileSync(resolve(promptFile), 'utf8')];
const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'],
  env: { ...process.env, ...(key ? { METEOR_E2E_API_KEY: key } : {}) } });
let log = '';
for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
  // Login URL is console-only for the invoking browser; never retain its token in reports.
  const login = line.match(/^dsh web: (https?:\/\/\S+\?token=\S+)$/);
  if (login) process.stdout.write(`METEOR_BROWSER_LOGIN ${login[1]}\n`);
  const text = clean(line) + '\n'; log += text; process.stdout.write(text);
});
process.on('SIGINT', () => child.kill());
child.on('error', error => { console.error(clean(error.message)); process.exitCode = 1; });
child.on('close', code => {
  writeFileSync(join(root, 'reports', 'live-dsh', 'latest.log'), clean(log));
  writeFileSync(join(root, 'reports', 'live-dsh', 'latest-result.json'), JSON.stringify({ exit_code: code, finished_at: new Date().toISOString() }, null, 2));
  console.log('METEOR_LIVE_EXIT ' + code);
  process.exitCode = code ?? 1;
});
