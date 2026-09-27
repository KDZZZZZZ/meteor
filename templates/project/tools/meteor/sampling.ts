import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { InitialContext, KernelModule, KnowledgeScope, Project, TargetRef } from './contracts.ts';
import { hashObject, readJson, safeId, sha256, writeImmutable } from './util.ts';
import { type CommitEnvelope, type StoreMaterial, ensureStore, listDbMaterials, listJsonFiles, nowIso, resolveEvidenceRef, storePaths } from './store.ts';
import { assertTarget, isWorkspace, scopeKey, statePath, targetPath, targetRef } from './workspace.ts';
import { trustedLegacyCommit } from './legacy.ts';
import { computeSourceHash } from './kernel-build.ts';
import { knowledgeScopeMatches, normalizeKnowledgeScope, normalizeKnowledgeShape } from './knowledge-scope.ts';

export interface MaterialCandidate extends KnowledgeScope {
  knowledge_ref?: string;
  target?: TargetRef;
  material_key?: string;
  category?: StoreMaterial['category'];
  applicability?: StoreMaterial['applicability'];
  material_id: string;
  kind: string;
  ref: string;
  statement: string;
  scope: string;
  last_novelty_event_at: string;
  recent_selections: number;
  inflight: number;
  weight: number;
  submission_id: string;
}

export interface InitialMaterial extends KnowledgeScope {
  target?: TargetRef;
  material_key?: string;
  category?: StoreMaterial['category'];
  applicability?: StoreMaterial['applicability'];
  material_id: string;
  kind: string;
  ref: string;
  statement: string;
  scope: string;
  source_refs: string[];
  content_hash: string;
  revision?: string;
  source_hash?: string;
  submission_id?: string;
  submission_hash?: string;
  evidence_refs?: string[];
  scope_match?: boolean;
  usage?: 'scope_match' | 'inspiration_only';
  scope_validation?: 'author_declared';
}

export interface SamplingDraw {
  target?: TargetRef;
  sampling_draw_id: string;
  drawn_at: string;
  seed: number;
  algorithm: 'meteor-freshness-v1';
  backend: string;
  library_revision: string;
  sampling: Project['config']['sampling'];
  shape?: Record<string, number>;
  candidates: MaterialCandidate[];
  selected: Array<MaterialCandidate & InitialMaterial>;
}

export type InitialMaterialSelection = (SamplingDraw & { mode: 'random'; initial_context: InitialContext }) | {
  target?: TargetRef;
  mode: 'specified';
  initial_context: InitialContext;
  drawn_at: string;
  algorithm: 'meteor-specified-v1';
  backend: string;
  library_revision: string;
  selected: InitialMaterial[];
};

export function normalizeInitialContext(input?: unknown): InitialContext {
  if (input === undefined) return { mode: 'random' };
  const value = objectValue(input, 'initial_context');
  allowedKeys(value, ['mode', 'sampling', 'kernel_refs', 'knowledge_refs', 'shape'], 'initial_context');
  const shape = value.shape === undefined ? {} : { shape: normalizeKnowledgeShape(value.shape) };
  const mode = value.mode === undefined ? 'random' : value.mode;
  if (mode !== 'random' && mode !== 'specified') throw new Error('initial_context.mode must be random or specified');
  if (mode === 'random') {
    for (const key of ['kernel_refs', 'knowledge_refs']) {
      if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > 0))
        throw new Error(`random initial_context requires ${key} to be omitted or empty; use specified mode for actual material refs`);
    }
    if (value.sampling === undefined) return { mode, ...shape };
    return { mode, ...shape, sampling: normalizeSampling(value.sampling) };
  }
  // The explicit mode owns selection. Validate supplied options before ignoring
  // them so a filled-out tool call cannot replace the user's exact materials.
  if (value.sampling !== undefined) normalizeSampling(value.sampling);
  const normalized: InitialContext = { mode, ...shape };
  for (const key of ['kernel_refs', 'knowledge_refs'] as const) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some((ref: unknown) => typeof ref !== 'string' || !ref.trim())) throw new Error(`${key} must contain nonempty strings`);
    normalized[key] = [...new Set((value[key] as string[]).map(ref => ref.trim()))];
  }
  return normalized;
}

