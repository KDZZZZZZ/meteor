import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const configuredPython = process.env.PYTHON ?? 'python';
const resolvedPython = spawnSync(configuredPython, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const python = resolvedPython || configuredPython;
const driver = join(process.cwd(), 'templates/project/tools/meteor/runners/remote/driver.py');

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value as Record<string, unknown>).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}

function hashObject(value: unknown): string {
  return sha256(canonical(value));
}

function b64(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
}

function runDriver(request: Record<string, unknown>, env: Record<string, string> = {}) {
  const proc = spawnSync(python, [driver], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: {
      ...process.env,
      METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT: '1',
      METEOR_REMOTE_DRIVER_FAKE_BUILD: '1',
      ...env,
    },
  });
  const parsed = JSON.parse(proc.stdout.trim() || '{}');
  return { proc, parsed };
}

test('remote command timeout returns durable queue failure on first response and preserves uncertain release', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-remote-timeout-'));
  const script = `import contextlib,io,json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import driver
os.environ['METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT']='1'
root=Path(sys.argv[2])
request={'action':'test','request_id':'timeout','remote_root':str(root),'queue_root':str(root/'queue')}
calls=[]
def timeout_handler(*_):
 calls.append('timeout')
 driver.run_command([sys.executable,'-c','import time; time.sleep(30)'],root,timeout=0.05)
driver.action_test=timeout_handler
def invoke(payload):
 driver.load_stdin=lambda:dict(payload)
 output=io.StringIO()
 with contextlib.redirect_stdout(output): code=driver.main()
 return code,json.loads(output.getvalue())
code,envelope=invoke(request)
assert code==1 and envelope['ok'] is False
result=envelope['result']
assert result['status']=='FAILED' and result['remote_release_confirmed'] is True
assert result['queue']['capacity']==1 and result['queue']['started_at']<=result['finished_at']
assert 'timed out' in result['error']
stored=json.loads((root/'requests/timeout/result.json').read_text())
assert stored==result
assert driver.dispatch(dict(request))==stored and calls==['timeout']
assert driver.dispatch({**request,'action':'collect'})==stored
driver.action_test=lambda *_:{'status':'COMPLETED','backend':'ssh','simulated':False}
following=driver.dispatch({**request,'request_id':'after-timeout'})
assert following['queue']['ticket']>result['queue']['ticket']
assert following['queue']['started_at']>=result['finished_at']
assert following['remote_release_confirmed'] is True
driver.action_test=timeout_handler
driver.ExecutionQueue.released=lambda self:False
code,uncertain=invoke({**request,'request_id':'uncertain'})
assert code==1 and uncertain['result']['status']=='UNKNOWN_REMOTE'
assert uncertain['result']['remote_release_confirmed'] is False
assert uncertain['result']['failed_command']['timeout_seconds']==0.05
assert not (root/'requests/uncertain/result.json').exists()
assert driver.ACTIVE_QUEUE is None
print(json.dumps({'ok':True}))
`;
  const result = spawnSync(python, ['-B', '-c', script, dirname(driver), root], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('remote command timeouts retain phase diagnostics without promoting partial work to PASS', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-timeout-diagnostics-'));
  const script = `import contextlib,io,json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import driver
os.environ['METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT']='1'
os.environ.pop('METEOR_REMOTE_DRIVER_FAKE_BUILD',None)
root=Path(sys.argv[2])
real_run=driver.run_command
driver.write_case_files=lambda *_:('input-hash','oracle-hash')
case={'case_id':'case1','shape':{'m':1,'n':1,'k':1}}
for stage in ['run','verify','device_witness']:
 calls=[]
 def timed_command(cwd):
  source="import sys,time; print('x'*21000+'progress-"+stage+"',flush=True); print('diagnostic-"+stage+"',file=sys.stderr,flush=True); time.sleep(30)"
  return real_run([sys.executable,'-u','-c',source],cwd,timeout=1)
 def run(command,cwd,timeout=900):
  current='verify' if 'verify_case.py' in str(command) else 'run'
  calls.append(current)
  if stage==current: return timed_command(cwd)
  return {'command':command,'returncode':0,'stdout':'QMQ_TIMING_US sample=0 value=10.0','stderr':'','duration_seconds':0.01}
 def witness(request,executable,case,case_dir,*_):
  calls.append('device_witness')
  return timed_command(case_dir)
 driver.run_command=run
 driver.msprof_witness=witness
 def handler(request,remote_root,request_dir):
  return driver.execute_case(request,remote_root,root/'candidate',case,0,0,1,request_dir,False)
 driver.action_test=handler
 payload={'action':'test','request_id':'timeout-'+stage,'remote_root':str(root),'queue_root':str(root/'queue')}
 driver.load_stdin=lambda:dict(payload)
 output=io.StringIO()
 with contextlib.redirect_stdout(output): code=driver.main()
 envelope=json.loads(output.getvalue()); result=envelope['result']
 assert code==1 and envelope['ok'] is False
 assert result['status']=='FAILED' and result['remote_release_confirmed'] is True
 context=result['failure_context']; diagnostic=result['failed_command']
 assert context['case_id']=='case1' and context['stage']==stage
 assert context['input_hash']=='input-hash' and context['oracle_hash']=='oracle-hash'
 expected={'run':[],'verify':['run'],'device_witness':['run','verify']}[stage]
 assert list(context['completed_commands'])==expected
 assert all(log['returncode']==0 for log in context['completed_commands'].values())
 assert calls==expected+[stage]
 assert diagnostic['stdout'].endswith('progress-'+stage+'\\n')
 assert diagnostic['stderr'].strip()=='diagnostic-'+stage
 assert len(diagnostic['stdout'])==20000 and diagnostic['timeout_seconds']==1
 assert diagnostic['duration_seconds']>=1 and diagnostic['returncode']!=0
 assert 'rows' not in result and 'observations' not in result and 'samples_us' not in result
 stored=json.loads((root/'requests'/payload['request_id']/'result.json').read_text())
 assert stored==result
 assert driver.dispatch({**payload,'action':'collect'})==result
 assert driver.dispatch(dict(payload))==result and calls==expected+[stage]
print(json.dumps({'ok':True}))
`;
  const result = spawnSync(python, ['-B', '-c', script, dirname(driver), root], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

function makeCase() {
  const x1 = Buffer.from([2]);
  const x2 = Buffer.from([3]);
  const x1Scale = Buffer.alloc(4);
  const x2Scale = Buffer.alloc(4);
  const yScale = Buffer.alloc(4);
  x1Scale.writeFloatLE(1, 0);
  x2Scale.writeFloatLE(1, 0);
  yScale.writeFloatLE(6 / 127, 0);
  const y = Buffer.from([127]);
  const filesNoCaseJson: Record<string, Buffer> = {
    'input/x1.bin': x1,
    'input/x2.bin': x2,
    'input/x1Scale.bin': x1Scale,
    'input/x2Scale.bin': x2Scale,
    'golden/y.bin': y,
    'golden/yScale.bin': yScale,
  };
  const metadata = {
    format_version: 1,
    m: 1,
    n: 1,
    k: 1,
    seed: 0,
    mode: 'provided',
    files: Object.fromEntries(Object.entries(filesNoCaseJson).map(([path, data]) => [path, { bytes: data.length, sha256: sha256(data) }])),
  };
  const allFiles = { ...filesNoCaseJson, 'case.json': Buffer.from(JSON.stringify(metadata, null, 2) + '\n') };
  const inputMap = Object.fromEntries(Object.entries(filesNoCaseJson).filter(([path]) => path.startsWith('input/')).map(([path, data]) => [path, sha256(data)]));
  const goldenMap = Object.fromEntries(Object.entries(filesNoCaseJson).filter(([path]) => path.startsWith('golden/')).map(([path, data]) => [path, sha256(data)]));
  const verifierSha256 = sha256(readFileSync(join(process.cwd(), 'templates/project/tools/meteor/runners/remote/verify_case.py')));
  return {
    case_id: 'case1',
    shape: { m: 1, n: 1, k: 1 },
    input_hash: hashObject(inputMap),
    oracle_hash: hashObject({ verifier_sha256: verifierSha256, golden: goldenMap }),
    files: Object.fromEntries(Object.entries(allFiles).map(([path, data]) => [path, { base64: b64(data), sha256: sha256(data) }])),
  };
}

test('verifier reports actual and expected scale mismatches without changing accuracy decisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-scale-diagnostics-'));
  const fixture = makeCase();
  for (const [path, record] of Object.entries(fixture.files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(record.base64, 'base64'));
  }
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'output/y.bin'), readFileSync(join(root, 'golden/y.bin')));
  const expectedScale = readFileSync(join(root, 'golden/yScale.bin')).readFloatLE();
  for (const actual of [expectedScale, 1, NaN, Infinity, -Infinity]) {
    const output = Buffer.alloc(4);
    output.writeFloatLE(actual);
    writeFileSync(join(root, 'output/yScale.bin'), output);
    const result = spawnSync(python, [join(dirname(driver), 'verify_case.py'), root], { encoding: 'utf8' });
    const report = JSON.parse(result.stdout);
    const passed = actual === expectedScale;
    assert.equal(result.status, passed ? 0 : 1, result.stderr);
    assert.equal(report.passed, passed);
    assert.equal(report.yScale.mismatches, passed ? 0 : 1);
    assert.equal(report.yScale.nonfinite_outputs, Number.isFinite(actual) ? 0 : 1);
    assert.equal(report.yScale.first_mismatches.length, passed ? 0 : 1);
    if (!passed) {
      const mismatch = report.yScale.first_mismatches[0];
      assert.equal(mismatch.row, 0);
      assert.equal(mismatch.expected, expectedScale);
      assert.equal(mismatch.actual, Number.isFinite(actual) ? actual : Number.isNaN(actual) ? 'nan' : actual > 0 ? 'inf' : '-inf');
    }
  }
});

