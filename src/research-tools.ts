import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeteorHost, object, observeResearchBudget, text } from './host.ts';
import type { ActiveResearch, DshContext, ToolExecution } from './host.ts';
import { submissionSchema } from './submission-schema.ts';
import { recordRemoteRequest } from './remote-requests.ts';

export const string = { type: 'string', minLength: 1 };
export const strings = { type: 'array', items: string };
const mockFixture = { description: 'Explicit mock-backend protocol tests only. Omit this field entirely for SSH research; do not send null, an empty object, or case metadata.' };

/** Raw alpha.2 ToolDefinition: JSON parameters and canonical output. */
export function defineTool(name: string, description: string, properties: Record<string, any>, required: string[], execute: (args: any, exec: ToolExecution) => Promise<any> | any): any {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(input: unknown, exec: ToolExecution) {
      const args = object(input);
      for (const key of Object.keys(args)) if (!(key in properties)) throw new Error(`Unknown argument: ${key}`);
      for (const key of required) if (!(key in args)) throw new Error(`Missing argument: ${key}`);
      for (const [key, value] of Object.entries(args)) validate(value, properties[key], key);
      exec.signal.throwIfAborted();
      const result = await execute(args, exec);
      return JSON.parse(JSON.stringify(result));
    },
  };
}

