import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaseSuite, MeteorConfig, Project } from '../templates/project/tools/meteor/contracts.ts';
import { assert, readJson, inside } from '../templates/project/tools/meteor/util.ts';

export function loadProject(root: string): Project {
  root = resolve(root);
  const config = readJson<MeteorConfig>(join(root, 'meteor.config.json'));
  const localPath = join(root, '.meteor.local.json');
  if (existsSync(localPath)) {
    const local = readJson(localPath);
    assert(Object.keys(local).every(key => ['execution', 'environment'].includes(key)), 'Local overrides support execution and environment only');
    if (local.execution) config.execution = { ...config.execution, ...local.execution };
    if (local.environment) config.environment = { ...config.environment, ...local.environment };
  }
  assert(config.schema_version === 1, 'Unsupported meteor config schema');
  assert(['mock', 'ssh'].includes(config.execution?.backend), 'execution.backend must be mock or ssh');
  assert(typeof config.execution.profile_ref === 'string' && config.execution.profile_ref.length > 0, 'A profile_ref is required');
  assert(config.environment?.simulated === (config.execution.backend === 'mock'), 'Environment simulation flag must match execution backend');
  assert(config.environment.environment_ref && config.environment.measurement_protocol_ref, 'Environment identity and measurement protocol are required');
  assert(Number.isInteger(config.budget?.max_experiments) && config.budget.max_experiments > 0, 'Positive experiment budget required');
  assert(Number.isFinite(config.budget.max_wall_time_seconds) && config.budget.max_wall_time_seconds > 0, 'Positive time budget required');
  const sampling = config.sampling;
  assert(sampling && sampling.epsilon >= 0 && sampling.epsilon <= 1 && sampling.lambda >= 0 && sampling.tau_hours > 0 && Number.isInteger(sampling.count) && sampling.count >= 0, 'Invalid sampling configuration');
  assert(config.integration?.min_relative_improvement >= 0 && config.integration.min_relative_improvement < 1, 'Invalid integration threshold');
  const suite = readJson<CaseSuite>(inside(root, config.case_suite));
  assert(typeof suite.revision === 'string' && suite.revision.length > 0 && suite.operator_abi === 'qmq-v1', 'Invalid case suite identity or ABI');
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
  return { root, config, suite, dataRoot: join(root, 'reports', 'meteor', config.execution.backend) };
}

export async function loadProjectRuntime(project: Project) {
  const base = join(project.snapshotRoot ?? project.root, 'tools', 'meteor');
  const load = (name: string) => import(pathToFileURL(join(base, name + (existsSync(join(base, name + '.ts')) ? '.ts' : '.js'))).href);
  const [research, build, test, profile, submit, sampling, integration] = await Promise.all([
    load('research'), load('kernel-build'), load('kernel-test'), load('kernel-profile'),
    load('submit'), load('sampling'), load('integration-events'),
  ]);
  return { research, build, test, profile, submit, sampling, integration };
}

export function readPersona(project: Project): string {
  return readFileSync(join(project.snapshotRoot ?? project.root, 'prompts', 'meteor.md'), 'utf8');
}
