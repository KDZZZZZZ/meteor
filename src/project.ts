import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaseSuite, MeteorConfig, Project, TargetRegistration } from '../templates/project/tools/meteor/contracts.ts';
import { assert, readJson, inside, safeId, sha256 } from '../templates/project/tools/meteor/util.ts';
import { artifactRoot } from '../templates/project/tools/meteor/workspace.ts';

export function loadWorkspace(root: string): MeteorConfig {
  root = resolve(root);
  const config = readJson<MeteorConfig>(join(root, 'meteor.config.json'));
  const localPath = join(root, '.meteor.local.json');
  if (existsSync(localPath)) {
    const local = readJson(localPath);
    assert(Object.keys(local).every(key => ['execution', 'environment'].includes(key)), 'Local overrides support execution and environment only');
    if (local.execution) config.execution = { ...config.execution, ...local.execution };
    if (local.environment) config.environment = { ...config.environment, ...local.environment };
  }
  assert(config.schema_version === 1 || config.schema_version === 2, 'Unsupported meteor config schema');
  if (config.schema_version === 2) {
    assert(config.workspace && safeId(config.workspace.workspace_id), 'Workspace identity is required');
    assert(config.workspace.hardware_ref === 'hardware/target.json', 'Workspace must have one hardware/target.json binding');
    assert(Array.isArray(config.targets) && config.targets.length > 0, 'Workspace targets must be nonempty');
    const keys = new Set<string>();
    for (const target of config.targets) {
      const key = safeId(target.op_id) + '/' + safeId(target.dtype_id);
      assert(!keys.has(key), 'Duplicate workspace target: ' + key); keys.add(key);
      assert(typeof target.operator_abi === 'string' && target.operator_abi, 'Target operator ABI required');
      for (const name of ['contract_ref', 'oracle_ref', 'adapter_ref', 'template_ref', 'case_suite_ref'] as const) {
        assert(typeof target[name] === 'string' && target[name] && existsSync(inside(root, target[name])), 'Target resource missing: ' + name);
      }
      if (target.assembly_template_ref !== undefined) {
        assert(typeof target.assembly_template_ref === 'string' && target.assembly_template_ref && existsSync(inside(root, target.assembly_template_ref)), 'Target resource missing: assembly_template_ref');
        assert(target.assembly_template?.ref === target.assembly_template_ref, 'Target assembly template metadata/ref mismatch');
        const text = readFileSync(inside(root, target.assembly_template_ref), 'utf8');
        assert(target.assembly_template?.sha256 === sha256(text), 'Target assembly template hash mismatch');
        assert(target.assembly_template.slot_contract === 'meteor-version-slots-v1', 'Unsupported assembly template slot contract');
      }
    }
    assert(config.design?.strategy && typeof config.design.strategy === 'string', 'Workspace design strategy required');
  }
  assert(['unconfigured', 'mock', 'ssh'].includes(config.execution?.backend), 'execution.backend must be unconfigured, mock or ssh');
  assert(typeof config.execution.profile_ref === 'string' && (config.execution.backend === 'unconfigured' || config.execution.profile_ref.length > 0), 'A profile_ref is required');
  assert(config.environment?.simulated === (config.execution.backend === 'mock'), 'Environment simulation flag must match execution backend');
  if (config.execution.backend !== 'unconfigured') assert(config.environment.environment_ref && config.environment.measurement_protocol_ref, 'Environment identity and measurement protocol are required');
  assert(Number.isInteger(config.budget?.max_experiments) && config.budget.max_experiments > 0, 'Positive experiment budget required');
  assert(Number.isFinite(config.budget.max_wall_time_seconds) && config.budget.max_wall_time_seconds > 0, 'Positive time budget required');
  const sampling = config.sampling;
  assert(sampling && sampling.epsilon >= 0 && sampling.epsilon <= 1 && sampling.lambda >= 0 && sampling.tau_hours > 0 && Number.isInteger(sampling.count) && sampling.count >= 0, 'Invalid sampling configuration');
  const legacyThreshold = config.integration?.min_relative_improvement;
  assert(legacyThreshold === undefined || (legacyThreshold >= 0 && legacyThreshold < 1), 'Invalid legacy integration threshold');
  return config;
}