test('remote driver build/test is durable and idempotent with fake executable harness', async t => {
  const numpyCheck = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' });
  if (numpyCheck.status !== 0) {
    t.skip('python numpy is required by bundled verify_case.py');
    return;
  }
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-'));
  const source = '// rendered kernel source\n';
  const buildRequest = {
    action: 'build',
    request_id: 'req-build',
    remote_root: remoteRoot,
    device_id: 0,
    npu_arch: 'dav-2201',
    env_script: '/unused/in/local/test/set_env.sh',
    source_base64: b64(source),
    rendered_source_hash: sha256(source),
    build_id: 'build-1',
    cases: [],
    supported_case_ids: ['case1'],
    repetitions: 5,
    warmup: 3,
    case_suite_revision: 'suite-1',
    environment_ref: 'env-1',
    measurement_protocol_ref: 'acl-event-5-v1',
  };
  const built = runDriver(buildRequest);
  assert.equal(built.proc.status, 0, built.proc.stderr);
  assert.equal(built.parsed.ok, true);
  assert.equal(built.parsed.result.status, 'COMPLETED');
  assert.equal(built.parsed.result.backend, 'ssh');
  assert.equal(built.parsed.result.simulated, true);
  assert.equal(built.parsed.result.remote_build_id, 'build-1');

  const builtAgain = runDriver(buildRequest);
  assert.equal(builtAgain.proc.status, 0);
  assert.equal(builtAgain.parsed.result.artifact_hash, built.parsed.result.artifact_hash);

  const differentPayload = runDriver({ ...buildRequest, source_base64: b64('// different\n') });
  assert.equal(differentPayload.proc.status, 1);
  assert.equal(differentPayload.parsed.ok, false);
  assert.match(differentPayload.parsed.error, /different payload/);

  const testRequest = {
    ...buildRequest,
    action: 'test',
    request_id: 'req-test',
    cases: [makeCase(), { ...makeCase(), case_id: 'case2' }],
    supported_case_ids: ['case1'],
    artifact_hash: built.parsed.result.artifact_hash,
  };
  const tested = runDriver(testRequest);
  assert.equal(tested.proc.status, 0, tested.proc.stderr);
  assert.equal(tested.parsed.result.status, 'COMPLETED');
  assert.equal(tested.parsed.result.simulated, true);
  assert.equal(tested.parsed.result.artifact_hash, built.parsed.result.artifact_hash);
  assert.equal(tested.parsed.result.rows.length, 2);
  assert.equal(tested.parsed.result.rows[0].status, 'PASS');
  assert.equal(tested.parsed.result.rows[0].device_execution.status, 'SIMULATED');
  assert.equal(tested.parsed.result.rows[0].samples_us.length, 5);
  assert.equal(tested.parsed.result.rows[0].median_us, 12);
  assert.equal(tested.parsed.result.rows[1].status, 'UNSUPPORTED');

  const collected = runDriver({ action: 'collect', request_id: 'req-test', remote_root: remoteRoot });
  assert.equal(collected.proc.status, 0);
  assert.equal(collected.parsed.result.status, 'COMPLETED');
  assert.equal(collected.parsed.result.rows[0].case_id, 'case1');

  const profileRequest = {
    ...buildRequest,
    action: 'profile',
    request_id: 'req-profile-ok',
    cases: [makeCase()],
    metrics: ['kernel_time_us'],
    supported_case_ids: ['case1'],
    artifact_hash: built.parsed.result.artifact_hash,
  };
  const profiled = runDriver(profileRequest);
  assert.equal(profiled.proc.status, 0, profiled.proc.stderr);
  assert.equal(profiled.parsed.result.status, 'COMPLETED');
  assert.equal(profiled.parsed.result.simulated, true);
  assert.equal(profiled.parsed.result.instrumented, false);
  assert.equal(profiled.parsed.result.measurement_kind, 'acl_event_interval');
  assert.deepEqual(profiled.parsed.result.supported_metrics, ['kernel_time_us', 'device_task_time_us']);
  assert.deepEqual(profiled.parsed.result.observations, [{ case_id: 'case1', metric: 'kernel_time_us', value: 12, unit: 'us', measurement_kind: 'acl_event_interval' }]);
  assert.equal(profiled.parsed.result.raw_profiles[0].samples_us.length, 5);
});

