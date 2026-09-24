import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { probeHardware } from '../src/hardware.ts';
import { loadProject } from '../src/project.ts';
import { createResearch } from '../templates/project/tools/meteor/research.ts';
import { hashObject, writeJson } from '../templates/project/tools/meteor/util.ts';
import { hardwareEnvironmentRef, SSH_MEASUREMENT_PROTOCOL_REF } from '../templates/project/tools/meteor/hardware.ts';
import {
  emptyHardwareProfiles,
  fixtureProfile,
  fixtureProfileRef,
  installFakeHardwareSsh,
  installHardwareProfile,
  materializeUnitCaseSuite,
  readyHardwareResult,
  writeReadyHardwareFixture,
} from './helpers/hardware.ts';

function tempRoot(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-hardware-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function startResearch(root: string, id = 'hardware_ready_research') {
  return createResearch(loadProject(root), {
    research_id: id,
    agent_session_id: 'session_' + id,
    chief_id: 'chief',
    goal: 'Verify hardware gate before starting research',
  });
}

test('probeHardware without configured profiles requests setup and writes no placeholder readiness', async t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  emptyHardwareProfiles(t, root);

  const result = await probeHardware(root);

  assert.equal(result.state, 'setup_required');
  assert.deepEqual(result.available_profiles, []);
  assert.equal(existsSync(join(root, '.meteor.local.json')), false);
  assert.equal(existsSync(join(root, 'reports', 'meteor', 'ssh', 'hardware')), false);
});

test('failed probe saves a blocked report and keeps research start disabled', async t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  installHardwareProfile(t, root);
  installFakeHardwareSsh(t, {
    status: 'FAILED',
    backend: 'ssh',
    simulated: false,
    readiness: 'BLOCKED',
    error: 'unit fixture probe failure',
  });

  const result = await probeHardware(root, fixtureProfileRef);

  assert.equal(result.state, 'setup_required');
  assert.match(String(result.diagnostics), /unit fixture probe failure/);
  const project = loadProject(root);
  assert.equal(project.config.execution.backend, 'unconfigured');
  assert.equal(project.config.environment.hardware_report_ref?.startsWith('reports/meteor/ssh/hardware/'), true);
  const report = JSON.parse(readFileSync(join(root, project.config.environment.hardware_report_ref!), 'utf8'));
  assert.equal(report.result.readiness, 'BLOCKED');
  assert.throws(() => startResearch(root), /Device setup required/);
});

test('successful stub probe binds a ready hardware report before research can start', async t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  materializeUnitCaseSuite(root);
  const profile = installHardwareProfile(t, root);
  installFakeHardwareSsh(t, readyHardwareResult());

  const result = await probeHardware(root, profile.profileRef);

  assert.equal(result.state, 'ready_ssh');
  assert.deepEqual(result.selected_device, { device_id: 0, soc_version: 'Ascend910B-unit-fixture', npu_arch: 'dav-2201' });
  const project = loadProject(root);
  assert.equal(project.config.execution.backend, 'ssh');
  assert.equal(project.config.environment.profile_hash, profile.profileHash);
  assert.equal(project.config.environment.npu_arch, 'dav-2201');
  assert.ok(project.config.environment.hardware_report_ref);
  const record = startResearch(root);
  assert.equal(record.execution_backend, 'ssh');
});

test('chief repairs to the project transport are used by the next hardware probe', async t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  installHardwareProfile(t, root);
  const transport = join(root, 'tools/meteor/runners/ssh.ts');
  for (const revision of ['before-repair', 'after-repair']) {
    writeFileSync(transport, 'export async function remoteRequest() { return ' + JSON.stringify({
      status: 'FAILED', backend: 'ssh', simulated: false, readiness: 'BLOCKED', error: revision,
    }) + '; }\n');
    const result = await probeHardware(root);
    assert.equal(result.state, 'setup_required');
    assert.equal(result.diagnostics, revision);
  }
});

test('empty optional profile references discover existing configuration instead of asking the user', async t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  materializeUnitCaseSuite(root);
  installHardwareProfile(t, root);
  installFakeHardwareSsh(t, readyHardwareResult());
  for (const reference of ['', '   ']) {
    const result = await probeHardware(root, reference);
    assert.equal(result.state, 'ready_ssh');
    assert.equal(result.profile_ref, fixtureProfileRef);
  }
  const invalid = await probeHardware(root, 'invented-profile');
  assert.equal(invalid.state, 'setup_required');
  assert.deepEqual(invalid.available_profiles, [fixtureProfileRef]);
  assert.match(invalid.action, /no arguments/);
});

test('research start rejects changed reports, changed profiles, and incomplete validation', t => {
  {
    const root = tempRoot(t);
    initProject(root, { git: false });
    materializeUnitCaseSuite(root);
    installHardwareProfile(t, root);
    const ready = writeReadyHardwareFixture(root);
    const report = JSON.parse(readFileSync(ready.reportPath, 'utf8'));
    report.result.selected_device.soc_version = 'tampered-device';
    writeFileSync(ready.reportPath, JSON.stringify(report, null, 2) + '\n');
    assert.throws(() => startResearch(root, 'changed_report'), /Hardware report changed/);
  }

  {
    const root = tempRoot(t);
    initProject(root, { git: false });
    materializeUnitCaseSuite(root);
    const changedProfile = { ...fixtureProfile(), npu_arch: 'dav-3000' };
    const profilePath = installHardwareProfile(t, root).profilePath;
    writeReadyHardwareFixture(root);
    writeJson(profilePath, { schema_version: 1, profiles: { [fixtureProfileRef]: changedProfile } });
    assert.throws(() => startResearch(root, 'changed_profile'), /SSH profile changed/);
  }

  {
    const root = tempRoot(t);
    initProject(root, { git: false });
    materializeUnitCaseSuite(root);
    installHardwareProfile(t, root);
    writeReadyHardwareFixture(root, {
      result: readyHardwareResult({
        validation: {
          compile: true,
          launch: true,
          correctness: true,
          device_execution: { status: 'CONFIRMED', matched_tasks: [] },
        },
      }),
    });
    assert.throws(() => startResearch(root, 'incomplete_validation'), /Hardware validation is not ready/);
  }
});

