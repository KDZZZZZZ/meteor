import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './contracts.ts';
import { readJson, safeId } from './util.ts';
import { getIntegrationEvent } from './integration-events.ts';
import { listJsonFiles, readCommittedSubmissions, readResearchManifest, storePaths } from './store.ts';

export interface EvidenceStatus {
  backend: string;
  research_id?: string;
  research?: unknown;
  prepared_submissions: number;
  committed_submissions: number;
  integration_events: Array<{
    integration_event_id: string;
    status: string;
    submission_id: string;
    integration_result_ref?: string;
    error?: string;
  }>;
  reports: string[];
}

export function getEvidenceStatus(project: Project, researchId?: string): EvidenceStatus {
  const paths = storePaths(project);
  const integrations = listJsonFiles(paths.integrationEventRoot)
    .map(path => readJson<any>(path))
    .filter(event => !researchId || event.research_id === researchId)
    .map(event => ({
      integration_event_id: event.integration_event_id,
      status: event.status,
      submission_id: event.submission_id,
      integration_result_ref: event.integration_result_ref,
      error: event.error,
    }));
  return {
    backend: project.config.execution.backend,
    research_id: researchId,
    research: researchId ? readResearchManifest(project, researchId) : undefined,
    prepared_submissions: listJsonFiles(paths.preparedRoot).length,
    committed_submissions: readCommittedSubmissions(project).filter(item => !researchId || item.submission.research_id === researchId).length,
    integration_events: integrations,
    reports: listJsonFiles(paths.reportsRoot).filter(path => !researchId || path.includes(`${researchId}`)),
  };
}

export function getPreparedSubmission(project: Project, preparedId: string): unknown | undefined {
  const path = join(storePaths(project).preparedRoot, `${safeId(preparedId)}.json`);
  return existsSync(path) ? readJson(path) : undefined;
}

export function getSubmissionReport(project: Project, submissionId: string): unknown | undefined {
  const commit = readCommittedSubmissions(project).find(item => item.submission_id === submissionId);
  return commit && existsSync(commit.report_ref) ? readJson(commit.report_ref) : undefined;
}

export function getIntegrationReport(project: Project, eventId: string): unknown | undefined {
  const event = getIntegrationEvent(project, eventId);
  if (!event?.integration_result_ref || !existsSync(event.integration_result_ref)) return undefined;
  return readJson(event.integration_result_ref);
}