function normalizeSampling(input: unknown): NonNullable<InitialContext['sampling']> {
  const parameters = objectValue(input, 'initial_context.sampling');
  allowedKeys(parameters, ['count', 'seed', 'epsilon', 'lambda', 'tau_hours'], 'initial_context.sampling');
  const normalized: NonNullable<InitialContext['sampling']> = {};
  for (const [key, parameter] of Object.entries(parameters)) {
    if (parameter === undefined) continue;
    if (typeof parameter !== 'number' || !Number.isFinite(parameter)) throw new Error(`sampling.${key} must be finite`);
    if (key === 'count' && (!Number.isSafeInteger(parameter) || parameter < 0)) throw new Error('sampling.count must be a nonnegative safe integer');
    if (key === 'seed' && (!Number.isInteger(parameter) || parameter < 0 || parameter > 0xffffffff)) throw new Error('sampling.seed must be an unsigned 32-bit integer');
    if (key === 'epsilon' && (parameter < 0 || parameter > 1)) throw new Error('sampling.epsilon must be between 0 and 1');
    if (key === 'lambda' && parameter < 0) throw new Error('sampling.lambda must be nonnegative');
    if (key === 'tau_hours' && parameter <= 0) throw new Error('sampling.tau_hours must be positive');
    normalized[key as keyof typeof normalized] = parameter;
  }
  return normalized;
}

export function selectInitialMaterials(project: Project, input?: InitialContext): InitialMaterialSelection {
  const context = normalizeInitialContext(input);
  if (context.mode === 'random') return { ...sampleMaterials(project, { ...context.sampling, shape: context.shape }), mode: 'random', initial_context: context };
  ensureStore(project);
  const materials = listDbMaterials(project, { all_targets: true });
  const selected: InitialMaterial[] = [];
  for (const [refs, kind] of [[context.kernel_refs ?? [], 'kernel'], [context.knowledge_refs ?? [], 'knowledge']] as const) {
    for (const ref of refs) {
      const material = withMaterialUsage(project, resolveSpecifiedMaterial(project, materials, ref, kind), context.shape);
      if (!selected.some(prior => materialKey(prior) === materialKey(material) && prior.content_hash === material.content_hash)) selected.push(material);
    }
  }
  return {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    mode: 'specified', initial_context: context, drawn_at: nowIso(), algorithm: 'meteor-specified-v1',
    backend: project.config.execution.backend,
    library_revision: hashObject(selected.map(item => [materialKey(item), item.content_hash, item.submission_hash])), selected,
  };
}

export function sampleMaterials(project: Project, options: NonNullable<InitialContext['sampling']> & { now?: string; shape?: Record<string, number> } = {}): SamplingDraw {
  const { now: requestedNow, shape: requestedShape, ...overrides } = options;
  const shape = requestedShape === undefined ? undefined : normalizeKnowledgeShape(requestedShape);
  const validated = normalizeInitialContext({ mode: 'random', sampling: overrides }).sampling!;
  const { seed: requestedSeed, ...parameters } = validated;
  const sampling = { ...project.config.sampling, ...parameters };
  ensureStore(project);
  const drawsRoot = samplingDrawRoot(project);
  mkdirSync(drawsRoot, { recursive: true });
  const now = requestedNow ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) throw new Error('Sampling time must be a valid date');
  const seed = requestedSeed ?? seededNumber(`${scopeKey(project)}:${now}:${project.config.execution.backend}:${project.suite.revision}`);
  const candidates = loadCandidates(project, now, sampling, shape);
  const selected = draw(candidates, sampling.count, seed, sampling.epsilon).map(candidate => ({
    ...candidate, ...withMaterialUsage(project, resolveStoredMaterial(project, candidate), shape),
  }));
  const drawRecord: SamplingDraw = {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    sampling_draw_id: `draw_${hashObject({ now, seed, sampling, shape, candidates, selected }).slice(0, 24)}`,
    drawn_at: now,
    seed,
    algorithm: 'meteor-freshness-v1',
    backend: project.config.execution.backend,
    library_revision: hashObject(candidates.map(candidate => [materialKey(candidate), candidate.submission_id, candidate.last_novelty_event_at])),
    sampling,
    ...(shape ? { shape } : {}),
    candidates,
    selected,
  };
  writeImmutable(join(drawsRoot, `${drawRecord.sampling_draw_id}.json`), drawRecord);
  return drawRecord;
}