test('ready hardware without a pinned case suite is still setup-required for every research entrypoint', t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  installHardwareProfile(t, root);
  writeReadyHardwareFixture(root);

  assert.throws(() => startResearch(root, 'unpinned_cases'), /pinned case files and oracle hashes/);
  const initialized = initProject(root, { git: false });
  assert.equal(initialized.state, 'setup_required');
  assert.equal(initialized.execution_backend, 'ssh');
  assert.equal(initialized.hardware_report_ref?.startsWith('reports/meteor/ssh/hardware/'), true);
});


test('stable hardware environment ref ignores dynamic report fields but tracks device and toolchain identity', () => {
  const profile = fixtureProfile();
  const profileHash = hashObject(profile);
  const baseResult = readyHardwareResult({
    selected_device: {
      device_id: 0,
      card_id: 3,
      chip_id: 1,
      physical_id: 7,
      soc_version: 'Ascend910B-unit-fixture',
      npu_arch: 'dav-2201',
      memory: { total_bytes: 1024, free_bytes: 512 },
      health: { status: 'OK' },
    },
    cann: { compiler: 'fixture-cann 1.0', runtime: 'fixture-runtime 1.0' },
    logs: [{ command: ['npu-smi'], stdout: 'first dynamic log' }],
  });
  const changedDynamicResult: any = structuredClone(baseResult);
  changedDynamicResult.selected_device.memory.free_bytes = 128;
  changedDynamicResult.selected_device.health.status = 'Warning';
  changedDynamicResult.logs = [{ command: ['npu-smi'], stdout: 'second dynamic log' }];
  const reportA = { schema_version: 1, probed_at: '2026-01-01T00:00:00.000Z', profile_ref: fixtureProfileRef, profile_hash: profileHash, result: baseResult };
  const reportB = { ...reportA, probed_at: '2026-01-01T00:00:01.000Z', result: changedDynamicResult };

  assert.notEqual(hashObject(reportA), hashObject(reportB));
  const baseRef = hardwareEnvironmentRef({ profile_ref: fixtureProfileRef, profile_hash: profileHash, result: baseResult, measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF });
  assert.equal(hardwareEnvironmentRef({ profile_ref: fixtureProfileRef, profile_hash: profileHash, result: changedDynamicResult, measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF }), baseRef);

  const cases: Array<[string, any, string, string]> = [
    ['profile', baseResult, 'other-profile-ref', hashObject({ ...profile, ssh_alias: 'other-host' })],
    ['device-id', readyHardwareResult({ selected_device: { ...(baseResult as any).selected_device, device_id: 1 } }), fixtureProfileRef, profileHash],
    ['physical-map', readyHardwareResult({ selected_device: { ...(baseResult as any).selected_device, physical_id: 8 } }), fixtureProfileRef, profileHash],
    ['soc', readyHardwareResult({ selected_device: { ...(baseResult as any).selected_device, soc_version: 'Ascend910C-unit-fixture' } }), fixtureProfileRef, profileHash],
    ['arch', readyHardwareResult({ selected_device: { ...(baseResult as any).selected_device, npu_arch: 'dav-3000' } }), fixtureProfileRef, profileHash],
    ['compiler', readyHardwareResult({ selected_device: (baseResult as any).selected_device, cann: { compiler: 'fixture-cann 2.0', runtime: 'fixture-runtime 1.0' } }), fixtureProfileRef, profileHash],
    ['runtime', readyHardwareResult({ selected_device: (baseResult as any).selected_device, cann: { compiler: 'fixture-cann 1.0', runtime: 'fixture-runtime 2.0' } }), fixtureProfileRef, profileHash],
    ['protocol', baseResult, fixtureProfileRef, profileHash],
  ];
  for (const [label, result, ref, hash] of cases) {
    const protocol = label === 'protocol' ? SSH_MEASUREMENT_PROTOCOL_REF + '-next' : SSH_MEASUREMENT_PROTOCOL_REF;
    assert.notEqual(hardwareEnvironmentRef({ profile_ref: ref, profile_hash: hash, result, measurement_protocol_ref: protocol }), baseRef, label);
  }
});

test('initProject ready_ssh next action points chief at existing report instead of re-probing', t => {
  const root = tempRoot(t);
  initProject(root, { git: false });
  materializeUnitCaseSuite(root);
  installHardwareProfile(t, root);
  const ready = writeReadyHardwareFixture(root);

  const initialized = initProject(root, { git: false });

  assert.equal(initialized.state, 'ready_ssh');
  assert.equal(initialized.hardware_report_ref, ready.reportRef);
  assert.match(initialized.next_action, /Existing hardware report is ready/);
  assert.match(initialized.next_action, new RegExp(ready.reportRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(initialized.next_action, /call meteor_hardware_probe with no arguments/);
});
