import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './contracts.ts';
import { readJson, safeId, writeJson } from './util.ts';
import { integrateSubmission, type IntegrationResult } from './integrate.ts';
import { claimDbIntegrationEvent, finishDbIntegrationEventWithToken, integrationChannel, listDbIntegrationEvents, nowIso, storePaths } from './store.ts';

export type IntegrationEventStatus = 'QUEUED' | 'SELECTING' | 'ASSEMBLING' | 'ASSEMBLED' | 'SKIPPED' | 'NO_CHANGE' | 'FAILED';

export interface IntegrationEvent {
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
}

export interface IntegrationProcessingReport {
  processed: number;
  assembled: number;
  skipped: number;
  no_change: number;
  failed: number;
  results: IntegrationResult[];
}

export async function processIntegrationEvents(project: Project): Promise<IntegrationProcessingReport> {
  const results: IntegrationResult[] = [];
  let failed = 0;
  const channel = integrationChannel(project);
  for (const dbEvent of listDbIntegrationEvents(project)) {
    if (dbEvent.channel !== channel) continue;
    if (!['QUEUED', 'SELECTING', 'ASSEMBLING', 'FAILED'].includes(dbEvent.status)) continue;
    const token = `claim_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const claimed = claimDbIntegrationEvent(project, dbEvent.integration_event_id, token);
    if (!claimed) continue;
    if (claimed.channel !== channel) throw new Error('Integration claim does not match the project channel');
    const path = join(storePaths(project).integrationEventRoot, `${claimed.integration_event_id}.json`);
    try {
      setEventStatus(path, 'ASSEMBLING', { claim_token: token });
      const result = await integrateSubmission(project, claimed.submission_id, claimed.integration_event_id);
      finishDbIntegrationEventWithToken(project, claimed.integration_event_id, token, result.status, result.report_ref);
      setEventStatus(path, result.status, { integration_result_ref: result.report_ref, error: undefined });
      results.push(result);
    } catch (error) {
      failed++;
      finishDbIntegrationEventWithToken(project, claimed.integration_event_id, token, 'FAILED', undefined, (error as Error).message);
      setEventStatus(path, 'FAILED', { error: (error as Error).message });
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

export function getIntegrationEvent(project: Project, eventId: string): IntegrationEvent | undefined {
  const path = join(storePaths(project).integrationEventRoot, `${safeId(eventId)}.json`);
  return existsSync(path) ? readJson<IntegrationEvent>(path) : undefined;
}

export function getIntegrationStatus(project: Project, eventId: string): IntegrationEvent | undefined {
  return getIntegrationEvent(project, eventId);
}

function setEventStatus(path: string, status: IntegrationEventStatus, patch: Partial<IntegrationEvent> = {}): void {
  const current = existsSync(path) ? readJson<IntegrationEvent>(path) : {};
  writeJson(path, { ...current, ...patch, status, updated_at: nowIso() });
}
