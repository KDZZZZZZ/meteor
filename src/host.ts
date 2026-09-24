import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { initProject } from './init.ts';
import { loadProject, loadProjectRuntime } from './project.ts';

/** Structural alpha.2 interfaces keep the plugin free of a second Cordis runtime. */
export interface Agent {
  id: string;
  session: { id?: string; header: { cwd?: string; parentSession?: string; origin?: string }; events?: readonly any[] };
  ctx?: any;
}
export interface ToolExecution { agent?: Agent; signal: AbortSignal; [key: string]: unknown }
export interface DshContext {
  get?(name: string): any;
  tools: { register(tool: any): () => void; get(name: string, scope?: unknown): unknown; schemas?(scope?: unknown): any[]; guard?(guard: (exec: any) => string | undefined): () => void };
  jobs: { start(spec: any): string; get?(id: string, owner?: string): unknown; kill?(id: string, owner?: string, reason?: string): unknown };
  subagents: { start(provider: string, request: any): Promise<any>; getProvider?(name: string): any };
  on(event: string, listener: (...args: any[]) => any): () => void;
  compaction?: unknown;
  skills?: unknown;
  logger?: { warn(message: string): void };
}
export interface ActiveResearch {
  id: string; chief: Agent; project: any; runtime: any;
  controller: AbortController; token: string; sessionId?: string; jobId?: string;
  run?: any; paused: boolean; pauseRequested: boolean; waiters: Set<() => void>;
  preparedIds: Set<string>; finalAccepted: boolean; done?: Promise<any>;
}

export const RESEARCH_TOOLS = [
  'meteor_read_file', 'meteor_write_file', 'meteor_kernel_build', 'meteor_kernel_test',
  'meteor_kernel_profile', 'meteor_run_status', 'meteor_run_control', 'meteor_prepare_submission',
];
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'skill', 'web_search', 'web_fetch'];
const TERMINAL = new Set(['CLOSED', 'CANCELLED', 'FAILED', 'INTERRUPTED']);
const OUTPUT_SCHEMA = {
  type: 'object', properties: { prepared_submission_id: { type: 'string' } },
  required: ['prepared_submission_id'], additionalProperties: false,
};

