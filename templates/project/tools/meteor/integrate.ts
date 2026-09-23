import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Case, KernelModule, KernelSubmission, Project, TestReceipt } from './contracts.ts';
import { readJson, safeId, writeImmutable, writeJson, inside } from './util.ts';
import { renderVersion, type VersionSpec } from './assemble.ts';
import { computeSourceHash } from './kernel-build.ts';
import { readCommittedSubmissions, resolveEvidenceRef, storePaths } from './store.ts';

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
    integration_id: id,
    integration_validation: 'NOT_RUN' as const,
    inputs_ref: join(outRoot, 'inputs.json'),
    selections_ref: join(outRoot, 'selections.json'),
    report_ref: join(outRoot, 'report.json'),
    route_rule_count: 0,
  };
  writeImmutable(base.inputs_ref, {
    submission_id: submissionId,
    submission_hash: current.submission_hash,
    backend: project.config.execution.backend,
    case_suite_revision: project.suite.revision,
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
    submitted_kernels: current.submission.submitted_kernels,
  });
  if (current.submission.submitted_kernels.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'submission contains no kernels' });
  }

  const candidates = collectCandidates(project, commits, current.submission_id);
  const submittedKeys = new Set(current.submission.submitted_kernels.map(kernelKey));
  const submittedCandidates = candidates.filter(candidate => submittedKeys.has(kernelKey(candidate.kernel)));
  if (submittedCandidates.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'no compatible completed submitted kernel measurements' });
  }

  const selected = selectByExactCase(project, candidates, submittedKeys);
  if (selected.rules.length === 0) {
    return finish(base, { status: 'SKIPPED', reason: 'no PASS case measurements available for exact shape routing' });
  }
  if (!selected.usesSubmitted) {
    writeImmutable(base.selections_ref, selected);
    return finish(base, { status: 'NO_CHANGE', reason: 'submitted kernels did not beat compatible historical incumbents outside near-tie threshold' });
  }

  const assemblyInput: AssemblyInput = {
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

function collectCandidates(project: Project, commits: ReturnType<typeof readCommittedSubmissions>, currentSubmissionId: string): Candidate[] {
  const candidates: Candidate[] = [];
  commits.forEach((commit, committedOrder) => {
    for (const kernel of commit.submission.submitted_kernels) {
      if (!isCompatible(project, kernel)) continue;
      const receipt = readJson<TestReceipt>(resolveEvidenceRef(project, kernel.full_size_test_ref));
      if (receipt.status !== 'COMPLETED' || receipt.mode !== 'full' || !receipt.accounting_complete) {
        throw new Error(`Corrupt integration candidate ${kernelKey(kernel)}: full receipt is incomplete`);
      }
      candidates.push({
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
  const minRelativeImprovement = project.config.integration.min_relative_improvement;
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
      .sort((left, right) => left.median - right.median || left.candidate.committedOrder - right.candidate.committedOrder);
    if (ranked.length === 0) continue;
    let chosen = ranked[0];
    const incumbent = ranked.find(item => !submittedKeys.has(kernelKey(item.candidate.kernel)));
    if (incumbent) {
      const needed = incumbent.median * (1 - minRelativeImprovement);
      if (chosen.median >= needed) chosen = incumbent;
    }
    if (submittedKeys.has(kernelKey(chosen.candidate.kernel))) usesSubmitted = true;
    kernels.push({ submission: chosen.candidate.kernel, module: loadSubmissionModule(project, chosen.candidate.kernel) });
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
  const specRef = join(outRoot, `${input.integration_id}.spec.json`);
  const ascRef = join(outRoot, `${input.integration_id}.asc`);
  writeJson(specRef, {
    schema_version: 1,
    integration_id: input.integration_id,
    integration_validation: input.integration_validation,
    case_suite_revision: input.case_suite_revision,
    environment_ref: input.environment_ref,
    measurement_protocol_ref: input.measurement_protocol_ref,
    route_rules: input.route_rules,
    version_spec: spec,
  });
  writeImmutableText(ascRef, renderVersion(project, spec));
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
  if (patch.status === 'SKIPPED' || patch.status === 'NO_CHANGE') writeJson(base.selections_ref, { rules: [], kernels: [], usesSubmitted: false });
  return result;
}

function kernelKey(kernel: { kernel_id: string; revision: string }): string {
  return `${kernel.kernel_id}@${kernel.revision}`;
}

function loadSubmissionModule(project: Project, kernel: KernelSubmission): KernelModule {
  const moduleRef = kernel.artifact_refs.find(ref => ref.endsWith('/kernel.json') || ref.endsWith('\\kernel.json'));
  if (!moduleRef) throw new Error(`Submitted kernel ${kernelKey(kernel)} is missing a module manifest ref`);
  const module = readJson<KernelModule>(inside(project.root, moduleRef));
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
