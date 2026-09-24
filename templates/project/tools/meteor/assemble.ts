import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Dependency, KernelModule, Project } from './contracts.ts';
import { assert, inside, sha256 } from './util.ts';

export interface SingleKernelRenderOptions {
  assembly_key?: string;
  host_context_helpers?: string;
}

export interface VersionImplementation {
  implementation_id: number;
  module: KernelModule;
}

export interface VersionRouteRule {
  rule_id: number;
  implementation_id: number;
  case_ids?: string[];
  shape?: Partial<{ m: number; n: number; k: number }>;
}

export interface VersionSpec {
  assembly_key: string;
  host_context_helpers?: string;
  implementations: VersionImplementation[];
  routes: VersionRouteRule[];
}

function readTemplate(project: Project, name: string): string {
  const templateRoot = (project as Project & { snapshotRoot?: string }).snapshotRoot ?? project.root;
  return readFileSync(inside(templateRoot, `asc/${name}`), 'utf8');
}

function readPinnedHostContext(project: Project): string {
  return readTemplate(project, 'host_context.asc.inc');
}

function renderSlots(template: string, slots: Record<string, string>): string {
  let output = template;
  for (const [name, value] of Object.entries(slots)) {
    const marker = `{{${name}}}`;
    const count = output.split(marker).length - 1;
    assert(count === 1, `Template slot ${name} must appear exactly once`);
    output = output.split(marker).join(value);
  }
  assert(!output.includes('{{'), 'Unrendered template slot remains');
  return output;
}

function validatePrefix(prefix: string): void {
  assert(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(prefix), `Invalid immutable symbol prefix: ${prefix}`);
}

function validateUint32(value: number, label: string): void {
  assert(Number.isInteger(value) && value > 0 && value <= 0xFFFFFFFF, `${label} must be a positive uint32`);
}

function validateSuite(project: Project): void {
  const seenShapes = new Set<string>();
  const seenCases = new Set<string>();
  for (const item of project.suite.cases) {
    assert(!seenCases.has(item.case_id), `Duplicate case_id in suite: ${item.case_id}`);
    seenCases.add(item.case_id);
    validateUint32(item.shape.m, `case ${item.case_id} m`);
    validateUint32(item.shape.n, `case ${item.case_id} n`);
    validateUint32(item.shape.k, `case ${item.case_id} k`);
    const shapeKey = `${item.shape.m}x${item.shape.n}x${item.shape.k}`;
    assert(!seenShapes.has(shapeKey), `Duplicate shape in suite: ${shapeKey}`);
    seenShapes.add(shapeKey);
  }
}

function validateModule(module: KernelModule, project: Project): void {
  assert(module.operator_abi === project.suite.operator_abi, `Module ${module.kernel_id}@${module.revision} ABI does not match suite`);
  validatePrefix(module.symbol_prefix);
  assert(module.launcher === `${module.symbol_prefix}launch`, `Launcher must be the immutable prefix launch symbol`);
  const knownCases = new Set(project.suite.cases.map(item => item.case_id));
  const seenSupported = new Set<string>();
  for (const caseId of module.supported_case_ids) {
    assert(knownCases.has(caseId), `Module ${module.kernel_id}@${module.revision} declares unknown supported case: ${caseId}. Use case IDs from this fixed suite: ${[...knownCases].join(', ')}`);
    assert(!seenSupported.has(caseId), `Module ${module.kernel_id}@${module.revision} duplicates supported case: ${caseId}`);
    seenSupported.add(caseId);
  }
  for (const dep of module.dependencies) validateDependency(project, dep);
}

function validateDependency(project: Project, dep: Dependency): void {
  assert(/^[A-Za-z0-9_.-]{1,120}$/.test(dep.id), `Invalid dependency id: ${dep.id}`);
  const text = readFileSync(inside(project.root, dep.path), 'utf8');
  assert(sha256(text) === dep.sha256, `Dependency hash mismatch: ${dep.path}`);
}

function readSource(project: Project, path: string): string {
  return readFileSync(inside(project.root, path), 'utf8');
}

function emitDependencies(project: Project, modules: KernelModule[]) {
  const seen = new Map<string, Dependency>();
  for (const module of modules) {
    for (const dep of module.dependencies) {
      const prior = seen.get(dep.id);
      if (prior) {
        assert(prior.path === dep.path && prior.sha256 === dep.sha256 && prior.kind === dep.kind, `Dependency id conflict: ${dep.id}`);
      } else {
        seen.set(dep.id, dep);
      }
    }
  }
  const deps = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  const preamble = deps.filter(dep => dep.kind === 'preamble').map(dep => readSource(project, dep.path)).join('\n');
  const shared = deps.filter(dep => dep.kind === 'shared').map(dep => readSource(project, dep.path)).join('\n');
  return { preamble, shared };
}

function moduleDevice(project: Project, module: KernelModule): string {
  return `// meteor module ${module.kernel_id}@${module.revision} device\n${readSource(project, module.device_file)}`;
}

function moduleHost(project: Project, module: KernelModule): string {
  return `// meteor module ${module.kernel_id}@${module.revision} host\n${readSource(project, module.host_file)}`;
}

