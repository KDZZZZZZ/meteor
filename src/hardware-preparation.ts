import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProject, loadWorkspace } from './project.ts';
import { assertHardwareReady } from '../templates/project/tools/meteor/hardware.ts';
import { loadExecutionModel, publishExecutionModel } from '../templates/project/tools/meteor/hardware-model.ts';
import { loadSshProfile } from '../templates/project/tools/meteor/profiles.ts';
import { assert, hashObject, inside, readJson, safeId, writeImmutable } from '../templates/project/tools/meteor/util.ts';

export interface HardwareExperimentInput {
  action: 'run' | 'poll' | 'collect' | 'cancel';
  experiment_id: string;
  question?: string;
  files?: Array<{ path: string; content: string }>;
  commands?: Array<{ argv: string[]; timeout_seconds: number }>;
}

export async function hardwareExperiment(root: string, input: HardwareExperimentInput, chiefId: string, signal?: AbortSignal) {
  const workspace = loadWorkspace(root), project = loadProject(root, workspace.targets?.[0]);
  const id = safeId(input.experiment_id), dir = inside(root, 'hardware/experiments/' + id), journalPath = join(dir, 'request.json');
  assert(['run', 'poll', 'collect', 'cancel'].includes(input.action), 'Unknown hardware experiment action');
  if (input.action === 'run') {
    assert(project.config.execution.backend === 'ssh' && project.config.environment.simulated === false,
      'Hardware diagnostics require a validated SSH device, never a mock or simulated project');
    assertHardwareReady(project);
    assert(!existsSync(journalPath), 'Hardware experiment already exists; poll/collect its original experiment_id. Never restart an unknown request.');
    assert(typeof input.question === 'string' && input.question.trim(), 'Specify the hardware question and intended observation');
    assert(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= 32, 'Provide 1 to 32 diagnostic source files');
    const paths = new Set<string>();
    for (const file of input.files) {
      assert(typeof file.path === 'string' && /^[A-Za-z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/')
        && file.path.split('/').every(x => x && x !== '.' && x !== '..') && !paths.has(file.path), 'Diagnostic paths must be unique relative file paths');
      paths.add(file.path); assert(typeof file.content === 'string', 'Diagnostic file content must be text');
    }
    assert(Buffer.byteLength(JSON.stringify(input.files)) <= 1_000_000, 'Diagnostic source limit is 1 MB');
    assert(Array.isArray(input.commands) && input.commands.length > 0 && input.commands.length <= 8, 'Provide 1 to 8 bounded diagnostic commands');
    for (const command of input.commands) {
      assert(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.every(x => typeof x === 'string' && x.length > 0), 'Command argv must be a nonempty string array');
      assert(Number.isInteger(command.timeout_seconds) && command.timeout_seconds >= 1 && command.timeout_seconds <= 900, 'Command timeout must be 1 to 900 seconds');
    }
    assert(input.commands.reduce((sum, c) => sum + c.timeout_seconds, 0) <= 1800, 'Diagnostic command budgets may total at most 1800 seconds');
    const hardware = readJson(inside(root, project.config.workspace!.hardware_ref));
    mkdirSync(dir, { recursive: true });
    const runtime = join(dir, 'runtime');
    cpSync(join(root, 'tools/meteor'), join(runtime, 'tools/meteor'), { recursive: true });
    const remoteId = 'hardware-experiment-' + hashObject({ workspace: project.scope!.workspace_id, hardware: hardware.hardware_id, id }).slice(0, 40);
    writeImmutable(journalPath, { schema_version: 1, experiment_id: id, chief_id: chiefId,
      hardware_id: hardware.hardware_id, environment_ref: project.config.environment.environment_ref,
      hardware_report_hash: project.config.environment.hardware_report_hash,
      profile_hash: hashObject(loadSshProfile(project.config.execution.profile_ref)), config: project.config,
      remote_request_id: remoteId, created_at: new Date().toISOString(), question: input.question,
      payload: { action: 'hardware_experiment', request_id: remoteId, question: input.question, files: input.files, commands: input.commands } });
  }
  assert(existsSync(journalPath), 'Unknown hardware experiment; do not guess a remote request ID');
  const journal = readJson(journalPath);
  assert(journal.chief_id === chiefId, 'Hardware experiment belongs to another Chief');
  assert(journal.profile_hash === hashObject(loadSshProfile(journal.config.execution.profile_ref)), 'Central SSH profile changed; original hardware request destination must be restored before collection');
  const resultPath = join(dir, 'result.json');
  if (existsSync(resultPath)) {
    const cached = readJson(resultPath);
    assert(cached.content_hash === hashObject(cached.value) && cached.value.request_hash === hashObject(journal)
      && cached.value.chief_id === chiefId, 'Hardware diagnostic cached receipt integrity mismatch');
    return { experiment_id: id, result_ref: `hardware/experiments/${id}/result.json`, ...cached.value.result };
  }
  project.config = journal.config; project.snapshotRoot = join(dir, 'runtime');
  // Hardware diagnostics have no operator oracle or target ABI. Only the frozen
  // generic driver bundle is needed, even when a target uses an external oracle.
  project.target = undefined;
  const base = join(project.snapshotRoot, 'tools/meteor/runners/ssh');
  const { remoteRequest } = await import(pathToFileURL(existsSync(base + '.ts') ? base + '.ts' : base + '.js').href);
  const request = input.action === 'run' ? journal.payload : { action: input.action, request_id: journal.remote_request_id };
  const response = await remoteRequest(project, request, signal);
  // collect wraps the original receipt; polling states are never final receipts.
  const raw = response.result ?? response;
  assert(raw.request_id === undefined || raw.request_id === journal.remote_request_id, 'Hardware diagnostic result request identity mismatch');
  assert(raw.simulated !== true, 'Hardware preparation rejects simulated receipts');
  const result = { ...raw, request_id: journal.remote_request_id };
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(result.status) && result.remote_release_confirmed === true;
  if (terminal) {
    assert(result.backend === 'ssh' && result.simulated === false, 'Hardware diagnostic terminal receipt backend mismatch');
    if (result.status === 'COMPLETED') assert(Array.isArray(result.commands) && result.commands.length === journal.payload.commands.length
      && result.commands.every((c: any, i: number) => c.returncode === 0 && hashObject(c.command) === hashObject(journal.payload.commands[i].argv)),
    'Hardware diagnostic completed receipt lacks matching command results');
    const value = { request_hash: hashObject(journal), chief_id: chiefId, result };
    writeImmutable(resultPath, { value, content_hash: hashObject(value) });
  }
  return { experiment_id: id, remote_request_id: journal.remote_request_id,
    ...(terminal ? { result_ref: `hardware/experiments/${id}/result.json` } : { next_action: 'Poll/collect this same experiment_id; release is not yet confirmed. Do not resubmit with a new ID.' }), ...result };
}

export function hardwareModel(root: string, input: { action: 'inspect' | 'publish'; path?: string }, chiefId: string) {
  const workspace = loadWorkspace(root), project = loadProject(root, workspace.targets?.[0]);
  if (input.action === 'inspect') return loadExecutionModel(project);
  assert(input.action === 'publish' && input.path, 'Publish requires a workspace-relative model JSON path');
  assertHardwareReady(project);
  return publishExecutionModel(project, readJson(inside(root, input.path)), chiefId);
}
