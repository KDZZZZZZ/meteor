import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { KnowledgeUpdate, Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission } from '../templates/project/tools/meteor/submit.ts';
import { listDbMaterials, storePaths } from '../templates/project/tools/meteor/store.ts';
import { normalizeInitialContext, sampleMaterials, selectInitialMaterials } from '../templates/project/tools/meteor/sampling.ts';
import { knowledgeScopeMatches, normalizeKnowledgeScope } from '../templates/project/tools/meteor/knowledge-scope.ts';
import { scopeKey, targetRef } from '../templates/project/tools/meteor/workspace.ts';
import { readJson, writeJson } from '../templates/project/tools/meteor/util.ts';

const range = { shape_id: 'm-small', dimensions: { m: { min: 2, max: 8 }, n: { min: 16, max: 64 }, k: { min: 32, max: 128 } } };

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-knowledge-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' });
  const config = readJson<any>(join(root, 'meteor.config.json'));
  const base = config.targets[0];
  const targets = [base, { ...base, dtype_id: 'other-dtype' }, { ...base, op_id: 'other-op' }];
  writeJson(join(root, 'meteor.config.json'), { ...config, targets });
  return { root, projects: targets.map(target => loadProject(root, target)) };
}

function claim(claim_id: string, scope_level?: KnowledgeUpdate['scope_level']): KnowledgeUpdate {
  return { claim_id, kind: 'observation', ...(scope_level ? { scope_level } : {}), statement: `Observation ${claim_id}`,
    scope: 'Author-declared mock scope; no real hardware or complete interval validation',
    evidence_refs: ['https://example.invalid/mock-background'], related_material_ids: [] };
}

