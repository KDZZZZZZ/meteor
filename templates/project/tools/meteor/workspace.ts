import { join, resolve } from 'node:path';
import type { Project, TargetRef } from './contracts.ts';
import { assert, inside, safeId } from './util.ts';

export function isWorkspace(project: Project): boolean { return project.config.schema_version === 2; }

export function targetRef(project: Project): TargetRef | undefined {
  if (!isWorkspace(project)) return undefined;
  assert(project.scope?.workspace_id && project.scope.op_id && project.scope.dtype_id, 'Resolved workspace target is required');
  return { ...project.scope };
}

export function scopeKey(project: Project): string {
  const scope = targetRef(project);
  return scope ? [scope.workspace_id, scope.op_id, scope.dtype_id].map(safeId).join('/') : '';
}

export function assertTarget(project: Project, actual: TargetRef | undefined, label = 'Evidence'): void {
  const expected = targetRef(project);
  if (!expected) { assert(!actual, label + ' belongs to a workspace target, not this legacy project'); return; }
  assert(actual && actual.workspace_id === expected.workspace_id && actual.op_id === expected.op_id && actual.dtype_id === expected.dtype_id,
    label + ' target does not match the bound workspace/op/dtype');
}

/** Mock data is isolated; real targets share one workspace catalog and device. */
export function artifactRoot(project: Project): string {
  if (!isWorkspace(project)) return resolve(project.dataRoot);
  return project.config.execution.backend === 'mock' ? join(project.root, '.meteor', 'mock') : project.root;
}

export function targetPath(project: Project, kind: string, ...parts: string[]): string {
  const scope = targetRef(project);
  const root = scope ? join(artifactRoot(project), safeId(kind), safeId(scope.op_id), safeId(scope.dtype_id))
    : join(project.dataRoot, safeId(kind));
  return inside(root, parts.join('/'));
}

export function statePath(project: Project, kind: string, ...parts: string[]): string {
  const scope = targetRef(project);
  if (!scope) return inside(join(project.dataRoot, safeId(kind)), parts.join('/'));
  const root = project.config.execution.backend === 'mock' ? join(artifactRoot(project), 'state') : join(project.root, '.meteor', 'state');
  return inside(join(root, safeId(kind), safeId(scope.op_id), safeId(scope.dtype_id)), parts.join('/'));
}

export function knowledgePath(project: Project, ...parts: string[]): string {
  return inside(join(artifactRoot(project), 'knowledge'), parts.join('/'));
}

export function targetFile(project: Project, key: 'contract_ref' | 'oracle_ref' | 'adapter_ref' | 'template_ref' | 'case_suite_ref' | 'assembly_template_ref'): string {
  const legacy = { contract_ref: 'asc/operator.json', oracle_ref: 'tools/meteor/runners/remote/verify_case.py',
    adapter_ref: 'asc/operator.json', template_ref: 'asc', case_suite_ref: project.config.case_suite,
    assembly_template_ref: 'asc/version.asc.tmpl' };
  const value = key === 'assembly_template_ref' ? project.target?.assembly_template_ref : project.target?.[key];
  return inside(project.snapshotRoot ?? project.root, value ?? legacy[key]);
}
