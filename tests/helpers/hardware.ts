import type { TestContext } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { hashObject, readJson, sha256, writeJson } from '../../templates/project/tools/meteor/util.ts';
import { hardwareEnvironmentRef, SSH_MEASUREMENT_PROTOCOL_REF } from '../../templates/project/tools/meteor/hardware.ts';

export const fixtureProfileRef = 'fixture-only-no-connection';

export function fixtureProfile() {
  return {
    ssh_alias: 'fake-host',
    remote_root: '/tmp/meteor-remote',
    env_script: '/tmp/set_env.sh',
    npu_arch: 'dav-2201',
    device_id: '0',
    connect_timeout_seconds: 1,
  };
}

export function readyHardwareResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'COMPLETED',
    backend: 'ssh',
    simulated: false,
    readiness: 'READY',
    selected_device: { device_id: 0, soc_version: 'Ascend910B-unit-fixture', npu_arch: 'dav-2201' },
    validation: {
      compile: true,
      launch: true,
      correctness: true,
      device_execution: {
        status: 'CONFIRMED',
        tool: 'unit-fixture',
        matched_tasks: [{ device_id: 0, task_type: 'AI_CORE', op_name: 'meteor_hardware_probe' }],
      },
    },
    supported_metrics: ['kernel_time_us'],
    cann: { compiler: 'fixture-cann' },
    ...overrides,
  };
}

export function installHardwareProfile(
  t: TestContext,
  root: string,
  profileRef = fixtureProfileRef,
  profile = fixtureProfile(),
) {
  const oldProfiles = process.env.METEOR_PROFILES_PATH;
  const profilePath = join(root, 'profiles.json');
  writeJson(profilePath, { schema_version: 1, profiles: { [profileRef]: profile } });
  process.env.METEOR_PROFILES_PATH = profilePath;
  t.after(() => {
    if (oldProfiles === undefined) delete process.env.METEOR_PROFILES_PATH;
    else process.env.METEOR_PROFILES_PATH = oldProfiles;
  });
  return { profilePath, profileRef, profile, profileHash: hashObject(profile) };
}

// Unit fixture only: writes strict hardware evidence for local tests without claiming a real device measurement.
export function writeReadyHardwareFixture(
  root: string,
  options: {
    profileRef?: string;
    profile?: ReturnType<typeof fixtureProfile>;
    result?: Record<string, unknown>;
    reportId?: string;
  } = {},
) {
  const profileRef = options.profileRef ?? fixtureProfileRef;
  const profile = options.profile ?? fixtureProfile();
  const result = options.result ?? readyHardwareResult();
  const report = {
    schema_version: 1,
    probed_at: '2026-01-01T00:00:00.000Z',
    profile_ref: profileRef,
    profile_hash: hashObject(profile),
    result,
  };
  const reportPath = join(root, 'reports', 'meteor', 'ssh', 'hardware', `${options.reportId ?? 'unit-fixture'}.json`);
  writeJson(reportPath, report);
  const reportRef = relative(root, reportPath).replaceAll('\\', '/');
  const reportHash = hashObject(report);
  const device = (result as any).selected_device ?? {};
  writeJson(join(root, '.meteor.local.json'), {
    execution: { backend: 'ssh', profile_ref: profileRef },
    environment: {
      environment_ref: hardwareEnvironmentRef({ profile_ref: profileRef, profile_hash: hashObject(profile), result, measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF }),
      hardware: device.soc_version,
      toolchain: (result as any).cann?.compiler ?? 'fixture-cann',
      measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF,
      simulated: false,
      hardware_report_ref: reportRef,
      hardware_report_hash: reportHash,
      profile_hash: hashObject(profile),
      device_id: device.device_id,
      npu_arch: device.npu_arch,
    },
  });
  return { report, reportRef, reportPath, reportHash, profileHash: hashObject(profile) };
}

