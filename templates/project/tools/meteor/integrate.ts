import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Case, KernelModule, KernelSubmission, Project, TargetRef, TestReceipt } from './contracts.ts';
import { assert, hashObject, readJson, safeId, writeImmutable, writeJson, inside } from './util.ts';
import { renderVersion, type VersionSpec } from './assemble.ts';
import { computeSourceHash } from './kernel-build.ts';
import { readCommittedSubmissions, resolveEvidenceRef, storePaths } from './store.ts';
import { assertTarget, isWorkspace, targetRef } from './workspace.ts';
import { trustedLegacySubmissions } from './legacy.ts';

export type IntegrationStatus = 'ASSEMBLED' | 'SKIPPED' | 'NO_CHANGE';

export interface AssemblyRouteRule {
  case_id: string;
  shape: Case['shape'];
  kernel_id: string;
  revision: string;
  median_us: number;
  source: 'submitted' | 'historical';
}

export interface AssemblyInput {
  target?: TargetRef;
  integration_id: string;
  operator_abi: string;
  case_suite_revision: string;
  environment_ref: string;
  measurement_protocol_ref: string;
  integration_validation: 'NOT_RUN';
  route_rules: AssemblyRouteRule[];
  kernels: Array<{ submission: KernelSubmission; module: KernelModule }>;
}

export interface IntegrationResult {
  target?: TargetRef;
  integration_id: string;
  status: IntegrationStatus;
  integration_validation: 'NOT_RUN';
  reason?: string;
  inputs_ref: string;
  selections_ref: string;
  report_ref: string;
  version_spec_ref?: string;
  version_asc_ref?: string;
  route_rule_count: number;
}

interface Candidate {
  evidenceProject: Project;
  kernel: KernelSubmission;
  receipt: TestReceipt;
  source: 'submitted' | 'historical';
  committedOrder: number;
}

export async function integrateSubmission(project: Project, submissionId: string, integrationId?: string): Promise<IntegrationResult> {
  const paths = storePaths(project);
  const id = safeId(integrationId || `integration_${submissionId.replace(/^submission_/, '')}`);
  const outRoot = join(paths.integrationRoot, id);
  mkdirSync(outRoot, { recursive: true });
  const commits = readCommittedSubmissions(project);
  const current = commits.find(commit => commit.submission_id === submissionId);
  if (!current) throw new Error(`Committed submission not found: ${submissionId}`);
  const base = {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    integration_id: id,
    integration_validation: 'NOT_RUN' as const,
    inputs_ref: join(outRoot, 'inputs.json'),
    selections_ref: join(outRoot, 'selections.json'),
    report_ref: join(outRoot, 'report.json'),
    route_rule_count: 0,
  };
  writeImmutable(base.inputs_ref, {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    submission_id: submissionId,
    submission_hash: current.submission_hash,
    backend: project.config.execution.backend,
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    submitted_kernels: current.submission.submitted_kernels,
  });
  if (existsSync(base.report_ref)) {
    const prior = readJson<IntegrationResult>(base.report_ref);
    assertTarget(project, prior.target, 'Integration result');
    assert(prior.integration_id === id && ['ASSEMBLED', 'SKIPPED', 'NO_CHANGE'].includes(prior.status),
      'Frozen integration result identity is invalid');
    return prior;
  }
  if (current.submission.submitted_kernels.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'submission contains no kernels' });
  }

  const legacy = trustedLegacySubmissions(project).flatMap(group => collectCandidates(project, group.commits, current.submission_id, group.project));
  const candidates = [...legacy, ...collectCandidates(project, commits, current.submission_id)];
  candidates.forEach((candidate, index) => { candidate.committedOrder = index; });
  const submittedKeys = new Set(current.submission.submitted_kernels.map(kernelKey));
  const submittedCandidates = candidates.filter(candidate => submittedKeys.has(kernelKey(candidate.kernel)));
  if (submittedCandidates.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'no compatible completed submitted kernel measurements' });
  }

  const selected = existsSync(base.selections_ref)
    ? validateFrozenSelection(project, readJson(base.selections_ref), candidates, submittedKeys)
    : selectByExactCase(project, candidates, submittedKeys);
  if (selected.rules.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'no PASS case measurements available for exact shape routing' });
  }
  if (!selected.usesSubmitted) {
    writeImmutable(base.selections_ref, selected);
    return finish(base, { status: 'NO_CHANGE', reason: 'submitted kernels were not the fastest compatible recommended PASS candidate for any measured shape' });
  }
  if (isWorkspace(project) && !project.target?.assembly_template_ref) {
    writeImmutable(base.selections_ref, selected);
    return finish(base, { status: 'SKIPPED', reason: 'assembly template setup required: Chief must choose and configure an assembly_template_ref for this op/dtype before automatic version integration' });
  }

  const assemblyInput: AssemblyInput = {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    integration_id: id,
    operator_abi: project.suite.operator_abi,
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    integration_validation: 'NOT_RUN',
    route_rules: selected.rules,
    kernels: Array.from(new Map(selected.kernels.map(kernel => [kernelKey(kernel.submission), kernel])).values()),
  };
  writeImmutable(base.selections_ref, selected);
  const artifact = await renderAssembly(project, assemblyInput, outRoot);
  return finish(base, {
    status: 'ASSEMBLED',
    version_spec_ref: artifact.specRef,
    version_asc_ref: artifact.ascRef,
    route_rule_count: selected.rules.length,
  });
}

