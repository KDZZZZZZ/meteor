import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadProject } from './project.ts';
import { listSshProfiles, loadSshProfile, profileStorePath } from '../templates/project/tools/meteor/profiles.ts';
import { hardwareEnvironmentRef, hardwareReady, SSH_MEASUREMENT_PROTOCOL_REF } from '../templates/project/tools/meteor/hardware.ts';
import { hashObject, writeImmutable, writeJson } from '../templates/project/tools/meteor/util.ts';
import { prepareDefaultCases } from './cases.ts';

export async function probeHardware(root: string, profileRef?: string, signal?: AbortSignal) {
  profileRef = profileRef?.trim() || undefined;
  const project = loadProject(root);
  const profiles = listSshProfiles();
  const ref = profileRef ?? (project.config.execution.backend !== 'mock' && project.config.execution.profile_ref ? project.config.execution.profile_ref : undefined)
    ?? (profiles.length === 1 ? profiles[0] : undefined);
  if (!ref) return { state: 'setup_required', available_profiles: profiles, profile_store: profileStorePath(),
    action: 'Select or configure one central SSH profile using a system SSH alias, then call meteor_hardware_probe with profile_ref. Credentials stay in system SSH configuration.' };
  if (!profiles.includes(ref)) return { state: 'setup_required', available_profiles: profiles, profile_store: profileStorePath(),
    error: 'Unknown SSH profile reference: ' + ref,
    action: profiles.length === 1 ? 'Call meteor_hardware_probe again with no arguments; the existing central profile will be selected automatically. Do not ask the user for a profile already listed here.'
      : 'Use an available_profiles reference. Request configuration only if no usable profile exists.' };
  const profile = loadSshProfile(ref);
  const profileHash = hashObject(profile);
  project.config.execution = { backend: 'ssh', profile_ref: ref };
  project.dataRoot = join(project.root, 'reports', 'meteor', 'ssh');
  const id = randomUUID();
  let result: any;
  try {
    const base = join(project.root, 'tools/meteor/runners/ssh');
    const transport = existsSync(base + '.ts') ? base + '.ts' : base + '.js';
    const { remoteRequest } = await import(pathToFileURL(transport).href + '?version=' + hashObject(readFileSync(transport, 'utf8')));
    result = await remoteRequest(project, { action: 'hardware', request_id: 'hardware-' + id }, signal);
  }
  catch (error) { result = { status: 'FAILED', backend: 'ssh', simulated: false, readiness: 'BLOCKED', error: String(error) }; }
  const report = { schema_version: 1, probed_at: new Date().toISOString(), profile_ref: ref, profile_hash: profileHash, result };
  const path = join(project.dataRoot, 'hardware', id + '.json');
  writeImmutable(path, report);
  const reportRef = relative(project.root, path).replaceAll('\\', '/');
  const markdownPath = path.replace(/\.json$/, '.md');
  const ready = hardwareReady(result);
  const markdown = ['# Meteor hardware report', '', `- Time: ${report.probed_at}`, `- Profile: ${ref}`,
    `- State: ${ready ? 'READY' : 'BLOCKED'}`, `- Raw evidence: [${id}.json](./${id}.json)`, '',
    '## Measured device', '', '```json', JSON.stringify(result.selected_device ?? null, null, 2), '```', '',
    '## Validation and capabilities', '', '```json', JSON.stringify({ validation: result.validation ?? null,
      supported_metrics: result.supported_metrics ?? [], tools: result.tools ?? null, cann: result.cann ?? null,
      diagnostics: result.diagnostics ?? result.error ?? result.reason ?? null }, null, 2), '```', '',
    ready ? 'This report binds the measured device and compiler to subsequent research. Performance is measured per candidate.'
      : 'Research is blocked. Chief should inspect raw command logs, fix device/toolchain access in the central profile and probe again. Unknown values are not hardware facts.', ''].join('\n');
  writeFileSync(markdownPath, markdown, { flag: 'wx' });
  const localPath = join(project.root, '.meteor.local.json');
  const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8')) : {};
  // Invalidate old readiness after a failed re-probe as well.
  local.execution = { backend: ready ? 'ssh' : 'unconfigured', profile_ref: ref };
  local.environment = ready ? {
    environment_ref: hardwareEnvironmentRef({ profile_ref: ref, profile_hash: profileHash, result, measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF }), hardware: result.selected_device.soc_version,
    toolchain: result.cann?.compiler ?? 'See measured compiler log in hardware report',
    measurement_protocol_ref: SSH_MEASUREMENT_PROTOCOL_REF, simulated: false,
    hardware_report_ref: reportRef, hardware_report_hash: hashObject(report), profile_hash: profileHash,
    device_id: result.selected_device.device_id, npu_arch: result.selected_device.npu_arch,
  } : { environment_ref: '', hardware: '', toolchain: '', measurement_protocol_ref: '', simulated: false,
    hardware_report_ref: reportRef, hardware_report_hash: hashObject(report), profile_hash: profileHash };
  writeJson(localPath, local);
  let caseSetup: any = null;
  if (ready) {
    try { caseSetup = await prepareDefaultCases(project, signal); }
    catch (error) { caseSetup = { error: String(error), action: 'Repair local Python/NumPy or pin a complete case suite, then re-probe.' }; }
  }
  const setupReady = ready && !caseSetup?.error;
  return { state: setupReady ? 'ready_ssh' : 'setup_required', hardware_ready: ready, hardware_report_ref: reportRef,
    hardware_report_path: markdownPath, profile_ref: ref, selected_device: result.selected_device ?? null,
    validation: result.validation ?? null, supported_metrics: result.supported_metrics ?? [],
    diagnostics: result.diagnostics ?? result.error ?? result.reason ?? null, case_setup: caseSetup,
    action: caseSetup?.error ? caseSetup.action : setupReady ? 'Read the hardware report, then start hypothesis research.' : 'Read hardware report logs, repair device/toolchain setup and probe again.' };
}
