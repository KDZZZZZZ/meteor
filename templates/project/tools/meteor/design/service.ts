import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { KernelModule, Project, TargetRef } from '../contracts.ts';
import { computeSourceHash } from '../kernel-build.ts';
import { assertResearchActive, researchPath } from '../research.ts';
import { assert, hashObject, inside, readJson, safeId, writeImmutable } from '../util.ts';
import { assertTarget, targetFile, targetPath, targetRef } from '../workspace.ts';
import { GRAPH_PRIMITIVES, hasImplementation } from './annotations.ts';
import { loadExecutionModel } from '../hardware-model.ts';
import { checkWithStrategy, requireDesignStrategy } from './registry.ts';

interface DesignRecord {
  schema_version: 1; design_id: string; research_id: string; experiment_id: string;
  strategy: string; kernel_path: string; kernel_ref: { kernel_id: string; revision: string };
  module_hash: string; formula_ref: string; formula_hash: string; environment_ref: string;
  case_suite_revision: string; target?: TargetRef; hardware_model_ref: string; hardware_model_hash: string;
}
export interface DesignInput { research_id: string; design_ref: string }
export interface OpenDesignInput { research_id: string; experiment_id: string; kernel_path: string; design_id?: string; strategy?: string }
export interface BuildDesignInput { research_id: string; experiment_id: string; kernel_path: string; design_ref?: string; fixture?: unknown }

function ref(project: Project, path: string): string { return relative(project.root, path).split(sep).join('/'); }
function cleanKernelPath(project: Project, path: string): string { return ref(project, inside(project.root, path.replace(/[/\\]kernel\.json$/, ''))); }
function recordPath(project: Project, researchId: string, designId: string): string { return targetPath(project, 'ir', safeId(researchId), safeId(designId), 'design.json'); }
function artifact(project: Project, designRef: string, file: string): string { return inside(dirname(inside(project.root, designRef)), file); }
function save(path: string, value: unknown): void { writeImmutable(path, { value, content_hash: hashObject(value) }); }
function saved<T = any>(path: string): T {
  const entry = readJson(path); assert(entry.content_hash === hashObject(entry.value), 'Design artifact integrity mismatch'); return entry.value as T;
}
function samePath(a: string, b: string): boolean { return resolve(a) === resolve(b); }
function authorPath(project: Project, researchId: string, path: string): void {
  const draftRoot = resolve(researchPath(project, researchId), 'drafts');
  const part = relative(draftRoot, resolve(path));
  assert(part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part), 'Design sources must belong to this research drafts directory');
}
function moduleAt(project: Project, kernelPath: string): KernelModule { return readJson(inside(project.root, kernelPath + '/kernel.json')); }
function sources(project: Project, module: KernelModule) {
  return [module.device_file, module.host_file].map(path => ({ path, text: readFileSync(inside(project.root, path), 'utf8') }));
}
function readDesign(project: Project, input: DesignInput): DesignRecord {
  const path = inside(project.root, input.design_ref), design = saved<DesignRecord>(path);
  assert(design.schema_version === 1 && design.research_id === input.research_id, 'Design belongs to another research or schema');
  assert(samePath(path, recordPath(project, input.research_id, design.design_id)), 'Design reference is not its authoritative artifact path');
  assertTarget(project, design.target, 'Design');
  assert(design.environment_ref === project.config.environment.environment_ref && design.case_suite_revision === project.suite.revision, 'Design environment or suite is stale');
  assert(design.formula_ref === ref(project, targetFile(project, 'contract_ref')) && design.formula_hash === hashObject(readJson(targetFile(project, 'contract_ref'))), 'Design formula identity is stale');
  return design;
}
function checked(project: Project, input: DesignInput) {
  const design = readDesign(project, input), module = moduleAt(project, design.kernel_path);
  assert(hashObject(module) === design.module_hash, 'Kernel manifest changed after design open; create a new design attempt');
  const source = sources(project, module);
  const hardware = loadExecutionModel(project, design.hardware_model_ref, design.hardware_model_hash);
  const parsed = checkWithStrategy(design.strategy, source, design.formula_ref, readJson(targetFile(project, 'contract_ref')), hardware.model);
  return { design, module, source, parsed };
}

