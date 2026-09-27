import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import meteor, { createHost } from '../src/index.ts';
import { MeteorHost } from '../src/host.ts';
import { initProject } from '../src/init.ts';
import { loadProject, loadProjectRuntime } from '../src/project.ts';
import { writablePath } from '../src/research-tools.ts';
import { researchPath } from '../templates/project/tools/meteor/research.ts';
import { storePaths } from '../templates/project/tools/meteor/store.ts';
import { createHash } from 'node:crypto';
import { scopeKey } from '../templates/project/tools/meteor/workspace.ts';
import { installHardwareProfile, materializeUnitCaseSuite, writeReadyHardwareFixture } from './helpers/hardware.ts';

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(options: { init?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-dsh-'));
  if (options.init !== false) initProject(root, { git: false, backend: 'mock' });
  const tools = new Map<string, any>();
  tools.set('skill', { name: 'skill' }); tools.set('read', { name: 'read' });
  tools.set('subagent', { name: 'subagent' }); tools.set('bash', { name: 'bash' });
  const listeners = new Map<string, Function[]>(); const guards: Function[] = [];
  const jobs = new Map<string, any>(); const starts: any[] = [];
  const childReady = deferred(); const childReadies = [childReady]; const final = deferred();
  const childAt = (index: number) => (childReadies[index] ??= deferred()).promise;
  const chief = { id: 'chief-test', session: { id: 'chief-test', header: { cwd: root } }, ctx: { compaction: {}, skills: {} } };
  const ctx: any = {
    skills: { registerProvider() { return () => {}; } },
    tools: {
      register(tool: any) { assert(!tools.has(tool.name)); tools.set(tool.name, tool); return () => tools.delete(tool.name); },
      get(name: string) { return tools.get(name); },
      guard(fn: Function) { guards.push(fn); return () => { guards.splice(guards.indexOf(fn), 1); }; },
    },
    on(event: string, fn: Function) { const list = listeners.get(event) ?? []; list.push(fn); listeners.set(event, list); return () => { list.splice(list.indexOf(fn), 1); }; },
    jobs: {
      start(spec: any) { const id = `meteor-${jobs.size + 1}`; assert.equal(spec.owner, chief.id); jobs.set(id, { ...spec, ...spec.run() }); return id; },
    },
    subagents: {
      async start(provider: string, request: any) {
        assert.equal(provider, 'spawn'); starts.push(request);
        const childIndex = starts.length - 1;
        const registeredSkills: any[] = [];
        const child = { id: `child-${starts.length}`, session: { id: `child-${starts.length}`, header: { cwd: root, parentSession: chief.id, origin: 'subagent' } }, ctx: { compaction: {}, skills: { register(value: any) { registeredSkills.push(value); } } } };
        let disposed = false;
        const result = (async () => {
          for (const fn of listeners.get('agent/pre-step') ?? []) await fn({ agent: child, messages: [{ content: request.prompt }], signal: request.signal }, async () => ({ kind: 'enter', messages: [] }));
          (childReadies[childIndex] ??= deferred()).resolve({ child, registeredSkills });
          return new Promise<any>(resolveResult => {
            const abort = () => resolveResult({ stopReason: 'aborted', output: [{ type: 'text', text: 'Partial research remains in memory.md' }] });
            request.signal.addEventListener('abort', abort, { once: true });
            if (request.signal.aborted) abort();
            final.promise.then(result => { request.signal.removeEventListener('abort', abort); resolveResult(result); });
          });
        })();
        return { id: child.id, localAgent: child, result, async dispose() { disposed = true; }, isDisposed: () => disposed };
      },
    },
  };
  const host = createHost(ctx);
  const exec = (agent = chief) => ({ agent, signal: new AbortController().signal });
  const call = (name: string, args: any, agent: any = chief) => tools.get(name).execute(args, exec(agent));
  const active = (id: string) => [...host.active.values()].find(state => state.id === id);
  return { root, host, ctx, tools, listeners, guards, jobs, starts, chief, childReady, childAt, active, final, exec, call };
}
function submission(researchId: string, sessionId: string) {
  return {
    research_id: researchId, agent_session_id: sessionId, execution_backend: 'mock', termination_reason: 'No real hardware configured',
    hypothesis: { hypothesis_id: 'h1', revision: '1', statement: 'Tiling reduces measured latency', scope: 'qmq mock protocol', mechanism: 'Data reuse',
      intervention: 'Change tile size', controls: ['same cases'], predictions: ['lower latency'], support_criteria: ['paired lower runtime'], refutation_criteria: ['paired higher runtime'],
      confounders: ['simulation'], measurement_plan: 'Full suite then paired real-hardware timing', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['Mock only'] },
    hypothesis_history: [],
    experiments: [{ experiment_id: 'e1', hypothesis_revision: '1', question: 'Can protocol run?', intervention: 'Mock review', controls: [], kernel_revisions: [],
      environment_ref: 'mock-qmq-v1', full_size_test_refs: [], profile_refs: [], analysis: 'No hardware evidence exists', next_experiment: 'Configure the SSH profile' }],
    submitted_kernels: [], knowledge_updates: [],
    chief_report: { summary: 'Hardware conclusion remains inconclusive', findings: ['Protocol ran in one session'], unresolved: ['Real timings'], next_steps: ['Configure SSH and measure the original hypothesis'] },
  };
}

function researchDirectory(root: string, id: string) { return researchPath(loadProject(root), id); }

test('status on a new workspace gives an actionable setup state without creating or concealing configuration', async t => {
  const h = harness({ init: false }); t.after(() => h.host.dispose());
  const observedAt = '2026-09-26T03:00:00.000Z';
  t.mock.method(Date, 'now', () => Date.parse(observedAt));
  const result = await h.call('meteor_status', {});
  assert.equal(result.state, 'initialization_required');
  assert.equal(result.observed_at, observedAt);
  assert.deepEqual(result.research, []);
  assert.match(result.next_action, /meteor_init/);
  assert.equal(existsSync(join(h.root, 'meteor.config.json')), false);
  assert.equal(h.starts.length, 0);
  assert.equal(h.jobs.size, 0);
  writeFileSync(join(h.root, 'meteor.config.json'), '{invalid');
  await assert.rejects(h.call('meteor_status', {}), SyntaxError);
});

test('hardware preparation tools stay Chief-only and cannot change an active research environment', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  for (const name of ['meteor_hardware_experiment', 'meteor_hardware_model', 'meteor_configure_assembly_template']) assert(h.tools.has(name));
  await h.call('meteor_start', { research_id: 'setup-boundary', goal: 'Use frozen preparation' });
  const { child } = await h.childReady.promise;
  const original = readFileSync(join(researchDirectory(h.root, 'setup-boundary'), 'manifest.json'), 'utf8');
  for (const [name, args] of [
    ['meteor_hardware_experiment', { action: 'run', experiment_id: 'not-a-research-experiment' }],
    ['meteor_hardware_model', { action: 'publish', path: 'hardware/draft.json' }],
    ['meteor_configure_assembly_template', { source_path: 'example.asc.tmpl' }],
  ] as const) await assert.rejects(h.call(name, args, child), /live chief/);
  await assert.rejects(h.call('meteor_hardware_experiment', { action: 'run', experiment_id: 'blocked' }), /finish active research/);
  await assert.rejects(h.call('meteor_hardware_model', { action: 'publish', path: 'hardware/draft.json' }), /Finish active research/);
  assert.equal(readFileSync(join(researchDirectory(h.root, 'setup-boundary'), 'manifest.json'), 'utf8'), original);
  assert.equal(existsSync(join(h.root, 'hardware/experiments/blocked/request.json')), false);
  assert.equal(h.starts.length, 1);
});

