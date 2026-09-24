import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { bindResearchSession, createResearch, getResearch, updateResearch, assertResearchActive } from '../templates/project/tools/meteor/research.ts';
import { loadSshProfile } from '../templates/project/tools/meteor/profiles.ts';
import { writeJson } from '../templates/project/tools/meteor/util.ts';

test('init is idempotent, preserves human changes, and starts unconfigured by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-init-'));
  const first = initProject(root, { git: false });
  assert.equal(first.state, 'setup_required');
  assert.equal(first.execution_backend, 'unconfigured');
  assert(first.created.includes('meteor.config.json'));
  const second = initProject(root, { git: false });
  assert.equal(second.created.length, 0);
  assert.equal(second.conflicts.length, 0);
  writeFileSync(join(root, 'prompts/meteor.md'), 'human customization');
  const third = initProject(root, { git: false });
  assert(third.conflicts.some(path => path.replaceAll('\\','/') === 'prompts/meteor.md'));
  assert.equal(readFileSync(join(root, 'prompts/meteor.md'), 'utf8'), 'human customization');
  assert.equal(loadProject(root).config.execution.backend, 'unconfigured');
  assert(!existsSync(join(root, '.git')));
});

test('one research preserves its session and pinned snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-session-'));
  initProject(root, { git: false, backend: 'mock' });
  const project = loadProject(root);
  const record = createResearch(project, { chief_id: 'chief', agent_session_id: 'pending', goal: 'Test a defined prediction' });
  bindResearchSession(project, record.research_id, 'original-session');
  assert.throws(() => bindResearchSession(project, record.research_id, 'replacement-session'), /cannot switch/);
  const pinned = readFileSync(join(project.snapshotRoot!, 'prompts/meteor.md'), 'utf8');
  writeFileSync(join(root, 'prompts/meteor.md'), 'next run prompt');
  assert.equal(readFileSync(join(project.snapshotRoot!, 'prompts/meteor.md'), 'utf8'), pinned);
  updateResearch(project, record.research_id, { run_status: 'PAUSED' });
  assert.throws(() => assertResearchActive(project, record.research_id), /not active/);
  updateResearch(project, record.research_id, { run_status: 'ACTIVE' });
  assert.equal(getResearch(project, record.research_id).agent_session_id, 'original-session');
  updateResearch(project, record.research_id, { run_status: 'CANCELLED' });
  assert.throws(() => updateResearch(project, record.research_id, { run_status: 'ACTIVE' }), /cannot be restarted/);
});

test('chief assignments are copied and cannot be changed after research creation', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-assignment-'));
  initProject(root, { git: false, backend: 'mock' });
  const project = loadProject(root);
  const hypothesis = { statement: 'Reuse reduces transfers', predictions: ['Fewer repeated transfers'] };
  const initialContext = { mode: 'specified', knowledge_refs: ['knowledge/notes.md'] };
  const record = createResearch(project, { chief_id: 'chief', agent_session_id: 'pending', goal: 'Test chief assignment',
    initial_context: initialContext, assigned_hypothesis: hypothesis });
  hypothesis.statement = 'Changed by caller';
  initialContext.knowledge_refs.push('another-file.md');
  assert.equal(getResearch(project, record.research_id).assigned_hypothesis?.statement, 'Reuse reduces transfers');
  assert.deepEqual(getResearch(project, record.research_id).initial_context?.knowledge_refs, ['knowledge/notes.md']);
  assert.throws(() => updateResearch(project, record.research_id, { assigned_hypothesis: hypothesis }), /pinned research assignment/);
  assert.throws(() => updateResearch(project, record.research_id, { initial_context: { mode: 'random' } }), /pinned research assignment/);
  assert.throws(() => createResearch(project, { chief_id: 'chief', agent_session_id: 'pending', goal: 'Invalid assignment', assigned_hypothesis: { statement: '' } }), /hypothesis.statement/);
  assert.throws(() => createResearch(project, { chief_id: 'chief', agent_session_id: 'pending', goal: 'Invalid criteria', assigned_hypothesis: { statement: 'A prediction', predictions: [] } }), /criteria cannot be empty/);
});

test('central SSH profiles permit aliases, reject embedded credentials, and never connect', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-profiles-'));
  const path = join(root, 'profiles.json');
  writeJson(path, { schema_version: 1, profiles: { dev: { ssh_alias: 'ascend-dev', remote_root: '/mnt/workspace/meteor' } } });
  assert.equal(loadSshProfile('dev', { profilesPath: path }).ssh_alias, 'ascend-dev');
  writeJson(path, { schema_version: 1, profiles: { dev: { ssh_alias: 'ascend-dev', remote_root: '/mnt/workspace/meteor', private_key: 'not-a-real-key' } } });
  assert.throws(() => loadSshProfile('dev', { profilesPath: path }), /credentials belong/);
  writeJson(path, { schema_version: 1, profiles: { dev: { ssh_alias: '-oProxyCommand=bad', remote_root: '/mnt/workspace/meteor' } } });
  assert.throws(() => loadSshProfile('dev', { profilesPath: path }), /Invalid SSH alias/);
});

test('local override cannot silently mix real and simulated environments', () => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-config-'));
  initProject(root, { git: false, backend: 'mock' });
  writeJson(join(root, '.meteor.local.json'), { execution: { backend: 'ssh', profile_ref: 'dev' } });
  assert.throws(() => loadProject(root), /simulation flag/);
  writeJson(join(root, '.meteor.local.json'), { password: 'not-a-real-secret' });
  assert.throws(() => loadProject(root), /overrides support/);
});
