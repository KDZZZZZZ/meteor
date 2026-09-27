import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const configuredPython = process.env.PYTHON ?? 'python';
const resolvedPython = spawnSync(configuredPython, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const python = resolvedPython || configuredPython;
const driver = join(process.cwd(), 'templates/project/tools/meteor/runners/remote/driver.py');

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

test('hardware action exposes schema and never fabricates real hardware in fake mode', () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-hardware-fake-'));
  const result = runDriver({
    action: 'hardware',
    request_id: 'req-hardware',
    remote_root: remoteRoot,
  });
  assert.equal(result.proc.status, 0, result.proc.stderr);
  assert.equal(result.parsed.ok, true);
  assert.equal(result.parsed.result.status, 'COMPLETED');
  assert.equal(result.parsed.result.readiness, 'BLOCKED');
  assert.equal(result.parsed.result.backend, 'ssh');
  assert.equal(result.parsed.result.simulated, true);
  assert.deepEqual(result.parsed.result.supported_metrics, ['kernel_time_us', 'device_task_time_us']);
  assert.equal(result.parsed.result.selected_device, null);
  assert.equal(result.parsed.result.validation.compile, false);
  assert.equal(result.parsed.result.validation.launch, false);
  assert.equal(result.parsed.result.validation.correctness, false);
  assert.equal(result.parsed.result.validation.device_execution.status, 'SIMULATED');
  assert.equal(result.parsed.result.device_count, 0);
  assert.deepEqual(result.parsed.result.devices, []);
  assert.equal(result.parsed.result.cann.reason, 'fake harness');
  assert.equal(result.parsed.result.tools.reason, 'fake harness');
  assert.equal(result.parsed.result.logs[0].command[0], 'fake-hardware');
});

test('hardware action reports unknowns with reasons when device tools are absent', () => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'meteor-hardware-empty-'));
  const result = runDriver({
    action: 'hardware',
    request_id: 'req-hardware',
    remote_root: remoteRoot,
  }, { METEOR_REMOTE_DRIVER_FAKE_BUILD: '', PATH: '' });
  assert.equal(result.proc.status, 0, result.proc.stderr);
  assert.equal(result.parsed.ok, true);
  assert.equal(result.parsed.result.status, 'FAILED');
  assert.equal(result.parsed.result.readiness, 'BLOCKED');
  assert.equal(result.parsed.result.simulated, false);
  assert.equal(result.parsed.result.selected_device, null);
  assert.equal(result.parsed.result.validation.compile, false);
  assert.equal(result.parsed.result.validation.launch, false);
  assert.equal(result.parsed.result.validation.correctness, false);
  assert.equal(result.parsed.result.validation.device_execution.status, 'NOT_RUN');
  assert.equal(result.parsed.result.device_count, null);
  assert.deepEqual(result.parsed.result.devices, []);
  assert.deepEqual(result.parsed.result.supported_metrics, ['kernel_time_us', 'device_task_time_us']);
  assert.equal(result.parsed.result.cann.runtime, null);
  assert.match(result.parsed.result.cann.reason, /npu-smi/);
  assert.equal(result.parsed.result.tools.msprof, null);
  assert.match(result.parsed.result.tools.reason, /msprof/);
  assert.ok(result.parsed.result.logs.some((item: any) => item.unavailable_reason));
});