test('status observes the pinned live wall-time budget without extending or consuming it', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  await h.call('meteor_start', { research_id: 'budget-clock', goal: 'Observe a mock research clock', budget: { max_wall_time_seconds: 120 } });
  const { child } = await h.childReady.promise;
  const state = h.active('budget-clock')!;
  const manifestPath = join(researchDirectory(h.root, state.id), 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  const record = JSON.parse(original), createdAt = Date.parse(record.created_at);
  const configPath = join(h.root, 'meteor.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.budget.max_wall_time_seconds = 86_400;
  writeFileSync(configPath, JSON.stringify(config));
  let now = createdAt + 30_000;
  t.mock.method(Date, 'now', () => now);
  const status = await h.call('meteor_status', { research_id: state.id });
  const expected = { state: 'active', deadline_at: new Date(createdAt + 120_000).toISOString(),
    elapsed_seconds: 30, remaining_seconds: 90, exhausted: false };
  assert.equal(status.observed_at, new Date(now).toISOString());
  assert.deepEqual(status.wall_time, expected);
  assert.equal(status.budget.max_wall_time_seconds, 120);
  const childStatus = await h.call('meteor_run_status', {}, child);
  assert.equal(childStatus.observed_at, status.observed_at);
  assert.equal(childStatus.research_id, state.id);
  assert.deepEqual(childStatus.wall_time, expected);
  assert.deepEqual(childStatus.requests, []);
  const list = await h.call('meteor_status', {});
  assert.equal(list.observed_at, status.observed_at);
  assert.equal(list.research[0].observed_at, status.observed_at);
  assert.deepEqual(list.research[0].wall_time, expected);
  for (const elapsed of [120, 125.25]) {
    now = createdAt + elapsed * 1000;
    const expired = await h.call('meteor_status', { research_id: state.id });
    assert.deepEqual(expired.wall_time, { ...expected, elapsed_seconds: elapsed, remaining_seconds: 0, exhausted: true });
    assert.equal(expired.run_status, 'ACTIVE');
    assert.equal(expired.live, true);
    const childExpired = await h.call('meteor_run_status', {}, child);
    assert.equal(childExpired.observed_at, expired.observed_at);
    assert.deepEqual(childExpired.wall_time, expired.wall_time);
  }
  state.finalAccepted = true;
  try {
    const finalizing = await h.call('meteor_status', { research_id: state.id });
    assert.equal(finalizing.wall_time.state, 'inactive');
    assert.equal(finalizing.wall_time.exhausted, null);
  } finally {
    state.finalAccepted = false;
  }
  assert.equal(readFileSync(manifestPath, 'utf8'), original);
  assert.equal(state.controller.signal.aborted, false);
  assert.equal(h.host.sessions.get(state.sessionId!), state);
  assert.equal(h.starts.length, 1);
  assert.equal(h.jobs.size, 1);
});

test('status does not invent a live deadline from damaged or unknown manifest times', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  await h.call('meteor_start', { research_id: 'budget-invalid', goal: 'Reject unknown clock data in a mock fixture' });
  await h.childReady.promise;
  const state = h.active('budget-invalid')!;
  const manifestPath = join(researchDirectory(h.root, state.id), 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8'), record = JSON.parse(original);
  let now = Date.parse(record.created_at) + 10_000;
  t.mock.method(Date, 'now', () => now);
  const patches = [
    { created_at: undefined }, { created_at: 'not-a-date' }, { created_at: 1 },
    { created_at: '1' }, { created_at: '2026-02-30T00:00:00.000Z' },
    { created_at: new Date(now + 1000).toISOString() }, { budget: undefined },
    ...[undefined, 0, -1, '120', 1e20].map(max_wall_time_seconds => ({ budget: { ...record.budget, max_wall_time_seconds } })),
  ];
  try {
    for (const patch of patches) {
      const damaged = JSON.stringify({ ...record, ...patch });
      writeFileSync(manifestPath, damaged);
      const status = await h.call('meteor_status', { research_id: state.id });
      assert.deepEqual(status.wall_time, { state: 'unknown', deadline_at: null,
        elapsed_seconds: null, remaining_seconds: null, exhausted: null });
      assert.equal(status.observed_at, new Date(now).toISOString());
      assert.equal(readFileSync(manifestPath, 'utf8'), damaged);
    }
    writeFileSync(manifestPath, original);
    now = Number.NaN;
    const unknownClock = await h.call('meteor_status', { research_id: state.id });
    assert.equal(unknownClock.observed_at, null);
    assert.equal(unknownClock.wall_time.state, 'unknown');
    assert.equal(unknownClock.wall_time.exhausted, null);
    assert.equal(readFileSync(manifestPath, 'utf8'), original);
    assert.equal(state.controller.signal.aborted, false);
  } finally {
    writeFileSync(manifestPath, original);
  }
});

test('status leaves historical wall-time budgets inactive and preserves terminal manifests', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const project = loadProject(h.root), runtime = await loadProjectRuntime(project);
  const manifests = new Map<string, string>();
  for (const run_status of ['CLOSED', 'CANCELLED', 'FAILED', 'INTERRUPTED']) {
    const id = 'historical-' + run_status.toLowerCase();
    runtime.research.createResearch(project, { research_id: id, chief_id: h.chief.id, agent_session_id: 'historical-child',
      goal: 'Preserve ended mock research', budget: { max_wall_time_seconds: 1 } });
    runtime.research.updateResearch(project, id, { run_status });
    const manifestPath = join(researchDirectory(h.root, id), 'manifest.json');
    manifests.set(manifestPath, readFileSync(manifestPath, 'utf8'));
  }
  const now = Date.now() + 86_400_000;
  t.mock.method(Date, 'now', () => now);
  const list = await h.call('meteor_status', {});
  assert.equal(list.observed_at, new Date(now).toISOString());
  assert.equal(list.research.length, 4);
  for (const record of list.research) {
    assert.equal(record.live, false);
    assert.equal(record.observed_at, list.observed_at);
    assert.deepEqual(record.wall_time, { state: 'inactive', deadline_at: null,
      elapsed_seconds: null, remaining_seconds: null, exhausted: null });
    const selected = await h.call('meteor_status', { research_id: record.research_id });
    assert.deepEqual(selected.wall_time, record.wall_time);
  }
  for (const [path, original] of manifests) assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(h.starts.length, 0);
  assert.equal(h.jobs.size, 0);
});

test('chief can read files through meteor_read_file before project initialization', async () => {
  const h = harness({ init: false });
  writeFileSync(join(h.root, 'operator.json'), '{"abi":"qmq-v1"}\n');
  assert.equal((await h.call('meteor_read_file', { path: 'operator.json' })).text, '{"abi":"qmq-v1"}\n');
  const first = await h.call('meteor_read_file', { path: 'operator.json', limit: 8 });
  assert.equal(first.offset_unit, 'characters');
  assert.equal(first.text, '{"abi":"');
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, 8);
  const rest = await h.call('meteor_read_file', { path: 'operator.json', offset: first.next_offset, limit: 100 });
  assert.equal(rest.text, 'qmq-v1"}\n');
  assert.equal(rest.truncated, false);
  assert.equal(rest.next_offset, null);
  await h.host.dispose();
});

test('one native run keeps research tools and skills in one session, and commits only its prepared final output', async () => {
  const h = harness();
  await assert.rejects(h.call('meteor_start', { goal: 'Investigate tiling', budget: { experiments: 3 } }), /budget\.experiments is not supported/);
  assert.equal(h.host.active.size, 0);
  const started = await h.call('meteor_start', { research_id: 'continuous', goal: 'Investigate tiling', initial_context: { mode: 'random', kernel_refs: [], knowledge_refs: [] } });
  const { child, registeredSkills } = await h.childReady.promise;
  assert.equal(h.starts.length, 1);
  assert.equal(registeredSkills.length, 2);
  assert(h.starts[0].toolFilter.allow.includes('skill'));
  assert(h.starts[0].toolFilter.allow.includes('read'));
  assert(!h.starts[0].toolFilter.allow.includes('subagent'));
  assert(!h.starts[0].toolFilter.allow.includes('bash'));
  assert.match(h.starts[0].prompt[0].text, /Seeds are inspiration only/);
  const startup = JSON.parse(h.starts[0].prompt[0].text.split('\n').slice(1).join('\n'));
  assert.equal(startup.contracts_ref, join(researchDirectory(h.root, 'continuous'), 'kernel-contracts.md'));
  assert.equal(startup.target.op_id, 'qmq-v1');
  assert.equal(startup.target.dtype_id, 'int8');
  assert(existsSync(startup.formula_ref));
  assert(existsSync(startup.kernel_template_ref));
  assert(existsSync(startup.design_guide_ref));
  assert(existsSync(startup.activity_primitives_ref));
  const fullSuite = JSON.parse(readFileSync(startup.case_suite_ref, 'utf8'));
  assert.equal(startup.case_suite.revision, fullSuite.revision);
  assert.equal(startup.case_suite.operator_abi, fullSuite.operator_abi);
  assert.deepEqual(startup.case_suite.cases, fullSuite.cases.map(({ case_id, shape, dtype, layout }: any) => ({ case_id, shape, dtype, layout })));
  assert(startup.case_suite_ref.startsWith(join(startup.research_directory, 'snapshot')));
  assert(fullSuite.cases.every((entry: any) => entry.input_hash && entry.oracle_hash));
  assert(startup.case_suite.cases.every((entry: any) => !('input_hash' in entry) && !('oracle_hash' in entry)));
  assert.equal(startup.hardware_report_ref, undefined, 'Mock research without a hardware report must not invent a report path');
  assert(h.starts[0].toolFilter.allow.includes('meteor_design'));
  assert.match(readFileSync(startup.contracts_ref, 'utf8'), /KernelModule JSON/);
  assert.match(readFileSync(startup.contracts_ref, 'utf8'), /supported_case_ids/);
  assert(readFileSync(startup.contracts_ref, 'utf8').includes(relative(h.root, startup.research_directory).replace(/\\/g, '/')));
  const outside = join(tmpdir(), `meteor-other-material-${Date.now()}.txt`);
  writeFileSync(outside, 'another research kernel');
  assert.equal((await h.call('meteor_read_file', { path: outside }, child)).text, 'another research kernel');
  for (const round of [1, 2]) await h.call('meteor_write_file', { path: 'memory.md', content: `Round ${round}: original hypothesis still unresolved` }, child);
  await assert.rejects(
    h.call('meteor_prepare_submission', { submission: { ...submission('continuous', child.id), experiments: [] } }, child),
    /submission\.experiments requires at least 1 items/,
  );
  assert.equal(h.host.active.size, 1);
  assert.equal((await h.call('meteor_status', { research_id: 'continuous' })).run_status, 'ACTIVE');
  const autoBoundSubmission: any = submission('wrong-research', 'wrong-session');
  delete autoBoundSubmission.research_id;
  delete autoBoundSubmission.agent_session_id;
  delete autoBoundSubmission.execution_backend;
  const prepared = await h.call('meteor_prepare_submission', { submission: autoBoundSubmission }, child);
  assert.equal(prepared.committed, false);
  assert.equal(prepared.next_action.tool, 'structured_output');
  assert.deepEqual(prepared.next_action.arguments, { prepared_submission_id: prepared.prepared_submission_id });
  const before = await h.call('meteor_status', { research_id: 'continuous' });
  assert.equal(before.run_status, 'OUTPUT_FROZEN');
  assert.equal(before.submission_id, undefined);
  assert(h.guards.some(g => g({ agent: child, name: 'structured_output', arguments: { prepared_submission_id: 'wrong' } })));
  h.final.resolve({ stopReason: 'completed', output: [], structured: prepared.next_action.arguments });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  const report = JSON.parse(outcome.result);
  assert.equal(report.report.report.next_steps[0], 'Configure SSH and measure the original hypothesis');
  assert.equal(report.research.research_goal_met, false);
  assert.equal(report.research.agent_session_id, child.id);
  assert.equal(h.starts.length, 1);
  await h.host.dispose();
});

