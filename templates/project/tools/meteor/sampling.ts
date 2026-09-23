import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { InitialContext, KernelModule, Project } from './contracts.ts';
import { hashObject, readJson, safeId, sha256, writeImmutable } from './util.ts';
import { type CommitEnvelope, type StoreMaterial, ensureStore, listDbMaterials, listJsonFiles, nowIso, resolveEvidenceRef, storePaths } from './store.ts';

export interface MaterialCandidate {
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

export interface InitialMaterial {
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
}

export interface SamplingDraw {
  sampling_draw_id: string;
  drawn_at: string;
  seed: number;
  algorithm: 'meteor-freshness-v1';
  backend: string;
  library_revision: string;
  sampling: Project['config']['sampling'];
  candidates: MaterialCandidate[];
  selected: Array<MaterialCandidate & InitialMaterial>;
}

export type InitialMaterialSelection = (SamplingDraw & { mode: 'random'; initial_context: InitialContext }) | {
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
  allowedKeys(value, ['mode', 'sampling', 'kernel_refs', 'knowledge_refs'], 'initial_context');
  const mode = value.mode === undefined ? 'random' : value.mode;
  if (mode !== 'random' && mode !== 'specified') throw new Error('initial_context.mode must be random or specified');
  if (mode === 'random') {
    if (value.kernel_refs !== undefined || value.knowledge_refs !== undefined) throw new Error('random initial_context cannot also specify material refs');
    if (value.sampling === undefined) return { mode };
    const parameters = objectValue(value.sampling, 'initial_context.sampling');
    allowedKeys(parameters, ['count', 'seed', 'epsilon', 'lambda', 'tau_hours'], 'initial_context.sampling');
    const normalizedParameters: NonNullable<InitialContext['sampling']> = {};
    for (const [key, parameter] of Object.entries(parameters)) {
      if (parameter === undefined) continue;
      if (typeof parameter !== 'number' || !Number.isFinite(parameter)) throw new Error(`sampling.${key} must be finite`);
      if (key === 'count' && (!Number.isSafeInteger(parameter) || parameter < 0)) throw new Error('sampling.count must be a nonnegative safe integer');
      if (key === 'seed' && (!Number.isInteger(parameter) || parameter < 0 || parameter > 0xffffffff)) throw new Error('sampling.seed must be an unsigned 32-bit integer');
      if (key === 'epsilon' && (parameter < 0 || parameter > 1)) throw new Error('sampling.epsilon must be between 0 and 1');
      if (key === 'lambda' && parameter < 0) throw new Error('sampling.lambda must be nonnegative');
      if (key === 'tau_hours' && parameter <= 0) throw new Error('sampling.tau_hours must be positive');
      normalizedParameters[key as keyof typeof normalizedParameters] = parameter;
    }
    return { mode, sampling: normalizedParameters };
  }
  if (value.sampling !== undefined) throw new Error('specified initial_context cannot include sampling parameters');
  const normalized: InitialContext = { mode };
  for (const key of ['kernel_refs', 'knowledge_refs'] as const) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some((ref: unknown) => typeof ref !== 'string' || !ref.trim())) throw new Error(`${key} must contain nonempty strings`);
    normalized[key] = [...new Set((value[key] as string[]).map(ref => ref.trim()))];
  }
  return normalized;
}

export function selectInitialMaterials(project: Project, input?: InitialContext): InitialMaterialSelection {
  const context = normalizeInitialContext(input);
  if (context.mode === 'random') return { ...sampleMaterials(project, context.sampling), mode: 'random', initial_context: context };
  ensureStore(project);
  const materials = listDbMaterials(project);
  const selected: InitialMaterial[] = [];
  for (const [refs, kind] of [[context.kernel_refs ?? [], 'kernel'], [context.knowledge_refs ?? [], 'knowledge']] as const) {
    for (const ref of refs) {
      const material = resolveSpecifiedMaterial(project, materials, ref, kind);
      if (!selected.some(prior => prior.kind === material.kind && prior.material_id === material.material_id && prior.content_hash === material.content_hash)) selected.push(material);
    }
  }
  return {
    mode: 'specified', initial_context: context, drawn_at: nowIso(), algorithm: 'meteor-specified-v1',
    backend: project.config.execution.backend,
    library_revision: hashObject(selected.map(item => [item.material_id, item.content_hash, item.submission_hash])), selected,
  };
}

