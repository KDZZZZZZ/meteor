import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Project } from './contracts.ts';
import { assertHardwareReady } from './hardware.ts';
import { assert, hashObject, inside, readJson, safeId, writeImmutable, writeJson } from './util.ts';

// This is a schema, not a hardware vocabulary. All resource and primitive IDs
// come from the Chief's evidence-backed preparation of the selected device.
export interface HardwareExecutionModel {
  schema_version: 1;
  model_id: string;
  hardware_id: string;
  environment_ref: string;
  sources: Array<{ id: string; kind: 'documentation' | 'experiment'; ref: string; description: string; url?: string; version?: string }>;
  resources: Array<{ id: string; description: string; evidence_refs: string[] }>;
  primitives: Array<{ id: string; description: string; resources: string[]; graph_required: boolean; evidence_refs: string[] }>;
  constraints: Array<{ statement: string; scope: string; status: 'documented' | 'measured' | 'hypothesis' | 'unknown'; evidence_refs: string[] }>;
  limitations: string[];
}

function words(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function canonicalHardwareEvidenceRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.includes('\\') || ref.includes(':')) return false;
  const parts = ref.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  return parts[0] === 'hardware' && ((parts[1] === 'sources' && parts.length > 2)
    || (parts[1] === 'experiments' && parts.length === 4 && /^[A-Za-z0-9_.-]+$/.test(parts[2]) && parts[3] === 'result.json')
    || (parts[1] === 'reports' && parts.length === 4
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[2])
      && parts[3] === 'report.json'));
}
function validateCurrentProbeEvidence(project: Project, sourceRef: string, content: string, reportHash: string): void {
  assert(/^hardware\/reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/report\.json$/.test(sourceRef),
    'Model probe experiment must be the current canonical hardware probe report');
  assert(sourceRef === project.config.environment.hardware_report_ref, 'Model probe experiment must be the current hardware report');
  const report = assertHardwareReady(project);
  assert(hashObject(report) === reportHash && hashObject(JSON.parse(content)) === reportHash,
    'Model probe experiment belongs to an older or modified hardware probe');
  assert(report.result?.remote_release_confirmed === true && report.result?.request_id === 'hardware-' + sourceRef.split('/')[2],
    'Model probe experiment has no released hardware request evidence');
}

export function validateExecutionModel(model: HardwareExecutionModel): void {
  assert(model?.schema_version === 1, 'Execution model schema_version must be 1');
  safeId(model.model_id);
  assert(nonempty(model.hardware_id) && nonempty(model.environment_ref), 'Execution model needs hardware and environment identity');
  assert(Array.isArray(model.sources) && model.sources.length > 0, 'Execution model needs sources');
  const ids = new Set<string>();
  for (const source of model.sources) {
    safeId(source.id); assert(!ids.has(source.id), 'Duplicate model source'); ids.add(source.id);
    assert(['documentation', 'experiment'].includes(source.kind) && nonempty(source.ref) && nonempty(source.description), 'Invalid model source');
    if (source.kind === 'documentation') assert(nonempty(source.version), 'Documentation must identify its device/toolchain version');
  }
  assert(model.sources.some(x => x.kind === 'documentation') && model.sources.some(x => x.kind === 'experiment'), 'Model requires both documentation and device preparation experiment evidence');
  const refs = (value: unknown, required = true) => assert(words(value) && (!required || value.length > 0) && value.every(id => ids.has(id)), 'Unknown or missing execution model evidence reference');
  const resources = new Set<string>();
  assert(Array.isArray(model.resources) && model.resources.length > 0, 'Model resources are required');
  for (const resource of model.resources) {
    safeId(resource.id); assert(!resources.has(resource.id) && nonempty(resource.description), 'Invalid or duplicate resource');
    resources.add(resource.id); refs(resource.evidence_refs);
  }
  const primitives = new Set<string>();
  assert(Array.isArray(model.primitives) && model.primitives.length > 0, 'Model primitives are required');
  for (const primitive of model.primitives) {
    safeId(primitive.id); assert(!primitives.has(primitive.id) && nonempty(primitive.description), 'Invalid or duplicate primitive'); primitives.add(primitive.id);
    assert(words(primitive.resources) && primitive.resources.length > 0 && primitive.resources.every(id => resources.has(id)), 'Primitive refers to an unknown resource');
    assert(typeof primitive.graph_required === 'boolean', 'Primitive must declare graph_required'); refs(primitive.evidence_refs);
  }
  assert(Array.isArray(model.constraints), 'Model constraints must be an array');
  for (const constraint of model.constraints) {
    assert(nonempty(constraint.statement) && nonempty(constraint.scope) && ['documented', 'measured', 'hypothesis', 'unknown'].includes(constraint.status), 'Constraint needs statement, scope and evidence status');
    refs(constraint.evidence_refs, constraint.status === 'documented' || constraint.status === 'measured');
    if (constraint.status === 'measured') assert(constraint.evidence_refs.some(id => model.sources.find(s => s.id === id)?.kind === 'experiment'), 'Measured constraint needs experiment evidence');
    if (constraint.status === 'documented') assert(constraint.evidence_refs.some(id => model.sources.find(s => s.id === id)?.kind === 'documentation'), 'Documented constraint needs documentation evidence');
  }
  assert(words(model.limitations) && model.limitations.length > 0, 'Record untested behavior and observation limits');
}