for (const referenceKind of ['relative', 'absolute'] as const) {
  test(`startup exposes the original hardware report as an absolute readable path (${referenceKind} configuration)`, async t => {
    const h = harness(); t.after(() => h.host.dispose());
    const reportRelative = 'hardware/reports/protocol-report.json';
    const reportPath = join(h.root, reportRelative);
    const reportText = JSON.stringify({ fixture: 'mock protocol only', report_id: 'pinned-report', environment_ref: 'mock-ascend-qmq-v1' }) + '\n';
    writeFileSync(reportPath, reportText);
    const configPath = join(h.root, 'meteor.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.environment.hardware_report_ref = referenceKind === 'relative' ? reportRelative : reportPath;
    const configText = JSON.stringify(config, null, 2) + '\n';
    writeFileSync(configPath, configText);
    const started = await h.call('meteor_start', { research_id: 'report-path', goal: 'Verify the hardware report reference protocol' });
    const { child } = await h.childReady.promise;
    const startup = JSON.parse(h.starts[0].prompt[0].text.split('\n').slice(1).join('\n'));
    assert.equal(startup.project_root, h.root);
    assert(isAbsolute(startup.hardware_report_ref));
    assert.equal(startup.hardware_report_ref, reportPath);
    assert(existsSync(startup.hardware_report_ref));
    const read = await h.call('meteor_read_file', { path: startup.hardware_report_ref }, child);
    assert.equal(read.path, reportPath);
    assert.equal(read.text, reportText);
    assert.equal(readFileSync(reportPath, 'utf8'), reportText, 'Resolving a reference must preserve the original report bytes');
    assert.equal(readFileSync(configPath, 'utf8'), configText, 'The project keeps its configured report identity');
    const pinnedConfig = JSON.parse(readFileSync(join(startup.research_directory, 'snapshot/meteor.config.json'), 'utf8'));
    assert.equal(pinnedConfig.environment.hardware_report_ref, config.environment.hardware_report_ref);
    assert.equal(existsSync(join(startup.research_directory, reportRelative)), false, 'The report is not copied into a research-relative location');
    await h.call('meteor_control', { research_id: 'report-path', action: 'cancel' });
    await h.jobs.get(started.job_id).done;
  });
}

test('chief reads project files and child reads relative to its bound project root', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'chief-visible.txt'), 'chief can read the project cwd');
  assert.equal((await h.call('meteor_read_file', { path: 'chief-visible.txt' })).text, 'chief can read the project cwd');
  const started = await h.call('meteor_start', { research_id: 'read-scope', goal: 'Verify read scope' });
  const { child } = await h.childReady.promise;
  assert.match((await h.call('meteor_read_file', { path: 'contracts/qmq-v1/int8/operator.json' }, child)).text, /qmq-v1/);
  await h.call('meteor_control', { research_id: 'read-scope', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('chief can assign readable initial materials and a hypothesis to the same native research session', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'knowledge', 'chief-note.md'), 'A chief-selected observation for experimental inspiration');
  const hypothesis = { statement: 'Keeping a row in local memory reduces repeated transfers', scope: 'Fixed qmq suite', predictions: ['Fewer repeated transfers'] };
  const initialContext = { mode: 'specified', knowledge_refs: ['knowledge/chief-note.md'] };
  const started = await h.call('meteor_start', { research_id: 'chief-assigned', goal: 'Test the supplied hypothesis', initial_context: initialContext, hypothesis });
  const { child } = await h.childReady.promise;
  const directory = researchDirectory(h.root, 'chief-assigned');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const seed = JSON.parse(readFileSync(join(directory, 'seed.json'), 'utf8'));
  assert.deepEqual(manifest.initial_context, initialContext);
  assert.deepEqual(manifest.assigned_hypothesis, hypothesis);
  assert.equal(manifest.agent_session_id, child.id);
  assert.equal(seed.mode, 'specified');
  assert.equal(seed.selected.length, 1);
  const source = seed.selected[0].source_refs[0];
  assert.match((await h.call('meteor_read_file', { path: source }, child)).text, /chief-selected observation/);
  const prompt = JSON.parse(h.starts[0].prompt[0].text.split('\n').slice(1).join('\n'));
  assert.deepEqual(prompt.assigned_hypothesis, hypothesis);
  assert.match(prompt.material_policy, /Read other kernels/);
  assert.match(prompt.hypothesis_policy, /supported revision does not settle an inconclusive original/);
  assert.equal(h.starts.length, 1);
  await h.call('meteor_control', { research_id: 'chief-assigned', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('chief sampling configuration is pinned per research without changing the project defaults', async () => {
  const h = harness();
  const configPath = join(h.root, 'meteor.config.json');
  const before = readFileSync(configPath, 'utf8');
  const initialContext = { mode: 'random', sampling: { count: 0, seed: 17, epsilon: 1, tau_hours: 24 } };
  const started = await h.call('meteor_start', { research_id: 'configured-sampling', goal: 'Explore a fresh hypothesis', initial_context: initialContext });
  assert.equal(started.ignored_initial_context_fields, undefined);
  await h.childReady.promise;
  const seed = JSON.parse(readFileSync(join(researchDirectory(h.root, 'configured-sampling'), 'seed.json'), 'utf8'));
  assert.equal(seed.mode, 'random');
  assert.equal(seed.seed, 17);
  assert.equal(seed.sampling.count, 0);
  assert.equal(seed.sampling.epsilon, 1);
  assert.equal(seed.sampling.tau_hours, 24);
  assert.equal(readFileSync(configPath, 'utf8'), before);
  await h.call('meteor_control', { research_id: 'configured-sampling', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('specified initial context ignores sampling while preserving exact refs', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'knowledge', 'chief-note.md'), 'Specified note fixture\n');
  const started = await h.call('meteor_start', {
    research_id: 'specified-sampling',
    goal: 'Use exact specified material without random sampling',
    initial_context: { mode: 'specified', sampling: { count: 3, seed: 99 }, knowledge_refs: ['knowledge/chief-note.md'] },
  });
  try {
    assert.deepEqual(started.ignored_initial_context_fields, ['sampling']);
    assert.deepEqual(started.initial_context, { mode: 'specified', knowledge_refs: ['knowledge/chief-note.md'] });
    await h.childReady.promise;
    const manifest = JSON.parse(readFileSync(join(researchDirectory(h.root, 'specified-sampling'), 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.initial_context, { mode: 'specified', knowledge_refs: ['knowledge/chief-note.md'] });
    assert.equal('sampling' in manifest.initial_context, false);
    const seed = JSON.parse(readFileSync(join(researchDirectory(h.root, 'specified-sampling'), 'seed.json'), 'utf8'));
    assert.equal(seed.mode, 'specified');
    assert.equal(seed.algorithm, 'meteor-specified-v1');
    assert.deepEqual(seed.initial_context, { mode: 'specified', knowledge_refs: ['knowledge/chief-note.md'] });
    assert.deepEqual(seed.selected.map((item: any) => item.ref), [join(h.root, 'knowledge/chief-note.md')]);
  } finally {
    if (h.active('specified-sampling')) await h.call('meteor_control', { research_id: 'specified-sampling', action: 'cancel' });
    await h.jobs.get(started.job_id).done.catch(() => {});
    await h.host.dispose();
  }
});

test('pause and resume wait at native boundaries without disposing or spawning a replacement', async () => {
  const h = harness(); const started = await h.call('meteor_start', { research_id: 'pause', goal: 'Test cooperative pause' });
  const { child } = await h.childReady.promise;
  await h.call('meteor_control', { research_id: 'pause', action: 'pause' });
  let passed = false;
  const boundary = h.listeners.get('agent/pre-step')![0]({ agent: child, messages: [], signal: new AbortController().signal }, async () => { passed = true; return { kind: 'enter' }; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.call('meteor_status', { research_id: 'pause' })).run_status, 'PAUSED');
  assert.equal(passed, false);
  await h.call('meteor_control', { research_id: 'pause', action: 'resume' }); await boundary;
  assert.equal(passed, true); assert.equal(h.starts.length, 1);
  await h.call('meteor_control', { research_id: 'pause', action: 'cancel' });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'killed');
  assert.match(outcome.result, /Partial research remains/);
  await assert.rejects(h.call('meteor_control', { research_id: 'pause', action: 'resume' }), /cannot be resumed/);
  await h.host.dispose();
});

test('the same child writes and measures two kernel revisions, and re-prepares after further work', async () => {
  const h = harness(); const started = await h.call('meteor_start', { research_id: 'iterations', goal: 'Compare two kernel revisions' });
  const { child } = await h.childReady.promise;
  const state = h.active('iterations')!;
  const caseIds = state.project.suite.cases.map((c: any) => c.case_id);
  for (const revision of ['r1', 'r2']) {
    const draft = `drafts/demo/${revision}`;
    const prefix = `demo_${revision}_`;
    const kernelPath = relative(h.root, join(h.host.researchDir(state.project, state.id), draft)).replace(/\\/g, '/');
    const module = { kernel_id: 'demo', revision, operator_abi: 'qmq-v1', symbol_prefix: prefix, launcher: `${prefix}launch`,
      device_file: `${kernelPath}/device.asc`, host_file: `${kernelPath}/host.asc`, supported_case_ids: caseIds,
      dependencies: [], hardware_scope: 'mock', resource_constraints: [] };
    await h.call('meteor_write_file', { path: `${draft}/kernel.json`, content: JSON.stringify(module) }, child);
    await h.call('meteor_write_file', { path: `${draft}/device.asc`, content: `__global__ __aicore__ void ${prefix}device() {}` }, child);
    await h.call('meteor_write_file', { path: `${draft}/host.asc`, content: `MeteorStatus ${prefix}launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }` }, child);
    const build = await h.call('meteor_kernel_build', { experiment_id: revision, kernel_path: kernelPath, fixture: { fixture_id: 'dsh-protocol-' + revision } }, child);
    const full = await h.call('meteor_kernel_test', { build_ref: build.build_ref, mode: 'full' }, child);
    assert.equal(full.rows.length, caseIds.length); assert.equal(full.accounting_complete, true);
    assert(existsSync(join(h.root, full.test_ref)));
    const profile = await h.call('meteor_kernel_profile', { build_ref: build.build_ref, case_ids: [caseIds[0]], metrics: ['memory_bytes'] }, child);
    assert.equal(profile.simulated, true); assert(existsSync(join(h.root, profile.profile_ref)));
  }
  const prepared = await h.call('meteor_prepare_submission', { submission: submission('iterations', child.id) }, child);
  await h.call('meteor_write_file', { path: 'memory.md', content: 'Further analysis; final delivery needs a fresh preparation' }, child);
  assert(h.guards.some(g => g({ agent: child, name: 'structured_output', arguments: { prepared_submission_id: prepared.prepared_submission_id } })));
  const all = await h.call('meteor_run_status', {}, child);
  assert.equal(all.requests.length, 6); assert(all.requests.every((r: any) => r.status === 'COMPLETED'));
  assert.equal(h.starts.length, 1);
  await h.call('meteor_control', { research_id: 'iterations', action: 'cancel' }); await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('chief receives the research report before deterministic integration finishes', { timeout: 3000 }, async () => {
  const h = harness(); const started = await h.call('meteor_start', { research_id: 'early-report', goal: 'Return report before integration' });
  const { child } = await h.childReady.promise;
  const state = h.active('early-report')!;
  const integration = deferred(); let integrationStarted = false;
  state.runtime.integration = { processIntegrationEvents: async () => { integrationStarted = true; return integration.promise; } };
  const prepared = await h.call('meteor_prepare_submission', { submission: submission('early-report', child.id) }, child);
  h.final.resolve({ stopReason: 'completed', output: [], structured: { prepared_submission_id: prepared.prepared_submission_id } });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'completed'); assert.equal(integrationStarted, true);
  assert.equal(JSON.parse(outcome.result).integration.status, 'QUEUED');
  integration.resolve({ status: 'SKIPPED' });
  await h.host.dispose();
});

test('committed integration still runs when ten owner job slots are occupied', { timeout: 6000 }, async t => {
  const h = harness();
  const heldJobs = deferred(), integration = deferred();
  t.after(async () => { heldJobs.resolve({ status: 'completed' }); integration.resolve({ status: 'SKIPPED' }); await h.host.dispose(); });
  const startJob = h.ctx.jobs.start;
  const running = new Set<string>(); let rejectedIntegrations = 0;
  h.ctx.jobs.start = (spec: any) => {
    if (running.size >= 10) {
      if (spec.kind === 'meteor-integration') rejectedIntegrations++;
      throw new Error('Maximum concurrent jobs per owner reached');
    }
    const id = startJob(spec); running.add(id);
    h.jobs.get(id).done.finally(() => { running.delete(id); });
    return id;
  };
  // Nine held jobs model occupied native owner slots without using real devices.
  for (let i = 0; i < 9; i++) h.ctx.jobs.start({ owner: h.chief.id, kind: 'meteor', run: () => ({ done: heldJobs.promise, cancel() {} }) });
  const started = await h.call('meteor_start', { research_id: 'full-owner', goal: 'Preserve committed integration when native owner capacity is full' });
  const { child } = await h.childReady.promise;
  assert.equal(running.size, 10);
  const state = h.active('full-owner')!;
  let integrationRuns = 0;
  state.runtime.integration = { processIntegrationEvents: async () => { integrationRuns++; return integration.promise; } };
  const prepared = await h.call('meteor_prepare_submission', { submission: submission('full-owner', child.id) }, child);
  h.final.resolve({ stopReason: 'completed', output: [], structured: { prepared_submission_id: prepared.prepared_submission_id } });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'completed');
  assert.equal(rejectedIntegrations, 1);
  assert.equal(integrationRuns, 1);
  const result = JSON.parse(outcome.result);
  assert.equal(result.integration.status, 'QUEUED');
  assert.equal(result.integration.receipt, 'meteor_status');
  assert.equal(result.integration.job_id, undefined);
  assert.equal(h.host.active.size, 0);
  assert.equal(h.host.sessions.size, 0);
  const integrations = (h.host as unknown as { integrations: Map<string, Promise<any>> }).integrations;
  assert.equal(integrations.size, 1);
  integration.resolve({ status: 'SKIPPED' });
  await Promise.all([...integrations.values()]);
  assert.equal(integrations.size, 0);
  assert.equal(h.starts.length, 1);
});

test('restart reports the lost run using its pinned snapshot without another Agent', async () => {
  const h = harness(); const project = loadProject(h.root); const runtime = await loadProjectRuntime(project);
  runtime.research.createResearch(project, { research_id: 'lost', chief_id: 'previous-chief', agent_session_id: 'old-child', goal: 'Preserve unfinished work' });
  runtime.research.updateResearch(project, 'lost', { run_status: 'ACTIVE' });
  const configPath = join(h.root, 'meteor.config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.environment.environment_ref = 'future-environment'; writeFileSync(configPath, JSON.stringify(config));
  const status = await h.call('meteor_status', { research_id: 'lost' });
  assert.equal(status.run_status, 'INTERRUPTED');
  assert.equal(status.wall_time.state, 'inactive');
  assert.equal(status.wall_time.exhausted, null);
  assert.equal(status.environment_ref, project.config.environment.environment_ref);
  assert.equal(status.report.agent_session_id, 'old-child'); assert.equal(h.starts.length, 0);
  await h.host.dispose();
});

test('status uses catalog retry eligibility and does not restart permanent or exhausted integrations', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const project = loadProject(h.root);
  const runtime = await loadProjectRuntime(project);
  for (const [id, retryable, failureCount] of [['permanent', 0, 1], ['exhausted', 1, 3]] as const) {
    runtime.research.createResearch(project, { research_id: id, chief_id: h.chief.id, agent_session_id: 'old-child', goal: 'Preserve failure' });
    const input = submission(id, 'old-child');
    input.experiments[0].environment_ref = project.config.environment.environment_ref;
    const prepared = runtime.submit.prepareSubmission(project, input);
    const report = runtime.submit.commitSubmission(project, prepared.prepared_submission_id, 'old-child');
    const eventPath = join(storePaths(project).integrationEventRoot, report.integration_event_id + '.json');
    writeFileSync(eventPath, JSON.stringify({ ...JSON.parse(readFileSync(eventPath, 'utf8')), status: 'FAILED', error: 'retained failure' }));
    const oldBytes = readFileSync(eventPath);
    const updated = spawnSync('python', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute("UPDATE integration_events SET status='FAILED',error='retained failure',retryable=?,failure_count=? WHERE integration_event_id=?",(int(sys.argv[2]),int(sys.argv[3]),sys.argv[4]))
`, join(storePaths(project).knowledgeRoot, 'catalog.sqlite'), String(retryable), String(failureCount), report.integration_event_id], { encoding: 'utf8', windowsHide: true });
    assert.equal(updated.status, 0, updated.stderr);
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await h.call('meteor_status', { research_id: id });
      assert.equal(status.integration.status, 'FAILED');
      assert.equal(status.integration.retryable, Boolean(retryable));
      assert.equal(status.integration.failure_count, failureCount);
      assert.equal(h.jobs.size, 0);
      assert.equal(h.starts.length, 0);
    }
    assert.deepEqual(readFileSync(eventPath), oldBytes);
  }
});

test('registered targets stay distinct during startup, listing and snapshot recovery', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const configPath = join(h.root, 'meteor.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const first = { op_id: config.targets[0].op_id, dtype_id: config.targets[0].dtype_id };
  const second = { op_id: 'qmq-other', dtype_id: 'int8' };
  config.targets.push({ ...config.targets[0], ...second });
  writeFileSync(configPath, JSON.stringify(config));
  await assert.rejects(h.call('meteor_start', { goal: 'An ambiguous target must not be guessed' }), /Choose target/);
  const started = await h.call('meteor_start', { research_id: 'selected', goal: 'Use the requested target', target: second });
  await h.childReady.promise;
  const startup = JSON.parse(h.starts[0].prompt[0].text.split('\n').slice(1).join('\n'));
  assert.equal(started.target.op_id, second.op_id);
  assert.equal(startup.target.op_id, second.op_id);
  assert.equal(startup.research_directory, researchPath(loadProject(h.root, second), 'selected'));
  await assert.rejects(h.call('meteor_status', { research_id: 'selected', target: first }), /Unknown research/);
  assert.equal((await h.call('meteor_status', { research_id: 'selected', target: second })).run_status, 'ACTIVE');
  await h.call('meteor_control', { research_id: 'selected', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  for (const target of [first, second]) {
    const project = loadProject(h.root, target), runtime = await loadProjectRuntime(project);
    runtime.research.createResearch(project, { research_id: 'same-name', chief_id: h.chief.id, agent_session_id: 'old-' + target.op_id, goal: 'Target-local history' });
    runtime.research.updateResearch(project, 'same-name', { run_status: 'FAILED' });
  }
  await assert.rejects(h.call('meteor_status', { research_id: 'same-name' }), /multiple targets/);
  const records = (await h.call('meteor_status', {})).research.filter((record: any) => record.research_id === 'same-name');
  assert.deepEqual(records.map((record: any) => record.target.op_id).sort(), [first.op_id, second.op_id].sort());
  assert.equal((await h.call('meteor_status', { research_id: 'same-name', target: first })).agent_session_id, 'old-' + first.op_id);
  const secondProject = loadProject(h.root, second);
  const targetPath = join(researchPath(secondProject, 'same-name'), 'snapshot/target.json');
  const scope = JSON.parse(readFileSync(targetPath, 'utf8')); scope.op_id = first.op_id;
  writeFileSync(targetPath, JSON.stringify(scope));
  await assert.rejects(h.call('meteor_status', { research_id: 'same-name', target: second }), /snapshot target/);
  assert.equal(h.starts.length, 1);
});

test('one chief runs the same research ID in two targets and controls each original session independently', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const configPath = join(h.root, 'meteor.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const firstTarget = { op_id: config.targets[0].op_id, dtype_id: config.targets[0].dtype_id };
  const secondTarget = { op_id: 'qmq-parallel', dtype_id: 'int8' };
  config.targets.push({ ...config.targets[0], ...secondTarget });
  writeFileSync(configPath, JSON.stringify(config));
  const researchId = 'parallel-name';
  const first = await h.call('meteor_start', { research_id: researchId, goal: 'First target protocol', target: firstTarget });
  const firstChild = (await h.childAt(0)).child;
  const second = await h.call('meteor_start', { research_id: researchId, goal: 'Second target protocol', target: secondTarget });
  const secondChild = (await h.childAt(1)).child;
  assert.equal(h.host.active.size, 2);
  assert.notEqual(firstChild.id, secondChild.id);
  const firstState = h.host.sessions.get(firstChild.id)!, secondState = h.host.sessions.get(secondChild.id)!;
  assert.notEqual(firstState.key, secondState.key);
  assert.equal(h.host.active.get(firstState.key), firstState);
  assert.equal(h.host.active.get(secondState.key), secondState);
  assert.equal(firstState.project.scope.op_id, firstTarget.op_id);
  assert.equal(secondState.project.scope.op_id, secondTarget.op_id);
  assert.equal((await h.call('meteor_status', { research_id: researchId, target: firstTarget })).agent_session_id, firstChild.id);
  assert.equal((await h.call('meteor_status', { research_id: researchId, target: secondTarget })).agent_session_id, secondChild.id);
  await assert.rejects(h.call('meteor_start', { research_id: researchId, goal: 'Duplicate in the same target', target: firstTarget }), /already has a native run/);
  await assert.rejects(h.call('meteor_status', { research_id: researchId }), /multiple targets/);
  await assert.rejects(h.call('meteor_control', { research_id: researchId, action: 'cancel' }), /multiple active targets/);
  assert(!firstState.controller.signal.aborted && !secondState.controller.signal.aborted);
  const unrelatedChief = { ...h.chief, id: 'another-chief', session: { ...h.chief.session, id: 'another-chief' } };
  await assert.rejects(h.call('meteor_control', { research_id: researchId, target: secondTarget, action: 'cancel' }, unrelatedChief), /No owned active research/);

  const paused = await h.call('meteor_control', { research_id: researchId, target: secondTarget, action: 'pause' });
  assert.deepEqual(paused.target, secondState.project.scope);
  assert.equal(firstState.pauseRequested, false);
  const secondBoundary = h.listeners.get('agent/pre-step')![0]({ agent: secondChild, messages: [], signal: new AbortController().signal }, async () => ({ kind: 'enter' }));
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.equal((await h.call('meteor_status', { research_id: researchId, target: secondTarget })).run_status, 'PAUSED');
  const firstMemory = await h.call('meteor_write_file', { path: 'memory.md', content: 'First target context' }, firstChild);
  await h.call('meteor_control', { research_id: researchId, target: firstTarget, action: 'cancel' });
  assert.equal((await h.jobs.get(first.job_id).done).status, 'killed');
  assert.equal(h.host.active.size, 1);
  assert.equal(h.host.active.get(secondState.key), secondState);
  assert.equal(h.host.sessions.has(firstChild.id), false);
  assert.equal(h.host.sessions.get(secondChild.id), secondState);
  assert.equal(secondState.controller.signal.aborted, false);
  assert.equal((await h.call('meteor_status', { research_id: researchId, target: firstTarget })).run_status, 'CANCELLED');
  // A unique active match remains convenient even when another target's same
  // research ID is already in the persistent history.
  const resumed = await h.call('meteor_control', { research_id: researchId, action: 'resume' });
  assert.equal(resumed.agent_session_id, secondChild.id);
  await secondBoundary;
  const secondMemory = await h.call('meteor_write_file', { path: 'memory.md', content: 'Second target context' }, secondChild);
  assert.notEqual(firstMemory.path, secondMemory.path);
  assert.equal(readFileSync(firstMemory.path, 'utf8'), 'First target context');
  assert.equal(readFileSync(secondMemory.path, 'utf8'), 'Second target context');
  await h.call('meteor_control', { research_id: researchId, target: secondTarget, action: 'cancel' });
  assert.equal((await h.jobs.get(second.job_id).done).status, 'killed');
  assert.equal(h.host.active.size, 0);
  assert.equal(h.host.sessions.size, 0);
  assert.equal(h.starts.length, 2);
});

test('migrated workspace status preserves legacy active evidence without recovering into the new catalog', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const project = loadProject(h.root);
  const runRoot = join(h.root, 'reports/meteor/ssh/research/legacy-active');
  const snapshot = join(runRoot, 'snapshot'); mkdirSync(snapshot, { recursive: true });
  const { workspace: _workspace, targets: _targets, default_target: _default, ...legacyConfig } = project.config;
  writeFileSync(join(snapshot, 'meteor.config.json'), JSON.stringify({ ...legacyConfig, schema_version: 1,
    execution: { backend: 'ssh', profile_ref: 'legacy-profile' } }));
  writeFileSync(join(snapshot, 'case-suite.json'), JSON.stringify(project.suite));
  const manifest = { research_id: 'legacy-active', agent_session_id: 'legacy-child', execution_backend: 'ssh', run_status: 'ACTIVE',
    prepared_submission_id: 'old-prepared', final_session_id: 'legacy-child', environment_ref: 'legacy-environment',
    created_at: '2020-01-01T00:00:00.000Z', budget: { max_wall_time_seconds: 1 } };
  const manifestPath = join(runRoot, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(manifestPath, 'utf8');
  const result = await h.call('meteor_status', { research_id: 'legacy-active' });
  assert.equal(result.legacy_read_only, true);
  assert.equal(result.run_status, 'ACTIVE');
  assert.equal(result.target, undefined);
  assert.equal(result.live, false);
  assert.deepEqual(result.wall_time, { state: 'inactive', deadline_at: null,
    elapsed_seconds: null, remaining_seconds: null, exhausted: null });
  assert.equal(readFileSync(manifestPath, 'utf8'), before);
  assert.equal(h.jobs.size, 0);
  assert.equal(h.starts.length, 0);
  writeFileSync(join(h.root, 'meteor.config.json'), JSON.stringify({ ...legacyConfig, schema_version: 1 }));
  await assert.rejects(h.call('meteor_start', { goal: 'Start research in a legacy instance' }), /Migrate this legacy project/);
  assert.equal(h.jobs.size, 0);
});

test('design actions and full append contents stay bound to the original research session', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  await assert.rejects(h.call('meteor_design', { action: 'open', experiment_id: 'e1', kernel_path: 'drafts/k' }), /original active/);
  const started = await h.call('meteor_start', { research_id: 'design-tools', goal: 'Check the design tool protocol' });
  const { child } = await h.childReady.promise;
  const state = h.active('design-tools')!;
  const actions: any[] = [], writes: any[] = [];
  state.runtime.design = {
    assertDesignWriteAllowed(_project: any, input: any) { writes.push(input); if (input.content.includes('REJECT')) throw new Error('Expected annotation changed'); },
    ...Object.fromEntries(['openDesign', 'checkDesign', 'freezeDesign', 'compareDesign'].map(method => [method, (_project: any, input: any) => {
      actions.push({ method, ...input }); return { design_ref: 'ir/design.json', action: method };
    }])),
  };
  await h.call('meteor_design', { action: 'open', experiment_id: 'e1', kernel_path: 'drafts/k/r1' }, child);
  await h.call('meteor_design', { action: 'check', design_ref: 'ir/design.json', stage: 'expected' }, child);
  await h.call('meteor_design', { action: 'check', design_ref: 'ir/design.json', stage: 'implementation' }, child);
  await h.call('meteor_design', { action: 'freeze', design_ref: 'ir/design.json' }, child);
  await h.call('meteor_design', { action: 'compare', design_ref: 'ir/design.json', receipt_refs: ['measurements/receipt.json'],
    analysis: { matched: [], deviations: [], unknown: ['Protocol fixture'] } }, child);
  assert.deepEqual(actions.map(action => action.method), ['openDesign', 'checkDesign', 'checkDesign', 'freezeDesign', 'compareDesign']);
  assert(actions.every(action => action.research_id === state.id));
  await assert.rejects(h.call('meteor_design', { action: 'check', design_ref: 'ir/design.json', stage: 'expected', research_id: 'other' }, child), /Unknown argument/);
  await h.call('meteor_write_file', { path: 'drafts/k/r1/device.asc', content: '// expectation\n' }, child);
  await h.call('meteor_write_file', { path: 'drafts/k/r1/device.asc', content: 'implementation();\n', mode: 'append' }, child);
  assert.equal(writes[1].content, '// expectation\nimplementation();\n');
  assert(writes.every(write => write.research_id === state.id));
  await assert.rejects(h.call('meteor_write_file', { path: 'drafts/k/r1/device.asc', content: 'REJECT', mode: 'append' }, child), /Expected annotation/);
  assert.equal(readFileSync(writes[1].path, 'utf8'), '// expectation\nimplementation();\n');
  let built: any;
  state.runtime.build = { async buildKernel(_project: any, input: any) { built = input; return { status: 'COMPLETED', build_id: 'protocol-build' }; },
    buildReceiptPath: () => join(h.root, 'builds/protocol-build/receipt.json'), receiptRef: (_project: any, path: string) => relative(h.root, path) };
  await h.call('meteor_kernel_build', { experiment_id: 'e1', kernel_path: 'drafts/k/r1', design_ref: 'ir/design.json' }, child);
  assert.equal(built.design_ref, 'ir/design.json');
  assert.equal(built.research_id, state.id);
  assert.equal(h.starts.length, 1);
  await h.call('meteor_control', { research_id: 'design-tools', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
});

test('research file replace edits one exact match literally and allows deletion', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const started = await h.call('meteor_start', { research_id: 'replace-success', goal: 'Exercise exact replacement in a mock protocol fixture' });
  const { child } = await h.childReady.promise;
  const state = h.active('replace-success')!;
  const written = await h.call('meteor_write_file', { path: 'memory.md', content: 'before <field> after\n' }, child);
  state.preparedIds.add('prepared-before-edit');
  const literal = "$& $$ $1 $` $'";
  const replaced = await h.call('meteor_write_file', { path: 'memory.md', mode: 'replace', old_text: '<field>', content: literal }, child);
  assert.equal(replaced.path, written.path);
  assert.equal(readFileSync(written.path, 'utf8'), 'before ' + literal + ' after\n');
  assert.equal(state.preparedIds.size, 0);
  const deleted = await h.call('meteor_write_file', { path: 'memory.md', mode: 'replace', old_text: literal, content: '' }, child);
  assert.equal(deleted.bytes, 0);
  assert.equal(readFileSync(written.path, 'utf8'), 'before  after\n');
  await h.call('meteor_write_file', { path: 'memory.md', mode: 'replace', old_text: '  ', content: ' ' }, child);
  assert.equal(readFileSync(written.path, 'utf8'), 'before after\n');
  await h.call('meteor_write_file', { path: 'memory.md', mode: 'append', content: 'appended\n' }, child);
  assert.equal(readFileSync(written.path, 'utf8'), 'before after\nappended\n');
  await h.call('meteor_write_file', { path: 'memory.md', content: 'default write\n' }, child);
  assert.equal(readFileSync(written.path, 'utf8'), 'default write\n');
  await h.call('meteor_control', { research_id: state.id, action: 'cancel' });
  await h.jobs.get(started.job_id).done;
});

test('research file replace rejects missing, repeated, overlapping and invalid mode inputs without mutation', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const started = await h.call('meteor_start', { research_id: 'replace-invalid', goal: 'Reject invalid replacement requests in a mock protocol fixture' });
  const { child } = await h.childReady.promise;
  const state = h.active('replace-invalid')!;
  const original = 'unique\nrepeat repeat\naaa\n';
  const written = await h.call('meteor_write_file', { path: 'memory.md', content: original }, child);
  state.preparedIds.add('keep-prepared-id');
  let designChecks = 0;
  state.runtime.design = { assertDesignWriteAllowed() { designChecks++; } };
  const cases: Array<{ args: any; error: RegExp }> = [
    { args: { mode: 'replace' }, error: /requires nonempty old_text/ },
    { args: { mode: 'replace', old_text: '' }, error: /old_text/ },
    { args: { mode: 'replace', old_text: 'absent' }, error: /not found/ },
    { args: { mode: 'replace', old_text: 'repeat' }, error: /exactly once/ },
    { args: { mode: 'replace', old_text: 'aa' }, error: /exactly once/ },
    { args: { old_text: 'unique' }, error: /only valid with mode replace/ },
    { args: { mode: 'write', old_text: 'unique' }, error: /only valid with mode replace/ },
    { args: { mode: 'append', old_text: 'unique' }, error: /only valid with mode replace/ },
    { args: { path: 'drafts/missing/r1/device.asc', mode: 'replace', old_text: 'unique' }, error: /requires an existing file/ },
  ];
  for (const item of cases) {
    await assert.rejects(h.call('meteor_write_file', { path: 'memory.md', content: 'replacement', ...item.args }, child), item.error);
    assert.equal(readFileSync(written.path, 'utf8'), original);
    assert.deepEqual([...state.preparedIds], ['keep-prepared-id']);
  }
  assert.equal(designChecks, 0);
  assert.equal(existsSync(join(h.host.researchDir(state.project, state.id), 'drafts/missing')), false);
  await h.call('meteor_control', { research_id: state.id, action: 'cancel' });
  await h.jobs.get(started.job_id).done;
});

test('research file replace checks complete proposed text and preserves design, session and snapshot guards', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const started = await h.call('meteor_start', { research_id: 'replace-design', goal: 'Preserve design write guards in a mock protocol fixture' });
  const { child } = await h.childReady.promise;
  const state = h.active('replace-design')!;
  const source = '// expected activity\nint candidate() { return 1; }\n';
  const written = await h.call('meteor_write_file', { path: 'drafts/k/r1/device.asc', content: source }, child);
  const checks: any[] = [];
  state.runtime.design = { assertDesignWriteAllowed(_project: any, input: any) {
    checks.push(input);
    if (!input.content.startsWith('// expected activity\n')) throw new Error('Expected design comments changed');
  } };
  state.preparedIds.add('keep-design-prepared-id');
  const rejected = { path: 'drafts/k/r1/device.asc', mode: 'replace', old_text: 'expected activity', content: 'different activity' };
  await assert.rejects(h.call('meteor_write_file', rejected, child), /Expected design comments changed/);
  assert.deepEqual(checks[0], { research_id: state.id, path: written.path,
    content: '// different activity\nint candidate() { return 1; }\n' });
  assert.equal(readFileSync(written.path, 'utf8'), source);
  assert.deepEqual([...state.preparedIds], ['keep-design-prepared-id']);
  await assert.rejects(h.call('meteor_write_file', rejected), /original active meteor research session/);
  const snapshotPath = join(state.project.snapshotRoot, 'prompts/meteor.md');
  const snapshotBefore = readFileSync(snapshotPath, 'utf8');
  await assert.rejects(h.call('meteor_write_file', { path: snapshotPath, mode: 'replace', old_text: snapshotBefore.slice(0, 20), content: '' }, child), /Writes are limited/);
  assert.equal(readFileSync(snapshotPath, 'utf8'), snapshotBefore);
  assert.equal(readFileSync(written.path, 'utf8'), source);
  assert.deepEqual([...state.preparedIds], ['keep-design-prepared-id']);
  assert.equal(checks.length, 1);
  await h.call('meteor_write_file', { path: written.path, mode: 'replace', old_text: 'return 1;', content: 'return 2;' }, child);
  assert.equal(checks[1].content, '// expected activity\nint candidate() { return 2; }\n');
  assert.equal(readFileSync(written.path, 'utf8'), checks[1].content);
  assert.equal(state.preparedIds.size, 0);
  await h.call('meteor_control', { research_id: state.id, action: 'cancel' });
  await h.jobs.get(started.job_id).done;
});

test('prepared submission survives a plain-text native ending without committing or restarting research', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  const started = await h.call('meteor_start', { research_id: 'prepared-only', goal: 'Preserve a missing final delivery' });
  const { child } = await h.childReady.promise;
  const before = await h.call('meteor_status', { research_id: 'prepared-only' });
  const prepared = await h.call('meteor_prepare_submission', { submission: submission('prepared-only', child.id) }, child);
  const frozen = readFileSync(prepared.submission_ref, 'utf8');
  h.final.resolve({ stopReason: 'error', output: [{ type: 'text', text: `Prepared: ${prepared.prepared_submission_id}` }] });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.detail, 'error');
  const report = JSON.parse(outcome.result);
  assert.match(report.reason, /^Native run ended: error/);
  assert.match(report.reason, /no prepared_submission_id was returned in the native final result/);
  assert.deepEqual(report.prepared_submission_ids, [prepared.prepared_submission_id]);
  assert.equal(report.committed, false);
  assert.equal(report.partial_output, `Prepared: ${prepared.prepared_submission_id}`);
  const record = await h.call('meteor_status', { research_id: 'prepared-only' });
  assert.equal(record.run_status, 'FAILED');
  assert.equal(record.submission_id, undefined);
  assert.equal(record.integration_event_id, undefined);
  assert.equal(record.agent_session_id, child.id);
  assert.deepEqual(record.budget, before.budget);
  assert.equal(readFileSync(prepared.submission_ref, 'utf8'), frozen);
  assert.deepEqual(JSON.parse(readFileSync(record.report_ref, 'utf8')), report);
  assert.equal(h.starts.length, 1);
  assert.equal(h.jobs.size, 1);
  assert.equal(h.host.active.size, 0);
});

test('forged final submission cannot commit and partial reports survive abnormal completion', async () => {
  const h = harness(); const started = await h.call('meteor_start', { research_id: 'forged', goal: 'Test final delivery' });
  await h.childReady.promise;
  h.final.resolve({ stopReason: 'completed', output: [], structured: { prepared_submission_id: 'prepared-from-another-session' } });
  assert.equal((await h.jobs.get(started.job_id).done).status, 'failed');
  const record = await h.call('meteor_status', { research_id: 'forged' });
  assert.equal(record.run_status, 'FAILED'); assert.equal(record.submission_id, undefined);
  assert(existsSync(record.report_ref));
  await h.host.dispose();
});

test('child writes accept research, project and absolute paths for the current writable research only', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'meteor-write-boundary-'));
  const root = join(projectRoot, 'reports/meteor/mock/research/current');
  mkdirSync(root, { recursive: true });
  const hypothesis = join(root, 'hypothesis.json');
  const projectRelative = relative(projectRoot, hypothesis).replace(/\\/g, '/');
  assert.equal(writablePath(root, 'hypothesis.json', projectRoot), hypothesis);
  assert.equal(writablePath(root, projectRelative, projectRoot), hypothesis);
  assert.equal(writablePath(root, hypothesis, projectRoot), hypothesis);

  const blocked = [
    'manifest.json',
    'experiments/e1/full-tests/forged.json',
    'snapshot/tools/meteor/submit.ts',
    'evidence/raw.json',
    '../another/memory.md',
    'drafts/../../escape',
    'reports/meteor/mock/research/other/hypothesis.json',
    'reports/meteor/mock/research/current/snapshot/tools/meteor/submit.ts',
    'reports/meteor/mock/research/current/evidence/raw.json',
  ];
  for (const path of blocked) {
    assert.throws(() => writablePath(root, path, projectRoot), /limited|escapes|Examples/);
  }
});