function collectCandidates(project: Project, commits: ReturnType<typeof readCommittedSubmissions>, currentSubmissionId: string, evidenceProject = project): Candidate[] {
  const candidates: Candidate[] = [];
  commits.forEach((commit, committedOrder) => {
    for (const kernel of commit.submission.submitted_kernels) {
      if (!isCompatible(project, kernel)) continue;
      const receipt = readJson<TestReceipt>(resolveEvidenceRef(evidenceProject, kernel.full_size_test_ref));
      assertTarget(evidenceProject, receipt.target, 'Integration measurement');
      assert(receipt.data_hash === hashObject(receipt.rows) && receipt.data_hash === kernel.data_hash
        && receipt.source_hash === kernel.source_hash && receipt.case_suite_revision === project.suite.revision
        && receipt.environment_ref === project.config.environment.environment_ref
        && receipt.measurement_protocol_ref === project.config.environment.measurement_protocol_ref,
      'Integration measurement identity or data hash is stale');
      if (receipt.status !== 'COMPLETED' || receipt.mode !== 'full' || !receipt.accounting_complete) {
        throw new Error(`Corrupt integration candidate ${kernelKey(kernel)}: full receipt is incomplete`);
      }
      candidates.push({
        evidenceProject,
        kernel,
        receipt,
        source: commit.submission_id === currentSubmissionId ? 'submitted' : 'historical',
        committedOrder,
      });
    }
  });
  return candidates;
}

function isCompatible(project: Project, kernel: KernelSubmission): boolean {
  return kernel.case_suite_revision === project.suite.revision
    && kernel.environment_ref === project.config.environment.environment_ref
    && kernel.measurement_protocol_ref === project.config.environment.measurement_protocol_ref;
}

