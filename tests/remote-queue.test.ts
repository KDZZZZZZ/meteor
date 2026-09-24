import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const configuredPython = process.env.PYTHON ?? 'python';
const resolvedPython = spawnSync(configuredPython, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const python = resolvedPython || configuredPython;
const driverDir = join(process.cwd(), 'templates/project/tools/meteor/runners/remote');
const queueModule = join(driverDir, 'execution_queue.py');
const scenario = join(process.cwd(), 'tests/helpers/remote_queue_scenarios.py');

test('remote ExecutionQueue serializes same-host work and recovers cancellation/crashes', { timeout: 60000 }, () => {
  assert.ok(existsSync(queueModule), 'remote execution_queue.py must be present');
  const result = spawnSync(python, [scenario, '--driver-dir', driverDir], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    timeout: 55000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}');
  assert.equal(parsed.ok, true);
});
