import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Project, TargetRef } from './contracts.ts';
import type { CommitEnvelope } from './store.ts';
import { assert, hashObject, inside, readJson, sha256 } from './util.ts';
import { assertTarget, isWorkspace } from './workspace.ts';

export const migrationLockRef = '.meteor/migrations/active.lock';

/** A legacy snapshot is a read surface, never a new research or catalog writer. */
export type LegacyProject = Project & { legacy_read_only: true };
export interface LegacySubmissionGroup {
  project: LegacyProject;
  commits: CommitEnvelope[];
  origin: { migration_id: string; journal_ref: string };
}
export interface LegacyCatalog {
  source_root: string;
  path: string;
  hash: string;
  fingerprint: string;
  counts: Record<string, number>;
  commits: Array<{ submission_id: string; research_id: string; submission_hash: string }>;
  research: Array<{ research_id: string; run_status: string }>;
  events: Array<{ integration_event_id: string; status: string }>;
}

export function assertMigrationIdle(projectOrRoot: Project | string): void {
  const root = typeof projectOrRoot === 'string' ? projectOrRoot : projectOrRoot.root;
  assert(!existsSync(inside(root, migrationLockRef)), 'Workspace migration is in progress; finish or recover it before starting research');
  if (typeof projectOrRoot !== 'string') {
    assert(!(projectOrRoot as Partial<LegacyProject>).legacy_read_only, 'Legacy migration evidence is read-only');
  }
}

