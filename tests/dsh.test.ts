import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import meteor, { createHost } from '../src/index.ts';
import { initProject } from '../src/init.ts';
import { loadProject, loadProjectRuntime } from '../src/project.ts';
import { writablePath } from '../src/research-tools.ts';

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
  const childReady = deferred(); const final = deferred();
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
        const registeredSkills: any[] = [];
        const child = { id: `child-${starts.length}`, session: { id: `child-${starts.length}`, header: { cwd: root, parentSession: chief.id, origin: 'subagent' } }, ctx: { compaction: {}, skills: { register(value: any) { registeredSkills.push(value); } } } };
        let disposed = false;
        const result = (async () => {
          for (const fn of listeners.get('agent/pre-step') ?? []) await fn({ agent: child, messages: [{ content: request.prompt }], signal: request.signal }, async () => ({ kind: 'enter', messages: [] }));
          childReady.resolve({ child, registeredSkills });
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
  return { root, host, ctx, tools, listeners, guards, jobs, starts, chief, childReady, final, exec, call };
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

test('chief can read files through meteor_read_file before project initialization', async () => {
  const h = harness({ init: false });
  writeFileSync(join(h.root, 'operator.json'), '{"abi":"qmq-v1"}\n');
  assert.equal((await h.call('meteor_read_file', { path: 'operator.json' })).text, '{"abi":"qmq-v1"}\n');
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
  assert.equal(startup.contracts_ref, join(h.root, 'reports/meteor/mock/research/continuous/kernel-contracts.md'));
  assert.match(readFileSync(startup.contracts_ref, 'utf8'), /KernelModule JSON/);
  assert.match(readFileSync(startup.contracts_ref, 'utf8'), /supported_case_ids/);
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
  const before = await h.call('meteor_status', { research_id: 'continuous' });
  assert.equal(before.run_status, 'OUTPUT_FROZEN');
  assert.equal(before.submission_id, undefined);
  assert(h.guards.some(g => g({ agent: child, name: 'structured_output', arguments: { prepared_submission_id: 'wrong' } })));
  h.final.resolve({ stopReason: 'completed', output: [], structured: { prepared_submission_id: prepared.prepared_submission_id } });
  const outcome = await h.jobs.get(started.job_id).done;
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  const report = JSON.parse(outcome.result);
  assert.equal(report.report.report.next_steps[0], 'Configure SSH and measure the original hypothesis');
  assert.equal(report.research.research_goal_met, false);
  assert.equal(report.research.agent_session_id, child.id);
  assert.equal(h.starts.length, 1);
  await h.host.dispose();
});

test('chief reads project files and child reads relative to its bound project root', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'chief-visible.txt'), 'chief can read the project cwd');
  assert.equal((await h.call('meteor_read_file', { path: 'chief-visible.txt' })).text, 'chief can read the project cwd');
  const started = await h.call('meteor_start', { research_id: 'read-scope', goal: 'Verify read scope' });
  const { child } = await h.childReady.promise;
  assert.match((await h.call('meteor_read_file', { path: 'asc/operator.json' }, child)).text, /qmq-v1/);
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
  const directory = join(h.root, 'reports/meteor/mock/research/chief-assigned');
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
  await h.childReady.promise;
  const seed = JSON.parse(readFileSync(join(h.root, 'reports/meteor/mock/research/configured-sampling/seed.json'), 'utf8'));
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
  const state = h.host.active.get('iterations')!;
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
    const build = await h.call('meteor_kernel_build', { experiment_id: revision, kernel_path: kernelPath }, child);
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
  const state = h.host.active.get('early-report')!;
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

test('restart reports the lost run using its pinned snapshot without another Agent', async () => {
  const h = harness(); const project = loadProject(h.root); const runtime = await loadProjectRuntime(project);
  runtime.research.createResearch(project, { research_id: 'lost', chief_id: 'previous-chief', agent_session_id: 'old-child', goal: 'Preserve unfinished work' });
  runtime.research.updateResearch(project, 'lost', { run_status: 'ACTIVE' });
  const configPath = join(h.root, 'meteor.config.json'); const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.environment.environment_ref = 'future-environment'; writeFileSync(configPath, JSON.stringify(config));
  const status = await h.call('meteor_status', { research_id: 'lost' });
  assert.equal(status.run_status, 'INTERRUPTED');
  assert.equal(status.environment_ref, project.config.environment.environment_ref);
  assert.equal(status.report.agent_session_id, 'old-child'); assert.equal(h.starts.length, 0);
  await h.host.dispose();
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

test('remote cancellation remains uncertain and collection reuses the original request identity', async () => {
  const h = harness();
  const started = await h.call('meteor_start', { research_id: 'remote-control', goal: 'Verify remote request lifecycle' });
  const { child } = await h.childReady.promise;
  const state = h.host.active.get('remote-control')!;
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
  assert(cancelled.every(id => id === `build-${request.request_id}`));
  const collected = await h.call('meteor_run_control', { request_id: request.request_id, action: 'collect' }, child);
  assert.equal(collected.status, 'COMPLETED');
  assert.equal(collected.receipt.build_id, 'original-build');
  assert.deepEqual(identities, [request.request_id, request.request_id]);
  await h.call('meteor_control', { research_id: 'remote-control', action: 'cancel' });
  await h.jobs.get(started.job_id).done;
  await h.host.dispose();
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
  assert.equal(ctx.tools.schemas().filter((tool: any) => tool.name.startsWith('meteor_')).length, 14);
  const failed = await ctx.tools.execute({ name: 'meteor_start', arguments: { goal: 'must require chief' }, callId: 'meteor-smoke', signal: new AbortController().signal });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /chief/);
  await plugin.dispose();
  assert.equal(ctx.tools.schemas().filter((tool: any) => tool.name.startsWith('meteor_')).length, 0);
  await ctx.fiber.dispose();
});
