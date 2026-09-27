import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { renderSingleKernel } from './assemble.ts';
import type { BuildReceipt, KernelModule, Project } from './contracts.ts';
import { MockRunner } from './runners/mock.ts';
import { SshRunner } from './runners/ssh.ts';
import type { MockFixture, Runner } from './runners/contract.ts';
import { assertResearchActive } from './research.ts';
import { assertHardwareReady } from './hardware.ts';
import { canonical, hashObject, inside, readJson, safeId, sha256, writeImmutable } from './util.ts';
import { assertTarget, isWorkspace, statePath, targetPath, targetRef } from './workspace.ts';
import { assertMigrationIdle, trustedLegacySubmissions } from './legacy.ts';

export interface BuildKernelInput {
  research_id: string;
  experiment_id: string;
  kernel_path: string;
  design_ref?: string;
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

function slash(path: string): string {
  return path.split(sep).join('/');
}

export function projectRef(project: Project, path: string): string {
  return slash(relative(resolve(project.root), resolve(path)));
}

export function experimentDir(project: Project, researchId: string, experimentId: string): string {
  if (isWorkspace(project)) return targetPath(project, 'experiments', safeId(researchId), safeId(experimentId));
  return resolve(project.dataRoot, 'research', safeId(researchId), 'experiments', safeId(experimentId));
}

export function buildReceiptPath(project: Project, receipt: BuildReceipt): string {
  if (isWorkspace(project)) return targetPath(project, 'builds', safeId(receipt.build_id), 'receipt.json');
  return resolve(experimentDir(project, receipt.research_id, receipt.experiment_id), 'builds', `${receipt.build_id}.json`);
}

export function selectRunner(project: Project): Runner {
  if (project.config.execution.backend === 'mock') return new MockRunner();
  assertHardwareReady(project);
  return new SshRunner();
}

export function readKernelModule(project: Project, kernelPath: string): KernelModule {
  const cleanPath = slash(kernelPath).replace(/\/kernel\.json$/, '').replace(/\/$/, '');
  return readJson<KernelModule>(inside(project.root, `${cleanPath}/kernel.json`));
}

function sourcePieces(project: Project, module: KernelModule): unknown {
  const dependencyPieces = module.dependencies.map(dep => ({
    id: dep.id,
    kind: dep.kind,
    path: dep.path,
    sha256: dep.sha256,
    content_sha256: sha256(readFileSync(inside(project.root, dep.path), 'utf8')),
  }));
  return {
    module,
    device_sha256: sha256(readFileSync(inside(project.root, module.device_file), 'utf8')),
    host_sha256: sha256(readFileSync(inside(project.root, module.host_file), 'utf8')),
    dependencies: dependencyPieces,
    operator_abi: project.suite.operator_abi,
  };
}

export function computeSourceHash(project: Project, module: KernelModule): string {
  return hashObject(sourcePieces(project, module));
}

export function assertDeviceKernelSource(project: Project, module: KernelModule): void {
  if (project.config.execution.backend !== 'ssh') return;
  const host = readFileSync(inside(project.root, module.host_file), 'utf8');
  const sources = [host, readFileSync(inside(project.root, module.device_file), 'utf8'),
    ...module.dependencies.map(dep => readFileSync(inside(project.root, dep.path), 'utf8'))].join('\n');
  // A supplemental contract check; actual execution is independently checked by msprof.
  const code = sources.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  if (/\b(?:aclrtMemcpy(?:Async)?|ACL_MEMCPY_DEVICE_TO_HOST|ACL_MEMCPY_HOST_TO_DEVICE|ASCENDC_CPU_DEBUG)\b|[<"](?:arm_neon|immintrin)\.h[>"]/.test(code)) {
    throw new Error('Device-kernel contract: host CPU fallback/debug and hidden host-device transfers are not permitted inside the measured candidate. Keep transfers in the harness and implement computation on the NPU.');
  }
}

function writeImmutableText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const prior = readFileSync(path, 'utf8');
    if (prior !== value) throw new Error(`Immutable text artifact conflict: ${path}`);
    return;
  }
  writeFileSync(path, value, { flag: 'wx' });
}

