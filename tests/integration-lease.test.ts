import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const python = process.env.PYTHON ?? 'python';
const store = fileURLToPath(new URL('../templates/project/knowledge/store.py', import.meta.url));
const channel = 'mock|qmq-v1|suite|environment|protocol';

// Both processes execute the real store against the same SQLite database. The
// trace callback only pauses before a write to make the competing reads overlap.
const worker = `import importlib.util,json,sys,time
from pathlib import Path
from types import SimpleNamespace
payload=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('meteor_store',payload['store'])
store=importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)
root=Path(payload['root'])
worker_id=payload['worker_id']
paused=False
def trace(sql):
 global paused
 if sql.startswith('BEGIN') or sql.startswith('SELECT * FROM integration_events'):
  (root/(worker_id+'.started')).touch()
 if not paused and sql.startswith('UPDATE integration_events SET status'):
  paused=True
  (root/(worker_id+'.paused')).touch()
  deadline=time.monotonic()+10
  while not (root/(worker_id+'.release')).exists():
   if time.monotonic()>deadline: raise TimeoutError('write was not released')
   time.sleep(0.01)
connect=store.connect
def traced_connect(path):
 db=connect(path)
 db.set_trace_callback(trace)
 return db
store.connect=traced_connect
store.sys_stdin=lambda:json.dumps(payload['request'])
getattr(store,payload['action'])(SimpleNamespace(knowledge_root=payload['root']))
`;

