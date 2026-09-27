import { resolve } from 'node:path';
import type { ProfileReceipt, Project } from './contracts.ts';
import { buildReceiptPath, experimentDir, loadBuildReceipt, receiptRef, selectRunner, validateBuildStillFresh } from './kernel-build.ts';
import type { MockFixture } from './runners/contract.ts';
import { assertResearchActive } from './research.ts';
import { assert, writeImmutable } from './util.ts';
import { assertHardwareReady } from './hardware.ts';
import { isWorkspace, targetPath, targetRef } from './workspace.ts';
import { assertMigrationIdle } from './legacy.ts';

export interface ProfileKernelInput {
  build_ref: string;
  case_ids: string[];
  metrics: string[];
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

export function profileReceiptPath(project: Project, receipt: ProfileReceipt): string {
  if (isWorkspace(project)) return targetPath(project, 'measurements', receipt.profile_id, 'receipt.json');
  return resolve(experimentDir(project, receipt.research_id, receipt.experiment_id), 'profiles', `${receipt.profile_id}.json`);
}

export async function profileKernel(project: Project, input: ProfileKernelInput): Promise<ProfileReceipt> {
  assertMigrationIdle(project);
  input.signal?.throwIfAborted();
  assert(input.case_ids.length > 0, 'profile requires at least one case_id');
  assert(input.metrics.length > 0, 'profile requires at least one metric');
  for (const metric of input.metrics) assert(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(metric), `Invalid profile metric: ${metric}`);
  if (project.config.execution.backend !== 'mock') {
    const report = assertHardwareReady(project);
    const allowed = report.result.supported_metrics ?? [];
    const unsupported = input.metrics.filter(metric => !allowed.includes(metric));
    assert(!unsupported.length, `Unsupported profile metrics: ${unsupported.join(', ')}. Allowed metrics on this device: ${allowed.join(', ')}. See hardware_report_ref for measurement meanings.`);
  }
  const knownCases = new Set(project.suite.cases.map(item => item.case_id));
  for (const caseId of input.case_ids) assert(knownCases.has(caseId), `Unknown profile case_id: ${caseId}`);
  const build = loadBuildReceipt(project, input.build_ref);
  assertResearchActive(project, build.research_id, build.experiment_id);
  const module = validateBuildStillFresh(project, build);
  const receipt = await selectRunner(project).profile({
    project,
    build,
    module,
    case_ids: input.case_ids,
    metrics: input.metrics,
    fixture: input.fixture,
    idempotency_key: input.idempotency_key,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const result: ProfileReceipt = { ...receipt, ...(targetRef(project) ? { target: targetRef(project) } : {}),
    build_ref: receiptRef(project, buildReceiptPath(project, build)) };
  writeImmutable(profileReceiptPath(project, result), result);
  return result;
}
