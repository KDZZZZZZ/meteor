import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { SshRunner, remoteRequest } from '../templates/project/tools/meteor/runners/ssh.ts';
import { hashObject, sha256 } from '../templates/project/tools/meteor/util.ts';
import type { BuildRequest } from '../templates/project/tools/meteor/runners/contract.ts';
import type { KernelModule, Project } from '../templates/project/tools/meteor/contracts.ts';

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function installFakeSsh(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'meteor-fake-ssh-'));
  const script = join(dir, 'fake-ssh.mjs');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const body = JSON.parse(input);
  if (process.env.METEOR_FAKE_SSH_LOG) writeFileSync(process.env.METEOR_FAKE_SSH_LOG, JSON.stringify(body.request) + '\\n', {flag:'a'});
  if (!body.files['CMakeLists.txt']) {
    console.log(JSON.stringify({ok:false,error:'missing CMakeLists.txt'}));
    process.exit(0);
  }
  const req = body.request;
  if (${JSON.stringify(mode)} === 'simulated') {
    console.log(JSON.stringify({ok:true,result:{status:'COMPLETED',backend:'ssh',simulated:true,artifact_hash:'a'.repeat(64),remote_build_id:req.build_id,rendered_source_hash:req.rendered_source_hash}}));
    return;
  }
  if (${JSON.stringify(mode)} === 'pass-missing-hash') {
    console.log(JSON.stringify({ok:true,result:{status:'COMPLETED',backend:'ssh',simulated:false,artifact_hash:req.artifact_hash,rendered_source_hash:req.rendered_source_hash,rows:[{case_id:'c1',status:'PASS',samples_us:[1,2,3,4,5]}]}}));
    return;
  }
  console.log(JSON.stringify({ok:true,result:{status:'COMPLETED',backend:'ssh',simulated:false,artifact_hash:'b'.repeat(64),remote_build_id:req.build_id,rendered_source_hash:req.rendered_source_hash}}));
});
`, 'utf8');
  if (process.platform === 'win32') {
    const wrapper = join(dir, 'ssh.cmd');
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}"\r\n`, 'utf8');
    return { dir, wrapper };
  }
  const wrapper = join(dir, 'ssh');
  writeFileSync(wrapper, `#!/usr/bin/env sh\nexec "${process.execPath}" "${script}"\n`, 'utf8');
  chmodSync(wrapper, 0o755);
  return { dir, wrapper };
}

function withFakeSsh(mode: string, fn: (root: string, logPath: string) => Promise<void>) {
  return async () => {
    const oldPath = process.env.PATH;
    const oldPathCapital = process.env.Path;
    const oldSshBin = process.env.METEOR_SSH_BIN;
    const oldProfiles = process.env.METEOR_PROFILES_PATH;
    const fake = installFakeSsh(mode);
    const root = mkdtempSync(join(tmpdir(), 'meteor-ssh-project-'));
    const profilePath = join(root, 'profiles.json');
    const logPath = join(root, 'requests.jsonl');
    writeJson(profilePath, {
      schema_version: 1,
      profiles: {
        dev: {
          ssh_alias: 'fake-host',
          remote_root: '/tmp/meteor-remote',
          env_script: '/tmp/set_env.sh',
          npu_arch: 'dav-2201',
          device_id: '0',
          connect_timeout_seconds: 1,
        },
      },
    });
    process.env.PATH = fake.dir + delimiter + oldPath;
    process.env.Path = fake.dir + delimiter + (oldPathCapital ?? oldPath ?? '');
    process.env.METEOR_SSH_BIN = fake.wrapper;
    process.env.METEOR_FAKE_SSH_LOG = logPath;
    process.env.METEOR_PROFILES_PATH = profilePath;
    try {
      await fn(root, logPath);
    } finally {
      process.env.PATH = oldPath;
      if (oldPathCapital === undefined) delete process.env.Path;
      else process.env.Path = oldPathCapital;
      if (oldSshBin === undefined) delete process.env.METEOR_SSH_BIN;
      else process.env.METEOR_SSH_BIN = oldSshBin;
      delete process.env.METEOR_FAKE_SSH_LOG;
      if (oldProfiles === undefined) delete process.env.METEOR_PROFILES_PATH;
      else process.env.METEOR_PROFILES_PATH = oldProfiles;
    }
  };
}

function project(root: string): Project {
  return {
    root,
    dataRoot: join(root, 'reports/meteor/ssh'),
    config: {
      schema_version: 1,
      execution: { backend: 'ssh', profile_ref: 'dev' },
      case_suite: 'suite',
      environment: { environment_ref: 'ssh-env', hardware: 'ascend910', toolchain: 'cann', measurement_protocol_ref: 'acl-event-5-v1', simulated: false },
      sampling: { epsilon: 0.1, lambda: 1, tau_hours: 24, count: 1 },
      budget: { max_experiments: 2, max_wall_time_seconds: 60 },
      integration: { min_relative_improvement: 0.01 },
    },
    suite: { revision: 'suite', operator_abi: 'qmq-v1', cases: [] },
  };
}