test('remote driver rejects artifact mismatch and does not rerun in-progress requests', () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-lock-'));
  const source = '// rendered kernel source\n';
  const buildRequest = {
    action: 'build',
    request_id: 'req-build',
    remote_root: remoteRoot,
    device_id: 0,
    npu_arch: 'dav-2201',
    source_base64: b64(source),
    rendered_source_hash: sha256(source),
    build_id: 'build-1',
    supported_case_ids: ['case1'],
    repetitions: 5,
    warmup: 3,
    case_suite_revision: 'suite-1',
    environment_ref: 'env-1',
    measurement_protocol_ref: 'acl-event-5-v1',
  };
  const built = runDriver(buildRequest);
  assert.equal(built.proc.status, 0);
  const badArtifact = runDriver({
    ...buildRequest,
    action: 'test',
    request_id: 'req-bad-artifact',
    cases: [makeCase()],
    artifact_hash: '0'.repeat(64),
  });
  assert.equal(badArtifact.proc.status, 1);
  assert.match(badArtifact.parsed.error, /artifact_hash mismatch/);

  const lockRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-running-'));
  const requestDir = join(lockRoot, 'requests', 'req-running');
  mkdirSync(join(requestDir, 'operation.lock'), { recursive: true });
  const runningRequest = { ...buildRequest, remote_root: lockRoot, request_id: 'req-running', build_id: 'build-running' };
  const running = runDriver(runningRequest);
  assert.equal(running.proc.status, 0);
  assert.equal(running.parsed.result.status, 'RUNNING');
  assert.equal(running.parsed.result.simulated, true);

  const unknownRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-unknown-'));
  const unknownDir = join(unknownRoot, 'requests', 'req-unknown');
  mkdirSync(unknownDir, { recursive: true });
  writeFileSync(join(unknownDir, 'status.json'), JSON.stringify({ state: 'running', action: 'build', pid: 'not-confirmed' }));
  const unknownRequest = { ...buildRequest, remote_root: unknownRoot, request_id: 'req-unknown', build_id: 'build-unknown' };
  const unknown = runDriver(unknownRequest);
  assert.equal(unknown.proc.status, 0);
  assert.equal(unknown.parsed.result.status, 'UNKNOWN_REMOTE');
  assert.match(unknown.parsed.result.reason, /stopped before completion/);
});

