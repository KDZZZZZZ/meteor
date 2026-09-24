import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Submission } from './contracts.ts';
import { hashObject, inside, readJson, safeId, writeImmutable, writeJson } from './util.ts';

export interface StorePaths {
  backendRoot: string;
  preparedRoot: string;
  commitRoot: string;
  reportsRoot: string;
  integrationEventRoot: string;
  integrationRoot: string;
  knowledgeRoot: string;
  artifactRoot: string;
}

export interface ArtifactRef {
  ref: string;
  path: string;
  hash: string;
}

export interface CommitEnvelope {
  submission_id: string;
  prepared_submission_id: string;
  submission_hash: string;
  committed_at: string;
  agent_session_id: string;
  research_goal_met: boolean;
  submission: Submission;
  report_ref: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function storePaths(project: Project): StorePaths {
  const backendRoot = resolve(project.dataRoot);
  return {
    backendRoot,
    preparedRoot: join(backendRoot, 'prepared-submissions'),
    commitRoot: join(backendRoot, 'research-commits'),
    reportsRoot: join(backendRoot, 'research-reports'),
    integrationEventRoot: join(backendRoot, 'integration-events'),
    integrationRoot: join(backendRoot, 'integrations'),
    knowledgeRoot: join(backendRoot, 'knowledge'),
    artifactRoot: join(backendRoot, 'knowledge', 'artifacts'),
  };
}

export function ensureStore(project: Project): StorePaths {
  const paths = storePaths(project);
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  initKnowledgeStore(project);
  return paths;
}

export function artifactPath(project: Project, hash: string, kind = 'json'): string {
  safeId(hash);
  return join(storePaths(project).artifactRoot, kind, hash.slice(0, 2), `${hash}.json`);
}

export function writeArtifact(project: Project, kind: string, value: unknown): ArtifactRef {
  const paths = ensureStore(project);
  const hash = hashObject(value);
  const path = join(paths.artifactRoot, safeId(kind), hash.slice(0, 2), `${hash}.json`);
  writeImmutable(path, value);
  return { ref: `artifact://${kind}/${hash}`, path, hash };
}

export function readArtifactRef<T = unknown>(project: Project, ref: string): T {
  return readJson<T>(resolveEvidenceRef(project, ref));
}

export function resolveEvidenceRef(project: Project, ref: string): string {
  if (!ref || typeof ref !== 'string') throw new Error('Missing evidence ref');
  if (ref.startsWith('artifact://')) {
    const [, rest] = ref.split('artifact://');
    const parts = rest.split('/');
    if (parts.length !== 2) throw new Error(`Invalid artifact ref: ${ref}`);
    const [kind, hash] = parts;
    safeId(kind);
    safeId(hash);
    return join(storePaths(project).artifactRoot, kind, hash.slice(0, 2), `${hash}.json`);
  }
  const candidates: string[] = [];
  const resolved = resolve(ref);
  if (isInside(project.root, resolved) || isInside(project.dataRoot, resolved)) candidates.push(resolved);
  if (!isAbsoluteRef(ref)) {
    candidates.push(inside(project.root, ref));
    candidates.push(inside(project.dataRoot, ref));
  }
  const path = candidates.find(candidate => existsSync(candidate));
  if (!path) throw new Error(`Evidence ref not found: ${ref}`);
  return path;
}

export function listJsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const st = statSync(path);
      if (st.isDirectory()) stack.push(path);
      else if (name.endsWith('.json')) out.push(path);
    }
  }
  return out.sort();
}

export function readCommittedSubmissions(project: Project): CommitEnvelope[] {
  return listJsonFiles(storePaths(project).commitRoot)
    .map(path => readJson<CommitEnvelope>(path))
    .filter(envelope => envelope.submission.execution_backend === project.config.execution.backend)
    .filter(envelope => envelope.submission.hypothesis && envelope.submission.research_id);
}

export function researchManifestPath(project: Project, researchId: string): string {
  return join(project.dataRoot, 'research', safeId(researchId), 'manifest.json');
}

export function readResearchManifest<T = unknown>(project: Project, researchId: string): T | undefined {
  const path = researchManifestPath(project, researchId);
  return existsSync(path) ? readJson<T>(path) : undefined;
}

export function updateResearchManifest(project: Project, researchId: string, patch: Record<string, unknown>): void {
  const path = researchManifestPath(project, researchId);
  if (!existsSync(path)) return;
  const current = readJson<Record<string, unknown>>(path);
  writeJson(path, { ...current, ...patch });
}

