import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildReceipt, Measurement, ProfileReceipt, Project, TestReceipt } from '../contracts.ts';
import { loadSshProfile } from '../profiles.ts';
import { assert, hashObject, inside, readJson, sha256, writeImmutable } from '../util.ts';
import type { BuildRequest, ProfileRequest, Runner, TestRequest } from './contract.ts';
import { selectCases, summarizeRows } from './contract.ts';
import { hasDeviceExecution } from '../device-evidence.ts';

const BOOTSTRAP = `import hashlib,json,subprocess,sys,base64,os,tempfile
from pathlib import Path
p=json.load(sys.stdin)
root=Path(p['remote_root']).resolve()
assert root.is_absolute() and str(root) not in ('/','/home','/mnt')
bundle=root/'drivers'/p['bundle_hash']
bundle.mkdir(parents=True,exist_ok=True)
for name,entry in p['files'].items():
 assert Path(name).name==name
 data=base64.b64decode(entry['base64']); assert hashlib.sha256(data).hexdigest()==entry['sha256']
 target=bundle/name
 if target.exists(): assert target.read_bytes()==data
 else:
  with tempfile.TemporaryDirectory(dir=bundle,prefix='.install-') as staging:
   staged=Path(staging)/name
   staged.write_bytes(data)
   # Publish a closed file atomically without replacing another installer's file.
   try: os.link(staged,target)
   except FileExistsError: assert target.read_bytes()==data
driver=p.get('driver_path') or str(bundle/'driver.py')
command=['bash','-c','source "$1" >/dev/null 2>&1 || exit; export LD_LIBRARY_PATH=/usr/local/Ascend/driver/lib64/common:/usr/local/Ascend/driver/lib64/driver:$LD_LIBRARY_PATH; exec python3 "$2"','meteor',p['env_script'],driver]
result=subprocess.run(command,input=json.dumps(p['request']),text=True)
sys.exit(result.returncode)
`;
function shellQuote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
function bundleFiles() {
  const root = fileURLToPath(new URL('./remote/', import.meta.url));
  return Object.fromEntries(readdirSync(root).filter(name => /^(CMakeLists\.txt|README\.md)$/.test(name) || /\.(py|asc|txt|cpp|h)$/.test(name)).map(name => {
    const data = readFileSync(join(root, name));
    return [name, { base64: data.toString('base64'), sha256: sha256(data) }];
  }));
}
function bundleHash() { return hashObject(bundleFiles()); }
function rawRef(project: Project, result: unknown) {
  const path = join(project.dataRoot, 'remote-receipts', hashObject(result) + '.json');
  writeImmutable(path, result);
  return relative(project.root, path).replaceAll('\\', '/');
}
function remoteIdempotency(prefix: string, key?: string) {
  return `${prefix}-${key ?? randomUUID()}`;
}
function normalizeRemoteStatus(status: string): 'COMPLETED' | 'FAILED' | 'UNKNOWN_REMOTE' {
  if (status === 'COMPLETED' || status === 'FINISHED') return 'COMPLETED';
  if (status === 'RUNNING' || status === 'UNKNOWN_REMOTE') return 'UNKNOWN_REMOTE';
  return 'FAILED';
}
function releaseConfirmed(result: any): boolean {
  return result?.remote_release_confirmed === true || result?.remote_released === true || result?.status === 'COMPLETED' || result?.status === 'FINISHED';
}
function trimDiagnostic(value: unknown, limit = 3500): string {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n[truncated ${text.length - limit} characters]`;
}
function failedBuildDiagnostic(result: any): string | undefined {
  if (result.error ?? result.reason) return result.error ?? result.reason;
  const log = Array.isArray(result.logs) ? result.logs.find((entry: any) => Number(entry?.returncode ?? 0) !== 0) : undefined;
  if (!log) return undefined;
  const command = Array.isArray(log.command) ? log.command.map((part: unknown) => String(part)).join(' ') : String(log.command ?? 'unknown');
  const output = String(log.stderr ?? '').trim() || String(log.stdout ?? '').trim();
  const parts = [`Remote build failed during command (exit ${log.returncode}): ${trimDiagnostic(command, 600)}`];
  if (output) parts.push(trimDiagnostic(output));
  return parts.join('\n');
}
function formatField(name: string, value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : `${name}=${String(value)}`;
}
function summarizeVerifyJson(report: any): string[] {
  const parts: string[] = [];
  if (typeof report?.error === 'string' && report.error.trim()) parts.push(`verify error: ${trimDiagnostic(report.error, 500)}`);
  for (const name of ['y', 'yScale']) {
    const section = report?.[name];
    if (!section || typeof section !== 'object') continue;
    const fields = [
      formatField('mismatches', section.mismatches),
      formatField('error_fraction', section.error_fraction),
      formatField('nonfinite_outputs', section.nonfinite_outputs),
      formatField('max_abs_error', section.max_abs_error),
      formatField('max_abs_error_finite', section.max_abs_error_finite),
      formatField('max_relative_error', section.max_relative_error),
      formatField('max_relative_error_finite', section.max_relative_error_finite),
    ].filter(Boolean);
    if (Array.isArray(section.first_mismatches) && section.first_mismatches.length > 0) {
      fields.push(`first_mismatch=${trimDiagnostic(JSON.stringify(section.first_mismatches[0]), 240)}`);
    }
    if (fields.length) parts.push(`${name}: ${fields.join(', ')}`);
  }
  return parts;
}
function rowFailureReason(remote: any): string | undefined {
  const base = remote.reason == null ? undefined : String(remote.reason);
  if (remote.status === 'PASS') return base;
  const details: string[] = [];
  const verify = remote.verify;
  const stdout = typeof verify?.stdout === 'string' ? verify.stdout.trim() : '';
  const stderr = typeof verify?.stderr === 'string' ? verify.stderr.trim() : '';
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      details.push(...summarizeVerifyJson(parsed));
      if (!details.length) details.push(`verify output: ${trimDiagnostic(stdout, 900)}`);
    } catch {
      details.push(`verify output: ${trimDiagnostic(stdout, 900)}`);
    }
  }
  if (!details.length && stderr) details.push(`verify stderr: ${trimDiagnostic(stderr, 900)}`);
  const run = remote.run;
  if (!details.length && run) {
    const runError = String(run.stderr ?? '').trim() || String(run.stdout ?? '').trim();
    const code = run.returncode === undefined ? 'unknown' : String(run.returncode);
    details.push(`run returncode=${code}${runError ? `: ${trimDiagnostic(runError, 900)}` : ''}`);
  }
  if (!details.length) return base;
  return trimDiagnostic([base, ...details].filter(Boolean).join('; '), 1200);
}
export async function remoteRequest(project: Project, request: any, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  const profile = loadSshProfile(project.config.execution.profile_ref);
  assert(profile.env_script, 'SSH profile requires env_script before execution');
  const environment = project.config.environment;
  const deviceId = request.action === 'hardware' ? profile.device_id : environment.device_id ?? profile.device_id;
  const npuArch = request.action === 'hardware' ? profile.npu_arch : environment.npu_arch ?? profile.npu_arch;
  const files = bundleFiles();
  const body = { remote_root: profile.remote_root, env_script: profile.env_script, driver_path: profile.driver_path,
    bundle_hash: hashObject(files), files, request: { ...request, remote_root: profile.remote_root,
      env_script: profile.env_script, ...(deviceId === undefined ? {} : { device_id: Number(deviceId) }),
      ...(npuArch === undefined ? {} : { npu_arch: npuArch }) } };
  const args = ['-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${profile.connect_timeout_seconds ?? 15}`, profile.ssh_alias,
    'python3 -c ' + shellQuote(BOOTSTRAP)];
  return await new Promise(resolveResult => {
    let output = '', error = '', started = false;
    const sshBin = process.env.METEOR_SSH_BIN ?? 'ssh';
    const child = spawn(sshBin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: process.env.METEOR_SSH_BIN !== undefined });
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('spawn', () => { started = true; });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 8_000_000) child.kill(); });
    child.stderr.on('data', data => { error = (error + data.toString()).slice(-12000); });
    child.on('error', err => { error = err.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
    child.on('close', code => {
      signal?.removeEventListener('abort', cancel);
      const lines = output.trim().split('\n');
      const raw = lines.at(-1) ?? '';
      let envelope: any;
      try {
        envelope = JSON.parse(raw);
      } catch {
        resolveResult({ status: started ? 'UNKNOWN_REMOTE' : 'FAILED', request_id: request.request_id,
          error: `SSH transport ended (exit ${code}); query the same remote request before retrying. ` + error.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]'),
          remote_release_confirmed: false });
        return;
      }
      try {
        assert(envelope.request_id === undefined || envelope.request_id === request.request_id, 'Remote request identity mismatch');
        const result = envelope.ok === true ? { ...envelope.result, request_id: request.request_id } : { status: 'FAILED', error: envelope.error, request_id: request.request_id };
        assert(result && typeof result.status === 'string', 'Remote response has no status');
        if (result.request_id === undefined) result.request_id = envelope.request_id ?? request.request_id;
        assert(result.simulated !== true, 'SSH transport rejects simulated remote receipts');
        if (result.status === 'COMPLETED') {
          assert(result.backend === 'ssh', 'Remote receipt backend mismatch');
          assert(result.simulated === false, 'Remote receipt must be real for SSH');
        }
        resolveResult(result);
      } catch (validationError) {
        resolveResult({ status: 'FAILED', request_id: request.request_id, error: (validationError as Error).message, remote_release_confirmed: false });
      }
    });
  });
}
function casesPayload(project: Project, selected: ReturnType<typeof selectCases>, supported: string[]) {
  const verifier = readFileSync(fileURLToPath(new URL('./remote/verify_case.py', import.meta.url)));
  return selected.map(c => {
    if (!supported.includes(c.case_id)) return { ...c, files: {} };
    assert(c.data_ref, 'Real cases require data_ref with pinned input/golden files');
    const root = inside(project.root, c.data_ref);
    const metadata = readJson(join(root, 'case.json'));
    assert(metadata.m === c.shape.m && metadata.n === c.shape.n && metadata.k === c.shape.k, 'Case metadata shape mismatch');
    const inputs: Record<string,string> = {}, golden: Record<string,string> = {};
    const files: Record<string, { base64: string; sha256: string }> = {};
    for (const name of Object.keys(metadata.files)) {
      assert(/^(input\/(x1|x2|x1Scale|x2Scale)|golden\/(y|yScale))\.bin$/.test(name), 'Unexpected case file');
      const bytes = readFileSync(inside(root, name)); const hash = sha256(bytes);
      assert(hash === metadata.files[name].sha256, 'Case file hash mismatch');
      (name.startsWith('input/') ? inputs : golden)[name] = hash;
      files[name] = { base64: bytes.toString('base64'), sha256: hash };
    }
    assert(hashObject(inputs) === c.input_hash, 'Pinned input_hash mismatch');
    assert(hashObject({ verifier_sha256: sha256(verifier), golden }) === c.oracle_hash, 'Pinned oracle_hash mismatch');
    const meta = readFileSync(join(root, 'case.json'));
    files['case.json'] = { base64: meta.toString('base64'), sha256: sha256(meta) };
    return { ...c, files };
  });
}
function common(project: Project) { return { case_suite_revision: project.suite.revision, environment_ref: project.config.environment.environment_ref,
  measurement_protocol_ref: project.config.environment.measurement_protocol_ref, warmup: 3, repetitions: 5 }; }