function resolveSpecifiedMaterial(project: Project, materials: StoreMaterial[], ref: string, category: 'kernel' | 'knowledge'): InitialMaterial {
  const sqlite = /^sqlite:\/\/([^/]+)\/(.+)$/.exec(ref);
  const id = sqlite ? decodeURIComponent(sqlite[2]) : ref;
  let matches = materials.filter(material => (material.material_id === id || materialKey(material) === id) && (!sqlite || material.kind === decodeURIComponent(sqlite[1])));
  if (matches.length) {
    const local = matches.filter(material => hashObject(material.target ?? null) === hashObject(targetRef(project) ?? null));
    if (local.length && !id.includes('#')) matches = local;
    if (new Set(matches.map(materialKey)).size > 1) throw new Error(`Initial material is ambiguous across targets; use its qualified sqlite ref or file path: ${ref}`);
    const selected = matches.find(material => (material.kind === 'kernel') === (category === 'kernel'));
    if (!selected) throw new Error(`Initial ${category} ref has the wrong material type: ${ref}`);
    return resolveStoredMaterial(project, selected);
  }
  if (ref.startsWith('sqlite://')) throw new Error(`Initial material not found: ${ref}`);
  let path = materialPath(project, ref);
  if (category === 'kernel' && statSync(path).isDirectory()) path = materialPath(project, join(path, 'kernel.json'));
  if (!statSync(path).isFile()) throw new Error(`Initial ${category} ref must resolve to a file: ${ref}`);
  if (category === 'kernel') {
    if (isKernelSourceFile(path)) return rawKernelSourceMaterial(path);
    const { module, sourceRefs } = kernelSources(project, path);
    return {
      ...(module.target ? { target: module.target } : {}),
      material_id: `${module.kernel_id}@${module.revision}`, kind: 'kernel', ref: path,
      statement: `${module.kernel_id}@${module.revision}`, scope: module.hardware_scope,
      source_refs: sourceRefs, revision: module.revision,
      content_hash: hashObject(sourceRefs.map(source => sha256(readFileSync(source)))),
    };
  }
  if (path.toLowerCase().endsWith('.json')) {
    const content = readJson<unknown>(path);
    if (content && typeof content === 'object' && 'kernel_id' in content && 'device_file' in content) {
      throw new Error(`Initial knowledge ref is a kernel module: ${ref}`);
    }
  }
  return {
    material_id: `file_${hashObject(path).slice(0, 24)}`, kind: 'document', ref: path,
    statement: basename(path), scope: 'Specified knowledge file', source_refs: [path], content_hash: sha256(readFileSync(path)),
  };
}