function validate(value: any, schema: any, path: string): void {
  if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength && value.length < schema.minLength)) throw new Error(`${path} must be a string`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path} is outside its integer bounds`);
  } else if (schema.type === 'object') {
    try { object(value); }
    catch { throw new Error(`${path} must be an object; pass its fields directly instead of a JSON string`); }
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(child, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not supported`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} requires at least ${schema.minItems} items`);
    value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)
      || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)
      || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) throw new Error(`${path} is outside its numeric bounds`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
}

interface RequestRecord {
  request_id: string; operation: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN_REMOTE';
  controller: AbortController; done?: Promise<any>; receipt?: any; error?: string;
  remote_request_id?: string; remote_state?: any;
  work?: (signal: AbortSignal, key: string) => Promise<any>;
}

export function registerResearchTools(ctx: DshContext, host: MeteorHost): Array<() => void> {
  const requests = new WeakMap<ActiveResearch, Map<string, RequestRecord>>();
  function entries(state: ActiveResearch) {
    if (!requests.has(state)) requests.set(state, new Map());
    return requests.get(state)!;
  }
  async function operation(state: ActiveResearch, name: string, exec: ToolExecution, work: (signal: AbortSignal, key: string) => Promise<any>): Promise<any> {
    await host.boundary(state, exec.signal);
    state.preparedIds.clear();
    const record: RequestRecord = { request_id: randomUUID(), operation: name, status: 'RUNNING', controller: new AbortController() };
    record.work = work;
    const remote = state.project.config.execution.backend === 'ssh';
    if (remote) record.remote_request_id = recordRemoteRequest(state, host.researchDir(state.project, state.id, state.runtime), name, record.request_id);
    entries(state).set(record.request_id, record);
    const signal = AbortSignal.any([state.controller.signal, exec.signal, record.controller.signal]);
    record.done = (async () => {
      let cleanup: Promise<any> | undefined;
      const cancel = () => {
        if (remote) cleanup = state.runtime.build.selectRunner(state.project).cancelRemote(state.project, record.remote_request_id)
          .then((result: any) => { record.remote_state = result; })
          .catch((error: unknown) => { record.remote_state = { status: 'UNKNOWN_REMOTE', remote_release_confirmed: false, error: String(error) }; });
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        record.receipt = await work(signal, record.request_id);
        signal.throwIfAborted();
        record.status = record.receipt.status ?? 'COMPLETED';
        return { ...record.receipt, request_id: record.request_id };
      } catch (error) {
        record.status = signal.aborted ? (remote ? 'UNKNOWN_REMOTE' : 'CANCELLED') : 'FAILED';
        record.error = String(error);
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        await cleanup;
      }
    })();
    return record.done;
  }
  function ownBuild(state: ActiveResearch, buildRef: string) {
    const build = state.runtime.build.loadBuildReceipt(state.project, buildRef);
    if (build.research_id !== state.id) throw new Error('Build receipt belongs to another research; read it as inspiration, then build your own experiment');
    return build;
  }
  const definitions = [
    defineTool('meteor_read_file', 'Read any accessible file or list a directory. Seeds do not restrict what you can read. Paths are relative to the project unless absolute.',
      { path: string, offset: { type: 'integer', minimum: 0, description: 'Zero-based character offset, not a line number.' }, limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Maximum characters to return.' } }, ['path'], (args, exec) => {
        const state = exec.agent && host.sessions.get(exec.agent.id);
        const path = resolve(state ? host.requireResearch(exec).project.root : host.root(host.chief(exec)), args.path);
        if (lstatSync(path).isDirectory()) return { path, entries: readdirSync(path, { withFileTypes: true }).map(d => ({ name: d.name, directory: d.isDirectory() })) };
        const content = readFileSync(path, 'utf8'); const offset = args.offset ?? 0; const limit = args.limit ?? 30000;
        const text = content.slice(offset, offset + limit);
        const next = offset + text.length;
        const truncated = next < content.length;
        return { path, offset, offset_unit: 'characters', total_characters: content.length, text, truncated, next_offset: truncated ? next : null };
      }),
    defineTool('meteor_write_file', 'Write this research’s hypothesis, plans, drafts, analysis or memory. For a local edit, use mode replace with the exact old_text and literal replacement content. Prefer research-relative paths such as hypothesis.json or drafts/k/r1/device.asc; project-relative and absolute paths to the same writable research area are also accepted. Tool-produced evidence, snapshots and shared files are immutable here.',
      { path: string, content: { type: 'string', description: 'Full contents for write, text to append for append, or literal replacement text for replace. May be empty.' },
        mode: { type: 'string', enum: ['write', 'append', 'replace'] },
        old_text: { ...string, description: 'Required only for replace. Exact nonempty text that must occur once in the existing file, including overlapping matches. Use enough surrounding context to make it unique.' },
      }, ['path', 'content'], (args, exec) => {
        const state = host.requireResearch(exec);
        const replacing = args.mode === 'replace';
        if (!replacing && 'old_text' in args) throw new Error('old_text is only valid with mode replace');
        if (replacing && !args.old_text) throw new Error('mode replace requires nonempty old_text');
        const root = host.researchDir(state.project, state.id, state.runtime);
        const target = writablePath(root, args.path, state.project.root);
        let content = args.content;
        if (replacing) {
          if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error('mode replace requires an existing file');
          const previous = readFileSync(target, 'utf8');
          const index = previous.indexOf(args.old_text);
          if (index < 0) throw new Error('old_text was not found in the file; read the current text before replacing it');
          if (previous.indexOf(args.old_text, index + 1) >= 0) throw new Error('old_text must match exactly once; overlapping matches also count');
          content = previous.slice(0, index) + args.content + previous.slice(index + args.old_text.length);
        } else if (args.mode === 'append' && existsSync(target)) content = readFileSync(target, 'utf8') + args.content;
        state.runtime.design?.assertDesignWriteAllowed(state.project, { research_id: state.id, path: target, content });
        mkdirSync(dirname(target), { recursive: true });
        if (replacing) {
          const staged = `${target}.meteor-${randomUUID()}.tmp`;
          try {
            writeFileSync(staged, content, { flag: 'wx', mode: lstatSync(target).mode & 0o777 });
            renameSync(staged, target);
          } finally {
            try { unlinkSync(staged); } catch { /* A successful rename removed it; failed staging must not change the original. */ }
          }
        } else writeFileSync(target, content);
        state.preparedIds.clear();
        return { path: target, bytes: Buffer.byteLength(args.content) };
      }),
    defineTool('meteor_design', 'In this original research session, open a candidate design; check expected source activity comments before implementation; check/freeze the implementation; then compare exact test/profile receipts with those expectations. Read the returned guide and preserve uncertainty in observations.',
      {
        action: { type: 'string', enum: ['open', 'check', 'freeze', 'compare'] },
        experiment_id: string,
        kernel_path: { ...string, description: 'Candidate module directory or kernel.json. Prefer the absolute path returned when meteor_write_file writes kernel.json. Relative paths are based on project_root, not research_directory: do not reuse a bare drafts/... write path. Manifest source paths are also project-root relative.' },
        design_id: string, strategy: string,
        design_ref: string, stage: { type: 'string', enum: ['expected', 'implementation'] },
        receipt_refs: { ...strings, minItems: 1 },
        analysis: { type: 'object', additionalProperties: false, required: ['matched', 'deviations', 'unknown'],
          properties: { matched: strings, deviations: strings, unknown: strings } },
      }, ['action'], async (args, exec) => {
        const state = host.requireResearch(exec);
        await host.boundary(state, exec.signal);
        const design = state.runtime.design;
        if (!design) throw new Error('This frozen research runtime does not provide the design tool; preserve its original protocol.');
        const identity = { research_id: state.id };
        state.preparedIds.clear();
        if (args.action === 'open') return design.openDesign(state.project, { ...identity,
          experiment_id: text(args.experiment_id, 'experiment_id'), kernel_path: text(args.kernel_path, 'kernel_path'),
          ...(args.design_id ? { design_id: args.design_id } : {}), ...(args.strategy ? { strategy: args.strategy } : {}) });
        const input = { ...identity, design_ref: text(args.design_ref, 'design_ref') };
        if (args.action === 'check') return design.checkDesign(state.project, { ...input, stage: text(args.stage, 'stage') });
        if (args.action === 'freeze') return design.freezeDesign(state.project, input);
        if (!args.receipt_refs?.length) throw new Error('receipt_refs are required to compare actual evidence');
        return design.compareDesign(state.project, { ...input, receipt_refs: args.receipt_refs, ...(args.analysis ? { analysis: args.analysis } : {}) });
      }),
    defineTool('meteor_kernel_build', 'Build one exact kernel revision for this research. Returns an immutable build receipt; mock output is simulated.',
      { experiment_id: string, kernel_path: { ...string, description: 'Candidate module directory or kernel.json. Prefer the absolute kernel.json path returned by meteor_write_file. Relative paths, including manifest source paths, use project_root, not research_directory. A bare drafts/... write path is not a project-root path. Changing source or manifest requires a new revision.' },
        design_ref: { ...string, description: 'Frozen design returned by meteor_design. Required for new kernel builds except explicit mock protocol fixtures.' }, fixture: mockFixture }, ['experiment_id', 'kernel_path'], async (args, exec) => {
        const state = host.requireResearch(exec);
        return operation(state, 'build', exec, async (signal, idempotency_key) => {
          const receipt = await state.runtime.build.buildKernel(state.project, { ...args, research_id: state.id, idempotency_key, signal });
          return { ...receipt, build_ref: state.runtime.build.receiptRef(state.project, state.runtime.build.buildReceiptPath(state.project, receipt)) };
        });
      }),
    defineTool('meteor_kernel_test', 'Run independent probe or full case tests for one of this research’s exact builds. Only full tests account for the entire fixed suite.',
      { build_ref: string, mode: { type: 'string', enum: ['probe', 'full'] }, case_ids: strings, fixture: mockFixture }, ['build_ref', 'mode'], async (args, exec) => {
        const state = host.requireResearch(exec); ownBuild(state, args.build_ref);
        return operation(state, 'test', exec, async (signal, idempotency_key) => {
          const receipt = await state.runtime.test.testKernel(state.project, { ...args, idempotency_key, signal });
          const ref = state.runtime.build.receiptRef(state.project, state.runtime.test.testReceiptPath(state.project, receipt));
          return { ...receipt, test_ref: ref, performance_data_ref: ref };
        });
      }),
    defineTool('meteor_kernel_profile', 'Collect selected observations for one exact build and selected cases. Profiling does not replace full-case tests or establish causality by itself.',
      { build_ref: string, case_ids: strings, metrics: { ...strings, description: 'Use supported_metrics from the hardware report. kernel_time_us is ACL event timing, not a hardware counter. Unsupported metrics return the allowed list.' }, fixture: mockFixture }, ['build_ref', 'case_ids', 'metrics'], async (args, exec) => {
        const state = host.requireResearch(exec); ownBuild(state, args.build_ref);
        return operation(state, 'profile', exec, async (signal, idempotency_key) => {
          const receipt = await state.runtime.profile.profileKernel(state.project, { ...args, idempotency_key, signal });
          const ref = state.runtime.build.receiptRef(state.project, state.runtime.profile.profileReceiptPath(state.project, receipt));
          return { ...receipt, profile_ref: ref };
        });
      }),
    defineTool('meteor_run_status', 'Original active research subagent only; chief uses meteor_status. Read current time, remaining research wall-time budget, and this session’s build/test/profile request status and receipts. Omit request_id to list them. A research_id is not a request_id; this tool does not start an experiment or execute analysis code. Completed requests stay readable until this research ends.',
      { request_id: { ...string, description: 'Use an actual request_id returned by an experiment operation, or omit to list this session’s requests.' } }, [], (args, exec) => {
        const state = host.requireResearch(exec); const all = entries(state);
        const selected = args.request_id === undefined ? [...all.values()] : [all.get(args.request_id)];
        if (selected.some(record => !record)) throw new Error('Unknown request in this research. Call meteor_run_status({}) to list actual request_ids; the research_id is not an experiment request_id.');
        const observed = observeResearchBudget(state.runtime.research.getResearch(state.project, state.id), !state.finalAccepted && !state.controller.signal.aborted);
        return { ...observed, research_id: state.id, requests: selected.map(record => ({ request_id: record!.request_id, operation: record!.operation, status: record!.status, receipt: record!.receipt, error: record!.error,
          remote_request_id: record!.remote_request_id, remote_state: record!.remote_state })) };
      }),
    defineTool('meteor_run_control', 'Original active research subagent only; chief uses meteor_status and meteor_control for research management. Cancel, poll or collect this research’s original request. Remote cancellation is a request, not proof of release; collect preserves its idempotency identity.',
      { request_id: string, action: { type: 'string', enum: ['cancel', 'poll', 'collect'] } }, ['request_id', 'action'], async (args, exec) => {
        const state = host.requireResearch(exec); const record = entries(state).get(args.request_id);
        if (!record) throw new Error('Unknown request in this research. Call meteor_run_status({}) to list actual request_ids; the research_id is not an experiment request_id.');
        const remote = state.project.config.execution.backend === 'ssh';
        if (args.action === 'cancel' && record.status === 'RUNNING') {
          record.controller.abort('Cancelled by research agent');
          await Promise.allSettled([record.done]);
        }
        if (remote && record.remote_request_id) {
          const runner = state.runtime.build.selectRunner(state.project);
          record.remote_state = args.action === 'cancel'
            ? await runner.cancelRemote(state.project, record.remote_request_id)
            : await runner.pollRemote(state.project, record.remote_request_id);
          if (record.remote_state.status === 'CANCELLED' && record.remote_state.remote_release_confirmed) record.status = 'CANCELLED';
          if (args.action === 'collect' && record.remote_state.status === 'COMPLETED' && record.work) {
            state.preparedIds.clear();
            record.receipt = await record.work(exec.signal, record.request_id);
            record.status = record.receipt.status ?? 'COMPLETED';
            record.error = undefined;
          }
        }
        return { request_id: record.request_id, status: record.status, receipt: record.receipt, error: record.error,
          remote_request_id: record.remote_request_id, remote_state: record.remote_state };
      }),
    defineTool('meteor_prepare_submission', 'Validate and freeze the final submission, including full tests for every submitted kernel. Pass submission as an object, not a JSON string. Finish report and memory writes first. Resolve feasible implementation or experiment gaps in this session before finishing; INCONCLUSIVE alone is not a reason to stop. Preparation validates evidence references, does not establish research success, and does not commit or integrate. A prepared:false result with issues is not ready for structured_output. After success, return the resulting ID through native structured_output; further writes, design or experiment operations invalidate the preparation and require preparing again.',
      { submission: submissionSchema }, ['submission'], async (args, exec) => {
        const state = host.requireResearch(exec); const supplied = object(args.submission);
        const identity = { research_id: state.id, agent_session_id: state.sessionId, execution_backend: state.project.config.execution.backend };
        for (const [key, value] of Object.entries(identity)) {
          if (supplied[key] !== undefined && supplied[key] !== value) throw new Error('Submission identity must match this original research session: ' + key);
        }
        const submission = { ...supplied, ...identity };
        state.preparedIds.clear();
        try {
          const prepared = await state.runtime.submit.prepareSubmission(state.project, submission);
          state.preparedIds.add(prepared.prepared_submission_id);
          await state.runtime.research.updateResearch(state.project, state.id, { run_status: 'OUTPUT_FROZEN' });
          return { ...prepared, committed: false, next_action: {
            tool: 'structured_output', arguments: { prepared_submission_id: prepared.prepared_submission_id },
          } };
        } catch (error) {
          if (error && typeof error === 'object' && 'issues' in error) return { prepared: false, issues: (error as any).issues, action: 'Preparation failed. Resolve the listed fields in this same session and prepare again; do not call structured_output until a new prepared_submission_id is returned.' };
          throw error;
        }
      }),
  ];
  return definitions.map(definition => ctx.tools.register(definition));
}

export function writablePath(root: string, input: string, projectRoot?: string): string {
  const raw = text(input, 'path');
  const base = resolve(root);
  const projectBase = projectRoot === undefined ? undefined : resolve(projectRoot);
  const candidates = isAbsolute(raw)
    ? [resolve(raw)]
    : [resolve(base, raw), ...(projectBase === undefined ? [] : [resolve(projectBase, raw)])];
  for (const target of [...new Set(candidates)]) {
    const nativePath = relative(base, target);
    if (!nativePath || nativePath.split(sep).some(p => p === '..') || isAbsolute(nativePath)) continue;
    const path = nativePath.split(sep).join('/');
    if (allowedWritablePath(path)) return assertWritablePath(base, target);
  }
  throw new Error('Writes are limited to this research’s drafts, plans, analysis and memory. Examples: memory.md, hypothesis.json, drafts/<kernel>/<revision>/kernel.json, experiments/<experiment_id>/analysis.json, or the same path under research_directory from the startup package.');
}

function allowedWritablePath(path: string): boolean {
  const allowed = /^(hypothesis\.json|memory\.md|checkpoint\.json|material_refs\.jsonl|submission-draft\.json)$/.test(path)
    || /^hypothesis_history\/[^/]+\.json$/.test(path)
    || /^drafts\/.+/.test(path)
    || /^experiments\/[^/]+\/(plan\.json|analysis\.json)$/.test(path);
  return allowed && !path.split('/').some(p => p === '..') && !!path;
}

function assertWritablePath(root: string, target: string): string {
  let cursor = target;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Research writes cannot traverse symbolic links');
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('Write path escapes research');
    cursor = parent;
  }
  return target;
}