export function initKnowledgeStore(project: Project): void {
  const script = knowledgeStoreScript(project);
  if (!existsSync(script)) throw new Error(`knowledge store script not found: ${script}`);
  const result = spawnSync('python', [script, 'init', storePaths(project).knowledgeRoot], knowledgeProcessOptions());
  if (result.status !== 0) throw new Error(`knowledge store init failed: ${result.stderr || result.stdout}`);
}

export function importSubmissionToKnowledge(project: Project, commitPath: string): void {
  const script = knowledgeStoreScript(project);
  if (!existsSync(script)) throw new Error(`knowledge store script not found: ${script}`);
  const result = spawnSync('python', [script, 'import-submission', storePaths(project).knowledgeRoot, commitPath], knowledgeProcessOptions());
  if (result.status !== 0) throw new Error(`knowledge store import failed: ${result.stderr || result.stdout}`);
}

export function commitSubmissionTransaction(project: Project, payload: unknown): void {
  const result = runKnowledgeCommand(project, 'commit-submission', payload);
  if (!result.ok) throw new Error(String(result.error || 'knowledge commit failed'));
}

export function listDbIntegrationEvents(project: Project): any[] {
  const result = runKnowledgeCommand(project, 'list-events', { backend: project.config.execution.backend });
  return Array.isArray(result.events) ? result.events : [];
}

export function integrationChannel(project: Project): string {
  return [
    project.config.execution.backend,
    project.suite.operator_abi,
    project.suite.revision,
    project.config.environment.environment_ref,
    project.config.environment.measurement_protocol_ref,
  ].join('|');
}

export function claimDbIntegrationEvent(project: Project, eventId: string, token: string): any | undefined {
  const result = runKnowledgeCommand(project, 'claim-event', { event_id: eventId, token, channel: integrationChannel(project) });
  return result.claimed ? result.event : undefined;
}

export function finishDbIntegrationEvent(project: Project, eventId: string, status: string, resultRef?: string, error?: string): void {
  runKnowledgeCommand(project, 'finish-event', { event_id: eventId, token: currentLeaseToken(project, eventId), status, result_ref: resultRef, error });
}

export function finishDbIntegrationEventWithToken(project: Project, eventId: string, token: string, status: string, resultRef?: string, error?: string): void {
  const result = runKnowledgeCommand(project, 'finish-event', { event_id: eventId, token, status, result_ref: resultRef, error });
  if (result.ok === false) throw new Error(String(result.error || 'integration lease finish failed'));
}

export interface StoreMaterial {
  material_id: string;
  kind: string;
  statement: string;
  scope: string;
  submission_id: string;
  last_novelty_event_at: string;
}

export function listDbMaterials(project: Project): StoreMaterial[] {
  const result = runKnowledgeCommand(project, 'list-materials', { backend: project.config.execution.backend });
  return Array.isArray(result.materials) ? result.materials : [];
}

function runKnowledgeCommand(project: Project, command: string, payload: unknown): any {
  const script = knowledgeStoreScript(project);
  if (!existsSync(script)) throw new Error(`knowledge store script not found: ${script}`);
  const result = spawnSync('python', [script, command, storePaths(project).knowledgeRoot], {
    ...knowledgeProcessOptions(),
    input: JSON.stringify(payload),
  });
  if (result.status !== 0) throw new Error(`knowledge store ${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : { ok: true };
}

function knowledgeProcessOptions() {
  return {
    encoding: 'utf8' as const,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  };
}

function currentLeaseToken(project: Project, eventId: string): string | undefined {
  return listDbIntegrationEvents(project).find(event => event.integration_event_id === eventId)?.claim_token;
}

function knowledgeStoreScript(project: Project): string {
  const roots = [
    project.snapshotRoot,
    project.root,
    join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  ].filter((value): value is string => Boolean(value));
  const found = roots.map(root => join(root, 'knowledge', 'store.py')).find(path => existsSync(path));
  return found ?? join(project.root, 'knowledge', 'store.py');
}

function isAbsoluteRef(ref: string): boolean {
  return resolve(ref) === ref || /^[A-Za-z]:[\\/]/.test(ref);
}

function isInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root).toLowerCase();
  const resolvedPath = resolve(path).toLowerCase();
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
}

export function materialIdFromRef(ref: string): string {
  return basename(ref).replace(/\.json$/, '');
}