export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, any>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a nonempty string`);
  return value;
}
function checkedId(value: unknown): string {
  const id = text(value, 'research_id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(id) || id.includes('..')) throw new Error('Invalid research_id');
  return id;
}
function abortError(signal: AbortSignal): Error { return new Error(signal.reason ? String(signal.reason) : 'Research cancelled'); }
function plain(value: any): any { return JSON.parse(JSON.stringify(value)); }
function agentService(agent: Agent, name: string): any {
  return agent.ctx?.get ? agent.ctx.get(name) : agent.ctx?.[name];
}
function compactionFor(ctx: DshContext, agent: Agent): unknown {
  // Web presets hide the service behind a Cordis realm, even from Agent.ctx.
  const presets = ctx.get?.('agentPresets');
  return presets?.serviceFor(agent, 'compaction')
    ?? agentService(agent, 'compaction');
}

export class MeteorHost {
  readonly ctx: DshContext;
  readonly active = new Map<string, ActiveResearch>();
  readonly sessions = new Map<string, ActiveResearch>();
  private integrations = new Map<string, Promise<any>>();
  private disposers: Array<() => void> = [];

  constructor(ctx: DshContext) {
    this.ctx = ctx;
    // The public pre-step waterfall can wait without ending the native run.
    this.disposers.push(ctx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
      let state = this.sessions.get(payload.agent.id);
      if (!state) {
        const first = (payload.messages ?? []).flatMap((m: any) => m.content ?? []).find((b: any) =>
          b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('METEOR_RESEARCH '));
        if (first) {
          const match = /^METEOR_RESEARCH ([\w.-]+) ([\w-]+)\n/.exec(first.text);
          const pending = match && this.active.get(match[1]);
          if (pending && pending.token === match![2] && payload.agent.session.header.parentSession === pending.chief.id) {
            await this.bind(pending, payload.agent.id, payload.agent);
            state = pending;
          }
        }
      }
      if (state) await this.boundary(state, payload.signal);
      return next();
    }));
    this.disposers.push(ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
      const state = exec.agent && this.sessions.get(exec.agent.id);
      if (state) await this.boundary(state, exec.signal);
      return next();
    }));
    // Validate the prepared reference BEFORE structured_output concludes the run.
    if (ctx.tools.guard) this.disposers.push(ctx.tools.guard(exec => {
      const state = exec.agent && this.sessions.get(exec.agent.id);
      if (!state) return;
      // DSH may register tools on the child's own layer after applying its
      // inherited-tool filter (for example its native subagent tool).
      if (![...RESEARCH_TOOLS, ...READ_TOOLS, 'structured_output'].includes(exec.name)) {
        return 'This research stays in its original agent. Use the Meteor experiment, read, skill and submission tools.';
      }
      if (exec.name === 'structured_output' && !state.preparedIds.has(exec.arguments?.prepared_submission_id)) {
        return 'Call meteor_prepare_submission successfully in this research session before structured_output.';
      }
    }));
  }

  chief(exec: ToolExecution): Agent {
    const agent = exec.agent;
    if (!agent || this.sessions.has(agent.id) || agent.session.header.origin === 'subagent') {
      throw new Error('This tool requires the live chief agent');
    }
    return agent;
  }
  root(agent: Agent): string {
    const cwd = text(agent.session.header.cwd, 'chief cwd');
    if (!isAbsolute(cwd)) throw new Error('chief cwd must be absolute');
    return resolve(cwd);
  }
  async init(exec: ToolExecution): Promise<any> { return initProject(this.root(this.chief(exec))); }
  async hardware(args: any, exec: ToolExecution): Promise<any> {
    const { probeHardware } = await import('./hardware.ts');
    const root = this.root(this.chief(exec));
    if ([...this.active.values()].some(state => state.project.root === root && !state.finalAccepted && !state.controller.signal.aborted)) {
      throw new Error('Finish or cancel active research before rebinding its project hardware');
    }
    return probeHardware(root, args.profile_ref, exec.signal);
  }

  async start(input: unknown, exec: ToolExecution): Promise<any> {
    const args = object(input);
    const chief = this.chief(exec);
    exec.signal.throwIfAborted();
    if (!compactionFor(this.ctx, chief) || !agentService(chief, 'skills') || !this.ctx.tools.get('skill', chief)) {
      throw new Error('meteor requires the DSH compaction service and native skill tool for continuous research');
    }
    const project = await loadProject(this.root(chief));
    const initial = await loadProjectRuntime(project);
    const id = args.research_id === undefined ? randomUUID() : checkedId(args.research_id);
    if (this.active.has(id)) throw new Error('Research already has a native run');
    await initial.research.createResearch(project, {
      research_id: id, chief_id: chief.id, agent_session_id: 'pending',
      goal: text(args.goal, 'goal'), ...(args.budget === undefined ? {} : { budget: object(args.budget) }),
      initial_context: args.initial_context,
      assigned_hypothesis: args.hypothesis,
    });
    const runtime = await loadProjectRuntime(project);
    const state: ActiveResearch = {
      id, chief, project, runtime, controller: new AbortController(), token: randomUUID(),
      paused: false, pauseRequested: false, waiters: new Set(), preparedIds: new Set(), finalAccepted: false,
    };
    this.active.set(id, state);
    try {
      exec.signal.throwIfAborted();
      const jobId = this.ctx.jobs.start({
        kind: 'meteor', label: `meteor: ${args.goal.slice(0, 100)}`, owner: chief.id,
        run: () => {
          state.done = this.drive(state);
          return {
            cancel: (reason?: string) => this.cancel(state, reason ?? 'Cancelled by chief or job controller'),
            done: state.done,
          };
        },
      });
      state.jobId = jobId;
      await runtime.research.updateResearch(project, id, { job_id: jobId });
      return { research_id: id, job_id: jobId, status: 'STARTING', execution_backend: project.config.execution.backend };
    } catch (error) {
      if (state.done) this.cancel(state, 'Job publication failed');
      await this.failure(state, 'FAILED', String(error));
      this.active.delete(id);
      throw error;
    }
  }

  private async bind(state: ActiveResearch, sessionId: string, agent?: Agent): Promise<void> {
    if (state.sessionId && state.sessionId !== sessionId) throw new Error('Research cannot switch its agent session');
    if (state.sessionId === sessionId) return;
    const skills = agent && agentService(agent, 'skills');
    if (!agent || !compactionFor(this.ctx, agent) || !skills?.register || !this.ctx.tools.get('skill', agent)) {
      throw new Error('Research Agent requires its own DSH compaction service, skill registry and native skill tool');
    }
    state.sessionId = sessionId;
    this.sessions.set(sessionId, state);
    await state.runtime.research.bindResearchSession(state.project, state.id, sessionId);
    await state.runtime.research.updateResearch(state.project, state.id, { run_status: 'ACTIVE' });
    // Snapshot both skill bodies into the SAME child's skill registry before its first step.
    for (const name of ['meteor-kernel-test', 'meteor-performance-analysis']) {
      const skillPath = resolve(state.project.snapshotRoot ?? state.project.root, '.dsh/skills', name, 'SKILL.md');
      skills.register({ name, description: name === 'meteor-kernel-test' ? 'Independent exact-revision full case testing' : 'Hypothesis evidence and performance analysis',
        source: 'runtime', content: readFileSync(skillPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''),
        path: skillPath, resourceBase: { kind: 'directory', path: dirname(skillPath) } });
    }
  }

  private async drive(state: ActiveResearch): Promise<any> {
    let outcome: any;
    try {
      const snapshot = state.project.snapshotRoot ?? state.project.root;
      const persona = readFileSync(resolve(snapshot, 'prompts/meteor.md'), 'utf8');
      const runRoot = this.researchDir(state.project, state.id);
      const record = state.runtime.research.getResearch(state.project, state.id);
      const seedPath = resolve(runRoot, 'seed.json');
      if (!existsSync(seedPath)) writeFileSync(seedPath, JSON.stringify(await state.runtime.sampling.selectInitialMaterials(state.project, record.initial_context), null, 2) + '\n', { flag: 'wx' });
      const prompt = `METEOR_RESEARCH ${state.id} ${state.token}\n` + JSON.stringify({
        research_id: state.id, goal: record.goal,
        initial_context: record.initial_context, assigned_hypothesis: record.assigned_hypothesis ?? null,
        project_root: state.project.root, research_directory: runRoot,
        contracts_ref: resolve(snapshot, 'tools/meteor', existsSync(resolve(snapshot, 'tools/meteor/contracts.ts')) ? 'contracts.ts' : 'contracts.md'),
        manifest_ref: resolve(runRoot, 'manifest.json'),
        kernel_template_ref: resolve(snapshot, 'asc/kernel_test.asc.tmpl'),
        operator_contract_ref: resolve(snapshot, 'asc/operator.json'),
        instructions: 'Read the contracts and single-kernel template first. Write kernel modules under your research_directory/drafts. kernel.json device_file and host_file are relative to project_root. Tools bind research/session identity automatically; do not pass extra identity parameters. Report all experiments and final next_steps.',
        execution_backend: state.project.config.execution.backend,
        case_suite: state.project.suite, seed_ref: existsSync(seedPath) ? seedPath : null,
        skills: ['meteor-kernel-test', 'meteor-performance-analysis'],
        material_policy: 'Seeds are inspiration only. Read other kernels, knowledge, and any accessible files; no inheritance is required.',
        hardware_report_ref: state.project.config.environment.hardware_report_ref,
        hypothesis_policy: 'If assigned_hypothesis is present, test the original proposition and fill missing experimental details. Treat verdicts quoted in goals, old reports or seeds as prior claims to examine, never predetermined outcomes. Reassess support/refutation using relevant controls and mechanism evidence; faster or slower kernels alone do not establish the hypothesis. A supported revision does not settle an inconclusive original. Otherwise propose your own hypothesis.',
        completion: 'Use meteor_prepare_submission, then native structured_output with its prepared_submission_id. Keep one continuous session.',
      });
      const allow = [...RESEARCH_TOOLS, ...READ_TOOLS.filter(name => this.ctx.tools.get(name, state.chief))];
      state.run = await this.ctx.subagents.start('spawn', {
        label: `meteor ${state.id}`, parent: state.chief, signal: state.controller.signal,
        prompt: [{ type: 'text', text: prompt }], persona,
        toolFilter: { allow }, outputSchema: OUTPUT_SCHEMA,
      });
      if (!state.run.localAgent) throw new Error('meteor requires an in-process spawn provider with a continuous local session');
      await this.bind(state, state.run.id, state.run.localAgent);
      const result = await state.run.result;
      const output = (result.output ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (result.stopReason !== 'completed') {
        const status = result.stopReason === 'aborted' ? 'CANCELLED' : 'FAILED';
        const report = await this.failure(state, status, `Native run ended: ${result.stopReason}`, output);
        outcome = { status: status === 'CANCELLED' ? 'killed' : 'failed', detail: result.stopReason, result: JSON.stringify(report) };
      } else {
        const preparedId = result.structured?.prepared_submission_id;
        if (typeof preparedId !== 'string' || !state.preparedIds.has(preparedId)) {
          throw new Error('Native final result did not reference a submission prepared in the same session');
        }
        state.finalAccepted = true;
        await state.runtime.research.updateResearch(state.project, state.id, {
          run_status: 'COMMIT_PENDING', prepared_submission_id: preparedId, final_session_id: state.sessionId,
        });
        const committed = await state.runtime.submit.commitSubmission(state.project, preparedId, state.sessionId);
        const integration = this.startIntegration(state.project, state.runtime, state.chief, committed.integration_event_id);
        const record = await state.runtime.research.getResearch(state.project, state.id);
        outcome = { status: 'completed', result: JSON.stringify({ research: record, report: committed, integration }) };
      }
    } catch (error) {
      if (state.finalAccepted) {
        await state.runtime.research.updateResearch(state.project, state.id, { recovery_error: String(error) });
        outcome = { status: 'failed', detail: 'Committed final output needs recovery', result: JSON.stringify({ research_id: state.id, error: String(error), next_steps: ['Read meteor_status to retry durable commit and integration without another Agent.'] }) };
      } else {
        const status = state.controller.signal.aborted ? 'CANCELLED' : 'FAILED';
        const report = await this.failure(state, status, String(error));
        outcome = { status: status === 'CANCELLED' ? 'killed' : 'failed', result: JSON.stringify(report) };
      }
    } finally {
      for (const wake of state.waiters) wake();
      if (state.run) {
        try { await state.run.dispose(); }
        catch (error) { outcome = { status: 'failed', detail: 'Native run cleanup failed', result: JSON.stringify({ previous: outcome, error: String(error) }) }; }
      }
      this.active.delete(state.id);
      if (state.sessionId) this.sessions.delete(state.sessionId);
    }
    return outcome;
  }

  researchDir(project: any, id: string): string { return resolve(project.dataRoot, 'research', checkedId(id)); }

  private startIntegration(project: any, runtime: any, chief: Agent, eventId: string): any {
    const key = `${project.root}\0${eventId}`;
    if (this.integrations.has(key)) return { integration_event_id: eventId, status: 'RUNNING' };
    let cancelled = false;
    const run = () => {
      const done = (async () => {
        try {
          const result = await runtime.integration.processIntegrationEvents(project);
          return { status: 'completed', result: JSON.stringify({ integration_event_id: eventId, result, ...(cancelled ? { note: 'Cancellation requested after admission; durable integration settled safely.' } : {}) }) };
        } catch (error) {
          return { status: 'failed', result: JSON.stringify({ integration_event_id: eventId, error: String(error), next_steps: ['Read meteor_status to retry the durable integration event.'] }) };
        } finally { this.integrations.delete(key); }
      })();
      this.integrations.set(key, done);
      return { done, cancel: () => { cancelled = true; } };
    };
    try {
      const jobId = this.ctx.jobs.start({ kind: 'meteor-integration', label: `meteor integration ${eventId}`, owner: chief.id, run });
      return { integration_event_id: eventId, job_id: jobId, status: 'QUEUED' };
    } catch {
      // An occupied UI job limit must not suppress already committed deterministic work.
      run();
      return { integration_event_id: eventId, status: 'QUEUED', receipt: 'meteor_status' };
    }
  }

  private async failure(state: ActiveResearch, status: string, reason: string, partial = ''): Promise<any> {
    const report = {
      research_id: state.id, agent_session_id: state.sessionId ?? null, run_status: status,
      research_goal_met: false, hypothesis_verdict: 'INCONCLUSIVE', reason, partial_output: partial,
      next_steps: ['Inspect the preserved experiment evidence and memory; chief may start a separately identified research task.'],
    };
    const path = resolve(this.researchDir(state.project, state.id), 'host-report.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    await state.runtime.research.updateResearch(state.project, state.id, { run_status: status, error: reason, report_ref: path, research_goal_met: false });
    return report;
  }

  async boundary(state: ActiveResearch, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    state.controller.signal.throwIfAborted();
    if (!state.pauseRequested) return;
    if (!state.paused) {
      state.paused = true;
      await state.runtime.research.updateResearch(state.project, state.id, { run_status: 'PAUSED', pause_requested: true });
    }
    while (state.pauseRequested && !state.controller.signal.aborted && !signal?.aborted) {
      await new Promise<void>(resolveWait => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          state.controller.signal.removeEventListener('abort', wake);
          state.waiters.delete(wake);
          resolveWait();
        };
        state.waiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
        state.controller.signal.addEventListener('abort', wake, { once: true });
      });
    }
    if (signal?.aborted) throw abortError(signal);
    state.controller.signal.throwIfAborted();
  }

  requireResearch(exec: ToolExecution): ActiveResearch {
    const state = exec.agent && this.sessions.get(exec.agent.id);
    if (!state) throw new Error('Tool is available only to its original active meteor research session');
    if (state.finalAccepted) throw new Error('Research final output is already frozen');
    return state;
  }
  private cancel(state: ActiveResearch, reason: string): void {
    state.controller.abort(reason);
    state.pauseRequested = false;
    for (const wake of state.waiters) wake();
  }

  async control(input: unknown, exec: ToolExecution): Promise<any> {
    const args = object(input); const chief = this.chief(exec); const id = checkedId(args.research_id);
    const state = this.active.get(id);
    if (!state || state.chief.id !== chief.id || state.project.root !== this.root(chief)) throw new Error('No owned active research; an ended session cannot be resumed');
    if (state.finalAccepted) throw new Error('Research has already delivered final output');
    switch (args.action) {
      case 'pause': state.pauseRequested = true; await state.runtime.research.updateResearch(state.project, id, { pause_requested: true }); break;
      case 'resume':
        state.pauseRequested = false; state.paused = false;
        await state.runtime.research.updateResearch(state.project, id, { run_status: state.sessionId ? 'ACTIVE' : 'CREATED', pause_requested: false });
        for (const wake of state.waiters) wake(); break;
      case 'cancel': this.cancel(state, typeof args.reason === 'string' ? args.reason : 'Cancelled by chief'); break;
      default: throw new Error('action must be pause, resume, or cancel');
    }
    return { research_id: id, action: args.action, paused: state.paused, pause_requested: state.pauseRequested, agent_session_id: state.sessionId ?? null };
  }

  async status(input: unknown, exec: ToolExecution): Promise<any> {
    const args = object(input); const chief = this.chief(exec); const project = await loadProject(this.root(chief));
    if (args.research_id === undefined) {
      const dir = resolve(project.dataRoot, 'research');
      if (!existsSync(dir)) return { research: [] };
      const records = await Promise.all(readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => this.status({ research_id: d.name }, exec)));
      return { research: records };
    }
    const id = checkedId(args.research_id); const active = this.active.get(id);
    let currentProject: any = active?.project ?? project;
    if (!active) {
      let runRoot = this.researchDir(project, id);
      if (!existsSync(resolve(runRoot, 'manifest.json'))) {
        const alternative = { ...project, dataRoot: resolve(project.root, 'reports/meteor', project.config.execution.backend === 'mock' ? 'ssh' : 'mock') };
        if (existsSync(resolve(this.researchDir(alternative, id), 'manifest.json'))) {
          currentProject = alternative;
          runRoot = this.researchDir(alternative, id);
        }
      }
      const snapshot = resolve(runRoot, 'snapshot');
      if (existsSync(resolve(snapshot, 'meteor.config.json'))) currentProject = {
        ...currentProject, snapshotRoot: snapshot,
        config: JSON.parse(readFileSync(resolve(snapshot, 'meteor.config.json'), 'utf8')),
        suite: JSON.parse(readFileSync(resolve(snapshot, 'case-suite.json'), 'utf8')),
      };
    }
    const runtime = active?.runtime ?? await loadProjectRuntime(currentProject);
    let record = await runtime.research.getResearch(currentProject, id);
    let recovery: any;
    if (!active && record.prepared_submission_id && record.final_session_id && ['COMMIT_PENDING', 'REPORT_PENDING'].includes(record.run_status)) {
      // Only a durable accepted native final result may be replayed after restart.
      recovery = await runtime.submit.commitSubmission(currentProject, record.prepared_submission_id, record.final_session_id);
      record = await runtime.research.getResearch(currentProject, id);
    } else if (!active && !TERMINAL.has(record.run_status)) {
      const path = resolve(this.researchDir(currentProject, id), 'host-report.json');
      const reason = 'Original native run is no longer resident; no replacement Agent was created.';
      writeFileSync(path, JSON.stringify({ research_id: id, agent_session_id: record.agent_session_id, run_status: 'INTERRUPTED',
        research_goal_met: false, reason, evidence_directory: this.researchDir(currentProject, id),
        next_steps: ['Inspect the preserved hypothesis, experiments and memory; start a separate research only if needed.'] }, null, 2) + '\n');
      record = await runtime.research.updateResearch(currentProject, id, { run_status: 'INTERRUPTED', research_goal_met: false, error: reason, report_ref: path });
    }
    const report = record.report_ref && existsSync(record.report_ref) ? JSON.parse(readFileSync(record.report_ref, 'utf8')) : undefined;
    const integration = record.integration_event_id ? await runtime.integration.getIntegrationStatus(currentProject, record.integration_event_id) : undefined;
    if (!active && integration && !['ASSEMBLED', 'SKIPPED', 'NO_CHANGE'].includes(integration.status)) {
      this.startIntegration(currentProject, runtime, chief, record.integration_event_id);
    }
    return plain({ ...record, live: Boolean(active), report, integration, ...(recovery === undefined ? {} : { recovery }) });
  }

  evidence(input: unknown, exec: ToolExecution): any {
    const args = object(input); const chief = this.chief(exec);
    const path = resolve(this.root(chief), text(args.path, 'path'));
    return { path, text: readFileSync(path, 'utf8').slice(0, 100_000) };
  }

  async dispose(): Promise<void> {
    for (const state of this.active.values()) this.cancel(state, 'meteor plugin unloaded');
    await Promise.allSettled([...this.active.values()].map(s => s.done));
    await Promise.allSettled([...this.integrations.values()]);
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
