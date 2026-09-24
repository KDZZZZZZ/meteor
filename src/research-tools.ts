import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MeteorHost, object, text } from './host.ts';
import type { ActiveResearch, DshContext, ToolExecution } from './host.ts';
import { submissionSchema } from './submission-schema.ts';

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
    object(value);
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
    if (remote) record.remote_request_id = `${name}-${record.request_id}`;
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
    defineTool('meteor_write_file', 'Write this research’s hypothesis, plans, drafts, analysis or memory. Prefer research-relative paths such as hypothesis.json or drafts/k/r1/device.asc; project-relative and absolute paths to the same writable research area are also accepted. Tool-produced evidence, snapshots and shared files are immutable here.',
      { path: string, content: { type: 'string' }, mode: { type: 'string', enum: ['write', 'append'] } }, ['path', 'content'], (args, exec) => {
        const state = host.requireResearch(exec);
        const root = host.researchDir(state.project, state.id);
        const target = writablePath(root, args.path, state.project.root);
        state.preparedIds.clear();
        mkdirSync(dirname(target), { recursive: true });
        if (args.mode === 'append') appendFileSync(target, args.content); else writeFileSync(target, args.content);
        return { path: target, bytes: Buffer.byteLength(args.content) };
      }),
    defineTool('meteor_kernel_build', 'Build one exact kernel revision for this research. Returns an immutable build receipt; mock output is simulated.',
      { experiment_id: string, kernel_path: { ...string, description: 'Module directory or its kernel.json, relative to project root. File paths inside kernel.json are also relative to project root. Changing source or manifest requires a new revision.' }, fixture: mockFixture }, ['experiment_id', 'kernel_path'], async (args, exec) => {
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
          const ref = relative(state.project.root, resolve(host.researchDir(state.project, state.id), 'experiments', receipt.experiment_id, 'full-tests', `${receipt.run_id}.json`)).split(sep).join('/');
          return { ...receipt, test_ref: ref, performance_data_ref: ref };
        });
      }),
    defineTool('meteor_kernel_profile', 'Collect selected observations for one exact build and selected cases. Profiling does not replace full-case tests or establish causality by itself.',
      { build_ref: string, case_ids: strings, metrics: { ...strings, description: 'Use supported_metrics from the hardware report. kernel_time_us is ACL event timing, not a hardware counter. Unsupported metrics return the allowed list.' }, fixture: mockFixture }, ['build_ref', 'case_ids', 'metrics'], async (args, exec) => {
        const state = host.requireResearch(exec); ownBuild(state, args.build_ref);
        return operation(state, 'profile', exec, async (signal, idempotency_key) => {
          const receipt = await state.runtime.profile.profileKernel(state.project, { ...args, idempotency_key, signal });
          const ref = relative(state.project.root, resolve(host.researchDir(state.project, state.id), 'experiments', receipt.experiment_id, 'profiles', `${receipt.profile_id}.json`)).split(sep).join('/');
          return { ...receipt, profile_ref: ref };
        });
      }),
    defineTool('meteor_run_status', 'Read this session’s experiment request status and receipts. Completed requests stay readable until this research ends.',
      { request_id: string }, [], (args, exec) => {
        const state = host.requireResearch(exec); const all = entries(state);
        const selected = args.request_id === undefined ? [...all.values()] : [all.get(args.request_id)];
        if (selected.some(record => !record)) throw new Error('Unknown request in this research');
        return { research_id: state.id, requests: selected.map(record => ({ request_id: record!.request_id, operation: record!.operation, status: record!.status, receipt: record!.receipt, error: record!.error,
          remote_request_id: record!.remote_request_id, remote_state: record!.remote_state })) };
      }),
    defineTool('meteor_run_control', 'Cancel, poll or collect this research’s original request. Remote cancellation is a request, not proof of release; collect preserves its idempotency identity.',
      { request_id: string, action: { type: 'string', enum: ['cancel', 'poll', 'collect'] } }, ['request_id', 'action'], async (args, exec) => {
        const state = host.requireResearch(exec); const record = entries(state).get(args.request_id);
        if (!record) throw new Error('Unknown request in this research');
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
    defineTool('meteor_prepare_submission', 'Validate and freeze the final submission, including full tests for every submitted kernel. Resolve feasible implementation or experiment gaps in this session before finishing; INCONCLUSIVE alone is not a reason to stop. Preparation validates evidence references, does not establish research success, and does not commit or integrate. Return the resulting ID through native structured_output when finished.',
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
          return { ...prepared, committed: false };
        } catch (error) {
          if (error && typeof error === 'object' && 'issues' in error) return { prepared: false, issues: (error as any).issues, action: 'Resolve the issues in this same session and prepare again.' };
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
  throw new Error('Writes are limited to this research’s drafts, plans, analysis and memory. Examples: memory.md, hypothesis.json, drafts/<kernel>/<revision>/kernel.json, experiments/<experiment_id>/analysis.json, or the same path under this project’s reports/meteor/<backend>/research/<research_id>/ directory.');
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
