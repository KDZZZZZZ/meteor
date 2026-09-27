import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AssignedHypothesis, Project, ResearchRecord } from './contracts.ts';
import { assert, hashObject, readJson, safeId, writeImmutable, writeJson } from './util.ts';
import { normalizeInitialContext } from './sampling.ts';
import { assertHardwareReady } from './hardware.ts';
import { loadExecutionModel, materializeExecutionModelEvidence } from './hardware-model.ts';
import { assertTarget, isWorkspace, targetPath, targetRef } from './workspace.ts';
import { assertMigrationIdle } from './legacy.ts';

export function researchPath(project: Project, id: string) { return targetPath(project, 'research', safeId(id)); }
export function getResearch(project: Project, id: string): ResearchRecord {
  const record = readJson<ResearchRecord>(join(researchPath(project, id), 'manifest.json'));
  assertTarget(project, record.target, 'Research');
  return record;
}
export function createResearch(project: Project, input: {
  research_id?: string; chief_id: string; agent_session_id: string; goal: string;
  budget?: Partial<ResearchRecord['budget']>;
  initial_context?: unknown; assigned_hypothesis?: unknown;
}): ResearchRecord {
  assertMigrationIdle(project);
  assertHardwareReady(project);
  let hardwareModel: ReturnType<typeof loadExecutionModel> | undefined;
  if (isWorkspace(project) && project.config.execution.backend === 'ssh') {
    hardwareModel = loadExecutionModel(project);
    assert(project.target?.assembly_template_ref && project.target.assembly_template,
      'Assembly template setup required: Chief must choose a user/repository example for this op/dtype with meteor_configure_assembly_template');
  }
  assert(input.goal?.trim(), 'Research goal is required');
  const id = input.research_id ?? 'research-' + randomUUID();
  const dir = researchPath(project, id);
  assert(!existsSync(join(dir, 'manifest.json')), 'Research identity already exists');
  const budget = { ...project.config.budget, ...input.budget };
  assert(Number.isInteger(budget.max_experiments) && budget.max_experiments > 0 && Number.isFinite(budget.max_wall_time_seconds) && budget.max_wall_time_seconds > 0, 'Invalid budget');
  const initialContext = normalizeInitialContext(input.initial_context);
  const assignedHypothesis = normalizeAssignedHypothesis(input.assigned_hypothesis);
  const record: ResearchRecord = {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    research_id: id, agent_session_id: input.agent_session_id, chief_id: input.chief_id,
    execution_backend: project.config.execution.backend, case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    goal: input.goal, run_status: 'CREATED', created_at: new Date().toISOString(),
    budget, research_goal_met: false,
    initial_context: initialContext,
    ...(assignedHypothesis === undefined ? {} : { assigned_hypothesis: assignedHypothesis }),
  };
  mkdirSync(dir, { recursive: true });
  const snapshot = join(dir, 'snapshot');
  mkdirSync(snapshot, { recursive: true });
  const references = isWorkspace(project) ? [project.target!.contract_ref, project.target!.oracle_ref,
    project.target!.adapter_ref, project.target!.template_ref,
    ...(project.config.design?.hardware_model_ref ? [project.config.design.hardware_model_ref, project.config.workspace!.hardware_ref] : []),
    ...(project.target!.assembly_template_ref && !project.target!.assembly_template_ref.startsWith(project.target!.template_ref + '/') ? [project.target!.assembly_template_ref] : [])] : ['asc'];
  for (const rel of [...new Set(['tools/meteor', 'prompts', '.dsh/skills', ...references])]) {
    const source = join(project.root, rel);
    if (existsSync(source)) { mkdirSync(dirname(join(snapshot, rel)), { recursive: true }); cpSync(source, join(snapshot, rel), { recursive: true, errorOnExist: true }); }
  }
  if (hardwareModel) materializeExecutionModelEvidence(snapshot, hardwareModel);
  // Freeze runtime code, never a live catalog or its growing artifact corpus.
  const knowledge = join(project.root, 'knowledge');
  if (existsSync(knowledge)) cpSync(knowledge, join(snapshot, 'knowledge'), { recursive: true,
    filter: source => source === knowledge || (statSync(source).isDirectory()
      ? relative(knowledge, source).split(/[\\/]/)[0] === 'migrations' : /\.(py|sql)$/.test(source)) });
  if (isWorkspace(project)) {
    writeImmutable(join(snapshot, project.target!.case_suite_ref), project.suite);
    writeImmutable(join(snapshot, 'target.json'), targetRef(project));
  }
  writeImmutable(join(snapshot, 'meteor.config.json'), project.config);
  writeImmutable(join(snapshot, 'case-suite.json'), project.suite);
  writeImmutable(join(dir, 'manifest.json'), record);
  writeJson(join(dir, 'checkpoint.json'), { research_id: id, agent_session_id: input.agent_session_id, step: 'created',
    pending: [assignedHypothesis ? 'Design experiments for the chief-assigned hypothesis' : 'Define a falsifiable hypothesis'] });
  project.snapshotRoot = snapshot;
  return record;
}
export function updateResearch(project: Project, id: string, patch: Partial<ResearchRecord> & Record<string, unknown>): ResearchRecord {
  assertMigrationIdle(project);
  const current = getResearch(project, id);
  if ('target' in patch) assertTarget(project, patch.target, 'Research update');
  for (const key of ['research_id', 'execution_backend', 'case_suite_revision', 'environment_ref', 'measurement_protocol_ref', 'chief_id', 'created_at'] as const) {
    assert(!(key in patch) || patch[key] === current[key], 'Cannot change pinned research identity: ' + key);
  }
  for (const key of ['initial_context', 'assigned_hypothesis'] as const) {
    assert(!(key in patch) || hashObject(patch[key] ?? null) === hashObject(current[key] ?? null), 'Cannot change pinned research assignment: ' + key);
  }
  if (patch.agent_session_id && current.agent_session_id && current.agent_session_id !== 'pending') assert(patch.agent_session_id === current.agent_session_id, 'A research cannot switch agent sessions');
  if (['CLOSED','CANCELLED','FAILED','INTERRUPTED'].includes(current.run_status) && patch.run_status) assert(patch.run_status === current.run_status, 'Terminal research cannot be restarted');
  const next = { ...current, ...patch, updated_at: new Date().toISOString() } as ResearchRecord;
  writeJson(join(researchPath(project, id), 'manifest.json'), next);
  return next;
}
export function bindResearchSession(project: Project, id: string, sessionId: string) {
  assert(sessionId?.trim() && sessionId !== 'pending', 'A real session id is required');
  return updateResearch(project, id, { agent_session_id: sessionId, run_status: 'ACTIVE' });
}
export function assertResearchActive(project: Project, id: string, experimentId?: string) {
  const record = getResearch(project, id);
  assert(['ACTIVE','OUTPUT_FROZEN'].includes(record.run_status), 'Research is not active: ' + record.run_status);
  assert(Date.now() - Date.parse(record.created_at) < record.budget.max_wall_time_seconds * 1000, 'Research wall-time budget exhausted; do not start new experiments. Finish collecting already-started requests, compare existing evidence and submit in the same session. Determine the hypothesis verdict from evidence against the original criteria; budget exhaustion alone does not imply INCONCLUSIVE.');
  const experimentsDir = isWorkspace(project) ? targetPath(project, 'experiments', safeId(id)) : join(researchPath(project, id), 'experiments');
  if (experimentId && !existsSync(join(experimentsDir, safeId(experimentId)))) {
    const count = existsSync(experimentsDir) ? readdirSync(experimentsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0;
    assert(count < record.budget.max_experiments, 'Experiment budget exhausted; submit current evidence');
  }
  return record;
}
export function listResearch(project: Project): ResearchRecord[] {
  const dir = targetPath(project, 'research');
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'manifest.json'))).map(entry => getResearch(project, entry.name)) : [];
}

function normalizeAssignedHypothesis(input: unknown): AssignedHypothesis | undefined {
  if (input === undefined) return undefined;
  assert(input && typeof input === 'object' && !Array.isArray(input), 'hypothesis must be an object');
  const values = input as Record<string, unknown>;
  const strings = ['statement', 'scope', 'mechanism', 'intervention', 'measurement_plan'];
  const arrays = ['controls', 'predictions', 'support_criteria', 'refutation_criteria', 'confounders'];
  assert(typeof values.statement === 'string' && values.statement.trim().length > 0, 'hypothesis.statement is required');
  for (const [key, value] of Object.entries(values)) {
    assert(strings.includes(key) || arrays.includes(key), 'Unknown hypothesis field: ' + key);
    assert(strings.includes(key)
      ? typeof value === 'string' && value.trim().length > 0
      : Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0),
    'Invalid hypothesis field: ' + key);
    if (['predictions', 'support_criteria', 'refutation_criteria'].includes(key)) {
      assert((value as string[]).length > 0, 'Supplied hypothesis criteria cannot be empty: ' + key);
    }
  }
  return JSON.parse(JSON.stringify(values)) as AssignedHypothesis;
}
