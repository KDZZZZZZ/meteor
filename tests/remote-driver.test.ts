import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const python = process.env.PYTHON ?? 'python';
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
  assert.equal(profiled.parsed.result.instrumented, true);
  assert.deepEqual(profiled.parsed.result.observations, [{ case_id: 'case1', metric: 'kernel_time_us', value: 12, unit: 'us' }]);
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
});