test('child write path guard rejects symbolic link traversal', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'meteor-write-symlink-'));
  const root = join(projectRoot, 'reports/meteor/mock/research/current');
  const outside = join(projectRoot, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, 'drafts'), 'junction');
  assert.throws(() => writablePath(root, 'drafts/k/r1/device.asc', projectRoot), /symbolic links/);
});

test('registered tools enforce session ownership and argument contracts', async () => {
  const h = harness();
  await assert.rejects(h.call('meteor_write_file', { path: 'memory.md', content: 'wrong caller' }), /original active/);
  await assert.rejects(h.call('meteor_start', { goal: 'test', invented: true }), /Unknown argument/);
  assert.deepEqual(h.tools.get('meteor_start').parameters.required, ['goal']);
  await h.host.dispose();
});

test('chief cannot start research while a workspace migration is publishing', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  writeFileSync(join(h.root, '.meteor/migrations/active.lock'), 'migration protocol fixture\n');
  await assert.rejects(h.call('meteor_start', { goal: 'Must wait for migration publication' }), /migration is in progress/);
  assert.equal(h.host.active.size, 0);
  assert.equal(h.jobs.size, 0);
});

test('remote cancellation remains uncertain and collection reuses the original request identity', async () => {
  const h = harness();
  const started = await h.call('meteor_start', { research_id: 'remote-control', goal: 'Verify remote request lifecycle' });
  const { child } = await h.childReady.promise;
  const state = h.active('remote-control')!;
  // Only the runner is a remote protocol fixture; the frozen research evidence
  // and its budget remain in the original mock workspace.
  const mockProject = { ...state.project, config: structuredClone(state.project.config) };
  const research = state.runtime.research;
  state.runtime.research = { ...research, getResearch: () => research.getResearch(mockProject, state.id) };
  state.project.config.execution.backend = 'ssh';
  const running = deferred();
  const identities: string[] = []; const cancelled: string[] = [];
  let calls = 0;
  const runner = {
    async cancelRemote(_project: unknown, id: string) { cancelled.push(id); return { status: 'UNKNOWN_REMOTE', remote_release_confirmed: false }; },
    async pollRemote() { return { status: 'COMPLETED', remote_release_confirmed: true }; },
  };
  state.runtime.build = {
    selectRunner: () => runner,
    receiptRef: () => 'build.json', buildReceiptPath: () => join(h.root, 'build.json'),
    async buildKernel(_project: unknown, args: any) {
      identities.push(args.idempotency_key);
      if (++calls > 1) return { status: 'COMPLETED', build_id: 'original-build' };
      running.resolve(undefined);
      return new Promise((_resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('SSH interrupted')), { once: true }));
    },
  };
  const attempt = h.call('meteor_kernel_build', { experiment_id: 'e1', kernel_path: 'drafts/kernel.json' }, child).catch((error: Error) => error);
  await running.promise;
  const request = (await h.call('meteor_run_status', {}, child)).requests[0];
  const cancelledResult = await h.call('meteor_run_control', { request_id: request.request_id, action: 'cancel' }, child);
  assert.match(String(await attempt), /SSH interrupted/);
  assert.equal(cancelledResult.status, 'UNKNOWN_REMOTE');
  assert.equal(cancelledResult.remote_state.remote_release_confirmed, false);
  const scopeHash = createHash('sha256').update(scopeKey(state.project)).digest('hex').slice(0, 16);
  assert(cancelled.every(id => id === `build-${scopeHash}-${request.request_id}`));
  const collected = await h.call('meteor_run_control', { request_id: request.request_id, action: 'collect' }, child);
  assert.equal(collected.status, 'COMPLETED');
  assert.equal(collected.receipt.build_id, 'original-build');
  assert.deepEqual(identities, [request.request_id, request.request_id]);
  state.project.config.execution.backend = 'mock';
  await h.call('meteor_control', { research_id: 'remote-control', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('confirmed remote cancellation is collected without reissuing the experiment', async () => {
  const h = harness();
  const started = await h.call('meteor_start', { research_id: 'remote-cancelled', goal: 'Collect a cancelled queued request' });
  const { child } = await h.childReady.promise;
  const state = h.active('remote-cancelled')!;
  state.project.config.execution.backend = 'ssh';
  let calls = 0;
  state.runtime.build = {
    selectRunner: () => ({ async pollRemote() { return { status: 'CANCELLED', remote_release_confirmed: true }; } }),
    receiptRef: () => 'build.json', buildReceiptPath: () => join(h.root, 'build.json'),
    async buildKernel() { calls++; return { status: 'UNKNOWN_REMOTE', build_id: 'lost-connection' }; },
  };
  const request = await h.call('meteor_kernel_build', { experiment_id: 'e1', kernel_path: 'drafts/kernel.json' }, child);
  const collected = await h.call('meteor_run_control', { request_id: request.request_id, action: 'collect' }, child);
  assert.equal(collected.status, 'CANCELLED');
  assert.equal(collected.remote_state.remote_release_confirmed, true);
  assert.equal(calls, 1);
  state.project.config.execution.backend = 'mock';
  await h.call('meteor_control', { research_id: 'remote-cancelled', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
});

test('chief can collect an ended research request from its durable identity without replaying an experiment', async t => {
  const h = harness(); t.after(() => h.host.dispose());
  // Only this temporary fixture models SSH; all transport methods are replaced below.
  const profile = installHardwareProfile(t, h.root, 'central-original');
  materializeUnitCaseSuite(h.root);
  writeReadyHardwareFixture(h.root, { profileRef: profile.profileRef });
  const started = await h.call('meteor_start', { research_id: 'ended-remote', goal: 'Exercise remote lifecycle with a local fake transport' });
  const { child } = await h.childReady.promise;
  const state = h.active('ended-remote')!;
  const remoteDirectory = researchPath(state.project, state.id);
  let builds = 0;
  state.runtime.build = {
    selectRunner: () => { throw new Error('Management must load the frozen runtime after the child ends'); },
    receiptRef: () => 'build.json', buildReceiptPath: () => join(h.root, 'build.json'),
    async buildKernel() {
      builds++;
      assert.equal(readdirSync(join(remoteDirectory, 'remote-requests')).length, 1, 'identity must be durable before dispatch');
      return { status: 'UNKNOWN_REMOTE', build_id: 'local-build-id' };
    },
  };
  const request = await h.call('meteor_kernel_build', { experiment_id: 'e1', kernel_path: 'drafts/kernel.json' }, child);
  const expectedRemoteId = `build-${createHash('sha256').update(scopeKey(state.project)).digest('hex').slice(0, 16)}-${request.request_id}`;
  const listed = await h.call('meteor_control', { research_id: state.id, action: 'requests' });
  assert.equal(listed.requests[0].remote_request_id, expectedRemoteId);
  assert.equal(listed.requests[0].agent_session_id, child.id);
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'requests' }, child), /chief/);
  await h.call('meteor_control', { research_id: state.id, action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  const manifestPath = join(remoteDirectory, 'manifest.json');
  const terminalManifest = readFileSync(manifestPath, 'utf8');
  assert.equal(JSON.parse(terminalManifest).run_status, 'CANCELLED');
  assert.equal(h.host.active.size, 0);
  assert.equal(h.host.sessions.size, 0);
  const configPath = join(h.root, '.meteor.local.json');
  const liveConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  liveConfig.execution.profile_ref = 'central-changed';
  writeFileSync(configPath, JSON.stringify(liveConfig));
  const { SshRunner } = await import(pathToFileURL(join(state.project.snapshotRoot, 'tools/meteor/runners/ssh.ts')).href);
  const restarted = new MeteorHost(h.ctx); t.after(() => restarted.dispose());
  const controls: any[] = [];
  for (const [method, status, released] of [['pollRemote', 'UNKNOWN_REMOTE', false], ['collectRemote', 'FAILED', true], ['cancelRemote', 'CANCEL_REQUESTED', false]] as const) {
    t.mock.method(SshRunner.prototype, method, async (project: any, id: string) => {
      controls.push({ method, id, profile: project.config.execution.profile_ref, scope: project.scope });
      return { status, remote_release_confirmed: released, receipt: { request_id: id } };
    });
  }
  for (const action of ['poll_request', 'collect_request', 'cancel_request']) {
    const result = await restarted.control({ research_id: state.id, action, request_id: expectedRemoteId }, h.exec());
    assert.equal(result.request_id, request.request_id);
    assert.equal(result.remote_request_id, expectedRemoteId);
    assert.equal(result.remote_state.remote_release_confirmed, action === 'collect_request');
  }
  assert(controls.every(entry => entry.id === expectedRemoteId && entry.profile === 'central-original'));
  assert(controls.every(entry => JSON.stringify(entry.scope) === JSON.stringify(state.project.scope)));
  const foreignChief = { ...h.chief, id: 'another-chief' };
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'collect_request', request_id: request.request_id }, foreignChief), /owned/);
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'collect_request', request_id: 'local-build-id' }), /Unknown request/);
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'poll_request' }), /request_id/);
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'resume' }), /ended/);
  assert.equal(controls.length, 3);
  assert.equal(builds, 1);
  assert.equal(h.starts.length, 1);
  assert.equal(h.jobs.size, 1);
  assert.equal(readFileSync(manifestPath, 'utf8'), terminalManifest, 'management must not rewrite terminal state or budget');
  const journalPath = join(remoteDirectory, 'remote-requests', request.request_id + '.json');
  const journal = readFileSync(journalPath, 'utf8');
  for (const patch of [{ agent_session_id: 'other-child' }, { target: { ...state.project.scope, dtype_id: 'other-dtype' } }, { remote_request_id: 'build-other-target' }]) {
    writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(journal), ...patch }));
    await assert.rejects(restarted.control({ research_id: state.id, action: 'collect_request', request_id: request.request_id }, h.exec()), /identity/);
  }
  writeFileSync(journalPath, journal);
  assert.equal(controls.length, 3, 'mismatched identity must fail before remote access');
  writeFileSync(profile.profilePath, JSON.stringify({ schema_version: 1, profiles: { 'central-original': { ...profile.profile, remote_root: '/tmp/different-server-root' } } }));
  await assert.rejects(h.call('meteor_control', { research_id: state.id, action: 'collect_request', request_id: request.request_id }), /SSH profile changed/);
  assert.equal(controls.length, 3, 'do not query a changed central destination');
});

