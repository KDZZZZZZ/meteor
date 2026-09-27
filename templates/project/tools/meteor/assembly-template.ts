import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { AssemblyTemplateRegistration, Project } from './contracts.ts';
import { validateAssemblyTemplateText, VERSION_TEMPLATE_SLOT_CONTRACT } from './assemble.ts';
import { assert, inside, safeId, sha256, writeJson, readJson } from './util.ts';
import { isWorkspace, targetRef } from './workspace.ts';

export interface ConfigureAssemblyTemplateInput {
  target?: { op_id: string; dtype_id: string; workspace_id?: string };
  source_path: string;
  template_id?: string;
  source_label?: string;
  now?: string;
}

export interface ConfigureAssemblyTemplateResult {
  target?: { op_id: string; dtype_id: string; workspace_id?: string };
  template_id: string;
  assembly_template_ref: string;
  assembly_template_hash: string;
  source_ref: string;
  slot_contract: typeof VERSION_TEMPLATE_SLOT_CONTRACT;
  status: 'CONFIGURED';
}

function rel(path: string): string { return path.replace(/\\/g, '/'); }

function resolveSource(project: Project, sourcePath: string): { absolute: string; source_ref: string } {
  assert(typeof sourcePath === 'string' && sourcePath.length > 0, 'source_path is required');
  const absolute = isAbsolute(sourcePath) ? sourcePath : inside(project.root, sourcePath);
  assert(existsSync(absolute), `Assembly template source does not exist: ${sourcePath}`);
  const source_ref = isAbsolute(sourcePath) ? absolute : rel(relative(project.root, absolute));
  return { absolute, source_ref };
}

function defaultTemplateId(sourceRef: string): string {
  const name = basename(sourceRef).replace(/\.asc(\.tmpl)?$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return safeId(name || 'assembly-template');
}

export function configureAssemblyTemplate(project: Project, input: ConfigureAssemblyTemplateInput): ConfigureAssemblyTemplateResult {
  assert(isWorkspace(project), 'Assembly template configuration is supported for schema_version 2 workspaces; legacy snapshots keep their frozen template');
  const scope = targetRef(project)!;
  if (input.target) {
    assert(input.target.op_id === scope.op_id && input.target.dtype_id === scope.dtype_id
      && (input.target.workspace_id === undefined || input.target.workspace_id === scope.workspace_id),
    'Assembly template configuration target does not match the bound workspace/op/dtype');
  }
  const { absolute, source_ref } = resolveSource(project, input.source_path);
  const text = readFileSync(absolute, 'utf8');
  validateAssemblyTemplateText(text);
  const hash = sha256(text);
  const templateId = safeId(input.template_id ?? defaultTemplateId(source_ref));
  const target = project.target!;
  const frozenRef = rel(join('templates', safeId(scope.op_id), safeId(scope.dtype_id), 'assembly', `${templateId}.version.asc.tmpl`));
  const frozenPath = inside(project.root, frozenRef);
  mkdirSync(dirname(frozenPath), { recursive: true });
  if (existsSync(frozenPath)) {
    const prior = readFileSync(frozenPath, 'utf8');
    assert(sha256(prior) === hash, `Frozen assembly template ${frozenRef} already exists with different content; choose a new template_id`);
  } else {
    writeFileSync(frozenPath, text, { flag: 'wx' });
  }
  const registration: AssemblyTemplateRegistration = {
    template_id: templateId,
    ref: frozenRef,
    sha256: hash,
    source_ref: input.source_label ?? source_ref,
    configured_at: input.now ?? new Date().toISOString(),
    slot_contract: VERSION_TEMPLATE_SLOT_CONTRACT,
  };
  const configPath = join(project.root, 'meteor.config.json');
  const config = readJson<any>(configPath);
  const targets = config.targets;
  assert(Array.isArray(targets), 'Workspace targets are required');
  const index = targets.findIndex((item: any) => item.op_id === target.op_id && item.dtype_id === target.dtype_id);
  assert(index >= 0, 'Current target is missing from meteor.config.json');
  targets[index] = { ...targets[index], assembly_template_ref: frozenRef, assembly_template: registration };
  writeJson(configPath, config);
  project.target = { ...target, assembly_template_ref: frozenRef, assembly_template: registration };
  project.config.targets = targets;
  return {
    target: scope,
    template_id: templateId,
    assembly_template_ref: frozenRef,
    assembly_template_hash: hash,
    source_ref: registration.source_ref,
    slot_contract: VERSION_TEMPLATE_SLOT_CONTRACT,
    status: 'CONFIGURED',
  };
}
