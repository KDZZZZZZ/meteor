import { assert, hashObject } from '../util.ts';
import type { HardwareExecutionModel } from '../hardware-model.ts';

export const GRAPH_PRIMITIVES = ['add', 'sub', 'mul', 'div', 'idiv', 'imod', 'min', 'max', 'fma', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'not', 'bit_and', 'bit_or', 'bit_xor', 'bit_not', 'shl', 'lshr', 'ashr', 'select', 'cast', 'round'] as const;
const integers = new Set(['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64']);
const floats = new Set(['f16', 'bf16', 'f32', 'f64']);
const types = new Set([...integers, ...floats, 'bool']);

export interface GraphNode { id: string; op: string; args: string[]; dtype: string; mode?: string; repeat?: string;
  reduce?: { axis: string; extent: string; tree: 'balanced' } }
export interface Activity { id: string; kind: string; operation: string; resource: string; implements: string[]; after: string[]; description: string; expected_cost?: string }
export interface Annotations {
  graph: { formula_ref: string; inputs: Record<string, string>; constants?: Record<string, { dtype: string; value: number | boolean }>; nodes: GraphNode[]; outputs: Record<string, string> };
  execution: { semantics: string; activities: Activity[] };
}
export interface SourceText { path: string; text: string }

/** Extract C++ comments without treating quoted or raw string literals as comments. */
export function scanSource(text: string): { code: string; comments: string[] } {
  const comments: string[] = [], chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const raw = text.slice(i).match(/^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/);
    if (raw) {
      const end = text.indexOf(')' + raw[1] + '"', i + raw[0].length);
      assert(end >= 0, 'Unterminated C++ raw string');
      const stop = end + raw[1].length + 2; chunks.push(text.slice(i, stop)); i = stop; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const start = i, quote = text[i++];
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === quote) break; }
      chunks.push(text.slice(start, i)); continue;
    }
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i + 2), stop = end < 0 ? text.length : end;
      comments.push(text.slice(i + 2, stop).trim()); chunks.push('\n'); i = stop; continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2); assert(end >= 0, 'Unterminated source comment');
      comments.push(text.slice(i + 2, end).trim()); chunks.push(' '); i = end + 2; continue;
    }
    chunks.push(text[i++]);
  }
  return { code: chunks.join(''), comments };
}

export function hasImplementation(text: string): boolean { return scanSource(text).code.trim().length > 0; }

function record(value: unknown, label: string): asserts value is Record<string, any> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
}
function words(value: unknown, label: string): asserts value is string[] {
  assert(Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()), label + ' must be a string array');
}
function name(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value), label + ' must be an identifier');
}
function text(value: unknown, label: string): asserts value is string { assert(typeof value === 'string' && value.trim(), label + ' is required'); }
function valueId(value: string): string {
  assert(/^[A-Za-z][A-Za-z0-9_]*(?:\[[^\[\]\r\n]+\])?$/.test(value), 'Invalid graph value reference: ' + value);
  return value.split('[')[0];
}

function checkNode(node: GraphNode, dtypes: string[]): void {
  const op = node.op, dtype = node.dtype;
  if (node.reduce !== undefined) {
    record(node.reduce, 'reduce'); name(node.reduce.axis, 'reduce.axis'); text(node.reduce.extent, 'reduce.extent');
    assert(node.reduce.tree === 'balanced' && ['add', 'min', 'max'].includes(op) && dtypes.length === 1, 'Reduction must expand a balanced binary add/min/max tree from one repeated value');
    assert(dtype !== 'bool' && dtypes[0] === dtype, 'Reduction dtype mismatch'); return;
  }
  const arity = ['not', 'bit_not', 'cast', 'round'].includes(op) ? 1 : ['fma', 'select'].includes(op) ? 3 : 2;
  assert(dtypes.length === arity, node.id + ': invalid primitive arity');
  if (op === 'cast') { assert(dtype !== 'bool' && dtypes[0] !== 'bool', 'cast requires numeric types'); return; }
  if (op === 'select') { assert(dtypes[0] === 'bool' && dtypes[1] === dtype && dtypes[2] === dtype, 'select dtype mismatch'); return; }
  if (['shl', 'lshr', 'ashr'].includes(op)) {
    assert(integers.has(dtype) && dtypes[0] === dtype && dtypes[1] === 'u32' && (op !== 'ashr' || dtype.startsWith('i')), 'shift dtype mismatch'); return;
  }
  assert(dtypes.every(x => x === dtypes[0]), node.id + ': implicit dtype conversion is not allowed');
  if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(op)) {
    assert(dtype === 'bool' && (['eq', 'ne'].includes(op) || dtypes[0] !== 'bool'), 'comparison dtype mismatch'); return;
  }
  assert(dtypes[0] === dtype, node.id + ': result dtype mismatch');
  if (['and', 'or', 'not'].includes(op)) assert(dtype === 'bool', 'Boolean operation requires bool');
  else if (op.startsWith('bit_') || ['idiv', 'imod'].includes(op)) assert(integers.has(dtype), 'Integer primitive requires an integer dtype');
  else if (['div', 'fma', 'round'].includes(op)) assert(floats.has(dtype), 'Floating primitive requires a floating dtype');
  else assert(dtype !== 'bool', 'Arithmetic primitive requires a numeric dtype');
  if (op === 'round') assert(['rne', 'rtz', 'floor', 'ceil'].includes(node.mode ?? ''), 'round requires an explicit mode');
}