export function sampleMaterials(project: Project, options: NonNullable<InitialContext['sampling']> & { now?: string } = {}): SamplingDraw {
  const { now: requestedNow, ...overrides } = options;
  const validated = normalizeInitialContext({ mode: 'random', sampling: overrides }).sampling!;
  const { seed: requestedSeed, ...parameters } = validated;
  const sampling = { ...project.config.sampling, ...parameters };
  ensureStore(project);
  const paths = storePaths(project);
  mkdirSync(join(paths.knowledgeRoot, 'sampling-draws'), { recursive: true });
  const now = requestedNow ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) throw new Error('Sampling time must be a valid date');
  const seed = requestedSeed ?? seededNumber(`${now}:${project.config.execution.backend}:${project.suite.revision}`);
  const candidates = loadCandidates(project, now, sampling);
  const selected = draw(candidates, sampling.count, seed, sampling.epsilon).map(candidate => ({
    ...candidate, ...resolveStoredMaterial(project, candidate),
  }));
  const drawRecord: SamplingDraw = {
    sampling_draw_id: `draw_${hashObject({ now, seed, sampling, candidates, selected }).slice(0, 24)}`,
    drawn_at: now,
    seed,
    algorithm: 'meteor-freshness-v1',
    backend: project.config.execution.backend,
    library_revision: hashObject(candidates.map(candidate => [candidate.material_id, candidate.kind, candidate.submission_id, candidate.last_novelty_event_at])),
    sampling,
    candidates,
    selected,
  };
  writeImmutable(join(paths.knowledgeRoot, 'sampling-draws', `${drawRecord.sampling_draw_id}.json`), drawRecord);
  return drawRecord;
}

