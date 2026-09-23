import type { BuildReceipt, Measurement, ProfileReceipt, Project, TestReceipt } from '../contracts.ts';
import { hashObject, sha256 } from '../util.ts';
import type { BuildRequest, ProfileRequest, Runner, TestRequest } from './contract.ts';
import { normalizeFixture, selectCases, summarizeRows } from './contract.ts';

function deterministicMicros(seed: unknown): number {
  const hex = hashObject(seed).slice(0, 8);
  return 10 + (Number.parseInt(hex, 16) % 5000) / 10;
}

function samples(seed: unknown): number[] {
  const base = deterministicMicros(seed);
  return [base, base + 0.4, base + 0.8, base + 1.2, base + 1.6];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function fixtureSeed(project: Project, fixture: unknown) {
  return {
    fixture,
    case_suite_revision: project.suite.revision,
    cases: project.suite.cases.map(item => ({
      case_id: item.case_id,
      shape: item.shape,
      input_hash: item.input_hash,
      oracle_hash: item.oracle_hash,
    })),
    environment_ref: project.config.environment.environment_ref,
    measurement_protocol_ref: project.config.environment.measurement_protocol_ref,
  };
}

function validateSamples(values: number[], caseId: string): void {
  if (values.length === 0) throw new Error(`PASS case ${caseId} must include timing samples`);
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid timing sample for case ${caseId}`);
  }
}

function notRunRow(request: TestRequest, item: Project['suite']['cases'][number], reason: string): Measurement {
  return {
    case_id: item.case_id,
    status: 'NOT_RUN',
    samples_us: [],
    reason,
    actual_kernel_ref: request.build.kernel_ref,
    source_hash: request.build.source_hash,
    input_hash: item.input_hash,
    oracle_hash: item.oracle_hash,
  };
}

export class MockRunner implements Runner {
  async build(request: BuildRequest): Promise<BuildReceipt> {
    request.signal?.throwIfAborted();
    const fixture = normalizeFixture(request.fixture);
    const seed = fixtureSeed(request.project, fixture);
    const status = fixture.build_status ?? 'COMPLETED';
    return {
      build_id: sha256(hashObject({
        kind: 'mock-build',
        research_id: request.research_id,
        experiment_id: request.experiment_id,
        kernel_ref: { kernel_id: request.module.kernel_id, revision: request.module.revision },
        source_hash: request.source_hash,
        rendered_source_hash: request.rendered_source_hash,
        seed,
      })).slice(0, 24),
      research_id: request.research_id,
      experiment_id: request.experiment_id,
      kernel_ref: { kernel_id: request.module.kernel_id, revision: request.module.revision },
      source_hash: request.source_hash,
      artifact_hash: sha256(hashObject({
        rendered_source_hash: request.rendered_source_hash,
        backend: 'mock',
        seed,
      })),
      environment_ref: request.project.config.environment.environment_ref,
      execution_backend: 'mock',
      simulated: true,
      status,
      source_ref: request.kernel_path,
      module_ref: `${request.kernel_path.replace(/\\/g, '/')}/kernel.json`,
      fixture_id: fixture.fixture_id,
      error: status === 'FAILED' ? fixture.build_error ?? 'mock build failure' : undefined,
    };
  }

  async test(request: TestRequest): Promise<TestReceipt> {
    request.signal?.throwIfAborted();
    const fixture = normalizeFixture(request.fixture);
    const seed = fixtureSeed(request.project, fixture);
    const selected = selectCases(request.project, request.mode, request.case_ids);
    const supported = new Set(request.module.supported_case_ids);
    const buildProblem = request.build.status !== 'COMPLETED'
      ? `build ${request.build.build_id} is ${request.build.status}`
      : request.build.execution_backend !== 'mock'
        ? 'build backend is not mock'
        : request.build.environment_ref !== request.project.config.environment.environment_ref
          ? 'build environment does not match project environment'
          : undefined;
    const rows: Measurement[] = selected.map(item => {
      if (buildProblem) return notRunRow(request, item, buildProblem);
      const override = fixture.cases?.[item.case_id];
      const defaultStatus = supported.has(item.case_id) ? 'PASS' : 'UNSUPPORTED';
      const requestedStatus = override?.status ?? defaultStatus;
      const status = !supported.has(item.case_id) && requestedStatus === 'PASS' ? 'UNSUPPORTED' : requestedStatus;
      const rowSamples = status === 'PASS'
        ? override?.samples_us ?? samples({
          seed,
          case_id: item.case_id,
          build_id: request.build.build_id,
          source_hash: request.build.source_hash,
        })
        : [];
      if (status === 'PASS') validateSamples(rowSamples, item.case_id);
      return {
        case_id: item.case_id,
        status,
        samples_us: rowSamples,
        median_us: median(rowSamples),
        reason: override?.reason ?? (status === 'UNSUPPORTED' ? 'kernel manifest does not claim this case' : undefined),
        actual_kernel_ref: request.build.kernel_ref,
        source_hash: request.build.source_hash,
        input_hash: item.input_hash,
        oracle_hash: item.oracle_hash,
      };
    });
    const summary = summarizeRows(rows, request.mode, request.project);
    return {
      run_id: sha256(hashObject({
        kind: 'mock-test',
        build_id: request.build.build_id,
        mode: request.mode,
        case_ids: selected.map(item => item.case_id),
        seed,
      })).slice(0, 24),
      research_id: request.build.research_id,
      experiment_id: request.build.experiment_id,
      kernel_ref: request.build.kernel_ref,
      build_ref: `reports/meteor/mock/research/${request.build.research_id}/experiments/${request.build.experiment_id}/builds/${request.build.build_id}.json`,
      source_hash: request.build.source_hash,
      artifact_hash: request.build.artifact_hash,
      execution_backend: 'mock',
      simulated: true,
      fixture_id: fixture.fixture_id,
      case_suite_revision: request.project.suite.revision,
      environment_ref: request.project.config.environment.environment_ref,
      measurement_protocol_ref: request.project.config.environment.measurement_protocol_ref,
      mode: request.mode,
      status: buildProblem ? 'FAILED' : 'COMPLETED',
      rows,
      ...summary,
      data_hash: hashObject(rows),
    };
  }

  async profile(request: ProfileRequest): Promise<ProfileReceipt> {
    request.signal?.throwIfAborted();
    if (request.build.status !== 'COMPLETED') throw new Error(`Cannot profile failed build ${request.build.build_id}`);
    if (request.build.execution_backend !== 'mock') throw new Error('Mock profile requires a mock build receipt');
    if (request.build.environment_ref !== request.project.config.environment.environment_ref) throw new Error('Build environment does not match project environment');
    const fixture = normalizeFixture(request.fixture);
    const seed = fixtureSeed(request.project, fixture);
    const supported = new Set(request.module.supported_case_ids);
    for (const caseId of request.case_ids) {
      if (!supported.has(caseId)) throw new Error(`Cannot profile unsupported case ${caseId}`);
    }
    for (const metric of request.metrics) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(metric)) throw new Error(`Invalid profile metric: ${metric}`);
    }
    const metricOverrides = fixture.profile_metrics ?? {};
    const observations = request.case_ids.flatMap(case_id => request.metrics.map(metric => ({
      case_id,
      metric,
      value: metricOverrides[case_id]?.[metric] ?? deterministicMicros({
        seed,
        build_id: request.build.build_id,
        case_id,
        metric,
      }),
      unit: metric.endsWith('_bytes') ? 'bytes' : 'count',
    })));
    return {
      profile_id: sha256(hashObject({
        kind: 'mock-profile',
        build_id: request.build.build_id,
        case_ids: request.case_ids,
        metrics: request.metrics,
        seed,
      })).slice(0, 24),
      research_id: request.build.research_id,
      experiment_id: request.build.experiment_id,
      kernel_ref: request.build.kernel_ref,
      source_hash: request.build.source_hash,
      environment_ref: request.project.config.environment.environment_ref,
      execution_backend: 'mock',
      simulated: true,
      fixture_id: fixture.fixture_id,
      observations,
      instrumented: true,
    };
  }

  async cancel() {
    return { status: 'NOT_FOUND' as const, reason: 'mock requests complete synchronously' };
  }

  async poll() {
    return { status: 'COMPLETED' as const };
  }

  async collect() {
    return { status: 'COMPLETED' };
  }
}
