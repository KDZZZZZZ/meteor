import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../templates/project/tools/meteor/runners/ssh.ts', import.meta.url), 'utf8');
const literal = source.match(/^const BOOTSTRAP = (`[\s\S]*?`);/m)?.[1];
assert.ok(literal, 'SSH bootstrap template must be present');
const bootstrap: string = runInNewContext(literal);
const python = process.env.PYTHON ?? 'python';

// Execute the actual bootstrap in local Python processes. Only its driver call is
// replaced, so no SSH, shell, CANN installation, or accelerator is needed.
const worker = `import base64,io,json,subprocess,sys,time
from pathlib import Path
from types import SimpleNamespace
payload=json.load(sys.stdin)
bootstrap=payload.pop('bootstrap')
control=Path(payload.pop('control'))
worker_id=payload.pop('worker_id')
slow=payload.pop('slow')
hold_driver=payload.pop('hold_driver')
paused=False
original_open=io.open
def wait_for(path):
 deadline=time.monotonic()+10
 while not path.exists():
  if time.monotonic()>deadline: raise TimeoutError(str(path))
  time.sleep(0.01)
class PausedWriter:
 def __init__(self,file): self.file=file
 def __getattr__(self,name): return getattr(self.file,name)
 def __enter__(self): return self
 def __exit__(self,*args): return self.file.__exit__(*args)
 def write(self,data):
  global paused
  if paused: return self.file.write(data)
  paused=True
  written=self.file.write(data[:1]); self.file.flush()
  (control/'write-paused').touch()
  wait_for(control/'write-release')
  return written+self.file.write(data[1:])
def tracked_open(path,mode='r',*args,**kwargs):
 file=original_open(path,mode,*args,**kwargs)
 if slow and 'b' in mode and ('w' in mode or 'x' in mode): return PausedWriter(file)
 return file
io.open=tracked_open
def local_driver(command,stdin,text):
 bundle=Path(payload['remote_root'])/'drivers'/payload['bundle_hash']
 assert Path(command[-1]).resolve()==(bundle/'driver.py').resolve()
 for name,entry in payload['files'].items():
  assert (bundle/name).read_bytes()==base64.b64decode(entry['base64']), 'driver observed incomplete bundle'
 assert json.load(stdin)==payload['request'], 'spooled request changed'
 (control/(worker_id+'.driver')).touch()
 if hold_driver: wait_for(control/'drivers-release')
 return SimpleNamespace(returncode=0)
subprocess.run=local_driver
sys.stdin=io.StringIO(json.dumps(payload))
exec(compile(bootstrap,'ssh-bootstrap','exec'))
`;

function entry(data: string) {
  return { base64: Buffer.from(data).toString('base64'), sha256: createHash('sha256').update(data).digest('hex') };
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-bootstrap-'));
  const files = { 'driver.py': entry('# remote driver\n'), 'helper.py': entry('# bundled helper\n') };
  const payload = { remote_root: join(root, 'remote'), bundle_hash: 'a'.repeat(64), env_script: '/unused/set_env.sh', files, request: {} };
  const bundle = join(payload.remote_root, 'drivers', payload.bundle_hash);
  const runs: { child: ReturnType<typeof spawn>; result: Promise<{ code: number | null; stderr: string }>; stderr: () => string }[] = [];
  function start(workerId: string, options: { slow?: boolean; holdDriver?: boolean; files?: typeof files } = {}) {
    let stderr = '';
    const child = spawn(python, ['-c', worker], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const result = new Promise<{ code: number | null; stderr: string }>(resolve => {
      child.on('error', error => resolve({ code: null, stderr: error.message }));
      child.on('close', code => resolve({ code, stderr }));
    });
    child.stdin.end(JSON.stringify({ ...payload, files: options.files ?? files, bootstrap, control: root,
      worker_id: workerId, slow: options.slow ?? false, hold_driver: options.holdDriver ?? false }));
    const run = { child, result, stderr: () => stderr };
    runs.push(run);
    return run;
  }
  async function waitFor(name: string, run: ReturnType<typeof start>) {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, name))) {
      assert.equal(run.child.exitCode, null, run.stderr());
      assert.ok(Date.now() < deadline, 'Timed out waiting for ' + name + ': ' + run.stderr());
      await delay(10);
    }
  }
  function release(name: string) { writeFileSync(join(root, name), ''); }
  t.after(async () => {
    for (const run of runs) if (run.child.exitCode === null) run.child.kill();
    await Promise.all(runs.map(run => run.result));
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, files, bundle, start, waitFor, release };
}

test('SSH bootstrap publishes complete files under concurrent installation and lets both drivers run', async t => {
  const env = setup(t);
  const first = env.start('first', { slow: true, holdDriver: true });
  await env.waitFor('write-paused', first);
  const second = env.start('second', { holdDriver: true });
  await env.waitFor('second.driver', second);
  // The second process has installed every file while the first is still writing.
  for (const [name, value] of Object.entries(env.files)) {
    assert.deepEqual(readFileSync(join(env.bundle, name)), Buffer.from(value.base64, 'base64'));
  }
  env.release('write-release');
  await env.waitFor('first.driver', first);
  // Both reach driver execution before either driver is allowed to finish.
  assert.equal(second.child.exitCode, null);
  env.release('drivers-release');
  for (const result of await Promise.all([first.result, second.result])) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(env.bundle).sort(), Object.keys(env.files).sort());
});

test('SSH bootstrap rejects concurrently published different bytes without replacing them', async t => {
  const env = setup(t);
  const first = env.start('first', { slow: true });
  await env.waitFor('write-paused', first);
  const files = { ...env.files, 'driver.py': entry('# different driver\n') };
  const second = env.start('second', { files });
  const published = await second.result;
  assert.equal(published.code, 0, published.stderr);
  env.release('write-release');
  const rejected = await first.result;
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stderr, /AssertionError/);
  assert.deepEqual(readFileSync(join(env.bundle, 'driver.py')), Buffer.from(files['driver.py'].base64, 'base64'));
  assert.equal(existsSync(join(env.root, 'first.driver')), false);
  assert.deepEqual(readdirSync(env.bundle).sort(), Object.keys(env.files).sort());
});

test('SSH bootstrap rejects an invalid file hash before publication or driver execution', async t => {
  const env = setup(t);
  const files = { ...env.files, 'driver.py': { ...env.files['driver.py'], sha256: '0'.repeat(64) } };
  const result = await env.start('invalid', { files }).result;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /AssertionError/);
  assert.deepEqual(readdirSync(env.bundle), []);
  assert.equal(existsSync(join(env.root, 'invalid.driver')), false);
});