test('remote driver profile fails explicitly instead of fabricating counters', () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-profile-'));
  const profiled = runDriver({
    action: 'profile',
    request_id: 'req-profile',
    remote_root: remoteRoot,
    build_id: 'build-1',
    device_id: 0,
    metrics: ['aic_cycles'],
  });
  assert.equal(profiled.proc.status, 0);
  assert.equal(profiled.parsed.ok, true);
  assert.equal(profiled.parsed.result.status, 'FAILED');
  assert.match(profiled.parsed.result.reason, /unsupported/);
  assert.deepEqual(profiled.parsed.result.unsupported_metrics, ['aic_cycles']);
  assert.deepEqual(profiled.parsed.result.allowed_metrics, ['kernel_time_us', 'device_task_time_us']);
});

test('remote driver requires explicit verified hardware parameters outside fake harness', () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-real-required-'));
  const source = '// rendered kernel source\n';
  const missingArch = runDriver({
    action: 'build',
    request_id: 'req-build',
    remote_root: remoteRoot,
    source_base64: b64(source),
    rendered_source_hash: sha256(source),
    build_id: 'build-1',
  }, { METEOR_REMOTE_DRIVER_FAKE_BUILD: '' });
  assert.equal(missingArch.proc.status, 1);
  assert.match(missingArch.parsed.error, /npu_arch/);

  const missingDevice = runDriver({
    action: 'test',
    request_id: 'req-test',
    remote_root: remoteRoot,
    build_id: 'build-1',
  }, { METEOR_REMOTE_DRIVER_FAKE_BUILD: '' });
  assert.equal(missingDevice.proc.status, 1);
  assert.match(missingDevice.parsed.error, /device_id/);
});