export class SshRunner implements Runner {
  async build(request: BuildRequest): Promise<BuildReceipt> {
    assert(request.fixture === undefined, 'Mock fixtures cannot be used with SSH');
    const remoteId = hashObject({ source: request.rendered_source_hash, env: request.project.config.environment, module: request.module, bundle: bundleHash() });
    let result: any;
    try {
      assert(request.rendered_source && sha256(request.rendered_source) === request.rendered_source_hash, 'Rendered source identity missing');
      result = await remoteRequest(request.project, { ...common(request.project), action: 'build', request_id: remoteIdempotency('build', request.idempotency_key), build_id: remoteId,
        source_base64: Buffer.from(request.rendered_source).toString('base64'), rendered_source_hash: request.rendered_source_hash }, request.signal);
    } catch (error) { result = { status: 'FAILED', error: (error as Error).message }; }
    const ref = rawRef(request.project, result);
    const status = normalizeRemoteStatus(result.status);
    assert(status !== 'COMPLETED' || result.remote_build_id === remoteId, 'Remote build id mismatch');
    assert(status !== 'COMPLETED' || result.rendered_source_hash === request.rendered_source_hash, 'Remote rendered source hash mismatch');
    assert(status !== 'COMPLETED' || /^[a-f0-9]{64}$/.test(result.artifact_hash), 'Remote build omitted actual ELF hash');
    return { build_id: hashObject({ research: request.research_id, experiment: request.experiment_id, remoteId, ref }).slice(0,24),
      research_id: request.research_id, experiment_id: request.experiment_id, kernel_ref: { kernel_id: request.module.kernel_id, revision: request.module.revision },
      source_hash: request.source_hash, artifact_hash: result.artifact_hash ?? '', environment_ref: request.project.config.environment.environment_ref,
      execution_backend: 'ssh', simulated: false, status, source_ref: request.kernel_path, module_ref: request.kernel_path + '/kernel.json',
      rendered_source_hash: request.rendered_source_hash, remote_build_id: remoteId, remote_request_id: result.request_id,
      raw_receipt_ref: ref, remote_release_confirmed: releaseConfirmed(result), error: status === 'COMPLETED' ? undefined : failedBuildDiagnostic(result) };
  }
  async test(request: TestRequest): Promise<TestReceipt> {
    assert(request.fixture === undefined, 'Mock fixtures cannot be used with SSH');
    const selected = selectCases(request.project, request.mode, request.case_ids);
    let result: any;
    if (request.build.status !== 'COMPLETED') result = { status: request.build.status, rows: [], error: 'Build is not completed; no test was issued' };
    else {
      const payload = { ...common(request.project), action: 'test', build_id: request.build.remote_build_id,
        artifact_hash: request.build.artifact_hash, rendered_source_hash: request.build.rendered_source_hash,
        kernel_name: request.module.symbol_prefix,
        cases: casesPayload(request.project, selected, request.module.supported_case_ids), supported_case_ids: request.module.supported_case_ids };
      result = await remoteRequest(request.project, { ...payload, request_id: remoteIdempotency('test', request.idempotency_key) }, request.signal);
    }
    if (result.status === 'COMPLETED') {
      assert(result.artifact_hash === request.build.artifact_hash, 'Remote test artifact hash mismatch');
      assert(result.rendered_source_hash === request.build.rendered_source_hash, 'Remote test rendered source hash mismatch');
    }
    const rows: Measurement[] = selected.map(c => {
      const remote = (result.rows ?? []).find((row: any) => row.case_id === c.case_id);
      if (!remote) return { case_id: c.case_id, status: 'NOT_RUN', samples_us: [], reason: result.error ?? 'No confirmed remote result',
        actual_kernel_ref: request.build.kernel_ref, source_hash: request.build.source_hash, input_hash: c.input_hash, oracle_hash: c.oracle_hash };
      assert(['PASS','INCORRECT','UNSUPPORTED','RESOURCE_REJECTED','RUN_FAILED','TIMEOUT','NOT_RUN'].includes(remote.status), 'Invalid remote case status');
      if (remote.status === 'PASS') {
        assert(request.module.supported_case_ids.includes(c.case_id) && Array.isArray(remote.samples_us) && remote.samples_us.length === 5 && remote.samples_us.every((x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0), 'Invalid real timing samples');
        assert(remote.input_hash === c.input_hash, 'Remote PASS input hash mismatch');
        assert(remote.oracle_hash === c.oracle_hash, 'Remote PASS oracle hash mismatch');
        assert(hasDeviceExecution(remote.device_execution, request.project.config.environment.device_id, request.module.symbol_prefix),
          'Remote PASS requires matching candidate device execution evidence; ACL event timing alone is insufficient');
      } else {
        assert(remote.input_hash === undefined || remote.input_hash === c.input_hash, 'Remote input hash mismatch');
        assert(remote.oracle_hash === undefined || remote.oracle_hash === c.oracle_hash, 'Remote oracle hash mismatch');
      }
      const samples = remote.status === 'PASS' ? remote.samples_us : [];
      return { case_id: c.case_id, status: remote.status, samples_us: samples,
        median_us: samples.length ? [...samples].sort((a:number,b:number)=>a-b)[Math.floor(samples.length/2)] : undefined, reason: rowFailureReason(remote),
        actual_kernel_ref: request.build.kernel_ref, source_hash: request.build.source_hash, input_hash: c.input_hash, oracle_hash: c.oracle_hash,
        device_execution: remote.device_execution };
    });
    const raw = rawRef(request.project, result);
    return { run_id: hashObject({ build: request.build.build_id, mode: request.mode, raw }).slice(0,24),
      research_id: request.build.research_id, experiment_id: request.build.experiment_id, kernel_ref: request.build.kernel_ref,
      build_ref: `reports/meteor/ssh/research/${request.build.research_id}/experiments/${request.build.experiment_id}/builds/${request.build.build_id}.json`,
      source_hash: request.build.source_hash, artifact_hash: request.build.artifact_hash, execution_backend: 'ssh', simulated: false,
      ...common(request.project), mode: request.mode, status: normalizeRemoteStatus(result.status),
      rows, ...summarizeRows(rows, request.mode, request.project), data_hash: hashObject(rows),
      remote_request_id: result.request_id, raw_receipt_ref: raw, remote_release_confirmed: releaseConfirmed(result) } as TestReceipt;
  }
  async profile(request: ProfileRequest): Promise<ProfileReceipt> {
    assert(request.fixture === undefined && request.build.status === 'COMPLETED', 'Profile requires a real completed build');
    const payload = { ...common(request.project), action: 'profile', build_id: request.build.remote_build_id, artifact_hash: request.build.artifact_hash,
      rendered_source_hash: request.build.rendered_source_hash,
      cases: casesPayload(request.project, selectCases(request.project, 'probe', request.case_ids), request.module.supported_case_ids),
      supported_case_ids: request.module.supported_case_ids, kernel_name: request.module.symbol_prefix, metrics: request.metrics };
    const result = await remoteRequest(request.project, { ...payload, request_id: remoteIdempotency('profile', request.idempotency_key) }, request.signal);
    const raw = rawRef(request.project, result);
    if (result.status === 'COMPLETED') {
      assert(result.artifact_hash === request.build.artifact_hash, 'Remote profile artifact hash mismatch');
      assert(result.rendered_source_hash === request.build.rendered_source_hash, 'Remote profile rendered source hash mismatch');
    }
    assert(result.status === 'COMPLETED' && Array.isArray(result.observations) && result.observations.length > 0, result.error ?? result.reason ?? 'No supported hardware observations; raw receipt: ' + raw);
    for (const row of result.raw_profiles ?? []) {
      const expected = request.project.suite.cases.find(c => c.case_id === row.case_id);
      if (expected) {
        if (row.status === 'PASS') {
          assert(hasDeviceExecution(row.device_execution, request.project.config.environment.device_id, request.module.symbol_prefix), 'Remote profile PASS requires candidate device execution evidence');
          assert(row.input_hash === expected.input_hash, 'Remote profile PASS input hash mismatch');
          assert(row.oracle_hash === expected.oracle_hash, 'Remote profile PASS oracle hash mismatch');
        } else {
          assert(row.input_hash === undefined || row.input_hash === expected.input_hash, 'Remote profile input hash mismatch');
          assert(row.oracle_hash === undefined || row.oracle_hash === expected.oracle_hash, 'Remote profile oracle hash mismatch');
        }
      }
    }
    return { profile_id: hashObject({ build: request.build.build_id, raw }).slice(0,24), research_id: request.build.research_id,
      experiment_id: request.build.experiment_id, kernel_ref: request.build.kernel_ref, source_hash: request.build.source_hash,
      environment_ref: request.project.config.environment.environment_ref, execution_backend: 'ssh', simulated: false,
      instrumented: result.instrumented === true, measurement_kind: result.measurement_kind ?? 'acl_event_interval',
      supported_metrics: result.supported_metrics ?? ['kernel_time_us'], observations: result.observations, remote_request_id: result.request_id,
      raw_profiles: (result.raw_profiles ?? []).map((row: any) => ({ case_id: row.case_id, status: row.status,
        device_execution: row.device_execution, input_hash: row.input_hash, oracle_hash: row.oracle_hash })),
      raw_receipt_ref: raw, remote_release_confirmed: releaseConfirmed(result) } as ProfileReceipt;
  }
  async pollRemote(project: Project, remoteRequestId: string) {
    const result = await remoteRequest(project, { action: 'poll', request_id: remoteRequestId });
    const raw = rawRef(project, result);
    return { status: normalizeRemoteStatus(result.status), receipt: result.result ?? result, raw_receipt_ref: raw, remote_release_confirmed: releaseConfirmed(result), reason: result.error ?? result.reason };
  }
  async collectRemote(project: Project, remoteRequestId: string) {
    const result = await remoteRequest(project, { action: 'collect', request_id: remoteRequestId });
    const raw = rawRef(project, result);
    return { status: normalizeRemoteStatus(result.status), receipt: result.result ?? result, raw_receipt_ref: raw, remote_release_confirmed: releaseConfirmed(result), reason: result.error ?? result.reason };
  }
  async cancelRemote(project: Project, remoteRequestId: string) {
    const result = await remoteRequest(project, { action: 'cancel', request_id: remoteRequestId });
    const raw = rawRef(project, result);
    return { status: result.status === 'NOT_FOUND' ? 'NOT_FOUND' as const : result.status === 'UNKNOWN_REMOTE' ? 'UNKNOWN_REMOTE' as const : 'CANCEL_REQUESTED' as const,
      receipt: result, raw_receipt_ref: raw, remote_release_confirmed: releaseConfirmed(result), reason: result.error ?? result.reason };
  }
}
