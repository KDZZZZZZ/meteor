import { MeteorHost } from './host.ts';
import type { DshContext } from './host.ts';
import { defineTool, registerResearchTools, string } from './research-tools.ts';
import { registerChiefSkills } from './skills.ts';

export const name = 'meteor';
// Web presets mount compaction in each Agent's realm; registries stay host-wide.
export const inject = ['tools', 'jobs', 'subagents', 'skills'];

export function createHost(ctx: DshContext): MeteorHost {
  const skills = registerChiefSkills(ctx);
  const host = new MeteorHost(ctx);
  const disposers = [skills.dispose, ...registerResearchTools(ctx, host)];
  const definitions = [
    defineTool('meteor_init', 'Initialize the current project with one persona, two skills, structured evidence storage and Ascend templates. Device setup is required; chief must probe and debug real hardware before research. Preserve existing files.', {}, [], async (_args, exec) => {
      const result = await host.init(exec);
      skills.invalidate();
      return result;
    }),
    defineTool('meteor_hardware_probe', 'Chief: discover and validate the real SSH device, compiler, launch, correctness and profiler support; save a hardware report and configure the project only when ready. Resolve diagnostics and re-probe if blocked. Uses only centralized SSH profiles.',
      { profile_ref: { type: 'string', description: 'Central SSH profile reference. Omit or leave empty to discover the existing configured profile automatically. Never invent a reference.' } }, [], (args, exec) => host.hardware(args, exec)),
    defineTool('meteor_start', 'Start one continuous hypothesis research Agent as a native background job. Chief decides when and how many research tasks run in parallel.',
      {
        goal: string, research_id: string, budget: { type: 'object', additionalProperties: false,
          description: 'Optional limits for this research; omitted fields use project defaults. One research can contain multiple experiments.',
          properties: { max_experiments: { type: 'integer', minimum: 1 }, max_wall_time_seconds: { type: 'number', exclusiveMinimum: 0 } } },
        initial_context: {
          type: 'object', additionalProperties: false,
          description: 'Choose freshness-based random materials or explicit kernel/knowledge references. In random mode omit material refs or use empty arrays; in specified mode omit sampling or use an empty object. Materials are inspiration, not access restrictions.',
          properties: {
            mode: { type: 'string', enum: ['random', 'specified'] },
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
    defineTool('meteor_status', 'Read research status, reports and automatic integration status. Recover an already accepted frozen final submission without starting another Agent.',
      { research_id: string }, [], (args, exec) => host.status(args, exec)),
    defineTool('meteor_control', 'Pause at the next supported operation boundary, resume the same resident Agent, or cancel a research task. An ended Agent cannot be resumed.',
      { research_id: string, action: { type: 'string', enum: ['pause', 'resume', 'cancel'] }, reason: string }, ['research_id', 'action'], (args, exec) => host.control(args, exec)),
    defineTool('meteor_evidence', 'Read an evidence or report file. Paths are relative to the chief project unless absolute; ordinary filesystem tools remain available to chief.',
      { path: string }, ['path'], (args, exec) => host.evidence(args, exec)),
  ];
  disposers.push(...definitions.map(definition => ctx.tools.register(definition)));
  ctx.on('dispose', async () => { await host.dispose(); for (const dispose of disposers) dispose(); });
  return host;
}

export function apply(ctx: DshContext): void { createHost(ctx); }

export default { name, inject, apply };
