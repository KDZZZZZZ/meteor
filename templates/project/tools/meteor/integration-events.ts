import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, TargetRef } from './contracts.ts';
import { assertTarget } from './workspace.ts';
import { hashObject, readJson, safeId, writeImmutable, writeJson } from './util.ts';
import { integrateSubmission, type IntegrationResult } from './integrate.ts';
import { claimDbIntegrationEvent, finishDbIntegrationEventWithToken, integrationChannel, listDbIntegrationEvents, nowIso, storePaths } from './store.ts';

export type IntegrationEventStatus = 'QUEUED' | 'SELECTING' | 'ASSEMBLING' | 'ASSEMBLED' | 'SKIPPED' | 'NO_CHANGE' | 'FAILED';

export interface IntegrationEvent {
  target?: TargetRef;
  integration_event_id: string;
  submission_id: string;
  submission_hash: string;
  research_id: string;
  execution_backend: string;
  channel: string;
  status: IntegrationEventStatus;
  created_at: string;
  updated_at: string;
  report_ref: string;
  submitted_kernel_count: number;
  claim_token?: string;
  integration_result_ref?: string;
  error?: string;
  first_error?: string;
  last_error?: string;
  retryable?: boolean;
  failure_count?: number;
}

export interface IntegrationProcessingReport {
  processed: number;
  assembled: number;
  skipped: number;
  no_change: number;
  failed: number;
  results: IntegrationResult[];
}

const MAX_INTEGRATION_FAILURES = 3;

export async function processIntegrationEvents(project: Project): Promise<IntegrationProcessingReport> {
  const results: IntegrationResult[] = [];
  let failed = 0;
  const channel = integrationChannel(project);
  for (const dbEvent of listDbIntegrationEvents(project)) {
    if (dbEvent.channel !== channel) continue;
    if (!isAutoClaimable(dbEvent)) continue;
    const token = `claim_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const claimed = claimDbIntegrationEvent(project, dbEvent.integration_event_id, token);
    if (!claimed) continue;
    if (claimed.channel !== channel) throw new Error('Integration claim does not match the project channel');
    const path = join(storePaths(project).integrationEventRoot, `${claimed.integration_event_id}.json`);
    try {
      assertTarget(project, readJson<IntegrationEvent>(path).target, 'Integration event');
      setEventStatus(path, 'ASSEMBLING', { claim_token: token });
      const result = await integrateSubmission(project, claimed.submission_id, claimed.integration_event_id);
      finishDbIntegrationEventWithToken(project, claimed.integration_event_id, token, result.status, result.report_ref);
      setEventStatus(path, result.status, { integration_result_ref: result.report_ref, error: undefined });
      results.push(result);
    } catch (error) {
      failed++;
      const classification = classifyIntegrationFailure(error);
      const failureCount = Number(claimed.failure_count ?? 0) + 1;
      const retryable = classification.retryable && failureCount < MAX_INTEGRATION_FAILURES;
      const firstError = claimed.first_error ?? claimed.error ?? classification.message;
      writeAttempt(project, claimed, failureCount, classification, retryable);
      finishDbIntegrationEventWithToken(project, claimed.integration_event_id, token, 'FAILED', undefined,
        classification.message, retryable, classification.errorClass);
      setEventStatus(path, 'FAILED', {
        error: firstError,
        first_error: firstError,
        last_error: classification.message,
        retryable,
        failure_count: failureCount,
      });
    }
  }
  return {
    processed: results.length + failed,
    assembled: results.filter(result => result.status === 'ASSEMBLED').length,
    skipped: results.filter(result => result.status === 'SKIPPED').length,
    no_change: results.filter(result => result.status === 'NO_CHANGE').length,
    failed,
    results,
  };
}

function isAutoClaimable(event: Partial<IntegrationEvent>): boolean {
  if (!['QUEUED', 'SELECTING', 'ASSEMBLING', 'FAILED'].includes(String(event.status))) return false;
  if (event.status !== 'FAILED') return true;
  if (event.retryable === false) return false;
  return Number(event.failure_count ?? 0) < MAX_INTEGRATION_FAILURES;
}

function classifyIntegrationFailure(error: unknown): { message: string; retryable: boolean; errorClass: string } {
  const message = sanitizeIntegrationError(error instanceof Error ? error.message : String(error));
  if (/symbol_prefix|Duplicate module symbol prefix|Launcher mismatch/i.test(message)) {
    return { message, retryable: false, errorClass: 'PERMANENT_SYMBOL_PREFIX' };
  }
  if (/Frozen integration|Immutable (record|text|input).*conflict|Immutable .* conflict/i.test(message)) {
    return { message, retryable: false, errorClass: 'PERMANENT_IMMUTABLE_INPUT' };
  }
  if (/Integration measurement identity|data hash is stale|source hash is stale/i.test(message)) {
    return { message, retryable: false, errorClass: 'PERMANENT_EVIDENCE_IDENTITY' };
  }
  return { message, retryable: true, errorClass: 'TRANSIENT_OR_UNKNOWN' };
}

function writeAttempt(
  project: Project,
  event: IntegrationEvent,
  attemptNo: number,
  failure: { message: string; retryable: boolean; errorClass: string },
  retryable: boolean,
): void {
  const attemptId = `attempt_${hashObject({
    integration_event_id: event.integration_event_id,
    claim_token: event.claim_token ?? null,
    attempt_started_at: event.updated_at,
  }).slice(0, 24)}`;
  const path = join(storePaths(project).integrationEventRoot, `${event.integration_event_id}.${attemptId}.json`);
  writeImmutable(path, {
    ...(event.target ? { target: event.target } : {}),
    attempt_id: attemptId,
    integration_event_id: event.integration_event_id,
    submission_id: event.submission_id,
    channel: event.channel,
    attempt_no: attemptNo,
    status: 'FAILED',
    error_class: failure.errorClass,
    retryable,
    error: failure.message,
    recorded_at: event.updated_at ?? nowIso(),
  });
}

function sanitizeIntegrationError(message: string): string {
  return message.replace(/\r/g, ' ').replace(/\n/g, ' ').slice(0, 4000);
}

export function getIntegrationEvent(project: Project, eventId: string): IntegrationEvent | undefined {
  const path = join(storePaths(project).integrationEventRoot, `${safeId(eventId)}.json`);
  if (!existsSync(path)) return undefined;
  const event = readJson<IntegrationEvent>(path);
  assertTarget(project, event.target, 'Integration event');
  return event;
}

export function getIntegrationStatus(project: Project, eventId: string): IntegrationEvent | undefined {
  const event = getIntegrationEvent(project, eventId);
  if (!event) return undefined;
  const durable = listDbIntegrationEvents(project).find(item => item.integration_event_id === eventId);
  if (!durable) return event;
  // The catalog owns leases/retry eligibility; an older JSON projection may
  // predate its migration or the final projection write after a transaction.
  return {
    ...event,
    status: durable.status,
    updated_at: durable.updated_at,
    error: durable.error ?? undefined,
    first_error: durable.first_error ?? undefined,
    last_error: durable.last_error ?? undefined,
    retryable: durable.retryable,
    failure_count: durable.failure_count,
    integration_result_ref: durable.result_ref ?? event.integration_result_ref,
  };
}

function setEventStatus(path: string, status: IntegrationEventStatus, patch: Partial<IntegrationEvent> = {}): void {
  const current = existsSync(path) ? readJson<IntegrationEvent>(path) : {};
  writeJson(path, { ...current, ...patch, status, updated_at: nowIso() });
}