function projectWithCase(root: string): Project {
  mkdirSync(join(root, 'case/input'), { recursive: true });
  mkdirSync(join(root, 'case/golden'), { recursive: true });
  const files: Record<string, Buffer> = {
    'input/x1.bin': Buffer.from([1]),
    'input/x2.bin': Buffer.from([1]),
    'input/x1Scale.bin': Buffer.alloc(4),
    'input/x2Scale.bin': Buffer.alloc(4),
    'golden/y.bin': Buffer.from([1]),
    'golden/yScale.bin': Buffer.alloc(4),
  };
  const fileMeta: Record<string, { bytes: number; sha256: string }> = {};
  const inputs: Record<string, string> = {};
  const golden: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(root, 'case', name), bytes);
    const digest = sha256(bytes);
    fileMeta[name] = { bytes: bytes.length, sha256: digest };
    (name.startsWith('input/') ? inputs : golden)[name] = digest;
  }
  writeJson(join(root, 'case/case.json'), { format_version: 1, m: 1, n: 1, k: 1, files: fileMeta });
  const verifier = readFileSync(join(process.cwd(), 'templates/project/tools/meteor/runners/remote/verify_case.py'));
  const inputHash = hashObject(inputs);
  const oracleHash = hashObject({ verifier_sha256: sha256(verifier), golden });
  const p = project(root);
  p.suite.cases = [{ case_id: 'c1', shape: { m: 1, n: 1, k: 1 }, dtype: 'int8', layout: 'qmq-v1', input_hash: inputHash, oracle_hash: oracleHash, data_ref: 'case' }];
  return p;
}

function module(): KernelModule {
  return {
    kernel_id: 'demo',
    revision: 'r1',
    operator_abi: 'qmq-v1',
    symbol_prefix: 'demo_',
    launcher: 'demo_launch',
    device_file: 'kernels/demo/r1/device.asc',
    host_file: 'kernels/demo/r1/host.asc',
    supported_case_ids: [],
    dependencies: [],
    hardware_scope: 'ascend910',
    resource_constraints: [],
  };
}

function buildRequest(root: string): BuildRequest {
  mkdirSync(join(root, 'reports/meteor/ssh'), { recursive: true });
  const rendered = 'rendered';
  return {
    project: project(root),
    research_id: 'r1',
    experiment_id: 'e1',
    module: module(),
    kernel_path: 'kernels/demo/r1',
    source_hash: 'source',
    rendered_source_hash: createHash('sha256').update(rendered).digest('hex'),
    rendered_source: rendered,
  };
}

function completedBuild(root: string) {
  return {
    build_id: 'local-build',
    research_id: 'r1',
    experiment_id: 'e1',
    kernel_ref: { kernel_id: 'demo', revision: 'r1' },
    source_hash: 'source',
    artifact_hash: 'b'.repeat(64),
    environment_ref: 'ssh-env',
    execution_backend: 'ssh' as const,
    simulated: false,
    status: 'COMPLETED' as const,
    source_ref: 'kernels/demo/r1',
    module_ref: 'kernels/demo/r1/kernel.json',
    rendered_source_hash: 'render-hash',
    remote_build_id: 'remote-build',
  };
}

test('remoteRequest deploys full bundle and accepts real completed ssh receipt', withFakeSsh('real', async root => {
  const result = await remoteRequest(project(root), {
    action: 'build',
    request_id: 'req',
    build_id: 'build',
    rendered_source_hash: 'hash',
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.backend, 'ssh');
  assert.equal(result.simulated, false);
}));

test('SshRunner rejects simulated remote build receipts', withFakeSsh('simulated', async root => {
  const receipt = await new SshRunner().build(buildRequest(root));
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.error ?? '', /simulated remote receipts/);
}));

test('SshRunner accepts real remote build identity and hashes', withFakeSsh('real', async root => {
  const receipt = await new SshRunner().build(buildRequest(root));
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(receipt.execution_backend, 'ssh');
  assert.equal(receipt.simulated, false);
  assert.equal(receipt.artifact_hash, 'b'.repeat(64));
  assert.equal(receipt.rendered_source_hash, buildRequest(root).rendered_source_hash);
  assert.match(receipt.remote_build_id ?? '', /^[a-f0-9]{64}$/);
}));

test('SshRunner uses fresh random request ids unless idempotency_key is supplied', withFakeSsh('real', async (root, logPath) => {
  await new SshRunner().build(buildRequest(root));
  await new SshRunner().build(buildRequest(root));
  await new SshRunner().build({ ...buildRequest(root), idempotency_key: 'same-key' });
  await new SshRunner().build({ ...buildRequest(root), idempotency_key: 'same-key' });
  const ids = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).request_id);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[2], 'build-same-key');
  assert.equal(ids[3], 'build-same-key');
}));

test('SshRunner rejects PASS rows without confirmed remote input and oracle hashes', withFakeSsh('pass-missing-hash', async root => {
  await assert.rejects(() => new SshRunner().test({
    project: projectWithCase(root),
    build: completedBuild(root),
    module: { ...module(), supported_case_ids: ['c1'] },
    mode: 'probe',
    case_ids: ['c1'],
  }), /Remote PASS input hash mismatch/);
}));
