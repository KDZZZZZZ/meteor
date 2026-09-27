import { resolve } from 'node:path';
import type { TestReceipt } from './contracts.ts';
import { buildReceiptPath, experimentDir, loadBuildReceipt, receiptRef, selectRunner, validateBuildStillFresh } from './kernel-build.ts';
import type { MockFixture, TestMode } from './runners/contract.ts';
import type { Project } from './contracts.ts';
import { assertResearchActive } from './research.ts';
import { hashObject, writeImmutable } from './util.ts';
import { isWorkspace, targetPath, targetRef } from './workspace.ts';
import { assertMigrationIdle } from './legacy.ts';

export interface TestKernelInput {
  build_ref: string;
  mode: TestMode;
  case_ids?: string[];
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

export function testReceiptPath(project: Project, receipt: TestReceipt): string {
  if (isWorkspace(project)) return targetPath(project, 'measurements', receipt.run_id, 'receipt.json');
  return resolve(experimentDir(project, receipt.research_id, receipt.experiment_id), 'full-tests', `${receipt.run_id}.json`);
}

export async function testKernel(project: Project, input: TestKernelInput): Promise<TestReceipt> {
  assertMigrationIdle(project);
  input.signal?.throwIfAborted();
  const build = loadBuildReceipt(project, input.build_ref);
  assertResearchActive(project, build.research_id, build.experiment_id);
  const module = validateBuildStillFresh(project, build);
  const receipt = await selectRunner(project).test({
    project,
    build,
    module,
    mode: input.mode,
    case_ids: input.case_ids,
    fixture: input.fixture,
    idempotency_key: input.idempotency_key,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const path = testReceiptPath(project, receipt);
  const projectRelativeReceipt: TestReceipt = {
    ...receipt,
    ...(targetRef(project) ? { target: targetRef(project) } : {}),
    build_ref: receiptRef(project, buildReceiptPath(project, build)),
    data_hash: hashObject(receipt.rows),
  };
  writeImmutable(path, projectRelativeReceipt);
  return projectRelativeReceipt;
}