interface SymbolPrefixOwner {
  target?: KernelModule['target'];
  symbol_prefix: string;
  kernel_ref: { kernel_id: string; revision: string };
  source_hash?: string;
  module_ref?: string;
}

function sameKernelRef(owner: SymbolPrefixOwner, module: KernelModule): boolean {
  return owner.kernel_ref.kernel_id === module.kernel_id && owner.kernel_ref.revision === module.revision;
}

function ownerLabel(owner: SymbolPrefixOwner): string {
  return `${owner.kernel_ref.kernel_id}@${owner.kernel_ref.revision}${owner.module_ref ? ` (${owner.module_ref})` : ''}`;
}

function prefixConflict(prefix: string, owner: SymbolPrefixOwner, module: KernelModule): Error {
  return new Error(`Kernel symbol_prefix ${prefix} is already owned in this target by ${ownerLabel(owner)}; candidate ${module.kernel_id}@${module.revision} must use a revision-unique symbol_prefix, update launcher to <new_prefix>launch, and update the manifest plus host/device declarations before building. No archive, device build, or experiment receipt was produced.`);
}

function archivedKernelManifests(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return archivedKernelManifests(path);
    return entry.isFile() && entry.name === 'kernel.json' ? [path] : [];
  });
}

function archivedPrefixOwner(project: Project, module: KernelModule): SymbolPrefixOwner | undefined {
  for (const path of archivedKernelManifests(targetPath(project, 'kernels'))) {
    const archived = readJson<KernelModule>(path);
    if (archived.symbol_prefix !== module.symbol_prefix) continue;
    const owner = {
      target: archived.target,
      symbol_prefix: archived.symbol_prefix,
      kernel_ref: { kernel_id: archived.kernel_id, revision: archived.revision },
      module_ref: projectRef(project, path),
    };
    if (!sameKernelRef(owner, module)) return owner;
  }
  return undefined;
}

function registryOwner(project: Project, module: KernelModule, sourceHash: string): SymbolPrefixOwner {
  return {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    symbol_prefix: module.symbol_prefix,
    kernel_ref: { kernel_id: module.kernel_id, revision: module.revision },
    source_hash: sourceHash,
  };
}

function prefixRegistryPath(project: Project, symbolPrefix: string): string {
  return statePath(project, 'kernel-symbol-prefix-registry', `${sha256(symbolPrefix)}.json`);
}

function readPrefixOwner(project: Project, symbolPrefix: string): SymbolPrefixOwner | undefined {
  const path = prefixRegistryPath(project, symbolPrefix);
  return existsSync(path) ? readJson<SymbolPrefixOwner>(path) : undefined;
}