export function loadExecutionModel(project: Project, modelRef = project.config.design?.hardware_model_ref, expectedHash?: string) {
  assert(modelRef, 'Hardware execution model required: Chief must complete meteor-hardware-prepare and publish meteor_hardware_model before research/design');
  assert(/^hardware\/execution-models\/[A-Za-z0-9_.-]+\/[a-f0-9]{64}\.json$/.test(modelRef), 'Invalid execution model artifact path');
  const entry = readJson(inside(project.snapshotRoot ?? project.root, modelRef));
  assert(entry.content_hash === hashObject(entry.value) && (!expectedHash || entry.content_hash === expectedHash), 'Hardware execution model integrity mismatch');
  assert(modelRef === `hardware/execution-models/${safeId(entry.value.model.model_id)}/${entry.content_hash}.json`, 'Execution model must use its canonical path');
  const model = entry.value.model as HardwareExecutionModel;
  validateExecutionModel(model);
  assert(model.environment_ref === project.config.environment.environment_ref, 'Hardware execution model environment is stale');
  if (project.config.execution.backend !== 'mock') assert(entry.value.hardware_report_hash
    && entry.value.hardware_report_hash === project.config.environment.hardware_report_hash,
  'Hardware execution model probe is stale; repeat preparation after re-probing the device');
  const binding = readJson(inside(project.snapshotRoot ?? project.root, project.config.workspace!.hardware_ref));
  assert(binding.state === 'bound' && binding.hardware_id === model.hardware_id, 'Execution model belongs to another hardware');
  return { model, model_ref: modelRef, model_hash: entry.content_hash as string, evidence: entry.value.evidence };
}

export function materializeExecutionModelEvidence(snapshotRoot: string, loaded: ReturnType<typeof loadExecutionModel>): void {
  const sources = new Map(loaded.model.sources.map(source => [source.id, source]));
  assert(Array.isArray(loaded.evidence), 'Hardware execution model evidence must be an array');
  for (const evidence of loaded.evidence) {
    const source = sources.get(evidence?.source_id);
    assert(source, 'Frozen evidence refers to an unknown model source');
    assert(typeof evidence.content === 'string' && evidence.content.trim(), 'Frozen evidence content is missing');
    assert(evidence.content_hash === hashObject(evidence.content), 'Frozen evidence content hash mismatch');
    // Non-hardware documentation may be a valid model source. Keep it readable
    // through value.evidence[].content without writing outside the hardware tree.
    if (!canonicalHardwareEvidenceRef(source.ref)) continue;
    const path = inside(snapshotRoot, source.ref);
    if (existsSync(path)) {
      assert(readFileSync(path, 'utf8') === evidence.content, 'Frozen hardware evidence snapshot conflict: ' + source.ref);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, evidence.content, { flag: 'wx' });
  }
}