function conditionFor(rule: VersionRouteRule, project: Project): string {
  validateUint32(rule.rule_id, `route rule ${rule.rule_id}`);
  validateUint32(rule.implementation_id, `route implementation ${rule.implementation_id}`);
  const parts: string[] = [];
  if (rule.case_ids && rule.case_ids.length > 0) {
    const known = new Map(project.suite.cases.map(item => [item.case_id, item.shape]));
    const caseParts = rule.case_ids.map(caseId => {
      const shape = known.get(caseId);
      assert(shape, `Unknown route case_id: ${caseId}`);
      return `(shape.m == ${shape.m}U && shape.n == ${shape.n}U && shape.k == ${shape.k}U)`;
    });
    parts.push(`(${caseParts.join(' || ')})`);
  }
  if (rule.shape) {
    assert(rule.shape.m !== undefined && rule.shape.n !== undefined && rule.shape.k !== undefined, `Route rule ${rule.rule_id} cannot use partial shape predicates`);
    validateUint32(rule.shape.m, `route rule ${rule.rule_id} m`);
    validateUint32(rule.shape.n, `route rule ${rule.rule_id} n`);
    validateUint32(rule.shape.k, `route rule ${rule.rule_id} k`);
    const exact = project.suite.cases.find(item => item.shape.m === rule.shape!.m && item.shape.n === rule.shape!.n && item.shape.k === rule.shape!.k);
    assert(exact, `Route rule ${rule.rule_id} shape is outside the measured case suite`);
    if (rule.case_ids) assert(rule.case_ids.includes(exact.case_id), `Route rule ${rule.rule_id} shape predicate disagrees with case_ids`);
    parts.push(`shape.m == ${rule.shape.m}U`);
    parts.push(`shape.n == ${rule.shape.n}U`);
    parts.push(`shape.k == ${rule.shape.k}U`);
  }
  assert(parts.length > 0, `Route rule ${rule.rule_id} has no predicate`);
  return parts.join(' && ');
}

export function renderSingleKernel(project: Project, module: KernelModule, options: SingleKernelRenderOptions = {}): string {
  validateSuite(project);
  validateModule(module, project);
  const deps = emitDependencies(project, [module]);
  const template = readTemplate(project, 'kernel_test.asc.tmpl');
  return renderSlots(template, {
    ASSEMBLY_KEY: options.assembly_key ?? `${module.kernel_id}-${module.revision}`,
    DEPENDENCY_PREAMBLE: deps.preamble,
    SHARED_CODE: deps.shared,
    HOST_CONTEXT_HELPERS: options.host_context_helpers ?? readPinnedHostContext(project),
    KERNEL_DEVICE_CODE: moduleDevice(project, module),
    KERNEL_HOST_LAUNCHERS: moduleHost(project, module),
    KERNEL_LAUNCH_CALL: `status = ${module.launcher}(call, shape, resources);`,
  });
}

export function renderVersion(project: Project, spec: VersionSpec): string {
  validateSuite(project);
  assert(spec.implementations.length > 0, 'Version spec needs at least one implementation');
  const ids = new Set<number>();
  const prefixes = new Set<string>();
  const modules = spec.implementations.map(item => {
    validateUint32(item.implementation_id, `implementation ${item.implementation_id}`);
    assert(!ids.has(item.implementation_id), `Duplicate implementation id: ${item.implementation_id}`);
    ids.add(item.implementation_id);
    validateModule(item.module, project);
    assert(!prefixes.has(item.module.symbol_prefix), `Duplicate module symbol prefix: ${item.module.symbol_prefix}`);
    prefixes.add(item.module.symbol_prefix);
    return item.module;
  });
  const moduleById = new Map(spec.implementations.map(item => [item.implementation_id, item.module]));
  const ruleIds = new Set<number>();
  const routedCases = new Set<string>();
  for (const rule of spec.routes) {
    assert(moduleById.has(rule.implementation_id), `Route references unknown implementation ${rule.implementation_id}`);
    validateUint32(rule.rule_id, `route rule ${rule.rule_id}`);
    assert(!ruleIds.has(rule.rule_id), `Duplicate route rule id: ${rule.rule_id}`);
    ruleIds.add(rule.rule_id);
    assert(rule.case_ids && rule.case_ids.length > 0, `Route rule ${rule.rule_id} must route explicit measured case_ids`);
    const module = moduleById.get(rule.implementation_id)!;
    const supported = new Set(module.supported_case_ids);
    for (const caseId of rule.case_ids) {
      assert(supported.has(caseId), `Route rule ${rule.rule_id} sends untested or unsupported case ${caseId} to ${module.kernel_id}@${module.revision}`);
      assert(!routedCases.has(caseId), `Duplicate or overlapping route for case ${caseId}`);
      routedCases.add(caseId);
    }
  }
  const deps = emitDependencies(project, modules);
  const routeSelect = spec.routes.map(rule =>
    `if (${conditionFor(rule, project)}) { return {${rule.rule_id}U, ${rule.implementation_id}U}; }`
  ).join('\n    ');
  const dispatch = spec.implementations.map(item =>
    `case ${item.implementation_id}U:\n            status = ${item.module.launcher}(call, shape, resources);\n            break;`
  ).join('\n        ');
  const template = readTemplate(project, 'version.asc.tmpl');
  return renderSlots(template, {
    ASSEMBLY_KEY: spec.assembly_key,
    DEPENDENCY_PREAMBLE: deps.preamble,
    SHARED_CODE: deps.shared,
    HOST_CONTEXT_HELPERS: spec.host_context_helpers ?? readPinnedHostContext(project),
    KERNEL_DEVICE_CODE: modules.map(module => moduleDevice(project, module)).join('\n\n'),
    KERNEL_HOST_LAUNCHERS: modules.map(module => moduleHost(project, module)).join('\n\n'),
    ROUTE_SELECT_BODY: routeSelect,
    DISPATCH_CASES: dispatch,
  });
}

export function defaultTemplatePath(root: string): string {
  return join(root, 'asc');
}