test('remote driver confirms device execution from msprof op_summary matched_tasks', async t => {
  const numpyCheck = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' });
  if (numpyCheck.status !== 0) {
    t.skip('python numpy is required by bundled verify_case.py');
    return;
  }
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-msprof-'));
  const buildDir = join(remoteRoot, 'builds', 'build-real');
  mkdirSync(buildDir, { recursive: true });
  const executable = join(buildDir, 'qmq_remote_main.py');
  const script = [
    '#!/usr/bin/env python3',
    'from pathlib import Path',
    'import shutil, sys',
    "Path('output').mkdir(exist_ok=True)",
    "shutil.copyfile('golden/y.bin','output/y.bin')",
    "shutil.copyfile('golden/yScale.bin','output/yScale.bin')",
    'reps=int(sys.argv[6]) if len(sys.argv)>6 else 5',
    "for i in range(reps): print(f'QMQ_TIMING_US sample={i} value={10.0+i:.3f}')",
    '',
  ].join('\n');
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  const metadata = {
    status: 'COMPLETED',
    backend: 'ssh',
    simulated: false,
    remote_build_id: 'build-real',
    rendered_source_hash: sha256('kernel'),
    artifact_hash: '',
    executable,
    npu_arch: 'dav-test',
  };
  metadata.artifact_hash = hashObject({
    kernel: metadata.rendered_source_hash,
    executable: sha256(readFileSync(executable)),
    npu_arch: metadata.npu_arch,
  });
  writeFileSync(join(buildDir, 'build-result.json'), JSON.stringify(metadata));

  const fakeBin = join(remoteRoot, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  const fakeMsprof = join(fakeBin, process.platform === 'win32' ? 'msprof.cmd' : 'msprof');
  const fakeMsprofScript = join(fakeBin, 'msprof_fixture.py');
  writeFileSync(fakeMsprofScript, [
    'from pathlib import Path',
    'import sys',
    'args = sys.argv[1:]',
    'if any(arg in args for arg in ["--application", "--force=true", "--output"]): sys.exit(7)',
    'out = Path(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--output="))) / "nested"',
    'out.mkdir(parents=True, exist_ok=True)',
    '(out / "op_summary.csv").write_text(',
    '  "device_id,task_id,stream_id,op_name,op_type,task_type,task_start_time_us,task_duration_us,block_dim\\n"',
    '  "0,7,3,meteor_candidate_kernel,Kernel,AI_CORE,100,42.5,8\\n"',
    '  ",8,3,meteor_candidate_kernel,Kernel,AI_CORE,101,99.5,8\\n"',
    '  "0,9,3,meteor_candidate_kernel,Kernel,AI_CORE_UNKNOWN,102,99.5,8\\n", encoding="utf-8")',
  ].join('\n'));
  const fakeMsprofBody = process.platform === 'win32'
    ? '@echo off\r\n"' + python + '" "' + fakeMsprofScript + '" %*\r\n'
    : '#!/bin/sh\nexec "' + python + '" "' + fakeMsprofScript + '" "$@"\n';
  writeFileSync(fakeMsprof, fakeMsprofBody);
  chmodSync(fakeMsprof, 0o755);

  const tested = runDriver({
    action: 'profile',
    request_id: 'req-profile-device-task',
    remote_root: remoteRoot,
    build_id: 'build-real',
    device_id: 0,
    cases: [makeCase()],
    supported_case_ids: ['case1'],
    artifact_hash: metadata.artifact_hash,
    repetitions: 5,
    warmup: 3,
    metrics: ['kernel_time_us', 'device_task_time_us'],
    kernel_name: 'meteor_candidate_kernel',
  }, { METEOR_REMOTE_DRIVER_FAKE_BUILD: '', PATH: fakeBin });
  assert.equal(tested.proc.status, 0, tested.proc.stderr);
  assert.equal(tested.parsed.result.status, 'COMPLETED');
  assert.equal(tested.parsed.result.raw_profiles[0].status, 'PASS');
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.status, 'CONFIRMED');
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.source, 'profile_dir');
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.matched_task_count, 1);
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.matched_tasks.length, 1);
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.matched_tasks[0].device_id, 0);
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.matched_tasks[0].kernel_name, 'meteor_candidate_kernel');
  assert.equal(tested.parsed.result.raw_profiles[0].device_execution.matched_tasks[0].task_type, 'AI_CORE');
  assert.deepEqual(tested.parsed.result.observations.map((item: any) => item.metric), ['kernel_time_us', 'device_task_time_us']);
  assert.equal(tested.parsed.result.observations[1].value, 42.5);
});

