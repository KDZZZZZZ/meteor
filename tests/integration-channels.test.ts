import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission } from '../templates/project/tools/meteor/submit.ts';
import { getIntegrationEvent, processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { claimDbIntegrationEvent, listDbIntegrationEvents, storePaths } from '../templates/project/tools/meteor/store.ts';
import { readJson } from '../templates/project/tools/meteor/util.ts';

function queuedResearch(project: Project, id: string) {
  const session = `session-${id}`;
  createResearch(project, { research_id: id, chief_id: 'chief', agent_session_id: session, goal: 'Preserve untested research evidence' });
  const submission: Submission = {
    research_id: id, agent_session_id: session, execution_backend: project.config.execution.backend,
    termination_reason: 'No measured kernel is available',
    hypothesis: {
      hypothesis_id: `hypothesis-${id}`, revision: 'h1', statement: 'Tiling could reduce latency', scope: 'Fixed case suite',
      mechanism: 'Data reuse', intervention: 'Change tiling', controls: [], predictions: ['Latency decreases'],
      support_criteria: ['Controlled measurements agree'], refutation_criteria: ['Controlled measurements disagree'],
      confounders: [], measurement_plan: 'Measure independent kernels', verdict: 'INCONCLUSIVE',
      supporting_evidence: [], counterevidence: [], limitations: ['No real measurements'],
    },
    hypothesis_history: [],
    experiments: [{ experiment_id: 'planning', hypothesis_revision: 'h1', question: 'Can tiling help?', intervention: 'Plan tiling',
      controls: [], kernel_revisions: [], environment_ref: project.config.environment.environment_ref,
      full_size_test_refs: [], profile_refs: [], analysis: 'No execution was attempted', next_experiment: 'Measure a kernel' }],
    submitted_kernels: [], knowledge_updates: [],
    chief_report: { summary: 'Evidence is inconclusive', findings: [], unresolved: ['Measurements'], next_steps: ['Run the planned experiment'] },
  };
  const prepared = prepareSubmission(project, submission);
  return commitSubmission(project, prepared.prepared_submission_id, session);
}

function projectFixture(): Project {
  const root = mkdtempSync(join(tmpdir(), 'meteor-integration-channels-'));
  initProject(root, { git: false, backend: 'mock' });
  return loadProject(root);
}

test('integration leaves other channels queued for their original research snapshots', async () => {
  const original = projectFixture();
  const prior = queuedResearch(original, 'original');
  const variants: Array<[string, (project: Project) => void]> = [
    ['environment', project => { project.config.environment.environment_ref += '-new'; }],
    ['suite', project => { project.suite.revision += '-new'; }],
    ['protocol', project => { project.config.environment.measurement_protocol_ref += '-new'; }],
  ];
  for (const [name, change] of variants) {
    const current = loadProject(original.root);
    change(current);
    const next = queuedResearch(current, name);
    const processed = await processIntegrationEvents(current);
    assert.equal(processed.processed, 1, `${name} processor must consume only its own channel`);
    assert.equal(getIntegrationEvent(current, next.integration_event_id)?.status, 'SKIPPED');
    assert.equal(getIntegrationEvent(current, prior.integration_event_id)?.status, 'QUEUED');
    assert.equal(listDbIntegrationEvents(current).find(event => event.integration_event_id === prior.integration_event_id)?.status, 'QUEUED');
    assert.equal(existsSync(join(storePaths(current).integrationRoot, prior.integration_event_id)), false);
  }
  const restored: Project = {
    ...loadProject(original.root), snapshotRoot: original.snapshotRoot,
    config: readJson(join(original.snapshotRoot!, 'meteor.config.json')),
    suite: readJson(join(original.snapshotRoot!, 'case-suite.json')),
  };
  const recovered = await processIntegrationEvents(restored);
  assert.equal(recovered.processed, 1);
  assert.equal(getIntegrationEvent(restored, prior.integration_event_id)?.status, 'SKIPPED');
});

test('a claim cannot lease an integration event from a different project channel', async () => {
  const original = projectFixture();
  const prior = queuedResearch(original, 'original');
  const current = loadProject(original.root);
  current.config.environment.environment_ref += '-new';
  assert.equal(claimDbIntegrationEvent(current, prior.integration_event_id, 'foreign-token'), undefined);
  assert.equal(listDbIntegrationEvents(current).find(event => event.integration_event_id === prior.integration_event_id)?.status, 'QUEUED');
  const recovered = await processIntegrationEvents(original);
  assert.equal(recovered.processed, 1);
});
