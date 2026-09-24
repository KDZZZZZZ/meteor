import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { renderSingleKernel } from './assemble.ts';
import type { BuildReceipt, KernelModule, Project } from './contracts.ts';
import { MockRunner } from './runners/mock.ts';
import { SshRunner } from './runners/ssh.ts';
import type { MockFixture, Runner } from './runners/contract.ts';
import { assertResearchActive } from './research.ts';
import { assertHardwareReady } from './hardware.ts';
import { canonical, hashObject, inside, readJson, safeId, sha256, writeImmutable } from './util.ts';

export interface BuildKernelInput {
  research_id: string;
  experiment_id: string;
  kernel_path: string;
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
  return resolve(project.dataRoot, 'research', safeId(researchId), 'experiments', safeId(experimentId));
}

export function buildReceiptPath(project: Project, receipt: BuildReceipt): string {
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

function assertImmutableKernelRevision(project: Project, module: KernelModule, sourceHash: string): void {
  const path = join(project.dataRoot, 'kernel-source-registry', safeId(module.kernel_id), `${safeId(module.revision)}.json`);
  if (existsSync(path) && readJson(path).source_hash !== sourceHash) {
    throw new Error(`Kernel ${module.kernel_id}@${module.revision} already identifies different source or manifest paths. Reuse its original module path unchanged, or assign a new revision before building.`);
  }
  writeImmutable(path, {
    kernel_ref: { kernel_id: module.kernel_id, revision: module.revision },
    source_hash: sourceHash,
    module_ref: `${module.device_file}|${module.host_file}`,
  });
}

export async function buildKernel(project: Project, input: BuildKernelInput): Promise<BuildReceipt> {
  input = { ...input, kernel_path: projectRef(project, inside(project.root, slash(input.kernel_path).replace(/\/kernel\.json$/, '').replace(/\/$/, ''))) };
  input.signal?.throwIfAborted();
  assertResearchActive(project, input.research_id, input.experiment_id);
  const modulePath = inside(project.root, `${input.kernel_path}/kernel.json`);
  if (!existsSync(modulePath)) throw new Error(`Kernel manifest missing: ${modulePath}. Create kernel.json and its declared device/host sources in your research drafts, then retry this experiment with the written module path. No device build or experiment receipt was produced.`);
  const module = readKernelModule(project, input.kernel_path);
  const declaredSources = [module.device_file, module.host_file, ...module.dependencies.map(dep => dep.path)];
  const missing = declaredSources.filter(path => typeof path !== 'string' || !existsSync(inside(project.root, path)));
  if (missing.length) throw new Error(`Kernel source files missing: ${missing.join(', ')}. Write the declared device, host and dependency sources, then retry this experiment. No device build or experiment receipt was produced.`);
  assertDeviceKernelSource(project, module);
  const rendered = renderSingleKernel(project, module, {
    assembly_key: `${input.research_id}-${input.experiment_id}-${module.kernel_id}-${module.revision}`,
  });
  const source_hash = computeSourceHash(project, module);
  assertImmutableKernelRevision(project, module, source_hash);
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
    source_ref: slash(input.kernel_path),
    module_ref: `${slash(input.kernel_path)}/kernel.json`,
  };
  writeImmutable(path, projectRelativeReceipt);
  return projectRelativeReceipt;
}

export function loadBuildReceipt(project: Project, buildRef: string): BuildReceipt {
  const path = resolveBuildRef(project, buildRef);
  return readJson<BuildReceipt>(path);
}

export function resolveBuildRef(project: Project, buildRef: string): string {
  const resolved = resolve(project.root, buildRef);
  const dataRoot = resolve(project.dataRoot);
  const part = relative(dataRoot, resolved);
  if (part === '..' || part.startsWith('..' + sep) || resolve(part) === part) throw new Error('build_ref must point inside project.dataRoot');
  return resolved;
}

export function validateBuildStillFresh(project: Project, build: BuildReceipt): KernelModule {
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
