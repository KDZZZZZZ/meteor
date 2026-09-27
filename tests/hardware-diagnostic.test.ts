import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initProject } from '../src/init.ts';
import { hardwareExperiment } from '../src/hardware-preparation.ts';
import type { HardwareExperimentInput } from '../src/hardware-preparation.ts';
import { listJsonFiles } from '../templates/project/tools/meteor/store.ts';
import { hashObject, readJson, writeJson } from '../templates/project/tools/meteor/util.ts';
import { installHardwareProfile, materializeUnitCaseSuite, writeReadyHardwareFixture } from './helpers/hardware.ts';

const python = process.env.PYTHON ?? 'python';
const driver = resolve('templates/project/tools/meteor/runners/remote/driver.py');
const executable = spawnSync(python, ['-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).stdout.trim();

function temporary(t: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runDriver(request: Record<string, unknown>) {
  const env: NodeJS.ProcessEnv = { ...process.env, METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT: '1' };
  delete env.METEOR_REMOTE_DRIVER_FAKE_BUILD;
  const processResult = spawnSync(python, ['-B', driver], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 15000, env,
  });
  assert.equal(processResult.error, undefined, processResult.error?.message ?? 'Local diagnostic driver must start');
  return { processResult, envelope: JSON.parse(processResult.stdout.trim() || '{}') };
}

function diagnosticRequest(root: string, id: string, source = "print('local diagnostic evidence')\n") {
  return { action: 'hardware_experiment', request_id: id, remote_root: root, queue_root: join(root, 'queue'),
    question: 'Local protocol fixture: can this diagnostic return command output?',
    files: [{ path: 'diagnostic.py', content: source }], commands: [{ argv: [executable, '-u', 'diagnostic.py'], timeout_seconds: 3 }] };
}

function assertDiagnosticOnly(result: Record<string, unknown>) {
  for (const key of ['run_id', 'build_id', 'profile_id', 'kernel_ref', 'rows', 'observations', 'mode', 'full_size_test_ref', 'device_execution', 'validation']) {
    assert.equal(key in result, false, `Hardware diagnostic must not manufacture ${key}`);
  }
}

function researchArtifacts(root: string) {
  return ['research', 'measurements', 'builds', 'kernels', 'versions'].flatMap(kind => listJsonFiles(join(root, kind)));
}

function installDiagnosticSsh(t: TestContext, root: string) {
  const previous = process.env.METEOR_SSH_BIN;
  const responsesPath = join(root, 'fake-responses.json');
  const requestsPath = join(root, 'fake-requests.jsonl');
  const script = join(root, 'fake-ssh.mjs');
  writeJson(responsesPath, {});
  writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => input += part);
process.stdin.on('end', () => {
  const body = JSON.parse(input), request = body.request;
  writeFileSync(${JSON.stringify(requestsPath)}, JSON.stringify(request) + '\\n', { flag: 'a' });
  const responses = JSON.parse(readFileSync(${JSON.stringify(responsesPath)}, 'utf8'));
  const response = responses[request.action] ?? { status: 'UNKNOWN_REMOTE', remote_release_confirmed: false };
  console.log(JSON.stringify({ ok: true, request_id: request.request_id, result: response }));
});
`, 'utf8');
  const wrapper = join(root, process.platform === 'win32' ? 'fake-ssh.cmd' : 'fake-ssh');
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}"\r\n`
    : `#!/usr/bin/env sh\nexec "${process.execPath}" "${script}"\n`);
  if (process.platform !== 'win32') chmodSync(wrapper, 0o755);
  process.env.METEOR_SSH_BIN = wrapper;
  t.after(() => {
    if (previous === undefined) delete process.env.METEOR_SSH_BIN;
    else process.env.METEOR_SSH_BIN = previous;
  });
  return {
    respond: (responses: Record<string, unknown>) => writeJson(responsesPath, responses),
    requests: () => existsSync(requestsPath) ? readFileSync(requestsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

function setupHost(t: TestContext) {
  const root = temporary(t, 'meteor-hardware-diagnostic-host-');
  // Point profile reads at this synthetic file before initialization; never inspect user profiles.
  const profile = installHardwareProfile(t, root);
  const ssh = installDiagnosticSsh(t, root);
  initProject(root, { git: false });
  materializeUnitCaseSuite(root);
  writeReadyHardwareFixture(root);
  return { root, profile, ssh };
}

function runInput(id: string): HardwareExperimentInput {
  return { action: 'run', experiment_id: id, question: 'Synthetic transport fixture; no real hardware claim',
    files: [{ path: 'probe.py', content: "print('fixture diagnostic')\n" }], commands: [{ argv: ['python3', 'probe.py'], timeout_seconds: 2 }] };
}

const complete = { status: 'COMPLETED', backend: 'ssh', simulated: false, remote_release_confirmed: true,
  commands: [{ command: ['python3', 'probe.py'], returncode: 0, stdout: 'fixture diagnostic\n', stderr: '', duration_seconds: 0.01 }],
  interpretation: 'Synthetic command evidence only' };

test('local Python diagnostics use the shared FIFO, release it and preserve the same request receipt', t => {
  assert.ok(executable, 'Python executable is required for local diagnostic tests');
  const root = temporary(t, 'meteor-hardware-diagnostic-driver-');
  const source = "from pathlib import Path\np=Path('executions.txt')\np.write_text(str(int(p.read_text())+1) if p.exists() else '1')\nprint('local diagnostic evidence')\n";
  const request = diagnosticRequest(root, 'first', source);
  const first = runDriver(request);
  assert.equal(first.processResult.status, 0, first.processResult.stderr || JSON.stringify(first.envelope));
  assert.equal(first.envelope.ok, true);
  const result = first.envelope.result;
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.remote_release_confirmed, true);
  assert.equal(result.queue.capacity, 1);
  assert.equal(result.queue.scope, 'host');
  assert.match(result.commands[0].stdout, /local diagnostic evidence/);
  assertDiagnosticOnly(result);
  const saved = readJson<any>(join(root, 'requests/first/result.json'));
  assert.deepEqual(saved, result);
  assert.deepEqual(runDriver(request).envelope.result, result);
  assert.equal(readFileSync(join(root, 'requests/first/diagnostic/executions.txt'), 'utf8'), '1');
  assert.deepEqual(runDriver({ ...request, action: 'collect' }).envelope.result, result);
  const second = runDriver(diagnosticRequest(root, 'second')).envelope.result;
  assert.equal(second.remote_release_confirmed, true);
  assert.ok(second.queue.ticket > result.queue.ticket);
  assert.ok(second.queue.started_at >= result.finished_at);
  assert.deepEqual(readJson<any>(join(root, 'queue/queue.json')).entries, []);
  assertDiagnosticOnly(second);
});

test('diagnostic timeout retains bounded command context and identical later collect evidence', t => {
  const root = temporary(t, 'meteor-hardware-diagnostic-timeout-');
  const request = diagnosticRequest(root, 'timeout', "import sys,time\nprint('x'*21000+'timeout-progress',flush=True)\nprint('timeout-detail',file=sys.stderr,flush=True)\ntime.sleep(10)\n");
  request.commands = [
    { argv: [executable, '-u', '-c', "print('setup complete')"], timeout_seconds: 2 },
    { argv: [executable, '-u', 'diagnostic.py'], timeout_seconds: 1 },
    { argv: [executable, '-c', "from pathlib import Path; Path('should-not-run').touch()"], timeout_seconds: 2 },
  ];
  const { processResult, envelope } = runDriver(request);
  assert.equal(processResult.status, 1, processResult.stderr);
  assert.equal(envelope.ok, false);
  const result = envelope.result;
  assert.equal(result.status, 'FAILED');
  assert.equal(result.remote_release_confirmed, true);
  assert.ok(result.failure_context, JSON.stringify(envelope));
  assert.equal(result.failure_context.stage, 'hardware_experiment');
  assert.equal(result.failure_context.command_index, 1);
  assert.equal(result.failure_context.completed_commands.length, 1);
  assert.match(result.failure_context.completed_commands[0].stdout, /setup complete/);
  assert.equal(result.failed_command.timeout_seconds, 1);
  assert.equal(result.failed_command.stdout.length, 20000);
  assert.match(result.failed_command.stdout, /timeout-progress\s*$/);
  assert.match(result.failed_command.stderr, /timeout-detail/);
  assert.notEqual(result.failed_command.returncode, 0);
  assert.equal(existsSync(join(root, 'requests/timeout/diagnostic/should-not-run')), false);
  assert.deepEqual(runDriver({ ...request, action: 'collect' }).envelope.result, result);
  assert.deepEqual(runDriver(request).envelope.result, result);
  assert.deepEqual(readJson<any>(join(root, 'queue/queue.json')).entries, []);
  assertDiagnosticOnly(result);
});

test('Chief diagnostics retain one request ID, reject duplicate runs and only cache released receipts', async t => {
  const { root, ssh } = setupHost(t);
  const before = researchArtifacts(root);
  const input = runInput('stable');
  const initial = await hardwareExperiment(root, input, 'chief');
  assert.equal(initial.status, 'UNKNOWN_REMOTE');
  assert.equal(initial.remote_release_confirmed, false);
  const resultPath = join(root, 'hardware/experiments/stable/result.json');
  const journalPath = join(root, 'hardware/experiments/stable/request.json');
  assert.equal(existsSync(resultPath), false);
  const journalBytes = readFileSync(journalPath);
  const journal = readJson<any>(journalPath);
  assert.equal(journal.remote_request_id, initial.remote_request_id);
  assert.deepEqual(journal.payload.files, input.files);
  assert.ok(existsSync(join(root, 'hardware/experiments/stable/runtime/tools/meteor/runners/remote/driver.py')));
  await assert.rejects(hardwareExperiment(root, input, 'chief'), /already exists/);
  assert.equal(ssh.requests().length, 1);
  ssh.respond({ poll: { status: 'RUNNING', remote_release_confirmed: false }, collect: complete });
  const pending = await hardwareExperiment(root, { action: 'poll', experiment_id: 'stable' }, 'chief');
  assert.equal(pending.status, 'RUNNING');
  assert.equal(existsSync(resultPath), false);
  const completed = await hardwareExperiment(root, { action: 'collect', experiment_id: 'stable' }, 'chief');
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.result_ref, 'hardware/experiments/stable/result.json');
  const cached = readJson<any>(resultPath);
  assert.equal(cached.value.request_hash, hashObject(journal));
  assert.equal(cached.content_hash, hashObject(cached.value));
  assert.deepEqual(readFileSync(journalPath), journalBytes);
  const reads = ssh.requests();
  assert.deepEqual(reads.map(item => item.action), ['hardware_experiment', 'poll', 'collect']);
  assert.equal(new Set(reads.map(item => item.request_id)).size, 1);
  await hardwareExperiment(root, { action: 'collect', experiment_id: 'stable' }, 'chief');
  assert.equal(ssh.requests().length, 3, 'a released immutable receipt is read locally');
  await assert.rejects(hardwareExperiment(root, input, 'chief'), /already exists/);
  assert.deepEqual(researchArtifacts(root), before);
  assertDiagnosticOnly(cached.value.result);
});

test('diagnostic runs reject mock, simulated and unbound hardware before recording or dispatching', async t => {
  for (const variant of ['mock', 'simulated-environment', 'simulated-report', 'unbound'] as const) {
    await t.test(variant, async t => {
      const { root, profile, ssh } = setupHost(t);
      const localPath = join(root, '.meteor.local.json'), local = readJson<any>(localPath);
      if (variant === 'mock') {
        // A usable SSH profile must not turn an explicitly mock workspace into a real diagnostic.
        local.execution = { backend: 'mock', profile_ref: profile.profileRef };
        local.environment.simulated = true;
        writeJson(localPath, local);
      } else if (variant === 'simulated-environment') {
        local.environment.simulated = true;
        writeJson(localPath, local);
      } else if (variant === 'simulated-report') {
        const reportPath = join(root, local.environment.hardware_report_ref), report = readJson<any>(reportPath);
        report.result.simulated = true;
        writeJson(reportPath, report);
        local.environment.hardware_report_hash = hashObject(report);
        writeJson(localPath, local);
      } else {
        writeJson(join(root, 'hardware/target.json'), { schema_version: 1, state: 'unconfigured' });
      }
      await assert.rejects(hardwareExperiment(root, runInput(variant), 'chief'), /SSH|simulat|hardware|bound/i);
      assert.equal(existsSync(join(root, `hardware/experiments/${variant}`)), false, 'Rejected preparation must not leave a journal or runtime snapshot');
      assert.deepEqual(ssh.requests(), [], 'Rejected preparation must not reach SSH');
    });
  }
});

test('hardware diagnostics run and collect without copying a target oracle outside the runtime', async t => {
  const { root, ssh } = setupHost(t);
  const configPath = join(root, 'meteor.config.json'), config = readJson<any>(configPath);
  const oracleRef = 'contracts/qmq-v1/int8/custom-oracle.py';
  writeFileSync(join(root, oracleRef), '# Synthetic target oracle; hardware diagnostics do not consume this file.\n');
  config.targets[0].oracle_ref = oracleRef;
  writeJson(configPath, config);
  const result = await hardwareExperiment(root, runInput('independent-oracle'), 'chief');
  assert.equal(result.status, 'UNKNOWN_REMOTE');
  const snapshot = join(root, 'hardware/experiments/independent-oracle/runtime');
  assert.equal(existsSync(join(snapshot, oracleRef)), false);
  writeFileSync(join(root, oracleRef), '# Changed target oracle must not affect collection of hardware diagnostics.\n');
  ssh.respond({ collect: complete });
  const collected = await hardwareExperiment(root, { action: 'collect', experiment_id: 'independent-oracle' }, 'chief');
  assert.equal(collected.status, 'COMPLETED');
  assert.equal(collected.remote_release_confirmed, true);
  assert.ok(collected.result_ref);
  assert.deepEqual(ssh.requests().map(item => item.action), ['hardware_experiment', 'collect']);
  assert.equal(new Set(ssh.requests().map(item => item.request_id)).size, 1);
  assertDiagnosticOnly(collected);
});

test('cancellation keeps the original ID and remains pending until release is collected', async t => {
  const { root, ssh } = setupHost(t);
  await hardwareExperiment(root, runInput('cancelled'), 'chief');
  ssh.respond({ cancel: { status: 'CANCEL_REQUESTED', remote_released: false },
    collect: { status: 'CANCELLED', backend: 'ssh', simulated: false, remote_release_confirmed: true } });
  const pending = await hardwareExperiment(root, { action: 'cancel', experiment_id: 'cancelled' }, 'chief');
  assert.equal(pending.status, 'CANCEL_REQUESTED');
  assert.equal(existsSync(join(root, 'hardware/experiments/cancelled/result.json')), false);
  const result = await hardwareExperiment(root, { action: 'collect', experiment_id: 'cancelled' }, 'chief');
  assert.equal(result.status, 'CANCELLED');
  assert.ok(result.result_ref);
  assert.deepEqual(ssh.requests().map(item => item.action), ['hardware_experiment', 'cancel', 'collect']);
  assert.equal(new Set(ssh.requests().map(item => item.request_id)).size, 1);
});

test('Chief and pinned profile identity are checked before transport and cached-result access', async t => {
  const { root, profile, ssh } = setupHost(t);
  await hardwareExperiment(root, runInput('identity'), 'chief-owner');
  await assert.rejects(hardwareExperiment(root, { action: 'poll', experiment_id: 'identity' }, 'other-chief'), /another Chief/);
  assert.equal(ssh.requests().length, 1);
  writeJson(profile.profilePath, { schema_version: 1, profiles: { [profile.profileRef]: { ...profile.profile, ssh_alias: 'changed-fixture-host' } } });
  await assert.rejects(hardwareExperiment(root, { action: 'collect', experiment_id: 'identity' }, 'chief-owner'), /profile changed/i);
  assert.equal(ssh.requests().length, 1);
  writeJson(profile.profilePath, { schema_version: 1, profiles: { [profile.profileRef]: profile.profile } });
  ssh.respond({ collect: complete });
  await hardwareExperiment(root, { action: 'collect', experiment_id: 'identity' }, 'chief-owner');
  await assert.rejects(hardwareExperiment(root, { action: 'collect', experiment_id: 'identity' }, 'other-chief'), /another Chief/);
  assert.equal(ssh.requests().length, 2);
  writeJson(profile.profilePath, { schema_version: 1, profiles: { [profile.profileRef]: { ...profile.profile, ssh_alias: 'changed-after-cache' } } });
  await assert.rejects(hardwareExperiment(root, { action: 'collect', experiment_id: 'identity' }, 'chief-owner'), /profile changed/i);
  assert.equal(ssh.requests().length, 2);
  writeJson(profile.profilePath, { schema_version: 1, profiles: { [profile.profileRef]: profile.profile } });
  await assert.rejects(hardwareExperiment(root, { action: 'collect', experiment_id: 'unknown-id' }, 'chief-owner'), /Unknown hardware experiment/);
  assert.equal(ssh.requests().length, 2);
});

test('nested poll receipts cannot bypass simulated, backend, request or command identity checks', async t => {
  const { root, ssh } = setupHost(t);
  for (const [id, invalid] of [
    ['simulated', { ...complete, simulated: true }],
    ['backend', { ...complete, backend: 'mock' }],
    ['request', { ...complete, request_id: 'foreign-request' }],
    ['command-count', { ...complete, commands: [] }],
    ['command-argv', { ...complete, commands: [{ ...complete.commands[0], command: ['python3', 'other.py'] }] }],
    ['command-status', { ...complete, commands: [{ ...complete.commands[0], returncode: 1 }] }],
  ] as const) {
    ssh.respond({});
    await hardwareExperiment(root, runInput(id), 'chief');
    ssh.respond({ poll: { status: 'FINISHED', result: invalid } });
    let response: any;
    try { response = await hardwareExperiment(root, { action: 'poll', experiment_id: id }, 'chief'); }
    catch { /* Rejecting invalid evidence is also an acceptable API outcome. */ }
    assert.equal(existsSync(join(root, `hardware/experiments/${id}/result.json`)), false, `${id} poll receipt must not be frozen as valid evidence`);
    assert.ok(response === undefined || response.status !== 'COMPLETED' || response.remote_release_confirmed !== true);
  }
});