export function installFakeHardwareSsh(t: TestContext, result: Record<string, unknown>) {
  const oldPath = process.env.PATH;
  const oldPathCapital = process.env.Path;
  const oldSshBin = process.env.METEOR_SSH_BIN;
  const dir = mkdtempSync(join(tmpdir(), 'meteor-fake-hardware-ssh-'));
  const script = join(dir, 'fake-ssh.mjs');
  writeFileSync(script, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const body = JSON.parse(input);
  const requestId = body.request?.request_id;
  const result = ${JSON.stringify(result)};
  console.log(JSON.stringify({ ok: true, request_id: requestId, result }));
});
`, 'utf8');
  const wrapper = process.platform === 'win32' ? join(dir, 'ssh.cmd') : join(dir, 'ssh');
  if (process.platform === 'win32') {
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}"\r\n`, 'utf8');
  } else {
    writeFileSync(wrapper, `#!/usr/bin/env sh\nexec "${process.execPath}" "${script}"\n`, 'utf8');
    chmodSync(wrapper, 0o755);
  }
  process.env.PATH = dir + delimiter + (oldPath ?? '');
  process.env.Path = dir + delimiter + (oldPathCapital ?? oldPath ?? '');
  process.env.METEOR_SSH_BIN = wrapper;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldPathCapital === undefined) delete process.env.Path;
    else process.env.Path = oldPathCapital;
    if (oldSshBin === undefined) delete process.env.METEOR_SSH_BIN;
    else process.env.METEOR_SSH_BIN = oldSshBin;
  });
  return { dir, wrapper };
}

export function emptyHardwareProfiles(t: TestContext, root: string) {
  const oldProfiles = process.env.METEOR_PROFILES_PATH;
  const profilePath = join(root, 'profiles.json');
  writeJson(profilePath, { schema_version: 1, profiles: {} });
  process.env.METEOR_PROFILES_PATH = profilePath;
  t.after(() => {
    if (oldProfiles === undefined) delete process.env.METEOR_PROFILES_PATH;
    else process.env.METEOR_PROFILES_PATH = oldProfiles;
  });
  return profilePath;
}

// Unit fixture only: materializes tiny pinned case files so research-start tests do not depend on Python/NumPy.
export function materializeUnitCaseSuite(root: string, revision = 'unit-hardware-suite') {
  const config = readJson<any>(join(root, 'meteor.config.json'));
  const suitePath = join(root, config.case_suite);
  const suite = readJson<any>(suitePath);
  const verifier = readFileSync(join(root, 'tools', 'meteor', 'runners', 'remote', 'verify_case.py'));
  const cases = suite.cases.map((item: any, index: number) => {
    const dataRef = `cases/${item.case_id}-unit-fixture`;
    const dir = join(root, dataRef);
    mkdirSync(join(dir, 'input'), { recursive: true });
    mkdirSync(join(dir, 'golden'), { recursive: true });
    const files: Record<string, Buffer> = {
      'input/x1.bin': Buffer.from([index, 1]),
      'input/x2.bin': Buffer.from([index, 2]),
      'input/x1Scale.bin': Buffer.alloc(4, index),
      'input/x2Scale.bin': Buffer.alloc(4, index + 1),
      'golden/y.bin': Buffer.from([index, 3]),
      'golden/yScale.bin': Buffer.alloc(4, index + 2),
    };
    const metadata: Record<string, { bytes: number; sha256: string }> = {};
    const inputs: Record<string, string> = {};
    const golden: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(dir, name), bytes);
      const digest = sha256(bytes);
      metadata[name] = { bytes: bytes.length, sha256: digest };
      (name.startsWith('input/') ? inputs : golden)[name] = digest;
    }
    writeJson(join(dir, 'case.json'), { format_version: 1, ...item.shape, files: metadata });
    return {
      ...item,
      data_ref: dataRef,
      input_hash: hashObject(inputs),
      oracle_hash: hashObject({ verifier_sha256: sha256(verifier), golden }),
    };
  });
  writeJson(suitePath, { ...suite, revision, cases });
}