export function openDesign(project: Project, input: OpenDesignInput) {
  assertResearchActive(project, input.research_id, input.experiment_id);
  const kernelPath = cleanKernelPath(project, input.kernel_path), module = moduleAt(project, kernelPath);
  authorPath(project, input.research_id, inside(project.root, kernelPath));
  for (const path of [module.device_file, module.host_file]) authorPath(project, input.research_id, inside(project.root, path));
  assert(module.operator_abi === project.suite.operator_abi, 'Kernel ABI does not match the bound target');
  const strategy = input.strategy ?? project.config.design?.strategy ?? 'layered-ir@1'; requireDesignStrategy(strategy);
  const hardware = loadExecutionModel(project);
  const designId = safeId(input.design_id ?? 'design-' + randomUUID());
  const design: DesignRecord = {
    schema_version: 1, design_id: designId, research_id: input.research_id, experiment_id: safeId(input.experiment_id),
    strategy, kernel_path: kernelPath, kernel_ref: { kernel_id: safeId(module.kernel_id), revision: safeId(module.revision) },
    module_hash: hashObject(module), formula_ref: ref(project, targetFile(project, 'contract_ref')),
    formula_hash: hashObject(readJson(targetFile(project, 'contract_ref'))), environment_ref: project.config.environment.environment_ref,
    case_suite_revision: project.suite.revision, ...(targetRef(project) ? { target: targetRef(project) } : {}),
    hardware_model_ref: hardware.model_ref, hardware_model_hash: hardware.model_hash,
  };
  const path = recordPath(project, input.research_id, designId); save(path, design);
  return { design_ref: ref(project, path), status: 'OPEN', strategy, formula_ref: design.formula_ref,
    guide_ref: ref(project, resolve(project.snapshotRoot ?? project.root, 'tools/meteor/design/guide.md')),
    stages: ['expected', 'implementation'], graph_primitives: GRAPH_PRIMITIVES,
    hardware_model_ref: hardware.model_ref, hardware_model_hash: hardware.model_hash,
    activity_primitives: hardware.model.primitives, hardware_resources: hardware.model.resources,
    next_action: 'Write graph/execution JSON inside a C++ block comment: /* meteor-ir:v1\n{...}\n*/. Use the exact field shapes and dtype names in guide_ref; raw JSON after a closed comment is not an annotation. Leave both source files free of implementation, then check expected.' };
}

export function checkDesign(project: Project, input: DesignInput & { stage: 'expected' | 'implementation' }) {
  assertResearchActive(project, input.research_id);
  const { design, module, source, parsed } = checked(project, input);
  if (input.stage === 'expected') {
    assert(source.every(item => !hasImplementation(item.text)), 'Expected activities must be checked before implementation code; start with comments only');
    const value = { design_ref: input.design_ref, annotation_hash: parsed.annotation_hash, module_hash: design.module_hash,
      sources: source, annotations: parsed.ir, coverage: parsed.coverage,
      dependency_hash: hashObject(module.dependencies.map(dependency => ({ ...dependency, content_hash: hashObject(readFileSync(inside(project.root, dependency.path), 'utf8')) }))) };
    const path = artifact(project, input.design_ref, 'expected.json'); save(path, value);
    return { status: 'EXPECTED_SAVED', design_ref: input.design_ref, expected_ref: ref(project, path), coverage: parsed.coverage,
      next_action: 'Keep these IR comments unchanged and implement the activities; use // meteor-activity: <id> beside their code.' };
  }
  assert(input.stage === 'implementation', 'Unknown design stage');
  const expectedPath = artifact(project, input.design_ref, 'expected.json');
  assert(existsSync(expectedPath), 'No immutable expected activities were saved before implementation');
  const expected = saved(expectedPath);
  assert(expected.annotation_hash === parsed.annotation_hash && expected.module_hash === design.module_hash, 'IR comments changed since the expected snapshot; preserve that attempt and create a new design before implementing');
  assert(source.every(item => hasImplementation(item.text)), 'Both device and host implementations must be present');
  assert(parsed.ir.execution.activities.every(item => parsed.markers.includes(item.id)), 'Every expected activity needs a meteor-activity source marker');
  const dependencyHash = hashObject(module.dependencies.map(dependency => ({ ...dependency, content_hash: hashObject(readFileSync(inside(project.root, dependency.path), 'utf8')) })));
  assert(dependencyHash === expected.dependency_hash, 'A dependency changed after the expected snapshot');
  return { status: 'IMPLEMENTATION_CHECKED', design_ref: input.design_ref, annotation_hash: parsed.annotation_hash,
    source_hash: computeSourceHash(project, module), kernel_ref: design.kernel_ref, coverage: parsed.coverage };
}