export function publishExecutionModel(project: Project, model: HardwareExecutionModel, chiefId: string) {
  validateExecutionModel(model);
  assert(project.config.execution.backend === 'ssh' && project.config.environment.simulated === false, 'Publish real execution models only for a validated SSH device');
  const reportHash = project.config.environment.hardware_report_hash;
  assert(nonempty(reportHash), 'Hardware execution model requires a current hardware probe');
  const binding = readJson(inside(project.root, project.config.workspace!.hardware_ref));
  assert(binding.state === 'bound' && binding.hardware_id === model.hardware_id && model.environment_ref === project.config.environment.environment_ref, 'Model hardware/environment differs from the probed device');
  let successfulExperiments = 0;
  const evidence = model.sources.map(source => {
    const path = inside(project.root, source.ref);
    assert(existsSync(path), 'Model source does not exist: ' + source.ref);
    const content = readFileSync(path, 'utf8');
    assert(content.trim() && Buffer.byteLength(content) <= 2_000_000, 'Model source must be nonempty and at most 2 MB');
    if (source.kind === 'documentation') assert(!/^hardware\/reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/report\.json$/.test(source.ref),
      'Hardware probe reports are experiment evidence, not documentation');
    if (source.kind === 'experiment') {
      if (source.ref === project.config.environment.hardware_report_ref || /^hardware\/reports\//.test(source.ref)) {
        validateCurrentProbeEvidence(project, source.ref, content, reportHash);
        return { source_id: source.id, content_hash: hashObject(content), content };
      }
      assert(/^hardware\/experiments\/[A-Za-z0-9_.-]+\/result\.json$/.test(source.ref), 'Model experiment must be a canonical hardware preparation receipt');
      const receipt = JSON.parse(content), request = readJson(inside(project.root, source.ref.replace(/result\.json$/, 'request.json')));
      assert(receipt.content_hash === hashObject(receipt.value), 'Hardware experiment receipt integrity mismatch');
      const value = receipt.value;
      assert(value.request_hash === hashObject(request) && value.chief_id === chiefId && request.chief_id === chiefId,
        'Hardware experiment author or request mismatch');
      assert(request.hardware_id === model.hardware_id && request.environment_ref === model.environment_ref, 'Model experiment belongs to another device/environment');
      assert(request.hardware_report_hash === reportHash, 'Model experiment belongs to an older hardware probe');
      const result = value.result;
      assert(['COMPLETED', 'FAILED', 'CANCELLED'].includes(result?.status) && result.backend === 'ssh'
        && result.simulated === false && result.remote_release_confirmed === true
        && result.request_id === request.remote_request_id, 'Model experiment has no complete, released command evidence');
      if (result.status === 'COMPLETED') {
        assert(Array.isArray(request.payload?.commands) && request.payload.commands.length > 0
          && Array.isArray(result.commands) && result.commands.length === request.payload.commands.length
          && result.commands.every((c: any, i: number) => c.returncode === 0 && hashObject(c.command) === hashObject(request.payload.commands[i].argv)),
        'Model experiment lacks matching successful command evidence');
        successfulExperiments++;
      }
    }
    // Freeze the source text, not only a mutable path or search result title.
    return { source_id: source.id, content_hash: hashObject(content), content };
  });
  assert(successfulExperiments > 0, 'Model requires at least one successful, released diagnostic; failed diagnostics only support their observed limitations');
  // A new probe invalidates the previous preparation even if some unobservable
  // runtime version fields leave the stable environment identity unchanged.
  const value = { model, evidence, chief_id: chiefId, hardware_report_hash: reportHash };
  const modelHash = hashObject(value), modelRef = `hardware/execution-models/${model.model_id}/${modelHash}.json`;
  writeImmutable(inside(project.root, modelRef), { value, content_hash: modelHash });
  const config = readJson(inside(project.root, 'meteor.config.json'));
  config.design = { ...config.design, hardware_model_ref: modelRef };
  writeJson(inside(project.root, 'meteor.config.json'), config);
  project.config.design = config.design;
  return { status: 'PUBLISHED', model_ref: modelRef, model_hash: modelHash, hardware_id: model.hardware_id,
    environment_ref: model.environment_ref, resources: model.resources.map(x => x.id), primitives: model.primitives.map(x => x.id),
    limits: 'Checks identity, structure and evidence provenance. The Chief remains responsible for whether each cited observation supports its claim. Unknown constraints remain unknown.' };
}