function writePrefixOwner(project: Project, owner: SymbolPrefixOwner): boolean {
  const path = prefixRegistryPath(project, owner.symbol_prefix);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(owner, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

function cleanupPrefixOwner(project: Project, owner: SymbolPrefixOwner): void {
  const path = prefixRegistryPath(project, owner.symbol_prefix);
  if (!existsSync(path) || hashObject(readJson(path)) !== hashObject(owner)) return;
  rmSync(path);
}

function reserveKernelSymbolPrefix(project: Project, module: KernelModule, sourceHash: string): { owner: SymbolPrefixOwner; created: boolean } {
  const archived = archivedPrefixOwner(project, module);
  if (archived) throw prefixConflict(module.symbol_prefix, archived, module);
  const owner = registryOwner(project, module, sourceHash);
  const created = writePrefixOwner(project, owner);
  const current = readPrefixOwner(project, module.symbol_prefix);
  if (current && !sameKernelRef(current, module)) throw prefixConflict(module.symbol_prefix, current, module);
  return { owner, created };
}

function assertImmutableKernelRevision(project: Project, module: KernelModule, sourceHash: string): void {
  const path = statePath(project, 'kernel-source-registry', safeId(module.kernel_id), `${safeId(module.revision)}.json`);
  if (existsSync(path) && readJson(path).source_hash !== sourceHash) {
    throw new Error(`Kernel ${module.kernel_id}@${module.revision} already identifies different source or manifest paths. Reuse its original module path unchanged, or assign a new revision before building.`);
  }
  writeImmutable(path, {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    kernel_ref: { kernel_id: module.kernel_id, revision: module.revision },
    source_hash: sourceHash,
    module_ref: `${module.device_file}|${module.host_file}`,
  });
}

/** Freeze drafts into the target's immutable kernel namespace before measurements. */
function archiveKernel(project: Project, module: KernelModule): { module: KernelModule; kernelPath: string } {
  const root = targetPath(project, 'kernels', safeId(module.kernel_id), safeId(module.revision));
  const kernelPath = projectRef(project, root);
  if (module.target && module.device_file === `${kernelPath}/device.asc` && module.host_file === `${kernelPath}/host.asc`
    && module.dependencies.every(dep => dep.path.startsWith(`${kernelPath}/dependencies/`))) {
    assertTarget(project, module.target, 'Archived kernel');
    writeImmutable(join(root, 'kernel.json'), module);
    return { module, kernelPath };
  }
  const sources: Array<[string, string]> = [[module.device_file, `${kernelPath}/device.asc`], [module.host_file, `${kernelPath}/host.asc`]];
  const dependencies = module.dependencies.map((dep, index) => {
    const path = `${kernelPath}/dependencies/${index}-${safeId(dep.id)}-${basename(dep.path)}`;
    sources.push([dep.path, path]);
    return { ...dep, path };
  });
  const archived: KernelModule = { ...module, target: targetRef(project), device_file: sources[0][1], host_file: sources[1][1], dependencies };
  // Read before writing so reusing an already archived module remains idempotent.
  const contents = sources.map(([source, dest]) => [dest, readFileSync(inside(project.root, source), 'utf8')] as const);
  for (const [dest, content] of contents) writeImmutableText(inside(project.root, dest), content);
  writeImmutable(join(root, 'kernel.json'), archived);
  return { module: archived, kernelPath };
}

function assertKnownSupportedCases(project: Project, module: KernelModule): void {
  const valid = project.suite.cases.map(item => item.case_id);
  const validSet = new Set(valid);
  const supported = Array.isArray(module.supported_case_ids) ? module.supported_case_ids : [];
  const unknown = supported.filter(id => typeof id !== 'string' || !validSet.has(id)).map(String);
  if (unknown.length) {
    throw new Error(`Kernel supported_case_ids include unknown case id(s): ${unknown.join(', ')}. Valid case_ids for suite ${project.suite.revision}: ${valid.join(', ')}. Use a legal subset of the fixed suite; not every case is required. No device build or experiment receipt was produced.`);
  }
}

export async function buildKernel(project: Project, input: BuildKernelInput): Promise<BuildReceipt> {
  assertMigrationIdle(project);
  input = { ...input, kernel_path: projectRef(project, inside(project.root, slash(input.kernel_path).replace(/\/kernel\.json$/, '').replace(/\/$/, ''))) };
  input.signal?.throwIfAborted();
  assertResearchActive(project, input.research_id, input.experiment_id);
  const modulePath = inside(project.root, `${input.kernel_path}/kernel.json`);
  if (!existsSync(modulePath)) throw new Error(`Kernel manifest missing: ${modulePath}. Create kernel.json and its declared device/host sources in your research drafts, then retry this experiment with the written module path. No device build or experiment receipt was produced.`);
  let module = readKernelModule(project, input.kernel_path);
  if (module.target) assertTarget(project, module.target, 'Kernel draft');
  const declaredSources = [module.device_file, module.host_file, ...module.dependencies.map(dep => dep.path)];
  const missing = declaredSources.filter(path => typeof path !== 'string' || !existsSync(inside(project.root, path)));
  if (missing.length) throw new Error(`Kernel source files missing: ${missing.join(', ')}. Write the declared device, host and dependency sources, then retry this experiment. No device build or experiment receipt was produced.`);
  assertKnownSupportedCases(project, module);
  assertDeviceKernelSource(project, module);
  const { assertDesignBuildReady } = await import('./design/service.ts');
  const design = assertDesignBuildReady(project, input);
  const draftSourceHash = computeSourceHash(project, module);
  if (isWorkspace(project)) {
    const reserved = trustedLegacySubmissions(project).some(group => group.commits.some(commit =>
      commit.submission.submitted_kernels.some(kernel => kernel.kernel_id === module.kernel_id && kernel.revision === module.revision)));
    if (reserved) throw new Error(`Kernel ${module.kernel_id}@${module.revision} is a preserved legacy revision. Read it as inspiration and assign a new revision before creating a canonical workspace build.`);
    const reservation = reserveKernelSymbolPrefix(project, module, draftSourceHash);
    try {
      const archived = archiveKernel(project, module);
      module = archived.module;
      input = { ...input, kernel_path: archived.kernelPath };
    } catch (error) {
      if (reservation.created) cleanupPrefixOwner(project, reservation.owner);
      throw error;
    }
  }
  const rendered = renderSingleKernel(project, module, {
    assembly_key: `${input.research_id}-${input.experiment_id}-${module.kernel_id}-${module.revision}`,
  });
  const source_hash = computeSourceHash(project, module);
  assertImmutableKernelRevision(project, module, source_hash);
  mkdirSync(experimentDir(project, input.research_id, input.experiment_id), { recursive: true });
  const rendered_source_hash = sha256(rendered);
  const receipt = await selectRunner(project).build({
    project,
    research_id: input.research_id,
    experiment_id: input.experiment_id,
    module,
    kernel_path: slash(input.kernel_path),
    source_hash,
    rendered_source_hash,
    rendered_source: rendered,
    fixture: input.fixture,
    idempotency_key: input.idempotency_key,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const path = buildReceiptPath(project, receipt);
  const ascPath = path.replace(/\.json$/, '.asc');
  writeImmutableText(ascPath, rendered);
  const projectRelativeReceipt: BuildReceipt = {
    ...receipt,
    ...(targetRef(project) ? { target: targetRef(project), draft_source_hash: draftSourceHash } : {}),
    ...design,
    source_ref: slash(input.kernel_path),
    module_ref: `${slash(input.kernel_path)}/kernel.json`,
  };
  writeImmutable(path, projectRelativeReceipt);
  return projectRelativeReceipt;
}

export function loadBuildReceipt(project: Project, buildRef: string): BuildReceipt {
  const path = resolveBuildRef(project, buildRef);
  const receipt = readJson<BuildReceipt>(path);
  assertTarget(project, receipt.target, 'Build receipt');
  return receipt;
}

export function resolveBuildRef(project: Project, buildRef: string): string {
  const resolved = resolve(project.root, buildRef);
  const dataRoot = resolve(project.dataRoot);
  const part = relative(dataRoot, resolved);
  if (part === '..' || part.startsWith('..' + sep) || resolve(part) === part) throw new Error('build_ref must point inside project.dataRoot');
  return resolved;
}

export function validateBuildStillFresh(project: Project, build: BuildReceipt): KernelModule {
  assertTarget(project, build.target, 'Build receipt');
  if (build.execution_backend !== project.config.execution.backend) {
    throw new Error(`Build backend ${build.execution_backend} does not match project backend ${project.config.execution.backend}`);
  }
  if (build.environment_ref !== project.config.environment.environment_ref) {
    throw new Error(`Build environment ${build.environment_ref} does not match project environment ${project.config.environment.environment_ref}`);
  }
  if (build.status === 'COMPLETED' && (!build.artifact_hash || !/^[a-f0-9]{64}$/.test(build.artifact_hash))) {
    throw new Error(`Build receipt ${build.build_id} has an invalid artifact hash`);
  }
  const moduleDir = build.module_ref.replace(/\/kernel\.json$/, '');
  const module = readKernelModule(project, moduleDir);
  if (isWorkspace(project)) assertTarget(project, module.target, 'Kernel module');
  const currentHash = computeSourceHash(project, module);
  if (currentHash !== build.source_hash) {
    throw new Error(`Stale build_ref ${build.build_id}: current source hash ${currentHash} does not match receipt ${build.source_hash}`);
  }
  if (module.kernel_id !== build.kernel_ref.kernel_id || module.revision !== build.kernel_ref.revision) {
    throw new Error(`Build receipt kernel ref does not match current module manifest`);
  }
  assertDeviceKernelSource(project, module);
  return module;
}

export function receiptRef(project: Project, path: string): string {
  return projectRef(project, path);
}

export function debugCanonical(value: unknown): string {
  return canonical(value);
}