export function freezeDesign(project: Project, input: DesignInput) {
  const check = checkDesign(project, { ...input, stage: 'implementation' });
  const design = readDesign(project, input), module = moduleAt(project, design.kernel_path);
  const value = { ...check, status: 'READY', research_id: input.research_id, experiment_id: design.experiment_id,
    kernel_path: design.kernel_path, target: design.target, environment_ref: design.environment_ref,
    case_suite_revision: design.case_suite_revision, module, sources: sources(project, module) };
  const path = artifact(project, input.design_ref, 'frozen.json'); save(path, value);
  return { ...check, status: 'READY', frozen_ref: ref(project, path), next_action: 'Build this exact kernel revision with design_ref, then test and compare actual evidence in the same session.' };
}

function researchDesigns(project: Project, researchId: string): Array<{ ref: string; design: DesignRecord }> {
  const root = targetPath(project, 'ir', safeId(researchId));
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = recordPath(project, researchId, entry.name);
    return existsSync(path) ? [{ ref: ref(project, path), design: saved<DesignRecord>(path) }] : [];
  });
}

export function assertDesignWriteAllowed(project: Project, input: { research_id: string; path: string; content: string }): void {
  if (project.config.execution.backend !== 'ssh' || !['.asc', '.c', '.cc', '.cpp', '.h', '.hpp', '.inc', '.cuh'].includes(extname(input.path).toLowerCase()) || !hasImplementation(input.content)) return;
  const path = inside(project.root, input.path); authorPath(project, input.research_id, path);
  const attempts = researchDesigns(project, input.research_id).filter(({ design }) => {
    const module = moduleAt(project, design.kernel_path);
    return [module.device_file, module.host_file].some(source => samePath(inside(project.root, source), path));
  });
  for (const attempt of attempts) {
    const expectedPath = artifact(project, attempt.ref, 'expected.json'); if (!existsSync(expectedPath)) continue;
    const module = moduleAt(project, attempt.design.kernel_path);
    const source = [module.device_file, module.host_file].map(sourcePath => ({ path: sourcePath,
      text: samePath(inside(project.root, sourcePath), path) ? input.content : readFileSync(inside(project.root, sourcePath), 'utf8') }));
    try {
      readDesign(project, { research_id: input.research_id, design_ref: attempt.ref });
      const hardware = loadExecutionModel(project, attempt.design.hardware_model_ref, attempt.design.hardware_model_hash);
      const parsed = checkWithStrategy(attempt.design.strategy, source, attempt.design.formula_ref, readJson(targetFile(project, 'contract_ref')), hardware.model);
      const expected = saved(expectedPath);
      if (hashObject(module) === expected.module_hash && parsed.annotation_hash === expected.annotation_hash) return;
    } catch { /* A different immutable attempt may match; otherwise the write fails below. */ }
  }
  throw new Error('Write expected activity comments first, open/check the expected design, then write implementation with unchanged IR comments. Source contains text outside comments. No matching immutable expected snapshot exists. Put the entire IR JSON inside /* meteor-ir:v1 ... */; raw JSON outside that block is not a source comment. Follow guide_ref for the supported fields.');
}

export function assertDesignBuildReady(project: Project, input: BuildDesignInput) {
  if (project.config.execution.backend === 'mock' && input.fixture !== undefined && input.fixture !== null) {
    return { compatibility: 'explicit-mock-fixture', simulated: true };
  }
  assert(input.design_ref, 'A frozen design_ref is required before building a new kernel; legacy receipts remain readable, and only explicit mock fixtures bypass this protocol');
  const design = readDesign(project, { research_id: input.research_id, design_ref: input.design_ref });
  assert(design.experiment_id === input.experiment_id && design.kernel_path === cleanKernelPath(project, input.kernel_path), 'Design experiment or candidate does not match this build');
  const frozenPath = artifact(project, input.design_ref, 'frozen.json'); assert(existsSync(frozenPath), 'Freeze the implementation design before build');
  const frozen = saved(frozenPath), module = moduleAt(project, design.kernel_path);
  assert(hashObject(module) === design.module_hash && computeSourceHash(project, module) === frozen.source_hash, 'Frozen design is stale: exact kernel source, revision or dependencies changed');
  return { design_ref: input.design_ref, draft_source_hash: frozen.source_hash };
}