function selectByExactCase(project: Project, candidates: Candidate[], submittedKeys: Set<string>) {
  const rules: AssemblyRouteRule[] = [];
  const kernels: Array<{ submission: KernelSubmission; module: KernelModule }> = [];
  let usesSubmitted = false;
  for (const testCase of project.suite.cases) {
    const ranked = candidates
      .map(candidate => {
        const row = candidate.receipt.rows.find(item => item.case_id === testCase.case_id);
        if (!row || row.status !== 'PASS' || typeof row.median_us !== 'number') return undefined;
        if (!candidate.kernel.recommended_case_ids.includes(testCase.case_id)) return undefined;
        return { candidate, median: row.median_us };
      })
      .filter((item): item is { candidate: Candidate; median: number } => Boolean(item))
      .sort((left, right) => left.median - right.median
        || (left.candidate.source === right.candidate.source ? 0 : left.candidate.source === 'historical' ? -1 : 1)
        || left.candidate.committedOrder - right.candidate.committedOrder);
    if (ranked.length === 0) continue;
    const chosen = ranked[0];
    if (submittedKeys.has(kernelKey(chosen.candidate.kernel))) usesSubmitted = true;
    kernels.push({ submission: chosen.candidate.kernel, module: loadSubmissionModule(chosen.candidate.evidenceProject, chosen.candidate.kernel) });
    rules.push({
      case_id: testCase.case_id,
      shape: testCase.shape,
      kernel_id: chosen.candidate.kernel.kernel_id,
      revision: chosen.candidate.kernel.revision,
      median_us: chosen.median,
      source: submittedKeys.has(kernelKey(chosen.candidate.kernel)) ? 'submitted' : 'historical',
    });
  }
  return { rules, kernels, usesSubmitted };
}

function validateFrozenSelection(project: Project, selected: ReturnType<typeof selectByExactCase>, candidates: Candidate[], submittedKeys: Set<string>) {
  assert(selected && Array.isArray(selected.rules) && Array.isArray(selected.kernels)
    && typeof selected.usesSubmitted === 'boolean', 'Frozen integration selection is invalid');
  const chosen = new Map<string, Candidate>();
  for (const kernel of selected.kernels) {
    const key = kernelKey(kernel.submission);
    const candidate = candidates.find(item => kernelKey(item.kernel) === key
      && hashObject(item.kernel) === hashObject(kernel.submission));
    assert(candidate, `Frozen integration candidate ${key} is missing or changed`);
    assert(hashObject(loadSubmissionModule(candidate.evidenceProject, candidate.kernel)) === hashObject(kernel.module),
      `Frozen integration module ${key} is changed`);
    chosen.set(key, candidate);
  }
  const cases = new Set<string>();
  for (const rule of selected.rules) {
    const candidate = chosen.get(kernelKey(rule));
    const testCase = project.suite.cases.find(item => item.case_id === rule.case_id);
    const row = candidate?.receipt.rows.find(item => item.case_id === rule.case_id);
    assert(!cases.has(rule.case_id) && testCase && hashObject(testCase.shape) === hashObject(rule.shape)
      && row?.status === 'PASS' && row.median_us === rule.median_us
      && candidate!.kernel.recommended_case_ids.includes(rule.case_id)
      && rule.source === (submittedKeys.has(kernelKey(rule)) ? 'submitted' : 'historical'),
    `Frozen integration route ${rule.case_id} does not match its measured candidate`);
    cases.add(rule.case_id);
  }
  assert(selected.usesSubmitted === selected.rules.some(rule => rule.source === 'submitted'),
    'Frozen integration selection has an inconsistent submitted marker');
  return selected;
}