export function parseAnnotations(sources: SourceText[], formulaRef: string, contract: Record<string, any>, model: HardwareExecutionModel) {
  assert(model?.primitives?.length && model?.resources?.length, 'A bound hardware execution model is required');
  const scanned = sources.map(source => ({ ...source, ...scanSource(source.text) }));
  const blocks = scanned.flatMap(source => source.comments.filter(c => c.startsWith('meteor-ir:')));
  assert(blocks.length === 1, 'Exactly one meteor-ir:v1 JSON comment is required in the kernel sources');
  assert(blocks[0].startsWith('meteor-ir:v1\n') || blocks[0].startsWith('meteor-ir:v1\r\n'), 'Unsupported IR annotation version');
  const value: unknown = JSON.parse(blocks[0].slice('meteor-ir:v1'.length)); record(value, 'IR');
  record(value.graph, 'graph'); record(value.execution, 'execution');
  const ir = value as unknown as Annotations, graph = ir.graph;
  assert(graph.formula_ref === formulaRef, 'graph.formula_ref must match the bound operator contract');
  record(graph.inputs, 'graph.inputs'); record(graph.outputs, 'graph.outputs');
  assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'graph.nodes must contain the primitive DAG');
  const defined = new Map<string, string>();
  for (const [id, dtype] of Object.entries(graph.inputs)) {
    name(id, 'input');
    assert(types.has(dtype), `Unknown input dtype at graph.inputs.${id}: expected a dtype string such as i8/i32/f32, received ${JSON.stringify(dtype)}`);
    defined.set(id, dtype);
  }
  const expectedInputs = Object.keys(contract.inputs ?? {}).sort(), expectedOutputs = Object.keys(contract.outputs ?? {}).sort();
  assert(hashObject(Object.keys(graph.inputs).sort()) === hashObject(expectedInputs), 'Graph inputs must match the formula inputs');
  assert(hashObject(Object.keys(graph.outputs).sort()) === hashObject(expectedOutputs), 'Graph outputs must match the formula outputs');
  const contractType = (value: unknown): string => {
    assert(typeof value === 'string', 'Contract tensor dtype must be declared as a string');
    const scalar = value.split('[')[0].trim();
    const aliases: Record<string, string> = { int8: 'i8', int16: 'i16', int32: 'i32', int64: 'i64',
      uint8: 'u8', uint16: 'u16', uint32: 'u32', uint64: 'u64', float16: 'f16', bfloat16: 'bf16', float32: 'f32', float64: 'f64' };
    const dtype = aliases[scalar] ?? scalar;
    assert(types.has(dtype), 'Unsupported contract dtype: ' + scalar);
    return dtype;
  };
  for (const id of expectedInputs) assert(graph.inputs[id] === contractType(contract.inputs[id]), 'Graph input dtype differs from formula: ' + id);
  if (graph.constants !== undefined) record(graph.constants, 'graph.constants');
  for (const [id, constant] of Object.entries(graph.constants ?? {})) {
    name(id, 'constant'); record(constant, 'constant'); assert(!defined.has(id), 'Duplicate graph value: ' + id);
    assert(types.has(constant.dtype), 'Unknown constant dtype');
    assert(constant.dtype === 'bool' ? typeof constant.value === 'boolean' : typeof constant.value === 'number' && Number.isFinite(constant.value), 'Invalid typed constant');
    if (integers.has(constant.dtype)) assert(Number.isSafeInteger(constant.value), 'Integer constants must be safe JSON integers');
    defined.set(id, constant.dtype);
  }
  for (const [index, node] of graph.nodes.entries()) {
    try {
      record(node, 'graph node'); name(node.id, 'node.id'); words(node.args, 'node.args');
      assert(!defined.has(node.id), 'Duplicate graph value: ' + node.id);
      assert((GRAPH_PRIMITIVES as readonly string[]).includes(node.op), 'Unknown graph primitive: ' + node.op);
      assert(types.has(node.dtype), 'Unknown node dtype: ' + node.dtype);
      assert(node.args.every(arg => defined.has(valueId(arg))), node.id + ': undefined/forward dependency or cyclic graph');
      if (node.repeat !== undefined) text(node.repeat, 'repeat description');
      checkNode(node, node.args.map(arg => defined.get(valueId(arg))!)); defined.set(node.id, node.dtype);
    } catch (error) {
      const id = typeof node?.id === 'string' ? ` (${node.id})` : '';
      throw new Error(`graph.nodes[${index}]${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  for (const id of Object.values(graph.outputs)) assert(typeof id === 'string' && defined.has(valueId(id)), 'Undefined graph output');
  for (const id of expectedOutputs) assert(defined.get(valueId(graph.outputs[id])) === contractType(contract.outputs[id]), 'Graph output dtype differs from formula: ' + id);
  text(ir.execution.semantics, 'execution.semantics');
  assert(Array.isArray(ir.execution.activities) && ir.execution.activities.length > 0, 'execution.activities is required');
  const activityIds = new Set<string>(), covered = new Set<string>(), nodes = new Set(graph.nodes.map(node => node.id));
  for (const [index, activity] of ir.execution.activities.entries()) {
    try {
      record(activity, 'activity'); name(activity.id, 'activity.id'); assert(!activityIds.has(activity.id), 'Duplicate activity id');
      const primitive = model.primitives.find(p => p.id === activity.kind);
      assert(primitive, 'Unknown activity primitive in the bound hardware model: ' + activity.kind);
      for (const field of ['operation', 'resource', 'description'] as const) text(activity[field], 'activity.' + field);
      assert(primitive.resources.includes(activity.resource), 'Activity resource is not allowed by the bound hardware primitive: ' + activity.resource);
      words(activity.implements, 'activity.implements'); words(activity.after, 'activity.after');
      assert(activity.implements.every(id => nodes.has(id)), 'Activity refers to an unknown graph node');
      assert(activity.after.every(id => activityIds.has(id)), 'Undefined/forward activity dependency or cycle');
      if (primitive.graph_required) assert(activity.implements.length > 0, 'This hardware primitive must identify graph nodes');
      if (activity.expected_cost !== undefined) text(activity.expected_cost, 'activity.expected_cost');
      activity.implements.forEach(id => covered.add(id)); activityIds.add(activity.id);
    } catch (error) {
      const id = typeof activity?.id === 'string' ? ` (${activity.id})` : '';
      throw new Error(`execution.activities[${index}]${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  assert([...nodes].every(id => covered.has(id)), 'Execution activities do not cover every graph node');
  const markers = scanned.flatMap(source => source.comments.filter(c => /^meteor-activity:\s*[A-Za-z][A-Za-z0-9_]*$/.test(c)).map(c => c.split(':')[1].trim()));
  assert(markers.every(id => activityIds.has(id)), 'Source marker refers to an unknown activity');
  return {
    ir, annotation_hash: hashObject(ir), markers,
    coverage: {
      checked: ['bound formula reference and input/output names and dtypes', '28 primitive names, arity and basic dtype signatures', 'hardware model primitive/resource membership', 'ordered acyclic value and activity references', 'graph node activity coverage', 'source activity marker references'],
      not_proved: ['formula/graph numerical equivalence', 'repeat/index domains and constant ranges', 'execution/graph mathematical equivalence', 'native code equivalence or hardware activity timing', 'hardware support, capacities and synchronization correctness'],
    },
  };
}
