import { MeteorHost } from './host.ts';
import type { DshContext } from './host.ts';
import { defineTool, registerResearchTools, string } from './research-tools.ts';
import { registerChiefSkills } from './skills.ts';
import { configureAssemblyTemplateSchema } from './assembly.ts';

export const name = 'meteor';
// Web presets mount compaction in each Agent's realm; registries stay host-wide.
export const inject = ['tools', 'jobs', 'subagents', 'skills'];
const target = { type: 'object', additionalProperties: false, required: ['op_id', 'dtype_id'],
  properties: { op_id: string, dtype_id: string },
  description: 'Registered operator/dtype target in this single-hardware workspace. Required when more than one target is registered.' };

export function createHost(ctx: DshContext): MeteorHost {
  const skills = registerChiefSkills(ctx);
  const host = new MeteorHost(ctx);
  const disposers = [skills.dispose, ...registerResearchTools(ctx, host)];
  const definitions = [
    defineTool('meteor_init', 'Chief first step for a new workspace: initialize one hardware workspace with op/dtype artifacts and four knowledge scopes. Preserve existing files. Load meteor-hardware-prepare to probe the device, derive its execution model through searches and diagnostics, and select each target assembly template before meteor_start.',
      {}, [], async (_args, exec) => {
      const result = await host.init(exec);
      skills.invalidate();
      return result;
    }),
    defineTool('meteor_hardware_probe', 'Chief setup: validate the configured real SSH device/compiler/launch/correctness/profiler and save its identity report. This is the initial device check, not a complete execution IR model. Continue meteor-hardware-prepare using official sources and hardware diagnostics, then publish the hardware model and select target assembly templates. Uses centralized SSH profiles.',
      { profile_ref: { type: 'string', description: 'Central SSH profile reference. Omit or leave empty to discover the existing configured profile automatically. Never invent a reference.' } }, [], (args, exec) => host.hardware(args, exec)),
    defineTool('meteor_hardware_experiment', 'Chief device-preparation diagnostics from meteor-hardware-prepare. For run, provide question, files:[{path,content}] and commands:[{argv,timeout_seconds}] together; every source file needs its relative path. Run bounded source/command experiments on the configured device using the same FIFO. Evidence is hardware setup only, never a research author full receipt. Request identity is persisted before dispatch; poll/collect/cancel use only the same experiment_id, including after disconnection. No automatic retry. New setup experiments require no active research.',
      { action: { type: 'string', enum: ['run', 'poll', 'collect', 'cancel'] }, experiment_id: string, question: { ...string, description: 'Required for run: the hardware question and intended observation.' },
        files: { type: 'array', minItems: 1, maxItems: 32, description: 'Required for run: each source needs both its relative path and complete content.', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { ...string, description: 'Required relative filename used by the command, such as diagnostic.py.' }, content: string } } },
        commands: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['argv', 'timeout_seconds'],
          properties: { argv: { type: 'array', minItems: 1, items: string }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 900 } } } },
      }, ['action', 'experiment_id'], (args, exec) => host.hardwareExperiment(args, exec)),
    defineTool('meteor_hardware_model', 'Chief inspect or publish a hardware execution model authored from searches and setup experiments. Publish takes a local JSON path, validates resource/primitive/evidence structure and hardware/environment binding, freezes sources and selects the immutable model for future research. No built-in activity vocabulary or automatic scientific endorsement.',
      { action: { type: 'string', enum: ['inspect', 'publish'] }, path: string }, ['action'], (args, exec) => host.hardwareModel(args, exec)),
    defineTool('meteor_configure_assembly_template', 'Chief chooses an assembly template from user material or repository examples for exactly one op/dtype. Validate slots, freeze selected content and record its hash/source. The plugin supplies selected kernel sources, bucket data and routing; the chosen template supplies the surrounding implementation. No automatic default template is selected.',
      configureAssemblyTemplateSchema, ['source_path'], (args, exec) => host.assemblyTemplate(args, exec)),
    defineTool('meteor_start', 'Chief handoff point after workspace and hardware readiness. Delegate kernel implementation and experiments to one continuous research subagent; chief may propose a hypothesis. Chief handles read-only submission audits, existing-result indexes and summary documents directly; these do not need a new experimental research or new measurements. Materials and an assigned hypothesis are optional. Choose the registered target when the workspace has several. After this returns a job_id, use native job_output for bounded waits when its result is needed, or do useful independent work. Read final reports and confirm terminal state. Meteor disposes the finished native run; DSH keeps its history.',
      {
        goal: { ...string, description: 'By default copy the user research aim and explicit constraints without expanding them into your own task specification. Shared steps/contracts come from the startup packet and skills; put your proposed hypothesis in hypothesis. Do not invent a mandatory compute engine, all-case PASS requirement or performance threshold. Research may deliver zero, one or several kernels; every submitted kernel still needs full-suite accounting and a supported scope.' },
        research_id: string, target, budget: { type: 'object', additionalProperties: false,
          description: 'Optional limits for this research; omitted fields use project defaults. One research can contain multiple experiments.',
          properties: { max_experiments: { type: 'integer', minimum: 1 }, max_wall_time_seconds: { type: 'number', exclusiveMinimum: 0 } } },
        initial_context: {
          type: 'object', additionalProperties: false,
          description: 'mode decides material selection. random applies sampling and requires absent or empty material refs. specified selects only the exact kernel/knowledge refs and ignores valid sampling options if supplied; omit sampling when specifying refs. Unknown or invalid sampling options still fail validation. Materials are inspiration, not access restrictions.',
          properties: {
            mode: { type: 'string', enum: ['random', 'specified'] },
            shape: { type: 'object', minProperties: 1, additionalProperties: { type: 'integer', minimum: 1 },
              description: 'Shape coordinates used to inherit matching shape-range knowledge. Without this, default knowledge inheritance stops at HW/op/dtype.' },
            sampling: { type: 'object', additionalProperties: false, properties: {
              count: { type: 'integer', minimum: 0 }, seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
              epsilon: { type: 'number', minimum: 0, maximum: 1 }, lambda: { type: 'number', minimum: 0 },
              tau_hours: { type: 'number', exclusiveMinimum: 0 },
            } },
            kernel_refs: { type: 'array', items: string }, knowledge_refs: { type: 'array', items: string },
          },
        },
        hypothesis: {
          type: 'object', additionalProperties: false, required: ['statement'],
          description: 'Optional chief-assigned hypothesis to test. The child fills missing experimental details and preserves the original proposition when revising it.',
          properties: {
            statement: string, scope: string, mechanism: string, intervention: string, measurement_plan: string,
            ...Object.fromEntries(['controls', 'predictions', 'support_criteria', 'refutation_criteria', 'confounders'].map(name => [name, {
              type: 'array', items: string, ...(['predictions', 'support_criteria', 'refutation_criteria'].includes(name) ? { minItems: 1 } : {}),
            }])),
          },
        },
      }, ['goal'], (args, exec) => host.start(args, exec)),
    defineTool('meteor_status', 'Chief research management: read current observed_at time, live research wall-time deadlines and remaining budget, reports and automatic integration status across targets, or return initialization_required for a new workspace. No shell clock is needed. Select a target for duplicate research names. Recover an accepted frozen final submission in its original target/runtime. Legacy records in migrated workspaces are read-only. Finished native runs are disposed automatically; persistent history is not a running agent.',
      { research_id: string, target }, [], (args, exec) => host.status(args, exec)),
    defineTool('meteor_control', 'Chief management of owned research: pause/resume/cancel the resident Agent, or list requests and poll/collect/cancel an existing remote request, including after its author ends. Remote actions use the frozen research target and profile and never run a new experiment or change the research budget/terminal state. Supply target for duplicate research names. An ended Agent cannot be resumed.',
      { research_id: string, target, action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'requests', 'poll_request', 'collect_request', 'cancel_request'] },
        request_id: { ...string, description: 'For *_request actions, copy request_id or remote_request_id from action requests. A local build/run ID is not a request ID.' }, reason: string }, ['research_id', 'action'], (args, exec) => host.control(args, exec)),
    defineTool('meteor_evidence', 'Read an evidence or report file. Paths are relative to the chief project unless absolute; ordinary filesystem tools remain available to chief.',
      { path: string }, ['path'], (args, exec) => host.evidence(args, exec)),
  ];
  disposers.push(...definitions.map(definition => ctx.tools.register(definition)));
  ctx.on('dispose', async () => { await host.dispose(); for (const dispose of disposers) dispose(); });
  return host;
}

export function apply(ctx: DshContext): void { createHost(ctx); }

export default { name, inject, apply };