function submission(project: Project, id: string, knowledge_updates: KnowledgeUpdate[]): Submission {
  createResearch(project, { research_id: id, agent_session_id: 'pending', chief_id: 'chief', goal: 'Knowledge catalog protocol fixture' });
  bindResearchSession(project, id, 'session');
  return {
    research_id: id, agent_session_id: 'session', execution_backend: 'mock', termination_reason: 'Mock fixture complete',
    hypothesis: { hypothesis_id: id, revision: 'h1', statement: 'Knowledge scopes remain independent', scope: 'Mock only',
      mechanism: 'Scope inheritance', intervention: 'Scoped catalog writes', controls: [], predictions: ['Independent identities'],
      support_criteria: ['Expected visibility'], refutation_criteria: ['Unexpected visibility'], confounders: ['Mock'],
      measurement_plan: 'Protocol checks', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'] },
    hypothesis_history: [], experiments: [{ experiment_id: id, hypothesis_revision: 'h1', question: 'Does scope isolation hold?',
      intervention: 'Fixture', controls: [], kernel_revisions: [], environment_ref: project.config.environment.environment_ref,
      full_size_test_refs: [], profile_refs: [], analysis: 'Mock protocol only', next_experiment: 'Real measurements' }],
    submitted_kernels: [], knowledge_updates,
    chief_report: { summary: 'Scope fixture', findings: [], unresolved: ['No real hardware validation'], next_steps: ['Real measurements'] },
  };
}

function publish(project: Project, id: string, claims: KnowledgeUpdate[]) {
  const input = submission(project, id, claims);
  const before = JSON.stringify(input);
  const prepared = prepareSubmission(project, input);
  const report = commitSubmission(project, prepared.prepared_submission_id, 'session');
  assert.equal(JSON.stringify(input), before, 'scope defaults never mutate authoritative submissions');
  return { input, prepared, report };
}

function sql(project: Project, query: string, params: unknown[] = []) {
  const script = 'import json,sqlite3,sys; p=json.load(sys.stdin); db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; result=[dict(r) for r in db.execute(p["sql"],p["params"])]; db.commit(); print(json.dumps(result))';
  const result = spawnSync('python', ['-B', '-c', script, join(storePaths(project).knowledgeRoot, 'catalog.sqlite')], {
    encoding: 'utf8', windowsHide: true, input: JSON.stringify({ sql: query, params }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function query(project: Project, extra: string[]) {
  const result = spawnSync('python', ['-B', join(project.root, 'knowledge/query.py'), storePaths(project).knowledgeRoot, 'claims', ...extra], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('formal commits materialize immutable knowledge at the four scope levels with source and evidence', t => {
  const { root, projects: [project] } = setup(t);
  const claims = [claim('hw', 'hardware'), claim('op', 'op'), claim('dtype', 'dtype'), { ...claim('shape', 'shape'), shape_range: range }];
  const result = publish(project, 'first', claims);
  const catalog = sql(project, 'SELECT * FROM knowledge_claims');
  const target = targetRef(project)!;
  const expected = { hardware: '.', op: target.op_id, dtype: `${target.op_id}/${target.dtype_id}`, shape: `${target.op_id}/${target.dtype_id}/${range.shape_id}` };
  for (const row of catalog) {
    const file = join(storePaths(project).knowledgeRoot, row.knowledge_ref);
    assert.equal(dirname(row.knowledge_ref).replaceAll('\\', '/'), expected[row.scope_level as keyof typeof expected]);
    const saved = readJson<any>(file);
    assert.deepEqual(saved.source.target, target);
    assert.equal(saved.source.submission_id, result.report.submission_id);
    assert.deepEqual(saved.evidence_refs, claims.find(item => item.claim_id === row.claim_id)!.evidence_refs);
    assert.equal(saved.scope_validation, 'author_declared', 'a scope or interval is not automatically proven by stored evidence');
    if (row.scope_level === 'shape') assert.deepEqual(saved.shape_range, range);
  }
  assert.ok(storePaths(project).knowledgeRoot.startsWith(join(root, '.meteor', 'mock')));
  assert.equal(existsSync(join(root, 'knowledge', catalog[0].knowledge_ref)), false, 'mock records cannot enter real HW knowledge');
  const originalFile = join(storePaths(project).knowledgeRoot, catalog.find((row: any) => row.claim_id === 'dtype').knowledge_ref);
  const original = readFileSync(originalFile);
  publish(project, 'second', [{ ...claim('dtype', 'dtype'), statement: 'A revised observation' }]);
  const revised = sql(project, 'SELECT knowledge_ref FROM knowledge_claims WHERE claim_id=?', ['dtype'])[0].knowledge_ref;
  assert.notEqual(join(storePaths(project).knowledgeRoot, revised), originalFile);
  assert.deepEqual(readFileSync(originalFile), original);
  assert.equal(readJson<any>(join(storePaths(project).commitRoot, result.report.submission_id + '.json')).submission.knowledge_updates[2].scope_level, 'dtype');
});

test('knowledge file conflicts roll back catalog publication and preserve evidence for the same submission retry', t => {
  const { projects: [project] } = setup(t);
  publish(project, 'existing-evidence', [claim('existing')]);
  const paths = storePaths(project);
  const previousClaim = sql(project, 'SELECT * FROM knowledge_claims WHERE claim_id=?', ['existing'])[0];
  const previousFile = join(paths.knowledgeRoot, previousClaim.knowledge_ref), previousBytes = readFileSync(previousFile);
  const input = submission(project, 'atomic-retry', [{ ...claim('existing'), statement: 'A revised observation' }, claim('blocked')]);
  const prepared = prepareSubmission(project, input), preparedBytes = readFileSync(prepared.submission_ref);
  const submissionId = `submission_${prepared.submission_hash.slice(0, 24)}`;
  const envelope = { ...readJson<any>(prepared.submission_ref), submission_id: submissionId,
    report_ref: join(paths.reportsRoot, input.research_id, `${submissionId}.json`) };
  const derived = spawnSync('python', ['-B', '-c',
    'import json,sys; sys.path.insert(0,sys.argv[1]); import store; envelope=json.load(sys.stdin); print(json.dumps([store.knowledge_document(envelope,claim)[0] for claim in envelope["submission"]["knowledge_updates"]]))',
    join(project.snapshotRoot!, 'knowledge')], { input: JSON.stringify(envelope), encoding: 'utf8', windowsHide: true });
  assert.equal(derived.status, 0, derived.stderr);
  const [firstFile, conflictFile] = (JSON.parse(derived.stdout) as string[]).map(ref => join(paths.knowledgeRoot, ref));
  const conflictBytes = Buffer.from('Existing conflicting fixture bytes must remain unchanged.\n');
  mkdirSync(dirname(conflictFile), { recursive: true });
  writeFileSync(conflictFile, conflictBytes, { flag: 'wx' });
  const tables = ['research_runs', 'hypotheses', 'hypothesis_revisions', 'experiments', 'knowledge_claims',
    'evidence_links', 'novelty_events', 'research_commits', 'research_reports', 'integration_events', 'integration_channels'];
  const catalog = () => Object.fromEntries(tables.map(table => [table, sql(project, `SELECT * FROM ${table} ORDER BY rowid`)]));
  const before = catalog();

  assert.throws(() => commitSubmission(project, prepared.prepared_submission_id, 'session'), /Immutable knowledge record has conflicting content/);
  assert.deepEqual(catalog(), before, 'No commit, claim, novelty or integration event may be published after a file write fails');
  assert.deepEqual(readFileSync(previousFile), previousBytes);
  assert.deepEqual(readFileSync(conflictFile), conflictBytes);
  assert.deepEqual(readFileSync(prepared.submission_ref), preparedBytes);
  assert.equal(existsSync(join(paths.commitRoot, `${submissionId}.json`)), false);
  assert.equal(existsSync(join(paths.integrationEventRoot, `integration_${prepared.submission_hash.slice(0, 24)}.json`)), false);
  const retainedBytes = readFileSync(firstFile);
  const preservedConflict = conflictFile + '.preserved';
  renameSync(conflictFile, preservedConflict);

  const report = commitSubmission(project, prepared.prepared_submission_id, 'session');
  assert.equal(report.submission_id, submissionId);
  assert.equal(sql(project, 'SELECT * FROM research_commits WHERE submission_id=?', [submissionId]).length, 1);
  assert.equal(sql(project, 'SELECT * FROM knowledge_claims WHERE submission_id=?', [submissionId]).length, 2);
  assert.equal(sql(project, 'SELECT * FROM integration_events WHERE submission_id=?', [submissionId]).length, 1);
  assert.deepEqual(readFileSync(firstFile), retainedBytes, 'Retry reuses an identical artifact left by the rolled-back transaction');
  assert.deepEqual(readFileSync(previousFile), previousBytes);
  assert.deepEqual(readFileSync(preservedConflict), conflictBytes);
  assert.equal(readJson<any>(conflictFile).source.submission_id, submissionId);
  const committed = catalog();
  commitSubmission(project, prepared.prepared_submission_id, 'session');
  assert.deepEqual(catalog(), committed, 'A successful retry remains idempotent');
});

test('default reuse inherits hardware and same-op scopes while dtype and shape remain bounded', t => {
  const { projects: [source, otherDtype, otherOp] } = setup(t);
  publish(source, 'scopes', [claim('hw', 'hardware'), claim('op', 'op'), claim('dtype'), { ...claim('shape', 'shape'), shape_range: range }]);
  const sampled = (project: Project, shape?: Record<string, number>) => sampleMaterials(project, { count: 20, seed: 7, shape });
  assert.deepEqual(sampled(source).selected.map(item => item.material_id).sort(), ['dtype', 'hw', 'op']);
  assert.deepEqual(sampled(otherDtype).selected.map(item => item.material_id).sort(), ['hw', 'op']);
  assert.deepEqual(sampled(otherOp).selected.map(item => item.material_id), ['hw']);
  for (const shape of [{ m: 2, n: 16, k: 32 }, { m: 8, n: 64, k: 128 }]) {
    const draw = sampled(source, shape);
    assert.ok(draw.selected.some(item => item.material_id === 'shape' && item.scope_match && item.usage === 'scope_match'));
    assert.ok(draw.selected.find(item => item.material_id === 'shape')!.source_refs.some(ref => /claim_[a-f0-9]+\.json$/.test(ref)));
  }
  const excludedShapes: Array<Record<string, number>> = [{ m: 1, n: 16, k: 32 }, { m: 9, n: 64, k: 128 }, { m: 4, n: 16 }];
  for (const shape of excludedShapes) {
    assert.equal(sampled(source, shape).selected.some(item => item.material_id === 'shape'), false);
  }
  const foreign = listDbMaterials(source).find(item => item.material_id === 'dtype')!;
  const selected = selectInitialMaterials(otherDtype, { mode: 'specified', knowledge_refs: [`sqlite://observation/${encodeURIComponent(foreign.material_key!)}`] });
  assert.equal(selected.selected[0].usage, 'inspiration_only');
  assert.equal(selected.selected[0].scope_match, false);
  assert.deepEqual(query(otherDtype, ['--target', scopeKey(otherDtype)]).map((row: any) => row.claim_id).sort(), ['hw', 'op']);
  assert.deepEqual(query(source, ['--target', scopeKey(source), '--level', 'shape']), []);
  assert.equal(query(source, ['--target', scopeKey(source), '--level', 'shape', '--shape', JSON.stringify({ m: 8, n: 64, k: 128 })])[0].claim_id, 'shape');
});

test('same claim IDs retain independent target identity and duplicate commits preserve novelty', t => {
  const { projects } = setup(t);
  for (const [index, project] of projects.entries()) publish(project, 'same-research', [{ ...claim('same-id'), statement: `Target ${index}` }]);
  assert.equal(sql(projects[0], 'SELECT * FROM knowledge_claims WHERE claim_id=?', ['same-id']).length, 3);
  assert.equal(new Set(sql(projects[0], 'SELECT knowledge_ref FROM knowledge_claims').map((row: any) => row.knowledge_ref)).size, 3);
  for (const [index, project] of projects.entries()) {
    assert.deepEqual(sampleMaterials(project, { count: 20, seed: 1 }).selected.map(item => item.statement), [`Target ${index}`]);
  }
  const before = sql(projects[0], 'SELECT * FROM novelty_events ORDER BY target_key, novelty_event_id');
  const commit = sql(projects[0], 'SELECT submission_id FROM research_commits WHERE target_key=?', [scopeKey(projects[0])])[0];
  const envelope = readJson<any>(join(storePaths(projects[0]).commitRoot, commit.submission_id + '.json'));
  commitSubmission(projects[0], envelope.prepared_submission_id, 'session');
  assert.deepEqual(sql(projects[0], 'SELECT * FROM novelty_events ORDER BY target_key, novelty_event_id'), before);
});

test('shape declarations require stable IDs and explicit bounds without promoting measurements into interval proof', t => {
  const { projects: [project] } = setup(t);
  const input = submission(project, 'invalid-scope', [claim('shape', 'shape')]);
  assert.throws(() => prepareSubmission(project, input), /shape_range/);
  for (const shape_range of [
    { shape_id: '../escape', dimensions: { m: { min: 1, max: 2 } } },
    { shape_id: 'empty', dimensions: {} },
    { shape_id: 'reverse', dimensions: { m: { min: 8, max: 2 } } },
    { shape_id: 'point-without-bounds', dimensions: { m: 4 } },
  ]) {
    assert.throws(() => normalizeKnowledgeScope({ scope_level: 'shape', shape_range: shape_range as any }));
  }
  assert.throws(() => normalizeKnowledgeScope({ scope_level: 'op', applicability: 'hardware' }));
  assert.throws(() => normalizeKnowledgeScope({ scope_level: 'dtype', shape_range: range }));
  assert.deepEqual(normalizeKnowledgeScope({}), { scope_level: 'dtype' });
  assert.deepEqual(normalizeKnowledgeScope({ applicability: 'hardware' }), { scope_level: 'hardware' });
  assert.deepEqual(normalizeInitialContext({ mode: 'random', shape: { m: 2, n: 16, k: 32 } }), { mode: 'random', shape: { m: 2, n: 16, k: 32 } });
  assert.throws(() => normalizeInitialContext({ shape: { m: 0 } }));
  assert.equal(knowledgeScopeMatches({ scope_level: 'shape', shape_range: range, target: targetRef(project) }, targetRef(project)), false);
});

test('v2 catalogs upgrade concurrently and repeatedly while preserving old dtype defaults, evidence and novelty', async t => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-old-knowledge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = resolve('templates/project/knowledge/store.py');
  const migrationRoot = dirname(store);
  const target = { workspace_id: 'old-hw', op_id: 'old-op', dtype_id: 'old-dtype' };
  const script = `import sqlite3,sys,json
from pathlib import Path
db=sqlite3.connect(Path(sys.argv[1])/'catalog.sqlite')
for revision in (1,2): db.executescript((Path(sys.argv[2])/'migrations'/f'{revision:04d}.sql').read_text())
db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES ('schema_version','2')")
db.execute('INSERT INTO targets VALUES (?,?,?,?)', ('old-hw/old-op/old-dtype','old-hw','old-op','old-dtype'))
for name,app in [('legacy-default','target'),('legacy-hw','hardware')]:
 db.execute('INSERT INTO knowledge_claims(target_key,claim_id,kind,statement,scope,submission_id,created_at,applicability) VALUES (?,?,?,?,?,?,?,?)', ('old-hw/old-op/old-dtype',name,'observation',name,'legacy','sub','2020-01-01',app))
db.execute('INSERT INTO novelty_events VALUES (?,?,?,?,?,?,?,?)', ('old-hw/old-op/old-dtype','old-event','legacy-default','mock','knowledge_update','old-hash','2020-01-01','sub'))
db.commit()
`;
  const seeded = spawnSync('python', ['-B', '-c', script, root, migrationRoot], { encoding: 'utf8', windowsHide: true });
  assert.equal(seeded.status, 0, seeded.stderr);
  const initialize = () => new Promise<void>((resolveRun, reject) => {
    const child = spawn('python', ['-B', store, 'init', root], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify({ target, workspace_root: root }));
  });
  await Promise.all([initialize(), initialize(), initialize()]);
  await initialize();
  const verified = spawnSync('python', ['-B', '-c', 'import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); print(json.dumps([list(db.execute("SELECT value FROM metadata WHERE key=\'schema_version\'").fetchone()),list(db.execute("SELECT claim_id,scope_level FROM knowledge_claims ORDER BY claim_id")),list(db.execute("SELECT novelty_event_id,created_at,content_hash FROM novelty_events"))]))', join(root, 'catalog.sqlite')], { encoding: 'utf8', windowsHide: true });
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), [['3'], [['legacy-default', 'dtype'], ['legacy-hw', 'hardware']], [['old-event', '2020-01-01', 'old-hash']]]);
});
