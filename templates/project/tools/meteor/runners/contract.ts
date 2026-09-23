import type { BuildReceipt, CaseStatus, KernelModule, Measurement, ProfileReceipt, Project, TestReceipt } from '../contracts.ts';

export type TestMode = 'probe' | 'full';

export interface MockFixture {
  fixture_id: string;
  build_status?: 'COMPLETED' | 'FAILED';
  build_error?: string;
  cases?: Record<string, {
    status?: CaseStatus;
    samples_us?: number[];
    reason?: string;
  }>;
  profile_metrics?: Record<string, Record<string, number>>;
}

export interface BuildRequest {
  project: Project;
  research_id: string;
  experiment_id: string;
  module: KernelModule;
  kernel_path: string;
  source_hash: string;
  rendered_source_hash: string;
  rendered_source?: string;
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

export interface TestRequest {
  project: Project;
  build: BuildReceipt;
  module: KernelModule;
  mode: TestMode;
  case_ids?: string[];
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

export interface ProfileRequest {
  project: Project;
  build: BuildReceipt;
  module: KernelModule;
  case_ids: string[];
  metrics: string[];
  fixture?: MockFixture | string;
  idempotency_key?: string;
  signal?: AbortSignal;
}

export interface Runner {
  build(request: BuildRequest): Promise<BuildReceipt>;
  test(request: TestRequest): Promise<TestReceipt>;
  profile(request: ProfileRequest): Promise<ProfileReceipt>;
  cancelRemote?(project: Project, remoteRequestId: string): Promise<{ status: 'CANCEL_REQUESTED' | 'UNKNOWN_REMOTE' | 'NOT_FOUND'; receipt?: unknown; raw_receipt_ref?: string; remote_release_confirmed: boolean; reason?: string }>;
  pollRemote?(project: Project, remoteRequestId: string): Promise<{ status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN_REMOTE' | 'NOT_FOUND'; receipt?: unknown; raw_receipt_ref?: string; remote_release_confirmed: boolean; reason?: string }>;
  collectRemote?(project: Project, remoteRequestId: string): Promise<{ status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN_REMOTE' | 'NOT_FOUND'; receipt?: unknown; raw_receipt_ref?: string; remote_release_confirmed: boolean; reason?: string }>;
  cancel?(idempotencyKey: string): Promise<{ status: 'CANCELLED' | 'UNKNOWN_REMOTE' | 'NOT_FOUND'; reason?: string }>;
  poll?(idempotencyKey: string): Promise<{ status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN_REMOTE'; reason?: string }>;
  collect?(idempotencyKey: string): Promise<unknown>;
}

export function normalizeFixture(fixture?: MockFixture | string): MockFixture {
  if (!fixture) return { fixture_id: 'mock-default-qmq-v1' };
  if (typeof fixture === 'string') return { fixture_id: fixture };
  return fixture;
}

export function selectCases(project: Project, mode: TestMode, caseIds?: string[]) {
  if (mode === 'full') return project.suite.cases;
  const wanted = caseIds && caseIds.length > 0 ? new Set(caseIds) : new Set(project.suite.cases.slice(0, 1).map(item => item.case_id));
  const known = new Set(project.suite.cases.map(item => item.case_id));
  for (const caseId of wanted) {
    if (!known.has(caseId)) throw new Error(`Unknown case_id: ${caseId}`);
  }
  return project.suite.cases.filter(item => wanted.has(item.case_id));
}

export function summarizeRows(rows: Measurement[], mode: TestMode, project: Project) {
  const accounting_complete = mode === 'full'
    && rows.length === project.suite.cases.length
    && rows.every(row => row.status !== 'NOT_RUN');
  return {
    accounting_complete,
    supported_correct_count: rows.filter(row => row.status === 'PASS').length,
    timed_case_count: rows.filter(row => row.status === 'PASS' && row.samples_us.length > 0).length,
  };
}