export function compareDesign(project: Project, input: DesignInput & { receipt_refs: string[]; analysis?: { matched: string[]; deviations: string[]; unknown: string[] } }) {
  const design = readDesign(project, input), frozenPath = artifact(project, input.design_ref, 'frozen.json');
  assert(existsSync(frozenPath), 'A frozen design is required for comparison'); const frozen = saved(frozenPath);
  assert(Array.isArray(input.receipt_refs) && input.receipt_refs.length > 0, 'Actual receipt references are required');
  const assertIdentity = (receipt: any) => {
    assert(receipt.research_id === input.research_id && receipt.experiment_id === design.experiment_id, 'Evidence belongs to another research or experiment');
    assertTarget(project, receipt.target, 'Comparison evidence');
    assert(receipt.kernel_ref?.kernel_id === design.kernel_ref.kernel_id && receipt.kernel_ref?.revision === design.kernel_ref.revision, 'Evidence kernel revision does not match the design');
    assert(receipt.environment_ref === design.environment_ref && receipt.execution_backend === project.config.execution.backend, 'Evidence environment/backend does not match');
    assert(receipt.simulated === (project.config.execution.backend === 'mock'), 'Evidence simulation flag is invalid');
  };
  const evidence = input.receipt_refs.map(receiptRef => {
    const path = inside(project.root, receiptRef), receipt = readJson(path);
    const legalRoots = ['builds', 'measurements'].map(kind => targetPath(project, kind));
    legalRoots.push(resolve(researchPath(project, input.research_id), 'experiments'));
    assert(legalRoots.some(root => { const part = relative(root, path); return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }), 'Evidence must be a tool-produced build/test/profile receipt');
    assertIdentity(receipt);
    let sourceHash = receipt.draft_source_hash ?? receipt.source_hash;
    if (sourceHash !== frozen.source_hash && receipt.build_ref) {
      const build = readJson(inside(project.root, receipt.build_ref));
      assert(build.source_hash === receipt.source_hash && build.design_ref === input.design_ref && build.research_id === input.research_id, 'Receipt build mapping does not match the design');
      assertIdentity(build);
      sourceHash = build.draft_source_hash ?? build.source_hash;
    }
    assert(sourceHash === frozen.source_hash, 'Evidence source does not match the frozen design');
    const kind = receipt.run_id ? 'test' : receipt.profile_id ? 'profile' : receipt.build_id ? 'build' : '';
    assert(kind, 'Unrecognized measurement receipt');
    return { receipt_ref: ref(project, path), content_hash: hashObject(receipt), kind, receipt };
  });
  assert(evidence.some(item => item.kind !== 'build'), 'Build-only evidence cannot describe actual activity');
  const analysis = input.analysis ?? { matched: [], deviations: [], unknown: ['Activity-level correspondence requires author analysis of the available measurements.'] };
  for (const key of ['matched', 'deviations', 'unknown'] as const) assert(Array.isArray(analysis[key]) && analysis[key].every(x => typeof x === 'string'), 'Invalid comparison analysis');
  const comparison = { design_ref: input.design_ref, expected_ref: ref(project, artifact(project, input.design_ref, 'expected.json')),
    evidence, analysis, analysis_kind: 'author_interpretation', simulated: project.config.execution.backend === 'mock',
    limits: ['Receipts preserve their actual measurement scope; whole-kernel times are not allocated to activities.', 'No automatic hypothesis verdict, per-activity timing, or mathematical equivalence claim.'] };
  const path = targetPath(project, 'comparisons', safeId(input.research_id), safeId(design.design_id), hashObject(comparison) + '.json'); save(path, comparison);
  return { status: 'COMPARED', comparison_ref: ref(project, path), design_ref: input.design_ref,
    evidence_count: evidence.length, simulated: comparison.simulated, analysis, limits: comparison.limits };
}