function setup(t: TestContext, expired = false) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-integration-lease-'));
  const initialized = spawnSync(python, [store, 'init', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr);
  const seeded = spawnSync(python, ['-c', `import json,sqlite3,sys
from pathlib import Path
p=json.load(sys.stdin)
db=sqlite3.connect(Path(p['root'])/'catalog.sqlite')
stamp='2000-01-01T00:00:00Z'
with db:
 for event in ['event-a','event-b']:
  db.execute('INSERT INTO integration_events(integration_event_id,submission_id,channel,status,created_at,updated_at) VALUES(?,?,?,?,?,?)',(event,'submission-'+event,p['channel'],'QUEUED',stamp,stamp))
 db.execute('INSERT INTO integration_channels(channel,updated_at) VALUES(?,?)',(p['channel'],stamp))
 if p['expired']:
  db.execute("UPDATE integration_events SET status='SELECTING',claim_token='old-token',lease_expires_at=? WHERE integration_event_id='event-a'",(stamp,))
  db.execute("UPDATE integration_channels SET active_event_id='event-a',lease_token='old-token',lease_expires_at=?",(stamp,))
`], { input: JSON.stringify({ root, channel, expired }), encoding: 'utf8', windowsHide: true });
  assert.equal(seeded.status, 0, seeded.stderr);
  const runs: { child: ReturnType<typeof spawn>; result: Promise<{ code: number | null; stdout: string; stderr: string }> }[] = [];
  function start(workerId: string, action: string, request: Record<string, unknown>) {
    const child = spawn(python, ['-B', '-c', worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveResult => {
      child.on('error', error => resolveResult({ code: null, stdout, stderr: error.message }));
      child.on('close', code => resolveResult({ code, stdout, stderr }));
    });
    child.stdin.end(JSON.stringify({ store, root, worker_id: workerId, action, request }));
    const run = { child, result };
    runs.push(run);
    return run;
  }
  async function reached(name: string, run: ReturnType<typeof start>, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!existsSync(join(root, name))) {
      if (run.child.exitCode !== null || Date.now() >= deadline) return false;
      await delay(10);
    }
    return true;
  }
  async function result(run: ReturnType<typeof start>) {
    const output = await run.result;
    assert.equal(output.code, 0, output.stderr);
    assert.equal(output.stderr, '');
    return JSON.parse(output.stdout);
  }
  function release(workerId: string) { writeFileSync(join(root, workerId + '.release'), ''); }
  function command(action: string, request: Record<string, unknown>) {
    const output = spawnSync(python, [store, action, root], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true });
    assert.equal(output.status, 0, output.stderr);
    return JSON.parse(output.stdout);
  }
  function snapshot() {
    const output = spawnSync(python, ['-c', `import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row
print(json.dumps({'events':[dict(r) for r in db.execute('SELECT * FROM integration_events ORDER BY integration_event_id')],'channel':dict(db.execute('SELECT * FROM integration_channels').fetchone())}))
`, join(root, 'catalog.sqlite')], { encoding: 'utf8', windowsHide: true });
    assert.equal(output.status, 0, output.stderr);
    return JSON.parse(output.stdout);
  }
  t.after(async () => {
    for (const run of runs) if (run.child.exitCode === null) run.child.kill();
    await Promise.all(runs.map(run => run.result));
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  return { start, reached, result, release, command, snapshot };
}

for (const secondEvent of ['event-a', 'event-b']) {
  test(`concurrent claims admit one owner for ${secondEvent === 'event-a' ? 'the same event' : 'different events in one channel'}`, { timeout: 15000 }, async t => {
    const env = setup(t);
    const first = env.start('first', 'claim_event', { event_id: 'event-a', token: 'token-a', channel });
    assert.equal(await env.reached('first.paused', first), true);
    const second = env.start('second', 'claim_event', { event_id: secondEvent, token: 'token-b', channel });
    assert.equal(await env.reached('second.started', second), true);
    await env.reached('second.paused', second, 1000);
    env.release('first'); env.release('second');
    const results = await Promise.all([env.result(first), env.result(second)]);
    assert.equal(results.filter(result => result.claimed).length, 1, 'only one process may receive a lease');
    const winner = results.find(result => result.claimed).event;
    const current = env.snapshot();
    assert.equal(current.channel.active_event_id, winner.integration_event_id);
    assert.equal(current.channel.lease_token, winner.claim_token);
    assert.equal(current.events.filter((event: any) => event.status === 'SELECTING').length, 1);
  });
}

test('reclaiming an expired lease and finishing its old owner cannot both succeed', { timeout: 15000 }, async t => {
  const env = setup(t, true);
  const first = env.start('finish', 'finish_event', { event_id: 'event-a', token: 'old-token', status: 'ASSEMBLED', result_ref: 'old-result' });
  assert.equal(await env.reached('finish.paused', first), true);
  const second = env.start('claim', 'claim_event', { event_id: 'event-a', token: 'new-token', channel });
  assert.equal(await env.reached('claim.started', second), true);
  const competingWrite = await env.reached('claim.paused', second, 1000);
  if (competingWrite) {
    env.release('claim');
    await env.result(second);
    env.release('finish');
  } else {
    env.release('finish'); env.release('claim');
  }
  const [finished, claimed] = await Promise.all([env.result(first), env.result(second)]);
  assert.equal(Number(finished.ok) + Number(claimed.claimed), 1, 'a stale finisher must not report a successful token-CAS');
  const current = env.snapshot();
  assert.equal(current.events[0].status, claimed.claimed ? 'SELECTING' : 'ASSEMBLED');
  assert.equal(current.channel.current_version_ref, claimed.claimed ? null : 'old-result');
});

test('finishing an event whose channel was reclaimed fails without updating the event', t => {
  const env = setup(t, true);
  const claimed = env.command('claim-event', { event_id: 'event-b', token: 'new-token', channel });
  assert.equal(claimed.claimed, true);
  const finished = env.command('finish-event', { event_id: 'event-a', token: 'old-token', status: 'ASSEMBLED', result_ref: 'old-result' });
  assert.equal(finished.ok, false);
  const current = env.snapshot();
  assert.equal(current.events[0].status, 'SELECTING');
  assert.equal(current.channel.active_event_id, 'event-b');
  assert.equal(current.channel.current_version_ref, null);
});
