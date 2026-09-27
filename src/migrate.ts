import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initProject } from './init.ts';
import { loadProject } from './project.ts';
import type { Project, TargetRef } from '../templates/project/tools/meteor/contracts.ts';
import { bindWorkspaceHardware, hardwareReady } from '../templates/project/tools/meteor/hardware.ts';
import { migrationLockRef, readOnlyLegacyCatalog, verifyMigrationOrigin, type LegacyCatalog } from '../templates/project/tools/meteor/legacy.ts';
import { assert, hashObject, inside, readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';

const researchTerminal = new Set(['CLOSED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
// FAILED events are retryable by the runtime, so they are not a quiet boundary.
const integrationTerminal = new Set(['COMPLETED', 'ASSEMBLED', 'NO_CHANGE', 'SKIPPED', 'CANCELLED']);
type FileHash = { path: string; hash: string };
type ManagedFile = { path: string; previous_hash: string | null; next_hash: string };
type Catalog = LegacyCatalog & { data_root: string; backend: string };
interface MigrationOptions {
  apply?: boolean;
  /** In-process fault injection for transaction tests; never exposed by the CLI. */
  afterPublishFile?: (path: string) => void;
}

/** Dry-run reads original bytes and immutable SQLite views; it creates no files. */
export function planMigration(directory: string) {
  const root = resolve(directory);
  if (readJson(join(root, 'meteor.config.json')).schema_version === 2) {
    const config = readJson(join(root, 'meteor.config.json'));
    const project = loadProject(root, config.targets?.[0]);
    const origin = verifyMigrationOrigin(project);
    return { root, state: 'already_current', blockers: [], legacy_roots: config.legacy?.data_roots ?? [], ...origin };
  }
  return inspectLegacy(root).plan;
}

function inspectLegacy(root: string) {
  const configPath = join(root, 'meteor.config.json');
  assert(readJson(configPath).schema_version === 1, 'Unsupported legacy config schema');
  const project = loadProject(root);
  const legacyRoots = ['ssh', 'mock', 'unconfigured'].map(backend => join(root, 'reports', 'meteor', backend)).filter(existsSync);
  const blockers: string[] = [];
  const runs = new Map<string, string>();
  const catalogs: Catalog[] = [];
  const evidence: FileHash[] = [];
  for (const legacyRoot of legacyRoots) {
    const dataRoot = ref(root, legacyRoot), backend = dataRoot.split('/').at(-1)!;
    for (const path of files(legacyRoot).filter(path => path.endsWith('.json'))) {
      const absolute = join(legacyRoot, path), local = path.replaceAll('\\', '/');
      evidence.push(fileHash(root, absolute));
      if (/^research\/[^/]+\/manifest\.json$/.test(local)) {
        const record = readJson(absolute);
        runs.set(dataRoot + '/' + record.research_id, record.run_status);
        if (!researchTerminal.has(record.run_status)) blockers.push(`Research ${record.research_id} is ${record.run_status}; reconcile its original session and remote requests before migration`);
      }
      if (/^integration-events\/[^/]+\.json$/.test(local)) {
        const event = readJson(absolute);
        if (!integrationTerminal.has(event.status)) blockers.push(`Integration event ${event.integration_event_id ?? event.event_id ?? local} is ${event.status}`);
      }
    }
    try {
      const catalog = readOnlyLegacyCatalog(join(legacyRoot, 'knowledge'));
      if (catalog) {
        catalogs.push({ ...catalog, data_root: dataRoot, backend });
        for (const run of catalog.research) if (!researchTerminal.has(run.run_status))
          blockers.push(`Catalog research ${run.research_id} is ${run.run_status}`);
        for (const event of catalog.events) if (!integrationTerminal.has(event.status))
          blockers.push(`Catalog integration event ${event.integration_event_id} is ${event.status}`);
      }
    } catch (error) { blockers.push(String((error as Error).message)); }
  }
  const populated = catalogs.filter(catalog => Object.values(catalog.counts).some(count => count > 0));
  if (populated.filter(catalog => catalog.backend !== 'mock').length > 1)
    blockers.push('Multiple nonempty legacy real-device catalogs require explicit source reconciliation before migration');
  const configuration = [fileHash(root, configPath), fileHash(root, inside(root, project.config.case_suite)),
    ...(existsSync(join(root, '.meteor.local.json')) ? [fileHash(root, join(root, '.meteor.local.json'))] : [])];
  const sourceHash = hashObject({ configuration, evidence, catalogs: catalogs.map(catalog => [catalog.data_root, catalog.hash, catalog.fingerprint]) });
  const plan = { root, state: blockers.length ? 'blocked' : 'ready', migration_id: 'workspace-v2-' + sourceHash.slice(0, 20),
    blockers: [...new Set(blockers)], legacy_roots: legacyRoots.map(path => ref(root, path)), research_count: runs.size,
    target: { op_id: 'qmq-v1', dtype_id: 'int8' }, case_suite_revision: project.suite.revision,
    case_count: project.suite.cases.length, source_hash: sourceHash, evidence_file_count: evidence.length,
    note: 'Original sources, receipts, snapshots and catalogs stay at their old paths. Dry-run creates no files, novelty, or integration events.' };
  return { plan, project, catalogs, evidence, configuration };
}

export function migrateProject(directory: string, options: MigrationOptions = {}) {
  if (!options.apply) return planMigration(directory);
  const root = resolve(directory);
  const lock = acquireLock(root);
  let journal: any, checkpoint: string | undefined, keepLock = false;
  try {
    if (readJson(join(root, 'meteor.config.json')).schema_version === 2) return planMigration(root);
    const before = inspectLegacy(root), plan = before.plan;
    assert(plan.blockers.length === 0, 'Migration blocked:\n' + plan.blockers.join('\n'));
    checkpoint = inside(root, '.meteor/migrations/' + plan.migration_id + '-' + lock.token);
    const staging = join(checkpoint, 'staged'), backup = join(checkpoint, 'backup');
    mkdirSync(backup, { recursive: true });
    journal = { schema_version: 1, ...plan, state: 'PREPARING', token: lock.token, started_at: new Date().toISOString(),
      checkpoint_ref: ref(root, checkpoint), files: [], legacy_read_only: true };
    writeJson(join(checkpoint, 'journal.json'), journal);
    lock.journal_ref = ref(root, join(checkpoint, 'journal.json'));
    writeJson(inside(root, migrationLockRef), lock);
    backupBytes(root, 'meteor.config.json', backup);
    if (existsSync(join(root, '.meteor.local.json'))) backupBytes(root, '.meteor.local.json', backup);
    initProject(staging, { git: false });
    const original = readJson(join(root, 'meteor.config.json'));
    const next = readJson(join(staging, 'meteor.config.json'));
    for (const key of ['execution', 'environment', 'sampling', 'budget', 'integration']) next[key] = original[key];
    next.legacy = { config_ref: ref(root, join(backup, 'meteor.config.json')), data_roots: plan.legacy_roots };
    const registration = next.targets[0];
    const target: TargetRef = { workspace_id: next.workspace.workspace_id, op_id: registration.op_id, dtype_id: registration.dtype_id };
    writeJson(join(staging, registration.case_suite_ref), before.project.suite);
    copyFileSync(inside(root, before.project.config.case_suite), join(backup, 'case-suite.json'));
    if (existsSync(join(root, 'asc/operator.json'))) copyFileSync(join(root, 'asc/operator.json'), join(staging, registration.contract_ref));
    writeJson(join(staging, 'meteor.config.json'), next);
    const env = before.project.config.environment;
    if (env.hardware_report_ref && existsSync(inside(root, env.hardware_report_ref))) {
      const report = readJson(inside(root, env.hardware_report_ref));
      if (env.hardware_report_hash === hashObject(report) && hardwareReady(report.result)) {
        bindWorkspaceHardware({ ...before.project, root: staging, config: next, target: registration, scope: target } as Project,
          report.result, env.hardware_report_ref);
      }
    }
    // The destination is detached until all imports/validation are successful.
    const imports: any[] = [];
    const byDestination = new Map<string, Catalog>();
    for (const catalog of before.catalogs) {
      const destination = catalog.backend === 'mock' ? '.meteor/mock/knowledge' : 'knowledge';
      const prior = byDestination.get(destination);
      if (!prior || Object.values(catalog.counts).some(count => count > 0)) byDestination.set(destination, catalog);
      const saved = join(backup, 'legacy-catalogs', catalog.backend, 'catalog.sqlite');
      mkdirSync(dirname(saved), { recursive: true }); copyFileSync(catalog.path, saved);
      assert(sha256(readFileSync(saved)) === catalog.hash, 'Catalog changed while checkpointing');
    }
    for (const [destination, catalog] of byDestination) {
      const result = spawnSync(process.env.METEOR_PYTHON ?? 'python', [join(staging, 'knowledge/store.py'), 'import-legacy',
        join(staging, destination), catalog.source_root], {
        input: JSON.stringify({ target }), encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      assert(result.status === 0, 'Catalog migration failed before publication: ' + (result.stderr || result.error?.message || result.stdout));
      const imported = JSON.parse(result.stdout);
      assert(imported.source_fingerprint === catalog.fingerprint && hashObject(imported.target) === hashObject(target), 'Imported catalog origin changed');
      imports.push({ destination, ...imported });
    }
    const evidence = [...before.evidence, fileHash(root, join(backup, 'case-suite.json'))];
    const legacyCommits = collectCommits(root, before.catalogs, evidence);
    const inventory = files(staging).filter(path => !/\.sqlite-(?:wal|shm)$/.test(path)).map(path => {
      noLinks(root, path);
      return { path: path.replaceAll('\\', '/'), previous_hash: existsSync(inside(root, path)) ? sha256(readFileSync(inside(root, path))) : null,
        next_hash: sha256(readFileSync(join(staging, path))) };
    });
    for (const entry of inventory) if (entry.previous_hash !== null) backupBytes(root, entry.path, backup);
    const current = inspectLegacy(root);
    assert(current.plan.source_hash === plan.source_hash && current.plan.blockers.length === 0, 'Legacy state changed during migration preparation');
    journal = { ...journal, state: 'PUBLISHING', target, scope: [target.workspace_id, target.op_id, target.dtype_id].join('/'),
      source_config_ref: next.legacy.config_ref, source_config_hash: sha256(readFileSync(join(backup, 'meteor.config.json'))),
      ...(existsSync(join(backup, '.meteor.local.json')) ? {
        source_local_config_ref: ref(root, join(backup, '.meteor.local.json')), source_local_config_hash: sha256(readFileSync(join(backup, '.meteor.local.json'))),
      } : {}), source_suite_ref: ref(root, join(backup, 'case-suite.json')),
      catalogs: before.catalogs.map(catalog => ({ ...catalog, path: ref(root, catalog.path), source_root: ref(root, catalog.source_root) })),
      imports, legacy_commits: legacyCommits, evidence_files: evidence, files: inventory };
    writeJson(join(checkpoint, 'journal.json'), journal);
    const configEntry = inventory.find(entry => entry.path === 'meteor.config.json')!;
    for (const entry of [...inventory.filter(entry => entry !== configEntry), configEntry]) {
      const destination = inside(root, entry.path);
      assert((existsSync(destination) ? sha256(readFileSync(destination)) : null) === entry.previous_hash, 'Managed destination changed during migration: ' + entry.path);
      if (entry.previous_hash !== entry.next_hash) atomicCopy(join(staging, entry.path), destination, lock.token);
      options.afterPublishFile?.(entry.path);
    }
    journal = { ...journal, state: 'COMPLETED', completed_at: new Date().toISOString(), workspace_id: target.workspace_id };
    writeJson(join(checkpoint, 'journal.json'), journal);
    return { ...plan, state: 'COMPLETED', workspace_id: target.workspace_id, checkpoint_ref: ref(root, checkpoint), legacy_read_only: true };
  } catch (error) {
    if (journal && checkpoint) {
      try { rollback(root, checkpoint, journal); }
      catch (rollbackError) {
        keepLock = true;
        writeJson(join(checkpoint, 'journal.json'), { ...journal, state: 'ROLLBACK_FAILED', error: String(error), rollback_error: String(rollbackError) });
        throw new Error('Migration rollback needs recovery; migration lock retained: ' + String(rollbackError), { cause: error });
      }
      writeJson(join(checkpoint, 'journal.json'), { ...journal, state: 'ROLLED_BACK', error: String(error), rolled_back_at: new Date().toISOString() });
    }
    throw error;
  } finally {
    if (!keepLock && existsSync(inside(root, migrationLockRef)) && readJson(inside(root, migrationLockRef)).token === lock.token)
      unlinkSync(inside(root, migrationLockRef));
  }
}

function collectCommits(root: string, catalogs: Catalog[], evidence: FileHash[]) {
  const evidencePaths = new Set(evidence.map(file => file.path));
  const result: any[] = [];
  for (const catalog of catalogs) {
    const commitRoot = inside(root, catalog.data_root + '/research-commits');
    const commits = existsSync(commitRoot) ? files(commitRoot).filter(path => path.endsWith('.json')).map(path => ({ path: join(commitRoot, path), value: readJson(join(commitRoot, path)) })) : [];
    for (const row of catalog.commits) {
      const matches = commits.filter(commit => commit.value.submission_id === row.submission_id);
      assert(matches.length === 1, 'Source catalog commit must have exactly one original JSON: ' + row.submission_id);
      const { path, value } = matches[0];
      assert(value.submission_hash === row.submission_hash && hashObject(value.submission) === row.submission_hash
        && value.submission.research_id === row.research_id && !value.submission.target, 'Legacy catalog/commit hash mismatch: ' + row.submission_id);
      const snapshot = inside(root, catalog.data_root + '/research/' + row.research_id + '/snapshot');
      const snapshotConfig = ref(root, join(snapshot, 'meteor.config.json')), snapshotSuite = ref(root, join(snapshot, 'case-suite.json'));
      assert(evidencePaths.has(snapshotConfig) === evidencePaths.has(snapshotSuite), 'Legacy research snapshot is incomplete');
      const related = new Set<string>();
      function visit(item: unknown) {
        if (Array.isArray(item)) { for (const child of item) visit(child); return; }
        if (item && typeof item === 'object') { for (const child of Object.values(item)) visit(child); return; }
        if (typeof item !== 'string') return;
        const artifact = /^artifact:\/\/([A-Za-z0-9_.-]+)\/([a-f0-9]+)$/.exec(item);
        if (!artifact && !item.endsWith('.json')) return;
        let candidate: string;
        try { candidate = inside(root, artifact ? `${catalog.data_root}/knowledge/artifacts/${artifact[1]}/${artifact[2].slice(0, 2)}/${artifact[2]}.json` : item); } catch { return; }
        if (!existsSync(candidate)) candidate = inside(root, catalog.data_root + '/' + item);
        if (!existsSync(candidate)) return;
        const key = ref(root, candidate);
        if (related.has(key)) return;
        related.add(key);
        if (!evidencePaths.has(key)) { evidence.push(fileHash(root, candidate)); evidencePaths.add(key); }
        visit(readJson(candidate));
      }
      visit(value);
      for (const file of evidence) if (file.path.startsWith(catalog.data_root + '/research/' + row.research_id + '/')) related.add(file.path);
      const manifestRef = ref(root, join(dirname(snapshot), 'manifest.json'));
      result.push({ ...row, data_root: catalog.data_root, commit_ref: ref(root, path),
        ...(evidencePaths.has(snapshotConfig) ? { snapshot_config_ref: snapshotConfig, snapshot_suite_ref: snapshotSuite } : {}),
        ...(evidencePaths.has(manifestRef) ? { manifest_ref: manifestRef } : {}), evidence_refs: [...related].sort() });
    }
  }
  return result;
}

function rollback(root: string, checkpoint: string, journal: any) {
  for (const entry of [...journal.files as ManagedFile[]].reverse()) {
    const destination = inside(root, entry.path);
    noLinks(root, entry.path);
    const temporary = destination + '.meteor-migrate-' + journal.token;
    if (existsSync(temporary)) { noLinks(root, ref(root, temporary)); unlinkSync(temporary); }
    const currentHash = existsSync(destination) ? sha256(readFileSync(destination)) : null;
    if (currentHash === entry.previous_hash) continue;
    assert(currentHash === entry.next_hash, 'Refusing to overwrite a file changed outside migration during rollback: ' + entry.path);
    if (entry.previous_hash === null) unlinkSync(destination);
    else {
      const backup = inside(join(checkpoint, 'backup'), entry.path);
      assert(sha256(readFileSync(backup)) === entry.previous_hash, 'Checkpoint backup changed: ' + entry.path);
      atomicCopy(backup, destination, journal.token);
    }
  }
}

function acquireLock(root: string): { token: string; pid: number; created_at: string; journal_ref?: string } {
  const path = inside(root, migrationLockRef);
  const lock = { token: randomUUID(), pid: process.pid, created_at: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const old = readJson(path);
    let alive = true;
    try { process.kill(old.pid, 0); } catch (error: any) { alive = error.code !== 'ESRCH'; }
    assert(!alive, 'Another migration is in progress (pid ' + old.pid + ')');
    const recovery = path + '.recovery';
    writeFileSync(recovery, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
    try {
      assert(readJson(path).token === old.token, 'Migration owner changed during recovery');
      if (old.journal_ref) {
        const journalPath = inside(root, old.journal_ref), journal = readJson(journalPath);
        assert(journal.token === old.token && resolve(journal.root) === root, 'Stale migration journal does not match its lock');
        if (journal.state === 'COMPLETED') verifyMigrationOrigin(loadProject(root, journal.target));
        else { rollback(root, dirname(journalPath), journal); writeJson(journalPath, { ...journal, state: 'ROLLED_BACK', recovered_at: new Date().toISOString() }); }
      }
      // Keep active.lock present throughout recovery and takeover; research start
      // never sees a gap between the dead owner and the new transaction.
      writeJson(path, lock);
      return lock;
    } finally { unlinkSync(recovery); }
  }
  writeFileSync(path, JSON.stringify(lock) + '\n', { flag: 'wx' });
  return lock;
}

function backupBytes(root: string, path: string, backup: string) {
  noLinks(root, path);
  const source = inside(root, path), saved = inside(backup, path), bytes = readFileSync(source);
  mkdirSync(dirname(saved), { recursive: true });
  if (existsSync(saved)) assert(sha256(readFileSync(saved)) === sha256(bytes), 'Checkpoint already contains different source bytes');
  else writeFileSync(saved, bytes, { flag: 'wx' });
}
function atomicCopy(source: string, destination: string, token: string) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = destination + '.meteor-migrate-' + token;
  try {
    writeFileSync(temporary, readFileSync(source), { flag: 'wx' });
    // Windows indexers/virus scanners can briefly hold a replaced file. Keep the
    // atomic rename and bound retries instead of deleting the destination first.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, destination); break; }
      catch (error: any) {
        if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function files(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    assert(!entry.isSymbolicLink(), 'Migration does not traverse symlinks');
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
    const local = join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...files(join(directory, entry.name), local));
    else found.push(local);
  }
  return found;
}
function noLinks(root: string, path: string) {
  let current = resolve(root);
  for (const part of relative(root, inside(root, path)).split(/[\\/]/)) {
    current = join(current, part);
    assert(!existsSync(current) || !lstatSync(current).isSymbolicLink(), 'Migration does not replace symlink paths');
  }
}
function fileHash(root: string, path: string): FileHash { return { path: ref(root, path), hash: sha256(readFileSync(path)) }; }
function ref(root: string, path: string) { return relative(root, path).replaceAll('\\', '/'); }