// immutable=1 never creates a journal or SHM file. An uncheckpointed WAL is an
// explicit blocker rather than silently reading an older database image.
export function readOnlyLegacyCatalog(knowledgeRoot: string): LegacyCatalog | undefined {
  const path = join(knowledgeRoot, 'catalog.sqlite');
  if (!existsSync(path)) return undefined;
  assert(!existsSync(path + '-wal') || statSync(path + '-wal').size === 0,
    'Legacy catalog has a nonempty WAL; quiesce its original runtime and checkpoint the catalog before migration');
  const bytes = readFileSync(path);
  const script = [
    'import hashlib,json,sqlite3,sys',
    'from pathlib import Path',
    'p=Path(sys.argv[1]).resolve()',
    'db=sqlite3.connect(p.as_uri()+"?mode=ro&immutable=1",uri=True)',
    'db.row_factory=sqlite3.Row',
    'tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}',
    'def rows(table,fields):',
    ' return [dict(r) for r in db.execute("SELECT "+fields+" FROM "+table)] if table in tables else []',
    'out=dict(fingerprint=hashlib.sha256("\\n".join(db.iterdump()).encode("utf-8")).hexdigest(),',
    ' counts={t:db.execute("SELECT COUNT(*) FROM \\\""+t.replace("\\\"","\\\"\\\"")+"\\\"").fetchone()[0] for t in tables if t not in ("metadata","targets")},',
    ' commits=rows("research_commits","submission_id,research_id,submission_hash"),',
    ' research=rows("research_runs","research_id,run_status"),events=rows("integration_events","integration_event_id,status"))',
    'print(json.dumps(out))',
    'db.close()',
  ].join('\n');
  const result = spawnSync(process.env.METEOR_PYTHON ?? 'python', ['-c', script, path], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert(result.status === 0, 'Read-only legacy catalog inspection failed: ' + (result.stderr || result.error?.message || result.stdout));
  assert(sha256(readFileSync(path)) === sha256(bytes), 'Legacy catalog changed during inspection');
  return { source_root: resolve(knowledgeRoot), path: resolve(path), hash: sha256(bytes), ...JSON.parse(result.stdout) };
}

/** Return only commits whose exact old bytes and original catalog row were frozen by a completed migration. */
export function trustedLegacySubmissions(project: Project): LegacySubmissionGroup[] {
  if (!isWorkspace(project) || !project.config.legacy) return [];
  const origin = readOrigin(project);
  if (!origin) return [];
  const { journal, journalRef, oldConfig, evidence } = origin;
  const groups: LegacySubmissionGroup[] = [];
  for (const entry of journal.legacy_commits ?? []) {
    const catalog = journal.catalogs.find((item: any) => item.data_root === entry.data_root);
    assert(catalog, 'Legacy commit has no catalog origin');
    verifyFile(project.root, catalog.path, catalog.hash);
    const row = catalog.commits.find((item: any) => item.submission_id === entry.submission_id);
    assert(row && row.submission_hash === entry.submission_hash && row.research_id === entry.research_id,
      'Legacy commit does not match the recorded source catalog');
    const commit = verifiedJson<CommitEnvelope>(project.root, entry.commit_ref, evidence);
    assert(commit.submission_id === entry.submission_id && commit.submission.research_id === entry.research_id
      && commit.submission_hash === entry.submission_hash && hashObject(commit.submission) === entry.submission_hash,
    'Legacy submission hash or research identity changed');
    assert(!commit.submission.target, 'Legacy source unexpectedly contains a workspace target');
    if (commit.submission.execution_backend !== project.config.execution.backend) continue;
    const config = entry.snapshot_config_ref
      ? verifiedJson<any>(project.root, entry.snapshot_config_ref, evidence) : structuredClone(oldConfig);
    const suite = verifiedJson<any>(project.root, entry.snapshot_suite_ref ?? journal.source_suite_ref, evidence);
    assert(config.schema_version === 1, 'Legacy source config must remain schema 1');
    assert(config.execution.backend === commit.submission.execution_backend, 'Legacy snapshot backend does not match its submission');
    const identities = entry.manifest_ref ? [verifiedJson<any>(project.root, entry.manifest_ref, evidence)] : commit.submission.submitted_kernels;
    for (const identity of identities) assert(suite.revision === identity.case_suite_revision
      && config.environment.environment_ref === identity.environment_ref
      && config.environment.measurement_protocol_ref === identity.measurement_protocol_ref,
    'Legacy snapshot identity does not match its research or kernel');
    for (const key of ['workspace', 'targets', 'default_target', 'design', 'legacy']) delete config[key];
    assert(project.config.legacy.data_roots.includes(entry.data_root) && journal.legacy_roots.includes(entry.data_root),
      'Legacy data root is not authorized by this migration');
    // Do not spread the new Project: its target/scope would silently reinterpret
    // old module paths and hashes. Keep the original snapshot and original root.
    const sourceProject: LegacyProject = {
      root: project.root, config, suite, dataRoot: inside(project.root, entry.data_root), legacy_read_only: true,
      ...(entry.snapshot_config_ref ? { snapshotRoot: dirname(inside(project.root, entry.snapshot_config_ref)) } : {}),
    };
    for (const ref of entry.evidence_refs ?? []) verifiedJson(project.root, ref, evidence);
    groups.push({ project: sourceProject, commits: [commit], origin: { migration_id: journal.migration_id, journal_ref: journalRef } });
  }
  return groups;
}

export function trustedLegacyCommit(project: Project, submissionId: string): { project: LegacyProject; commit: CommitEnvelope } | undefined {
  const found = trustedLegacySubmissions(project).flatMap(group => group.commits
    .filter(commit => commit.submission_id === submissionId).map(commit => ({ project: group.project, commit })));
  assert(found.length <= 1, 'Legacy submission id is ambiguous across source catalogs');
  return found[0];
}

export function verifyMigrationOrigin(project: Project): { migration_id: string; journal_ref: string } | undefined {
  if (!isWorkspace(project) || !project.config.legacy) return undefined;
  const origin = readOrigin(project);
  if (!origin) return undefined;
  const { journal, journalRef } = origin;
  return { migration_id: journal.migration_id, journal_ref: journalRef };
}

function readOrigin(project: Project) {
  const legacy = project.config.legacy!;
  const configPath = inside(project.root, legacy.config_ref);
  const checkpoint = dirname(dirname(configPath));
  assert(configPath === join(checkpoint, 'backup', 'meteor.config.json')
    && relative(inside(project.root, '.meteor/migrations'), checkpoint).split(/[\\/]/).every(part => part && part !== '..'),
  'Legacy config must refer to a migration checkpoint backup');
  const journalPath = join(checkpoint, 'journal.json');
  const journal = readJson<any>(journalPath);
  assert(journal.schema_version === 1 && journal.state === 'COMPLETED' && journal.legacy_read_only === true,
    'Legacy evidence requires a completed migration journal');
  assert(journal.target?.workspace_id === project.config.workspace!.workspace_id, 'Migration belongs to a different workspace');
  // Legacy provenance belongs to one op/dtype. Other registered targets simply
  // have no old candidates; a workspace-level config is not a target exemption.
  if (journal.target.op_id !== project.scope!.op_id || journal.target.dtype_id !== project.scope!.dtype_id) return undefined;
  assertTarget(project, journal.target as TargetRef, 'Migration origin');
  assert(journal.scope === [project.scope!.workspace_id, project.scope!.op_id, project.scope!.dtype_id].join('/'),
    'Migration scope does not match current target');
  assert(resolve(journal.root) === resolve(project.root) && journal.source_config_ref === legacy.config_ref,
    'Migration origin does not belong to this workspace/config');
  assert(hashObject([...legacy.data_roots].sort()) === hashObject([...journal.legacy_roots].sort()),
    'Legacy data roots differ from the completed migration');
  verifyFile(project.root, legacy.config_ref, journal.source_config_hash);
  let oldConfig = readJson<any>(configPath);
  if (journal.source_local_config_ref) {
    verifyFile(project.root, journal.source_local_config_ref, journal.source_local_config_hash);
    const local = readJson<any>(inside(project.root, journal.source_local_config_ref));
    oldConfig = { ...oldConfig, execution: { ...oldConfig.execution, ...local.execution },
      environment: { ...oldConfig.environment, ...local.environment } };
  }
  assert(oldConfig.schema_version === 1, 'Migration source is not a legacy config');
  const evidence = new Map<string, string>((journal.evidence_files ?? []).map((item: any) => [item.path, item.hash]));
  const journalRef = relative(project.root, journalPath).replaceAll('\\', '/');
  return { journal, journalRef, oldConfig, evidence };
}

function verifiedJson<T = unknown>(root: string, ref: string, evidence: Map<string, string>): T {
  const key = relative(root, inside(root, ref)).replaceAll('\\', '/');
  const expected = evidence.get(key);
  assert(expected, 'Legacy JSON evidence has no migration hash: ' + key);
  verifyFile(root, key, expected);
  return readJson<T>(inside(root, key));
}

function verifyFile(root: string, ref: string, hash: string): void {
  assert(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'Invalid migration file hash');
  assert(sha256(readFileSync(inside(root, ref))) === hash, 'Legacy evidence changed after migration: ' + ref);
}