export function resolveTarget(config: MeteorConfig, selected?: { op_id: string; dtype_id: string }): TargetRegistration | undefined {
  if (config.schema_version === 1) {
    assert(!selected || (selected.op_id === 'qmq-v1' && selected.dtype_id === 'int8'), 'Legacy project has only qmq-v1/int8');
    return undefined;
  }
  const targets = config.targets!;
  assert(selected || targets.length === 1, 'Choose target {op_id,dtype_id}: this workspace contains multiple targets');
  const target = selected ? targets.find(item => item.op_id === selected.op_id && item.dtype_id === selected.dtype_id) : targets[0];
  assert(target, 'Unknown workspace target');
  return { ...target };
}

export function loadProject(root: string, selected?: { op_id: string; dtype_id: string }): Project {
  root = resolve(root);
  const config = loadWorkspace(root);
  const target = resolveTarget(config, selected);
  if (target) {
    config.case_suite = target.case_suite_ref;
    const contract = readJson(inside(root, target.contract_ref));
    const adapter = readJson(inside(root, target.adapter_ref));
    assert(contract.operator_abi === target.operator_abi && adapter.operator_abi === target.operator_abi, 'Target contract/adapter ABI mismatch');
    assert(adapter.kind === 'qmq-v1' && target.operator_abi === 'qmq-v1', 'Target adapter is not implemented; register an implemented adapter before research');
    assert(adapter.input_dtype === 'int8' && adapter.layout === 'qmq-v1', 'Unsupported target adapter type/layout');
  }
  const suite = readJson<CaseSuite>(inside(root, config.case_suite));
  assert(typeof suite.revision === 'string' && suite.revision.length > 0 && suite.operator_abi === (target?.operator_abi ?? 'qmq-v1'), 'Invalid case suite identity or ABI');
  assert(Array.isArray(suite.cases) && suite.cases.length > 0, 'Case suite must be non-empty');
  const ids = new Set<string>(), shapes = new Set<string>();
  for (const c of suite.cases) {
    assert(c.case_id && !ids.has(c.case_id), 'Duplicate or missing case_id');
    ids.add(c.case_id);
    assert(c.shape && ['m','n','k'].every(key => Number.isSafeInteger(c.shape[key as keyof typeof c.shape]) && c.shape[key as keyof typeof c.shape] > 0), 'Invalid shape');
    assert(c.dtype === 'int8' && c.layout === 'qmq-v1', 'qmq-v1 currently requires int8/qmq-v1 cases');
    assert(c.input_hash && c.oracle_hash, 'Each case must pin inputs and oracle');
    const shape = JSON.stringify(c.shape);
    assert(!shapes.has(shape), 'Duplicate shape requires a richer routing ABI; use one case per shape in qmq-v1');
    shapes.add(shape);
  }
  const project: Project = { root, config, suite, dataRoot: join(root, 'reports', 'meteor', config.execution.backend),
    ...(target ? { target, scope: { workspace_id: config.workspace!.workspace_id, op_id: target.op_id, dtype_id: target.dtype_id } } : {}) };
  project.dataRoot = artifactRoot(project);
  return project;
}

export async function loadProjectRuntime(project: Project) {
  const base = join(project.snapshotRoot ?? project.root, 'tools', 'meteor');
  const load = (name: string) => import(pathToFileURL(join(base, name + (existsSync(join(base, name + '.ts')) ? '.ts' : '.js'))).href);
  const [research, build, test, profile, submit, sampling, integration] = await Promise.all([
    load('research'), load('kernel-build'), load('kernel-test'), load('kernel-profile'),
    load('submit'), load('sampling'), load('integration-events'),
  ]);
  const design = existsSync(join(base, 'design/service.ts')) || existsSync(join(base, 'design/service.js')) ? await load('design/service') : undefined;
  return { research, build, test, profile, submit, sampling, integration, design };
}

export function readPersona(project: Project): string {
  return readFileSync(join(project.snapshotRoot ?? project.root, 'prompts', 'meteor.md'), 'utf8');
}