function isKernelSourceFile(path: string): boolean {
  return new Set(['.asc', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp']).has(extname(path).toLowerCase());
}

function rawKernelSourceMaterial(path: string): InitialMaterial {
  const content = readFileSync(path);
  return {
    material_id: `kernel_source_${hashObject(path).slice(0, 24)}`, kind: 'kernel_source', ref: path,
    statement: `Raw kernel source: ${basename(path)}`, scope: 'Specified read-only kernel source file',
    source_refs: [path], content_hash: sha256(content),
  };
}

function resolveStoredMaterial(project: Project, material: StoreMaterial): InitialMaterial {
  const originProject = materialProject(project, material.target);
  let commitPath = join(storePaths(originProject).commitRoot, safeId(material.submission_id) + '.json');
  const legacy = existsSync(commitPath) ? undefined : trustedLegacyCommit(originProject, material.submission_id);
  const evidenceProject = legacy?.project ?? originProject;
  if (legacy) commitPath = join(storePaths(evidenceProject).commitRoot, safeId(material.submission_id) + '.json');
  const envelope = legacy?.commit ?? readJson<CommitEnvelope>(materialPath(project, commitPath));
  assertTarget(evidenceProject, envelope.submission.target, 'Initial material submission');
  assertTarget(originProject, material.target, 'Initial material');
  if (envelope.submission_id !== material.submission_id || hashObject(envelope.submission) !== envelope.submission_hash) {
    throw new Error(`Initial material submission identity is invalid: ${material.material_id}`);
  }
  if (envelope.submission.execution_backend !== project.config.execution.backend) throw new Error(`Initial material backend differs from the current project: ${material.material_id}`);
  const common = {
    ...(material.target ? { target: material.target } : {}),
    material_key: materialKey(material), category: material.category ?? 'research', applicability: material.applicability ?? 'target',
    material_id: material.material_id, kind: material.kind, ref: materialRef(project, material),
    statement: material.statement, scope: material.scope,
    submission_id: envelope.submission_id, submission_hash: envelope.submission_hash,
    ...normalizeKnowledgeScope(material), scope_validation: 'author_declared' as const,
  };
  if (material.kind === 'kernel') {
    const kernel = envelope.submission.submitted_kernels.find(item => `${item.kernel_id}@${item.revision}` === material.material_id);
    if (!kernel) throw new Error(`Kernel is absent from its committed submission: ${material.material_id}`);
    const sourceRefs = [commitPath];
    let hasModule = false;
    for (const ref of kernel.artifact_refs) {
      const path = materialPath(evidenceProject, ref);
      sourceRefs.push(path);
      if (basename(path) === 'kernel.json') {
        const source = kernelSources(evidenceProject, path);
        if (source.module.kernel_id !== kernel.kernel_id || source.module.revision !== kernel.revision) throw new Error(`Kernel module identity differs from its committed submission: ${ref}`);
        if (computeSourceHash(evidenceProject, source.module) !== kernel.source_hash) throw new Error(`Initial kernel source has changed since its committed measurement: ${material.material_id}`);
        sourceRefs.push(...source.sourceRefs);
        hasModule = true;
      }
    }
    if (!hasModule) throw new Error(`Initial kernel has no readable module artifact: ${material.material_id}`);
    sourceRefs.push(...readableEvidence(evidenceProject, [kernel.full_size_test_ref, kernel.performance_data_ref], envelope));
    return {
      ...common, revision: kernel.revision, source_hash: kernel.source_hash, content_hash: hashObject(kernel),
      source_refs: [...new Set(sourceRefs)], evidence_refs: [kernel.full_size_test_ref, kernel.performance_data_ref],
    };
  }
  const claim = envelope.submission.knowledge_updates.find(item => item.claim_id === material.material_id && item.kind === material.kind);
  if (!claim) throw new Error(`Knowledge is absent from its committed submission: ${material.material_id}`);
  return {
    ...common, content_hash: hashObject(claim), evidence_refs: [...claim.evidence_refs],
    ...normalizeKnowledgeScope(claim),
    source_refs: [...new Set([commitPath, ...readableEvidence(evidenceProject, claim.evidence_refs, envelope),
      ...knowledgeDocumentRefs(originProject, material)])],
  };
}

function knowledgeDocumentRefs(project: Project, material: StoreMaterial & { knowledge_ref?: string }): string[] {
  if (!material.knowledge_ref) return [];
  const path = join(storePaths(project).knowledgeRoot, material.knowledge_ref);
  return existsSync(path) ? [path] : [];
}

function withMaterialUsage(project: Project, material: InitialMaterial, shape?: Record<string, number>): InitialMaterial {
  const matches = !!material.submission_id && knowledgeScopeMatches(material, targetRef(project), shape);
  return { ...material, scope_match: matches, usage: matches ? 'scope_match' : 'inspiration_only' };
}

function readableEvidence(project: Project, refs: string[], envelope: CommitEnvelope): string[] {
  const result: string[] = [];
  for (const ref of refs) {
    const experiment = envelope.submission.experiments.find(item => item.experiment_id === ref);
    for (const source of experiment ? [...experiment.full_size_test_refs, ...experiment.profile_refs] : [ref]) {
      // The immutable submission preserves every evidence link, including background
      // URIs. source_refs lists files the research agent can open directly.
      try {
        const path = materialPath(project, source);
        if (statSync(path).isFile()) result.push(path);
      } catch { /* Non-file or unavailable historical references remain in the submission. */ }
    }
  }
  return result;
}

function kernelSources(project: Project, path: string): { module: KernelModule; sourceRefs: string[] } {
  const module = readJson<KernelModule>(path);
  if (!module || typeof module !== 'object'
    || ['kernel_id', 'revision', 'operator_abi', 'symbol_prefix', 'launcher', 'device_file', 'host_file', 'hardware_scope'].some(key => typeof (module as any)[key] !== 'string' || !(module as any)[key].trim())
    || !Array.isArray(module.dependencies) || !Array.isArray(module.supported_case_ids)) {
    throw new Error(`Initial kernel ref must be a kernel module manifest: ${path}`);
  }
  const sourceRefs = [path];
  for (const ref of [module.device_file, module.host_file, ...module.dependencies.map(item => item.path)]) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error(`Kernel source ref is invalid: ${path}`);
    const projectPath = resolve(project.root, ref);
    const source = materialPath(project, existsSync(projectPath) ? projectPath : resolve(dirname(path), ref));
    if (!statSync(source).isFile()) throw new Error(`Kernel source ref must resolve to a file: ${ref}`);
    sourceRefs.push(source);
  }
  return { module, sourceRefs: [...new Set(sourceRefs)] };
}

function materialPath(project: Project, ref: string): string {
  const path = ref.startsWith('artifact://') ? resolveEvidenceRef(project, ref) : resolve(project.root, ref);
  if (!existsSync(path)) throw new Error(`Initial material file not found: ${ref}`);
  return path;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function allowedKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${path} field: ${key}`);
}

function loadCandidates(project: Project, now: string, sampling: Project['config']['sampling'], shape?: Record<string, number>): MaterialCandidate[] {
  const selections = countPreviousSelections(project, now, sampling.tau_hours);
  const inflight = countInflightSelections(project);
  const tauMs = sampling.tau_hours * 60 * 60 * 1000;
  return listDbMaterials(project, { all_targets: true })
    .filter(material => knowledgeScopeMatches(material, targetRef(project), shape)).map(material => {
    const last = material.last_novelty_event_at || new Date(0).toISOString();
    const freshness = Math.exp(-Math.max(0, Date.parse(now) - Date.parse(last)) / tauMs);
    const recent = selections.get(materialKey(material)) || 0;
    const inflightCount = inflight.get(materialKey(material)) || 0;
    return {
      ...(material.target ? { target: material.target } : {}),
      material_key: materialKey(material), category: material.category, applicability: material.applicability,
      knowledge_ref: (material as StoreMaterial & { knowledge_ref?: string }).knowledge_ref,
      ...normalizeKnowledgeScope(material),
      material_id: material.material_id,
      kind: material.kind,
      ref: materialRef(project, material),
      statement: material.statement,
      scope: material.scope,
      submission_id: material.submission_id,
      last_novelty_event_at: last,
      recent_selections: recent,
      inflight: inflightCount,
      weight: (1 + sampling.lambda * freshness) / (1 + recent + inflightCount),
    };
  }).sort((left, right) => materialKey(left).localeCompare(materialKey(right)));
}

function materialKey(material: { material_key?: string; material_id: string; kind: string; target?: TargetRef }): string {
  if (material.material_key) return material.material_key;
  const target = material.target;
  return (target ? `${target.workspace_id}/${target.op_id}/${target.dtype_id}#` : '') + `${material.kind}/${material.material_id}`;
}

function materialRef(project: Project, material: StoreMaterial): string {
  const local = hashObject(material.target ?? null) === hashObject(targetRef(project) ?? null);
  return `sqlite://${material.kind}/${local ? material.material_id : encodeURIComponent(materialKey(material))}`;
}

function materialProject(project: Project, target?: TargetRef): Project {
  if (!target) { assertTarget(project, target, 'Material origin'); return project; }
  if (target.workspace_id !== targetRef(project)?.workspace_id) throw new Error('Initial material belongs to a different hardware workspace');
  const registration = project.config.targets?.find(item => item.op_id === target.op_id && item.dtype_id === target.dtype_id);
  // Reading existing artifacts does not require an executable adapter registration.
  return { ...project, scope: target, target: registration, snapshotRoot: undefined };
}

function targetProjects(project: Project): Project[] {
  return isWorkspace(project) ? (project.config.targets ?? []).map(item => materialProject(project, {
    workspace_id: project.scope!.workspace_id, op_id: item.op_id, dtype_id: item.dtype_id,
  })) : [project];
}

function samplingDrawRoot(project: Project): string {
  return isWorkspace(project) ? statePath(project, 'sampling-draws') : join(storePaths(project).knowledgeRoot, 'sampling-draws');
}

function countPreviousSelections(project: Project, now: string, tauHours: number): Map<string, number> {
  const counts = new Map<string, number>();
  const since = Date.parse(now) - tauHours * 60 * 60 * 1000;
  for (const origin of targetProjects(project)) for (const file of listJsonFiles(samplingDrawRoot(origin))) {
    const drawRecord = readJson<SamplingDraw>(file);
    assertTarget(origin, drawRecord.target, 'Sampling draw');
    if (Date.parse(drawRecord.drawn_at) < since) continue;
    for (const item of drawRecord.selected || []) {
      const key = materialKey(item);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function countInflightSelections(project: Project): Map<string, number> {
  const counts = new Map<string, number>();
  for (const origin of targetProjects(project)) {
    const researchRoot = targetPath(origin, 'research');
    if (!existsSync(researchRoot)) continue;
    for (const entry of readdirSync(researchRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(researchRoot, entry.name, 'manifest.json');
      const seedPath = join(researchRoot, entry.name, 'seed.json');
      if (!existsSync(manifestPath) || !existsSync(seedPath)) continue;
      const manifest = readJson<any>(manifestPath);
      assertTarget(origin, manifest.target, 'Inflight research');
      if (!['CREATED', 'ACTIVE', 'PAUSED', 'OUTPUT_FROZEN', 'COMMIT_PENDING', 'REPORT_PENDING', 'UNKNOWN_REMOTE'].includes(manifest.run_status)) continue;
      const seed = readJson<any>(seedPath);
      for (const item of seed.selected || seed.materials || []) {
        if (item.material_id) { const key = materialKey(item); counts.set(key, (counts.get(key) || 0) + 1); }
      }
    }
  }
  return counts;
}

function draw(candidates: MaterialCandidate[], count: number, seed: number, configuredEpsilon: number): MaterialCandidate[] {
  const selected: MaterialCandidate[] = [];
  const remaining = [...candidates];
  let rng = mulberry32(seed);
  const epsilon = Math.max(0, Math.min(1, configuredEpsilon));
  while (selected.length < count && remaining.length) {
    const total = remaining.reduce((sum, item) => sum + item.weight, 0);
    let target = rng();
    let acc = 0;
    let index = 0;
    for (; index < remaining.length; index++) {
      const weighted = weightedProbability(remaining[index].weight, total, remaining.length, epsilon);
      acc += weighted;
      if (target <= acc) break;
    }
    selected.push(remaining.splice(Math.min(index, remaining.length - 1), 1)[0]);
    rng = mulberry32(Math.floor(rng() * 0xffffffff));
  }
  return selected;
}

function weightedProbability(weight: number, total: number, size: number, epsilon: number): number {
  return epsilon / size + (1 - epsilon) * weight / total;
}

function seededNumber(value: string): number {
  return Number.parseInt(hashObject(value).slice(0, 8), 16);
}

function mulberry32(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current += 0x6D2B79F5;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
