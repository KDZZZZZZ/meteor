import type { Project } from './contracts.ts';
import { loadSshProfile } from './profiles.ts';
import { assert, hashObject, inside, readJson } from './util.ts';
import { hasDeviceExecution } from './device-evidence.ts';

export const SSH_MEASUREMENT_PROTOCOL_REF = 'acl-event-us-warmup3-samples5-device-witness-v2';

function stableScalar(value: unknown): string | number | boolean | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function stableInt(value: unknown): number | null {
  return Number.isSafeInteger(value) ? value as number : null;
}

export function hardwareEnvironmentIdentity(input: { profile_ref: string; profile_hash: string; result: any; measurement_protocol_ref?: string }) {
  const device = input.result?.selected_device ?? {};
  const cann = input.result?.cann ?? {};
  return {
    schema_version: 1,
    backend: 'ssh',
    profile_ref: input.profile_ref,
    profile_hash: input.profile_hash,
    measurement_protocol_ref: input.measurement_protocol_ref ?? SSH_MEASUREMENT_PROTOCOL_REF,
    selected_device: {
      device_id: stableInt(device.device_id),
      card_id: stableInt(device.card_id),
      chip_id: stableInt(device.chip_id),
      physical_id: stableInt(device.physical_id),
      soc_version: stableScalar(device.soc_version),
      npu_arch: stableScalar(device.npu_arch),
      name: stableScalar(device.name),
      inventory_name: stableScalar(device.inventory_name),
    },
    cann: {
      compiler: stableScalar(cann.compiler),
      runtime: stableScalar(cann.runtime),
    },
  };
}

export function hardwareEnvironmentRef(input: { profile_ref: string; profile_hash: string; result: any; measurement_protocol_ref?: string }): string {
  return 'hardware-' + hashObject(hardwareEnvironmentIdentity(input)).slice(0, 24);
}

export function hardwareReady(result: any): boolean {
  const device = result?.selected_device, check = result?.validation;
  return result?.status === 'COMPLETED' && result?.simulated === false && result?.backend === 'ssh'
    && result?.readiness === 'READY' && Number.isSafeInteger(device?.device_id) && device.device_id >= 0
    && typeof device.soc_version === 'string' && device.soc_version.length > 0
    && typeof device.npu_arch === 'string' && /^dav-[a-zA-Z0-9-]+$/.test(device.npu_arch)
    && check?.compile === true && check.launch === true && check.correctness === true
    && hasDeviceExecution(check.device_execution, device.device_id);
}

export function assertPinnedCaseSuite(project: Project): void {
  assert(project.suite.cases.every(item => item.data_ref && /^[a-f0-9]{64}$/.test(item.input_hash) && /^[a-f0-9]{64}$/.test(item.oracle_hash)),
    'Real research needs pinned case files and oracle hashes. Chief must resolve case_setup from meteor_hardware_probe or configure the fixed suite before starting.');
}

export function assertHardwareReady(project: Project): any {
  if (project.config.execution.backend === 'mock') return null;
  const env = project.config.environment;
  assert(project.config.execution.backend === 'ssh' && env.hardware_report_ref && env.hardware_report_hash,
    'Device setup required: chief must run meteor_hardware_probe and resolve its diagnostics before research');
  const report = readJson(inside(project.root, env.hardware_report_ref));
  assert(hashObject(report) === env.hardware_report_hash, 'Hardware report changed; run meteor_hardware_probe again');
  assert(hardwareReady(report.result), 'Hardware validation is not ready; run meteor_hardware_probe');
  assert(report.profile_ref === project.config.execution.profile_ref && report.profile_hash === env.profile_hash
    && report.profile_hash === hashObject(loadSshProfile(project.config.execution.profile_ref)),
  'SSH profile changed since hardware validation; run meteor_hardware_probe again');
  assert(env.device_id === report.result.selected_device.device_id && env.npu_arch === report.result.selected_device.npu_arch
    && env.environment_ref === hardwareEnvironmentRef({ profile_ref: report.profile_ref, profile_hash: report.profile_hash, result: report.result, measurement_protocol_ref: env.measurement_protocol_ref }), 'Environment does not match hardware report');
  assertPinnedCaseSuite(project);
  return report;
}