function resolveSpecifiedMaterial(project: Project, materials: StoreMaterial[], ref: string, category: 'kernel' | 'knowledge'): InitialMaterial {
  const sqlite = /^sqlite:\/\/([^/]+)\/(.+)$/.exec(ref);
  const id = sqlite ? decodeURIComponent(sqlite[2]) : ref;
  const matches = materials.filter(material => material.material_id === id && (!sqlite || material.kind === decodeURIComponent(sqlite[1])));
  if (matches.length) {
    const selected = matches.find(material => (material.kind === 'kernel') === (category === 'kernel'));
    if (!selected) throw new Error(`Initial ${category} ref has the wrong material type: ${ref}`);
    return resolveStoredMaterial(project, selected);
  }
  if (ref.startsWith('sqlite://')) throw new Error(`Initial material not found: ${ref}`);
  let path = materialPath(project, ref);
  if (category === 'kernel' && statSync(path).isDirectory()) path = materialPath(project, join(path, 'kernel.json'));
  if (!statSync(path).isFile()) throw new Error(`Initial ${category} ref must resolve to a file: ${ref}`);
  if (category === 'kernel') {
    const { module, sourceRefs } = kernelSources(project, path);
    return {
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

function resolveStoredMaterial(project: Project, material: StoreMaterial): InitialMaterial {
  const commitPath = join(storePaths(project).commitRoot, safeId(material.submission_id) + '.json');
  const envelope = readJson<CommitEnvelope>(materialPath(project, commitPath));
  if (envelope.submission_id !== material.submission_id || hashObject(envelope.submission) !== envelope.submission_hash) {
    throw new Error(`Initial material submission identity is invalid: ${material.material_id}`);
  }
  if (envelope.submission.execution_backend !== project.config.execution.backend) throw new Error(`Initial material backend differs from the current project: ${material.material_id}`);
  const common = {
    material_id: material.material_id, kind: material.kind, ref: `sqlite://${material.kind}/${material.material_id}`,
    statement: material.statement, scope: material.scope,
    submission_id: envelope.submission_id, submission_hash: envelope.submission_hash,
  };
  if (material.kind === 'kernel') {
    const kernel = envelope.submission.submitted_kernels.find(item => `${item.kernel_id}@${item.revision}` === material.material_id);
    if (!kernel) throw new Error(`Kernel is absent from its committed submission: ${material.material_id}`);
    const sourceRefs = [commitPath];
    let hasModule = false;
    for (const ref of kernel.artifact_refs) {
      const path = materialPath(project, ref);
      sourceRefs.push(path);
      if (basename(path) === 'kernel.json') {
        const source = kernelSources(project, path);
        if (source.module.kernel_id !== kernel.kernel_id || source.module.revision !== kernel.revision) throw new Error(`Kernel module identity differs from its committed submission: ${ref}`);
        sourceRefs.push(...source.sourceRefs);
        hasModule = true;
      }
    }
    if (!hasModule) throw new Error(`Initial kernel has no readable module artifact: ${material.material_id}`);
    sourceRefs.push(...readableEvidence(project, [kernel.full_size_test_ref, kernel.performance_data_ref], envelope));
    return {
      ...common, revision: kernel.revision, source_hash: kernel.source_hash, content_hash: hashObject(kernel),
      source_refs: [...new Set(sourceRefs)], evidence_refs: [kernel.full_size_test_ref, kernel.performance_data_ref],
    };
  }
  const claim = envelope.submission.knowledge_updates.find(item => item.claim_id === material.material_id && item.kind === material.kind);
  if (!claim) throw new Error(`Knowledge is absent from its committed submission: ${material.material_id}`);
  return {
    ...common, content_hash: hashObject(claim), evidence_refs: [...claim.evidence_refs],
    source_refs: [...new Set([commitPath, ...readableEvidence(project, claim.evidence_refs, envelope)])],
  };
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

function loadCandidates(project: Project, now: string, sampling: Project['config']['sampling']): MaterialCandidate[] {
  const selections = countPreviousSelections(project, now, sampling.tau_hours);
  const inflight = countInflightSelections(project);
  const tauMs = sampling.tau_hours * 60 * 60 * 1000;
  return listDbMaterials(project).map(material => {
    const last = material.last_novelty_event_at || new Date(0).toISOString();
    const freshness = Math.exp(-Math.max(0, Date.parse(now) - Date.parse(last)) / tauMs);
    const recent = selections.get(material.material_id) || 0;
    const inflightCount = inflight.get(material.material_id) || 0;
    return {
      material_id: material.material_id,
      kind: material.kind,
      ref: `sqlite://${material.kind}/${material.material_id}`,
      statement: material.statement,
      scope: material.scope,
      submission_id: material.submission_id,
      last_novelty_event_at: last,
      recent_selections: recent,
      inflight: inflightCount,
      weight: (1 + sampling.lambda * freshness) / (1 + recent + inflightCount),
    };
  }).sort((left, right) => left.material_id.localeCompare(right.material_id));
}

function countPreviousSelections(project: Project, now: string, tauHours: number): Map<string, number> {
  const counts = new Map<string, number>();
  const since = Date.parse(now) - tauHours * 60 * 60 * 1000;
  for (const file of listJsonFiles(join(storePaths(project).knowledgeRoot, 'sampling-draws'))) {
    const drawRecord = readJson<SamplingDraw>(file);
    if (Date.parse(drawRecord.drawn_at) < since) continue;
    for (const item of drawRecord.selected || []) counts.set(item.material_id, (counts.get(item.material_id) || 0) + 1);
  }
  return counts;
}

function countInflightSelections(project: Project): Map<string, number> {
  const counts = new Map<string, number>();
  const researchRoot = join(project.dataRoot, 'research');
  if (!existsSync(researchRoot)) return counts;
  for (const entry of readdirSync(researchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(researchRoot, entry.name, 'manifest.json');
    const seedPath = join(researchRoot, entry.name, 'seed.json');
    if (!existsSync(manifestPath) || !existsSync(seedPath)) continue;
    const manifest = readJson<any>(manifestPath);
    if (!['CREATED', 'ACTIVE', 'PAUSED', 'OUTPUT_FROZEN', 'COMMIT_PENDING', 'REPORT_PENDING', 'UNKNOWN_REMOTE'].includes(manifest.run_status)) continue;
    const seed = readJson<any>(seedPath);
    for (const item of seed.selected || seed.materials || []) {
      if (item.material_id) counts.set(item.material_id, (counts.get(item.material_id) || 0) + 1);
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