test('remote driver refuses PASS without a device execution witness', async t => {
  const numpyCheck = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' });
  if (numpyCheck.status !== 0) {
    t.skip('python numpy is required by bundled verify_case.py');
    return;
  }
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-remote-witness-'));
  const buildDir = join(remoteRoot, 'builds', 'build-real');
  mkdirSync(buildDir, { recursive: true });
  const executable = join(buildDir, 'qmq_remote_main.py');
  const script = [
    '#!/usr/bin/env python3',
    'from pathlib import Path',
    'import shutil, sys',
    "Path('output').mkdir(exist_ok=True)",
    "shutil.copyfile('golden/y.bin','output/y.bin')",
    "shutil.copyfile('golden/yScale.bin','output/yScale.bin')",
    'reps=int(sys.argv[6]) if len(sys.argv)>6 else 5',
    "for i in range(reps): print(f'QMQ_TIMING_US sample={i} value={10.0+i:.3f}')",
    '',
  ].join('\n');
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  const metadata = {
    status: 'COMPLETED',
    backend: 'ssh',
    simulated: false,
    remote_build_id: 'build-real',
    rendered_source_hash: sha256('kernel'),
    artifact_hash: '',
    executable,
    npu_arch: 'dav-test',
  };
  metadata.artifact_hash = hashObject({
    kernel: metadata.rendered_source_hash,
    executable: sha256(readFileSync(executable)),
    npu_arch: metadata.npu_arch,
  });
  writeFileSync(join(buildDir, 'build-result.json'), JSON.stringify(metadata));

  const tested = runDriver({
    action: 'test',
    request_id: 'req-test',
    remote_root: remoteRoot,
    build_id: 'build-real',
    device_id: 0,
    cases: [makeCase()],
    supported_case_ids: ['case1'],
    artifact_hash: metadata.artifact_hash,
    repetitions: 5,
    warmup: 3,
  }, { METEOR_REMOTE_DRIVER_FAKE_BUILD: '', PATH: '' });
  assert.equal(tested.proc.status, 0, tested.proc.stderr);
  assert.equal(tested.parsed.result.rows[0].status, 'RUN_FAILED');
  assert.equal(tested.parsed.result.rows[0].reason, 'device execution witness missing');
  assert.equal(tested.parsed.result.rows[0].device_execution.tool, 'msprof');
  assert.match(tested.parsed.result.rows[0].device_execution.reason, /kernel_name/);
});