async function renderAssembly(project: Project, input: AssemblyInput, outRoot: string): Promise<{ specRef: string; ascRef: string }> {
  const modules = input.kernels.map(item => item.module);
  const implementationIds = new Map(modules.map((module, index) => [kernelKey(module), index + 1]));
  const spec: VersionSpec = {
    assembly_key: input.integration_id,
    implementations: modules.map(module => ({
      implementation_id: implementationIds.get(kernelKey(module))!,
      module,
    })),
    routes: input.route_rules.map((rule, index) => ({
      rule_id: index + 1,
      implementation_id: implementationIds.get(`${rule.kernel_id}@${rule.revision}`)!,
      case_ids: [rule.case_id],
      shape: rule.shape,
    })),
  };
  const specRef = join(outRoot, isWorkspace(project) ? 'spec.json' : `${input.integration_id}.spec.json`);
  const ascRef = join(outRoot, isWorkspace(project) ? 'kernel.asc' : `${input.integration_id}.asc`);
  const specRecord = existsSync(specRef) ? readJson<any>(specRef) : {
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    schema_version: 1,
    integration_id: input.integration_id,
    integration_validation: input.integration_validation,
    case_suite_revision: input.case_suite_revision,
    environment_ref: input.environment_ref,
    measurement_protocol_ref: input.measurement_protocol_ref,
    assembly_template: project.target?.assembly_template_ref ? {
      ref: project.target.assembly_template_ref,
      sha256: project.target.assembly_template?.sha256,
      template_id: project.target.assembly_template?.template_id,
      slot_contract: project.target.assembly_template?.slot_contract,
    } : undefined,
    route_rules: input.route_rules,
    version_spec: spec,
  };
  writeImmutable(specRef, specRecord);
  const frozenProject = specRecord.assembly_template?.ref ? {
    ...project,
    target: project.target ? {
      ...project.target,
      assembly_template_ref: specRecord.assembly_template.ref,
      assembly_template: {
        template_id: specRecord.assembly_template.template_id,
        ref: specRecord.assembly_template.ref,
        sha256: specRecord.assembly_template.sha256,
        source_ref: specRecord.assembly_template.source_ref ?? specRecord.assembly_template.ref,
        configured_at: specRecord.assembly_template.configured_at ?? '',
        slot_contract: specRecord.assembly_template.slot_contract,
      },
    } : project.target,
  } as Project : project;
  writeImmutableText(ascRef, renderVersion(frozenProject, specRecord.version_spec));
  return { specRef, ascRef };
}

function finish(base: Omit<IntegrationResult, 'status'>, patch: Partial<IntegrationResult> & { status: IntegrationStatus }): IntegrationResult {
  const result: IntegrationResult = {
    ...base,
    status: patch.status,
    reason: patch.reason,
    version_spec_ref: patch.version_spec_ref,
    version_asc_ref: patch.version_asc_ref,
    route_rule_count: patch.route_rule_count ?? base.route_rule_count,
    integration_validation: 'NOT_RUN',
  };
  writeJson(base.report_ref, result);
  if ((patch.status === 'SKIPPED' || patch.status === 'NO_CHANGE') && !existsSync(base.selections_ref)) {
    writeJson(base.selections_ref, { rules: [], kernels: [], usesSubmitted: false });
  }
  return result;
}

function kernelKey(kernel: { kernel_id: string; revision: string }): string {
  return `${kernel.kernel_id}@${kernel.revision}`;
}

function loadSubmissionModule(project: Project, kernel: KernelSubmission): KernelModule {
  const moduleRef = kernel.artifact_refs.find(ref => ref.endsWith('/kernel.json') || ref.endsWith('\\kernel.json'));
  if (!moduleRef) throw new Error(`Submitted kernel ${kernelKey(kernel)} is missing a module manifest ref`);
  const module = readJson<KernelModule>(inside(project.root, moduleRef));
  if (isWorkspace(project)) assertTarget(project, module.target, 'Integration kernel');
  if (module.kernel_id !== kernel.kernel_id || module.revision !== kernel.revision) {
    throw new Error(`Submitted kernel ${kernelKey(kernel)} module manifest references ${kernelKey(module)}`);
  }
  const currentSourceHash = computeSourceHash(project, module);
  if (currentSourceHash !== kernel.source_hash) {
    throw new Error(`Submitted kernel ${kernelKey(kernel)} source hash is stale: current ${currentSourceHash}, submitted ${kernel.source_hash}`);
  }
  return module;
}

function writeImmutableText(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  if (existsSync(path)) {
    const prior = readFileSync(path, 'utf8');
    if (prior !== value) throw new Error(`Immutable text artifact conflict: ${path}`);
    return;
  }
  writeFileSync(path, value, { flag: 'wx' });
}
