import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { initProject } from './init.ts';
import { hardwareExperiment, hardwareModel } from './hardware-preparation.ts';
import { loadProject, loadProjectRuntime, loadWorkspace } from './project.ts';
import { researchPath } from '../templates/project/tools/meteor/research.ts';
import { targetFile, targetPath } from '../templates/project/tools/meteor/workspace.ts';
import { assertMigrationIdle } from '../templates/project/tools/meteor/legacy.ts';
import type { Backend } from '../templates/project/tools/meteor/contracts.ts';
import { readRemoteRequests } from './remote-requests.ts';
import { remoteIdempotency } from '../templates/project/tools/meteor/runners/ssh.ts';

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
  key: string; id: string; chief: Agent; project: any; runtime: any;
  controller: AbortController; token: string; sessionId?: string; jobId?: string;
  run?: any; paused: boolean; pauseRequested: boolean; waiters: Set<() => void>;
  preparedIds: Set<string>; finalAccepted: boolean; done?: Promise<any>;
}

export const RESEARCH_TOOLS = [
  'meteor_read_file', 'meteor_write_file', 'meteor_design', 'meteor_kernel_build', 'meteor_kernel_test',
  'meteor_kernel_profile', 'meteor_run_status', 'meteor_run_control', 'meteor_prepare_submission',
];
const READ_TOOLS = ['read', 'read_image', 'glob', 'grep', 'skill', 'web_search', 'web_fetch'];
const TERMINAL = new Set(['CLOSED', 'CANCELLED', 'FAILED', 'INTERRUPTED']);
const TERMINAL_INTEGRATION = new Set(['ASSEMBLED', 'SKIPPED', 'NO_CHANGE']);
const MAX_INTEGRATION_FAILURES = 3;
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
function scopedKey(project: any, id: string): string {
  return JSON.stringify([resolve(project.root), project.scope?.workspace_id ?? '', project.scope?.op_id ?? '', project.scope?.dtype_id ?? '', id]);
}
/** Observe the manifest's frozen wall-time budget; never change research state. */
export function observeResearchBudget(record: any, live: boolean, observedAtMs = Date.now()): {
  observed_at: string | null;
  wall_time: { state: 'active' | 'inactive' | 'unknown'; deadline_at: string | null;
    elapsed_seconds: number | null; remaining_seconds: number | null; exhausted: boolean | null };
} {
  const observation = new Date(observedAtMs);
  const observed_at = Number.isFinite(observation.getTime()) ? observation.toISOString() : null;
  const unavailable = { deadline_at: null, elapsed_seconds: null, remaining_seconds: null, exhausted: null };
  if (!live || !['CREATED', 'ACTIVE', 'PAUSED', 'OUTPUT_FROZEN'].includes(record?.run_status)) {
    return { observed_at, wall_time: { state: 'inactive', ...unavailable } };
  }
  const createdAt = typeof record?.created_at === 'string' ? Date.parse(record.created_at) : NaN;
  const seconds = record?.budget?.max_wall_time_seconds;
  // Our manifests store canonical ISO timestamps. Reject parser normalization,
  // missing values and a clock before creation instead of inventing a deadline.
  if (observed_at === null || !Number.isFinite(createdAt)
    || new Date(createdAt).toISOString() !== record.created_at || observedAtMs < createdAt
    || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return { observed_at, wall_time: { state: 'unknown', ...unavailable } };
  }
  const deadlineMs = createdAt + seconds * 1000;
  const deadline = new Date(deadlineMs);
  if (!Number.isFinite(deadline.getTime())) return { observed_at, wall_time: { state: 'unknown', ...unavailable } };
  return { observed_at, wall_time: { state: 'active', deadline_at: deadline.toISOString(),
    elapsed_seconds: (observedAtMs - createdAt) / 1000,
    remaining_seconds: Math.max(0, (deadlineMs - observedAtMs) / 1000), exhausted: observedAtMs >= deadlineMs } };
}
function agentService(agent: Agent, name: string): any {
  return agent.ctx?.get ? agent.ctx.get(name) : agent.ctx?.[name];
}
function compactionFor(ctx: DshContext, agent: Agent): unknown {
  // Web presets hide the service behind a Cordis realm, even from Agent.ctx.
  const presets = ctx.get?.('agentPresets');
  return presets?.serviceFor(agent, 'compaction')
    ?? agentService(agent, 'compaction');
}
function kernelContractsDocument(project: any, researchDirectory: string): string {
  const draft = relative(project.root, resolve(researchDirectory, 'drafts/<kernel>/<revision>')).split(sep).join('/');
  const example = {
    kernel_id: 'short-stable-name', revision: 'r1',
    ...(project.scope ? { target: project.scope } : {}),
    operator_abi: project.suite.operator_abi, symbol_prefix: 'short_prefix_', launcher: 'short_prefix_launch',
    device_file: `${draft}/device.asc`, host_file: `${draft}/host.asc`,
    supported_case_ids: ['case-id-from-case_suite'], dependencies: [],
    hardware_scope: 'hardware and shape scope this revision was designed for', resource_constraints: [],
  };
  return `# Meteor Kernel Contracts

This file is generated for the active research snapshot. Treat it as read-only reference material.

## KernelModule JSON

Write one kernel module manifest as \`kernel.json\` under \`research_directory/drafts/<kernel>/<revision>/\`.
File paths inside \`kernel.json\` are relative to \`project_root\`.

\`\`\`json
${JSON.stringify(example, null, 2)}
\`\`\`

Required fields mirror the runtime \`KernelModule\` interface:

- \`kernel_id\` and \`revision\`: identify this exact candidate.
- \`operator_abi\`: use \`${project.suite.operator_abi}\` for this bound target.
- \`symbol_prefix\`: prefix for exported candidate symbols; keep it unique per revision.
- \`launcher\`: exactly \`symbol_prefix + "launch"\`, including only separators already present in the prefix. For example, \`short_prefix_\` requires \`short_prefix_launch\`. Implement this symbol in \`host_file\` with the signature in \`kernel_template_ref\`.
- \`device_file\` and \`host_file\`: candidate source files, relative to \`project_root\`.
- \`supported_case_ids\`: fixed-suite case ids this candidate claims to support.
- \`dependencies\`: optional shared source dependencies, each with \`id\`, \`path\`, \`sha256\`, and \`kind\` of \`preamble\` or \`shared\`.
- \`hardware_scope\`: concise hardware and shape domain intended for this revision.
- \`resource_constraints\`: known limits such as memory, alignment, or unsupported shapes.

## Source insertion and ABI ownership

The assembler inserts device_file, then host_file into ONE translation unit.
The template already defines TensorInfo, TensorGroupInfo, MeteorCall, MeteorShape,
MeteorResources, MeteorStatus and the external run_kernel entry. Do not redefine
these in a candidate. host_file implements only the candidate launcher and its
helpers; the preceding device definition is already visible, so another forward
declaration is unnecessary. Any declaration you do add must match its definition
exactly, including types, attributes and linkage.

Launcher signature (replace short_prefix_ with this revision's symbol_prefix):

\`\`\`cpp
MeteorStatus short_prefix_launch(const MeteorCall& call,
                                 const MeteorShape& shape,
                                 const MeteorResources& resources);
\`\`\`

Read \`operator_contract_ref\`, \`kernel_template_ref\`, \`design_guide_ref\`, and the compact \`case_suite\` catalogue from the startup package before writing a candidate. The frozen \`case_suite_ref\` holds complete input/oracle identities and paths; the catalogue already lists every case ID and shape.
Use \`meteor_design\` to open a design, check expected source comments before implementation, check and freeze the implementation, then build with its \`design_ref\`. After tests or profiling, compare the actual receipts with the expected activities in this same session. Every submitted kernel requires its own exact-revision \`meteor_kernel_test\` with \`mode: "full"\`.
`;
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
          const pending = match && [...this.active.values()].find(candidate => candidate.id === match[1]
            && candidate.token === match[2] && payload.agent.session.header.parentSession === candidate.chief.id);
          if (pending) {
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
        return 'Use the latest successful meteor_prepare_submission ID from this research session. A prepared:false result is not ready. Further writes, design or experiment operations invalidate earlier preparations; finish that work and prepare again before structured_output.';
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

  async hardwareExperiment(args: any, exec: ToolExecution): Promise<any> {
    const chief = this.chief(exec), root = this.root(chief);
    if (args.action === 'run' && [...this.active.values()].some(state => state.project.root === root && !state.finalAccepted && !state.controller.signal.aborted)) {
      throw new Error('Hardware preparation experiments run before research; finish active research before starting a new setup diagnostic. Existing requests can still be polled/collected.');
    }
    return hardwareExperiment(root, args, chief.id, exec.signal);
  }

  async hardwareModel(args: any, exec: ToolExecution): Promise<any> {
    const chief = this.chief(exec), root = this.root(chief);
    if (args.action === 'publish' && [...this.active.values()].some(state => state.project.root === root && !state.finalAccepted && !state.controller.signal.aborted)) {
      throw new Error('Finish active research before selecting a new hardware model; existing research keeps its frozen model.');
    }
    return hardwareModel(root, args, chief.id);
  }

  async assemblyTemplate(args: any, exec: ToolExecution): Promise<any> {
    const { configureAssemblyTemplate } = await import('./assembly.ts');
    return configureAssemblyTemplate(this.root(this.chief(exec)), args);
  }

  async start(input: unknown, exec: ToolExecution): Promise<any> {
    const args = object(input);
    const chief = this.chief(exec);
    exec.signal.throwIfAborted();
    assertMigrationIdle(this.root(chief));
    if (!compactionFor(this.ctx, chief) || !agentService(chief, 'skills') || !this.ctx.tools.get('skill', chief)) {
      throw new Error('meteor requires the DSH compaction service and native skill tool for continuous research');
    }
    const project = await loadProject(this.root(chief), args.target);
    if (project.config.schema_version !== 2) throw new Error('Migrate this legacy project to the single-hardware workspace before starting new research. Existing research snapshots remain available through meteor_status.');
    if (!project.scope) throw new Error('A resolved workspace target is required before starting research');
    const initial = await loadProjectRuntime(project);
    const id = args.research_id === undefined ? randomUUID() : checkedId(args.research_id);
    const key = scopedKey(project, id);
    if (this.active.has(key)) throw new Error('Research already has a native run in this workspace target');
    const record = await initial.research.createResearch(project, {
      research_id: id, chief_id: chief.id, agent_session_id: 'pending',
      goal: text(args.goal, 'goal'), ...(args.budget === undefined ? {} : { budget: object(args.budget) }),
      initial_context: args.initial_context,
      assigned_hypothesis: args.hypothesis,
    });
    const runtime = await loadProjectRuntime(project);
    const state: ActiveResearch = {
      key, id, chief, project, runtime, controller: new AbortController(), token: randomUUID(),
      paused: false, pauseRequested: false, waiters: new Set(), preparedIds: new Set(), finalAccepted: false,
    };
    this.active.set(key, state);
    try {
      exec.signal.throwIfAborted();
      const jobId = this.ctx.jobs.start({
        kind: 'meteor', label: `meteor ${project.scope.op_id}/${project.scope.dtype_id}: ${args.goal.slice(0, 100)}`, owner: chief.id,
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
      return {
        research_id: id, job_id: jobId, status: 'STARTING', execution_backend: project.config.execution.backend,
        ...(project.scope ? { target: project.scope } : {}),
        initial_context: record.initial_context,
        ...(record.initial_context?.mode === 'specified' && Object.keys(args.initial_context?.sampling ?? {}).length > 0
          ? { ignored_initial_context_fields: ['sampling'] } : {}),
      };
    } catch (error) {
      if (state.done) this.cancel(state, 'Job publication failed');
      await this.failure(state, 'FAILED', String(error));
      this.active.delete(key);
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
      const runRoot = this.researchDir(state.project, state.id, state.runtime);
      const record = state.runtime.research.getResearch(state.project, state.id);
      const seedPath = resolve(runRoot, 'seed.json');
      if (!existsSync(seedPath)) writeFileSync(seedPath, JSON.stringify(await state.runtime.sampling.selectInitialMaterials(state.project, record.initial_context), null, 2) + '\n', { flag: 'wx' });
      const contractsPath = resolve(runRoot, 'kernel-contracts.md');
      if (!existsSync(contractsPath)) writeFileSync(contractsPath, kernelContractsDocument(state.project, runRoot), { flag: 'wx' });
      const prompt = `METEOR_RESEARCH ${state.id} ${state.token}\n` + JSON.stringify({
        research_id: state.id, goal: record.goal,
        initial_context: record.initial_context, assigned_hypothesis: record.assigned_hypothesis ?? null,
        project_root: state.project.root, research_directory: runRoot,
        target: state.project.scope ?? null,
        contracts_ref: contractsPath,
        manifest_ref: resolve(runRoot, 'manifest.json'),
        kernel_template_ref: resolve(targetFile(state.project, 'template_ref'), 'kernel_test.asc.tmpl'),
        operator_contract_ref: targetFile(state.project, 'contract_ref'),
        formula_ref: targetFile(state.project, 'contract_ref'),
        oracle_ref: targetFile(state.project, 'oracle_ref'),
        operator_adapter_ref: targetFile(state.project, 'adapter_ref'),
        design_guide_ref: state.runtime.design ? resolve(snapshot, 'tools/meteor/design/guide.md') : null,
        hardware_execution_model_ref: state.project.config.design?.hardware_model_ref
          ? resolve(snapshot, state.project.config.design.hardware_model_ref) : null,
        activity_primitives_ref: state.runtime.design ? resolve(snapshot, 'tools/meteor/design/reference.md') : null,
        instructions: 'The Chief has prepared the workspace hardware, environment and shared primitives. Reuse hardware_execution_model_ref; do not repeat hardware probing, environment setup or primitive definition. Compose your own kernel intermediate expressions from those primitives. Read the selected target formula, contracts, single-kernel template and design guide first. Write kernel modules under your research_directory/drafts. Use meteor_design open, author expected graph and hardware activity comments, and check expected before implementation. Preserve that expectation, implement, check/freeze, build with design_ref, observe using testing/profiling skills, then compare the real receipts in this original session. kernel.json device_file and host_file are relative to project_root. The assembler inserts device_file then host_file into one translation unit and already defines all Meteor/Tensor ABI types and run_kernel. Implement your candidate device functions and prefix+launch. Tools bind research/session/target identity automatically; do not pass extra identity parameters. Report all experiments, uncertainties and final next_steps.',
        execution_backend: state.project.config.execution.backend,
        case_suite_ref: targetFile(state.project, 'case_suite_ref'),
        case_suite: {
          revision: state.project.suite.revision, operator_abi: state.project.suite.operator_abi,
          cases: state.project.suite.cases.map(({ case_id, shape, dtype, layout }: any) => ({ case_id, shape, dtype, layout })),
        },
        seed_ref: existsSync(seedPath) ? seedPath : null,
        skills: ['meteor-kernel-test', 'meteor-performance-analysis'],
        material_policy: 'Seeds are inspiration only. Read other kernels, knowledge, and any accessible files; no inheritance is required.',
        hardware_report_ref: state.project.config.environment.hardware_report_ref
          ? resolve(state.project.root, state.project.config.environment.hardware_report_ref)
          : undefined,
        hypothesis_policy: 'If assigned_hypothesis is present, test the original proposition and fill missing experimental details. Treat verdicts quoted in goals, old reports or seeds as prior claims to examine, never predetermined outcomes. Reassess support/refutation using relevant controls and mechanism evidence; faster or slower kernels alone do not establish the hypothesis. A supported revision does not settle an inconclusive original. Otherwise propose your own hypothesis.',
        completion: 'Keep one continuous session through implementation, debugging and experiments. INCONCLUSIVE describes the current evidence; it does not end a research while feasible work and budget remain. Finish when the research criteria and requested deliverables are met, the actual budget is exhausted, an investigated external blocker prevents progress, or cancellation is requested. Then use meteor_prepare_submission and native structured_output with its prepared_submission_id.',
      });
      const allow = [...RESEARCH_TOOLS, ...READ_TOOLS.filter(name => this.ctx.tools.get(name, state.chief))];
      state.run = await this.ctx.subagents.start('spawn', {
        label: `meteor ${state.project.scope.op_id}/${state.project.scope.dtype_id} ${state.id}`, parent: state.chief, signal: state.controller.signal,
        prompt: [{ type: 'text', text: prompt }], persona,
        toolFilter: { allow }, outputSchema: OUTPUT_SCHEMA,
      });
      if (!state.run.localAgent) throw new Error('meteor requires an in-process spawn provider with a continuous local session');
      await this.bind(state, state.run.id, state.run.localAgent);
      const result = await state.run.result;
      const output = (result.output ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (result.stopReason !== 'completed') {
        const status = result.stopReason === 'aborted' ? 'CANCELLED' : 'FAILED';
        const missingFinal = state.preparedIds.size > 0 && !result.structured?.prepared_submission_id;
        const reason = `Native run ended: ${result.stopReason}` + (missingFinal
          ? '; a submission was prepared but no prepared_submission_id was returned in the native final result; nothing was committed'
          : '');
        const report = await this.failure(state, status, reason, output);
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
      this.active.delete(state.key);
      if (state.sessionId) this.sessions.delete(state.sessionId);
    }
    return outcome;
  }

  researchDir(project: any, id: string, runtime?: any): string {
    return (runtime?.research.researchPath ?? researchPath)(project, checkedId(id));
  }

  private startIntegration(project: any, runtime: any, chief: Agent, eventId: string): any {
    const key = `${scopedKey(project, eventId)}\0${project.config.execution.backend}`;
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
      prepared_submission_ids: [...state.preparedIds], committed: false,
      next_steps: ['Inspect the preserved evidence, memory and delivery diagnostics. Keep this research terminal state and budget; resolve any unknown original remote request before choosing further research. Preparation alone is not a committed submission.'],
    };
    const path = resolve(this.researchDir(state.project, state.id, state.runtime), 'host-report.json');
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
    if (['requests', 'poll_request', 'collect_request', 'cancel_request'].includes(args.action)) return this.remoteControl(args, exec, chief);
    if (args.request_id !== undefined) throw new Error('request_id is only valid with poll_request, collect_request or cancel_request');
    const candidates = [...this.active.values()].filter(state => state.id === id && state.project.root === this.root(chief)
      && (!args.target || (state.project.scope?.op_id === args.target.op_id && state.project.scope?.dtype_id === args.target.dtype_id)));
    if (candidates.length > 1) throw new Error('Research identity exists in multiple active targets; supply target to select the research to control.');
    const state = candidates[0];
    if (!state || state.chief.id !== chief.id) throw new Error('No owned active research; an ended session cannot be resumed');
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
    return { research_id: id, ...(state.project.scope ? { target: state.project.scope } : {}), action: args.action,
      paused: state.paused, pause_requested: state.pauseRequested, agent_session_id: state.sessionId ?? null };
  }

  private async remoteControl(args: any, exec: ToolExecution, chief: Agent): Promise<any> {
    const { config, locations } = this.researchLocations(args, chief);
    const { persisted, currentProject: project, active, runRoot } = this.researchContext([...locations.values()][0], chief);
    if (persisted.chief_id !== chief.id) throw new Error('No owned research for remote request management');
    if (config.workspace?.workspace_id !== project.config.workspace?.workspace_id
      || this.researchDir(project, persisted.research_id) !== runRoot) throw new Error('Research snapshot does not match this workspace or target directory');
    if (!project.snapshotRoot || project.config.execution.backend !== 'ssh') throw new Error('Remote request management requires the original frozen SSH research');
    const requests = readRemoteRequests(runRoot, persisted);
    if (args.action === 'requests') {
      if (args.request_id !== undefined) throw new Error('Omit request_id when listing requests');
      return { research_id: persisted.research_id, target: project.scope, run_status: persisted.run_status, requests,
        note: 'These are persisted dispatch identities, not remote completion evidence. Use *_request actions to observe release. Older runs without a request journal cannot be recovered through this entry.' };
    }
    const id = text(args.request_id, 'request_id');
    const record = requests.find(item => item.request_id === id || item.remote_request_id === id);
    if (!record) throw new Error('Unknown request in this research. Use meteor_control action requests for recorded request_id/remote_request_id; build_id and run_id are not request IDs.');
    if (record.remote_request_id !== remoteIdempotency(project, record.operation, record.request_id)) throw new Error('Remote request identity does not match its frozen target');
    exec.signal.throwIfAborted();
    const runtime = active?.runtime ?? await loadProjectRuntime(project);
    const runner = runtime.build.selectRunner(project);
    const methods: Record<string, string> = { poll_request: 'pollRemote', collect_request: 'collectRemote', cancel_request: 'cancelRemote' };
    const method = methods[args.action];
    if (typeof runner[method] !== 'function') throw new Error('The frozen runner does not support remote request management');
    // Never replay record.work/build/test/profile here. The author may have ended,
    // and collecting raw evidence cannot grant a new formal submission or budget.
    const remoteState = await runner[method](project, record.remote_request_id);
    return { research_id: persisted.research_id, agent_session_id: persisted.agent_session_id, target: project.scope,
      run_status: persisted.run_status, request_id: record.request_id, remote_request_id: record.remote_request_id,
      operation: record.operation, remote_state: remoteState };
  }

  async status(input: unknown, exec: ToolExecution): Promise<any> {
    const args = object(input), chief = this.chief(exec), root = this.root(chief);
    const observedAtMs = Date.now();
    const { observed_at } = observeResearchBudget(undefined, false, observedAtMs);
    if (!existsSync(resolve(root, 'meteor.config.json'))) {
      return { state: 'initialization_required', observed_at, research: [],
        next_action: 'Call meteor_init in this workspace, then follow its returned device setup state before starting research.' };
    }
    const { config, locations } = this.researchLocations(args, chief);
    const records = [];
    for (const location of locations.values()) records.push(await this.statusRecord(location, chief, config.schema_version === 2, observedAtMs));
    return args.research_id === undefined ? { observed_at, research: records } : records[0];
  }

  private researchLocations(args: any, chief: Agent) {
    const root = this.root(chief);
    const config = loadWorkspace(root);
    const id = args.research_id === undefined ? undefined : checkedId(args.research_id);
    const locations = new Map<string, { project: any; runRoot: string }>();
    const targets = args.target ? [args.target] : config.schema_version === 2 ? config.targets! : [undefined];
    const addDirectory = (project: any, directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || (id !== undefined && entry.name !== id)) continue;
        const runRoot = resolve(directory, entry.name);
        if (existsSync(resolve(runRoot, 'manifest.json'))) locations.set(runRoot, { project, runRoot });
      }
    };
    for (const target of targets) {
      const project = loadProject(root, target);
      for (const backend of new Set<Backend>([project.config.execution.backend, 'ssh', 'mock'])) {
        const candidate = { ...project, config: { ...project.config, execution: { ...project.config.execution, backend } },
          ...(project.config.schema_version === 1 ? { dataRoot: resolve(root, 'reports/meteor', backend) } : {}) };
        addDirectory(candidate, targetPath(candidate, 'research'));
      }
    }
    // Migration preserves old roots and their frozen runtimes. Never apply a
    // workspace target or catalog to records from these legacy locations.
    if (config.schema_version === 2 && args.target === undefined) {
      const legacy = (config as any).legacy;
      const legacyConfig = legacy?.config_ref && existsSync(resolve(root, legacy.config_ref))
        ? JSON.parse(readFileSync(resolve(root, legacy.config_ref), 'utf8')) : undefined;
      const roots = new Set<string>(['reports/meteor/mock', 'reports/meteor/ssh', ...(legacy?.data_roots ?? [])]);
      for (const dataRoot of roots) addDirectory({ root, dataRoot: resolve(root, dataRoot), config: legacyConfig }, resolve(root, dataRoot, 'research'));
    }
    // A resident run remains addressable even if the chief changed the live
    // configuration while it was running; its snapshot is still authoritative.
    for (const active of this.active.values()) {
      if (active.project.root !== root || (id !== undefined && active.id !== id)) continue;
      if (args.target && (active.project.scope?.op_id !== args.target.op_id || active.project.scope?.dtype_id !== args.target.dtype_id)) continue;
      const runRoot = this.researchDir(active.project, active.id, active.runtime);
      locations.set(runRoot, { project: active.project, runRoot });
    }
    if (id !== undefined && locations.size !== 1) {
      throw new Error(locations.size ? 'Research identity exists in multiple targets or backends; supply target to disambiguate.' : 'Unknown research in this workspace');
    }
    return { config, locations };
  }

  private researchContext(location: { project: any; runRoot: string }, chief: Agent) {
    const { runRoot } = location;
    const persisted = JSON.parse(readFileSync(resolve(runRoot, 'manifest.json'), 'utf8'));
    const id = checkedId(persisted.research_id);
    if (resolve(runRoot, '..', id) !== runRoot) throw new Error('Research manifest identity does not match its directory');
    const resident = this.active.get(scopedKey({ root: this.root(chief), scope: persisted.target }, id));
    const active = resident && resident.project.root === this.root(chief)
      && this.researchDir(resident.project, resident.id, resident.runtime) === runRoot ? resident : undefined;
    let currentProject: any = active?.project ?? location.project;
    if (!active) {
      const snapshot = resolve(runRoot, 'snapshot');
      if (existsSync(resolve(snapshot, 'meteor.config.json'))) {
        const config = JSON.parse(readFileSync(resolve(snapshot, 'meteor.config.json'), 'utf8'));
        const suite = JSON.parse(readFileSync(resolve(snapshot, 'case-suite.json'), 'utf8'));
        currentProject = { root: this.root(chief), dataRoot: location.project.dataRoot, config, suite, snapshotRoot: snapshot };
        if (config.schema_version === 2) {
          const scope = existsSync(resolve(snapshot, 'target.json'))
            ? JSON.parse(readFileSync(resolve(snapshot, 'target.json'), 'utf8')) : persisted.target;
          const target = config.targets?.find((item: any) => item.op_id === scope?.op_id && item.dtype_id === scope?.dtype_id);
          if (!target || config.workspace?.workspace_id !== scope?.workspace_id
            || ['workspace_id', 'op_id', 'dtype_id'].some(key => scope?.[key] !== persisted.target?.[key])) throw new Error('Research snapshot target does not match its manifest');
          currentProject.target = target; currentProject.scope = scope;
        } else {
          currentProject.dataRoot = resolve(runRoot, '../..');
        }
      }
    }
    return { runRoot, persisted, id, active, currentProject };
  }

  private async statusRecord(location: { project: any; runRoot: string }, chief: Agent, workspace: boolean, observedAtMs: number): Promise<any> {
    const { runRoot, persisted, id, active, currentProject } = this.researchContext(location, chief);
    const reportFrom = (record: any) => {
      const path = record.report_ref && resolve(currentProject.root, record.report_ref);
      return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    };
    if (workspace && currentProject.config?.schema_version !== 2) {
      return plain({ ...persisted, ...observeResearchBudget(persisted, false, observedAtMs), live: false, legacy_read_only: true, research_directory: runRoot,
        report: reportFrom(persisted), recovery_note: 'Legacy evidence remains at its original paths. Status does not infer remote completion or replay legacy writes into the workspace catalog.' });
    }
    if (this.researchDir(currentProject, id) !== runRoot) throw new Error('Research snapshot resolves to a different target or backend directory');
    const runtime = active?.runtime ?? await loadProjectRuntime(currentProject);
    let record = await runtime.research.getResearch(currentProject, id);
    let recovery: any;
    if (!active && record.prepared_submission_id && record.final_session_id && ['COMMIT_PENDING', 'REPORT_PENDING'].includes(record.run_status)) {
      // Only a durable accepted native final result may be replayed after restart.
      recovery = await runtime.submit.commitSubmission(currentProject, record.prepared_submission_id, record.final_session_id);
      record = await runtime.research.getResearch(currentProject, id);
    } else if (!active && !TERMINAL.has(record.run_status)) {
      const path = resolve(this.researchDir(currentProject, id, runtime), 'host-report.json');
      const reason = 'Original native run is no longer resident; no replacement Agent was created.';
      writeFileSync(path, JSON.stringify({ research_id: id, agent_session_id: record.agent_session_id, run_status: 'INTERRUPTED',
        research_goal_met: false, reason, evidence_directory: this.researchDir(currentProject, id, runtime),
        next_steps: ['Inspect the preserved hypothesis, experiments and memory; start a separate research only if needed.'] }, null, 2) + '\n');
      record = await runtime.research.updateResearch(currentProject, id, { run_status: 'INTERRUPTED', research_goal_met: false, error: reason, report_ref: path });
    }
    const report = reportFrom(record);
    const integration = record.integration_event_id ? await runtime.integration.getIntegrationStatus(currentProject, record.integration_event_id) : undefined;
    if (!active && integration && shouldRecoverIntegration(integration)) {
      this.startIntegration(currentProject, runtime, chief, record.integration_event_id);
    }
    return plain({ ...record, ...observeResearchBudget(record, Boolean(active && !active.finalAccepted && !active.controller.signal.aborted), observedAtMs),
      live: Boolean(active), report, integration, ...(recovery === undefined ? {} : { recovery }) });
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

function shouldRecoverIntegration(integration: any): boolean {
  if (TERMINAL_INTEGRATION.has(integration.status)) return false;
  if (integration.status === 'FAILED') {
    if (integration.retryable === false) return false;
    if (Number(integration.failure_count ?? 0) >= MAX_INTEGRATION_FAILURES) return false;
  }
  return true;
}