test('installed DSH alpha.2 ToolRuntime accepts and executes meteor tool definitions', { skip: !process.env.METEOR_DSH_MODULE_ROOT }, async () => {
  const base = process.env.METEOR_DSH_MODULE_ROOT!;
  const { Context } = await import(pathToFileURL(join(base, '@deepseek-ai/cordis/lib/index.js')).href);
  const { ToolRuntime } = await import(pathToFileURL(join(base, '@deepseek-ai/dsh-tools/lib/index.js')).href);
  const version = JSON.parse(readFileSync(join(base, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
  assert.equal(version, '0.1.7-alpha.2');
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() { return () => {}; } });
  new ToolRuntime(ctx, { mode: 'native' });
  for (const service of ['jobs', 'subagents']) ctx.provide(service, {});
  ctx.provide('skills', { registerProvider() { return () => {}; } });
  const plugin = await ctx.plugin(meteor);
  assert.equal(ctx.tools.schemas().filter((tool: any) => tool.name.startsWith('meteor_')).length, 18);
  const failed = await ctx.tools.execute({ name: 'meteor_start', arguments: { goal: 'must require chief' }, callId: 'meteor-smoke', signal: new AbortController().signal });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /chief/);
  await plugin.dispose();
  assert.equal(ctx.tools.schemas().filter((tool: any) => tool.name.startsWith('meteor_')).length, 0);
  await ctx.fiber.dispose();
});
