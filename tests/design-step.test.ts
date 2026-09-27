import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { KernelModule, Project } from '../templates/project/tools/meteor/contracts.ts';
import { openDesign, checkDesign, freezeDesign, compareDesign, assertDesignWriteAllowed, assertDesignBuildReady } from '../templates/project/tools/meteor/design/service.ts';
import { parseAnnotations, scanSource } from '../templates/project/tools/meteor/design/annotations.ts';
import type { Annotations } from '../templates/project/tools/meteor/design/annotations.ts';
import { registerDesignStrategy } from '../templates/project/tools/meteor/design/registry.ts';
import { researchPath } from '../templates/project/tools/meteor/research.ts';
import { targetPath } from '../templates/project/tools/meteor/workspace.ts';
import { writeJson } from '../templates/project/tools/meteor/util.ts';
import { writeExecutionModelFixture } from './helpers/execution-model.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-design-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const target = { op_id: 'add-v1', dtype_id: 'f32', operator_abi: 'add-v1', contract_ref: 'contracts/add-v1/f32/operator.json', oracle_ref: 'oracle.py', adapter_ref: 'adapter.json', template_ref: 'templates/add-v1/f32', case_suite_ref: 'cases/add-v1/f32/suite.json' };
  const project: Project = {
    root, dataRoot: root, target, scope: { workspace_id: 'unit-workspace', op_id: target.op_id, dtype_id: target.dtype_id },
    config: { schema_version: 2, workspace: { workspace_id: 'unit-workspace', hardware_ref: 'hardware/target.json' }, targets: [target],
      execution: { backend: 'ssh', profile_ref: 'unit-not-connected' }, case_suite: target.case_suite_ref, design: { strategy: 'layered-ir@1' },
      environment: { environment_ref: 'unit-environment', hardware: 'unit-device', toolchain: 'unit-toolchain', measurement_protocol_ref: 'unit-protocol', simulated: false, hardware_report_hash: 'unit-probe-hash' },
      sampling: { epsilon: 0.1, lambda: 1, tau_hours: 24, count: 1 }, budget: { max_experiments: 10, max_wall_time_seconds: 600 }, integration: { min_relative_improvement: 0.01 } },
    suite: { revision: 'unit-suite', operator_abi: 'add-v1', cases: [{ case_id: 'c1', shape: { m: 1, n: 1, k: 1 }, dtype: 'f32', layout: 'unit', input_hash: 'unit-input', oracle_hash: 'unit-oracle' }] },
  };
  const contract = { inputs: { a: 'float32', b: 'float32' }, outputs: { y: 'float32' }, semantics: ['y = a+b'] };
  writeJson(join(root, '.meteor.local.json'), { environment: project.config.environment });
  const modelFixture = writeExecutionModelFixture(root, project.config.environment.environment_ref);
  project.config.design!.hardware_model_ref = modelFixture.modelRef;
  writeJson(join(root, target.contract_ref), contract);
  writeJson(join(researchPath(project, 'research-a'), 'manifest.json'), { research_id: 'research-a', agent_session_id: 'unit-session', run_status: 'ACTIVE', created_at: new Date().toISOString(), budget: project.config.budget, target: project.scope });
  const dir = join(researchPath(project, 'research-a'), 'drafts', 'add', 'r1'); mkdirSync(dir, { recursive: true });
  const rel = (path: string) => relative(root, path).replaceAll('\\', '/');
  const module: KernelModule = { kernel_id: 'add', revision: 'r1', operator_abi: 'add-v1', symbol_prefix: 'add_', launcher: 'add_launch', device_file: rel(join(dir, 'device.asc')), host_file: rel(join(dir, 'host.asc')), dependencies: [], supported_case_ids: ['c1'], hardware_scope: 'unit-device', resource_constraints: [] };
  writeJson(join(dir, 'kernel.json'), module); writeFileSync(join(dir, 'device.asc'), ''); writeFileSync(join(dir, 'host.asc'), '');
  const opened = openDesign(project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: rel(dir), design_id: 'attempt-a' });
  const ir: Annotations = { graph: { formula_ref: opened.formula_ref, inputs: { a: 'f32', b: 'f32' }, nodes: [{ id: 'sum', op: 'add', args: ['a', 'b'], dtype: 'f32' }], outputs: { y: 'sum' } }, execution: { semantics: 'f32 nearest-even scalar addition for y', activities: [{ id: 'compute', kind: 'unit_add', operation: 'Add', resource: 'UnitLane', implements: ['sum'], after: [], description: 'Read a and b, add, and write y.' }] } };
  const comment = (value = ir) => '/* meteor-ir:v1\n' + JSON.stringify(value) + '\n*/\n';
  const input = { research_id: 'research-a', design_ref: opened.design_ref };
  const expected = () => { writeFileSync(join(dir, 'device.asc'), comment()); return checkDesign(project, { ...input, stage: 'expected' }); };
  const implement = () => {
    const device = comment() + '// meteor-activity: compute\nvoid device() {}\n';
    assertDesignWriteAllowed(project, { research_id: 'research-a', path: join(dir, 'device.asc'), content: device });
    writeFileSync(join(dir, 'device.asc'), device);
    const host = 'void add_launch() {}\n'; assertDesignWriteAllowed(project, { research_id: 'research-a', path: join(dir, 'host.asc'), content: host }); writeFileSync(join(dir, 'host.asc'), host);
    return freezeDesign(project, input);
  };
  return { project, dir, rel, module, contract, opened, input, ir, comment, expected, implement, model: modelFixture.model };
}

test('implementation write and build are rejected before immutable expected comments', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => assertDesignWriteAllowed(f.project, { research_id: 'research-a', path: join(f.dir, 'kernel.json'), content: JSON.stringify(f.module) }));
  assert.doesNotThrow(() => assertDesignWriteAllowed(f.project, { research_id: 'research-a', path: join(f.dir, 'device.asc'), content: f.comment() }));
  assert.throws(() => assertDesignWriteAllowed(f.project, { research_id: 'research-a', path: join(f.dir, 'device.asc'), content: f.comment() + 'void device() {}' }), /No matching immutable expected snapshot/);
  assert.throws(() => assertDesignBuildReady(f.project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: f.rel(f.dir) }), /frozen design_ref/);
  writeFileSync(join(f.dir, 'device.asc'), f.comment() + 'void device() {}');
  assert.throws(() => checkDesign(f.project, { ...f.input, stage: 'expected' }), /before implementation/);
});

test('expected snapshots precede implementation; freeze pins source and revision', t => {
  const f = fixture(t); const saved = f.expected(); assert.ok(saved.expected_ref);
  const expectedText = readFileSync(join(f.project.root, saved.expected_ref), 'utf8');
  const frozen = f.implement(); assert.equal(frozen.status, 'READY');
  const ready = assertDesignBuildReady(f.project, { ...f.input, experiment_id: 'e1', kernel_path: f.rel(f.dir) });
  assert.equal(ready.draft_source_hash, frozen.source_hash);
  assert.equal(readFileSync(join(f.project.root, saved.expected_ref), 'utf8'), expectedText);
  assert.equal(frozen.coverage.not_proved.includes('formula/graph numerical equivalence'), true);
  writeFileSync(join(f.dir, 'host.asc'), 'void add_launch() { int changed = 1; }');
  assert.throws(() => assertDesignBuildReady(f.project, { ...f.input, experiment_id: 'e1', kernel_path: f.rel(f.dir) }), /stale/);
});

test('changing activity comments cannot reuse expected or frozen receipts', t => {
  const f = fixture(t); f.expected(); f.implement();
  f.ir.execution.activities[0].description = 'A different expectation';
  const text = f.comment() + '// meteor-activity: compute\nvoid device() {}';
  assert.throws(() => assertDesignWriteAllowed(f.project, { research_id: 'research-a', path: join(f.dir, 'device.asc'), content: text }), /No matching immutable expected/);
  writeFileSync(join(f.dir, 'device.asc'), text);
  assert.throws(() => checkDesign(f.project, { ...f.input, stage: 'implementation' }), /IR comments changed/);
  assert.throws(() => assertDesignBuildReady(f.project, { ...f.input, experiment_id: 'e1', kernel_path: f.rel(f.dir) }), /stale/);
});

test('unknown graph primitives and hardware activity families are rejected', t => {
  const f = fixture(t); f.ir.graph.nodes[0].op = 'matmul';
  assert.throws(() => f.expected(), /Unknown graph primitive: matmul/);
  f.ir.graph.nodes[0].op = 'add'; f.ir.execution.activities[0].kind = 'imaginary-hardware';
  assert.throws(() => f.expected(), /Unknown activity primitive/);
});

test('graph types, value dependencies and execution coverage are checked', t => {
  const f = fixture(t);
  const parse = () => parseAnnotations([{ path: 'device.asc', text: f.comment() }], f.opened.formula_ref, f.contract, f.model);
  f.ir.graph.nodes[0].args = ['sum', 'b']; assert.throws(parse, /undefined\/forward dependency/);
  f.ir.graph.nodes[0].args = ['a', 'b']; f.ir.graph.nodes[0].dtype = 'i32'; assert.throws(parse, /result dtype mismatch/);
  f.ir.graph.nodes[0].dtype = 'f32'; f.ir.execution.activities[0].implements = []; assert.throws(parse, /must identify graph nodes/);
});

test('annotation errors identify the input, graph node or hardware activity to repair', t => {
  const f = fixture(t);
  const parse = () => parseAnnotations([{ path: 'device.asc', text: f.comment() }], f.opened.formula_ref, f.contract, f.model);
  (f.ir.graph.inputs as Record<string, unknown>).a = { dtype: 'f32', shape: ['N'] };
  assert.throws(parse, /graph\.inputs\.a: expected a dtype string/);
  f.ir.graph.inputs.a = 'f32';
  (f.ir.graph.nodes[0] as unknown as Record<string, unknown>).args = 'a';
  assert.throws(parse, /graph\.nodes\[0\] \(sum\): node\.args must be a string array/);
  f.ir.graph.nodes[0].args = ['a[k]'];
  (f.ir.graph.nodes[0] as unknown as Record<string, unknown>).reduce = { axis: 'k', extent: 'K', tree: 'sequential' };
  assert.throws(parse, /graph\.nodes\[0\] \(sum\): Reduction must expand a balanced binary/);
  delete f.ir.graph.nodes[0].reduce;
  f.ir.graph.nodes[0].args = ['a', 'b'];
  f.ir.execution.activities[0].after = ['missing_load'];
  assert.throws(parse, /execution\.activities\[0\] \(compute\): Undefined\/forward activity dependency/);
  f.ir.execution.activities[0].after = [];
  assert.doesNotThrow(parse);
});

test('primitive reduction notation retains explicit binary-tree structure', t => {
  const f = fixture(t);
  f.ir.graph.nodes = [{ id: 'sum', op: 'add', args: ['a[k]'], dtype: 'f32', repeat: 'one output row', reduce: { axis: 'k', extent: 'K', tree: 'balanced' } }];
  assert.equal(f.expected().status, 'EXPECTED_SAVED');
});

test('graph input and output dtypes must match the fixed formula contract', t => {
  const f = fixture(t);
  const parse = () => parseAnnotations([{ path: 'device.asc', text: f.comment() }], f.opened.formula_ref, f.contract, f.model);
  f.ir.graph.inputs.a = 'i32';
  assert.throws(parse, /input dtype differs from formula: a/);
  f.ir.graph.inputs.a = 'f32';
  f.ir.graph.nodes.push({ id: 'integerResult', op: 'cast', args: ['sum'], dtype: 'i32' });
  f.ir.graph.outputs.y = 'integerResult';
  assert.throws(parse, /output dtype differs from formula: y/);
});

test('replaceable strategy retains the shared annotation gate', t => {
  const f = fixture(t); let checks = 0;
  const remove = registerDesignStrategy({ id: 'test-strategy@1', check() { checks++; } }); t.after(remove);
  const opened = openDesign(f.project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: f.rel(f.dir), design_id: 'alternative', strategy: 'test-strategy@1' });
  writeFileSync(join(f.dir, 'device.asc'), f.comment());
  assert.equal(checkDesign(f.project, { research_id: 'research-a', design_ref: opened.design_ref, stage: 'expected' }).status, 'EXPECTED_SAVED'); assert.equal(checks, 1);
  f.ir.graph.nodes[0].op = 'unknown'; writeFileSync(join(f.dir, 'device.asc'), f.comment());
  assert.throws(() => checkDesign(f.project, { research_id: 'research-a', design_ref: opened.design_ref, stage: 'expected' }), /Unknown graph/);
  assert.equal(checks, 1);
});

test('source markers inside literals cannot satisfy activity correspondence', t => {
  const f = fixture(t); f.expected();
  writeFileSync(join(f.dir, 'device.asc'), f.comment() + 'const char* x = R"tag(// meteor-activity: compute)tag";\nvoid device() {}');
  writeFileSync(join(f.dir, 'host.asc'), 'void add_launch() {}');
  assert.throws(() => freezeDesign(f.project, f.input), /needs a meteor-activity source marker/);
  assert.equal(scanSource('"/* meteor-ir:v1 {} */"').comments.length, 0);
});

test('comparison follows canonical-to-draft build identity without inventing activity time', t => {
  const f = fixture(t); f.expected(); const frozen = f.implement();
  const buildPath = targetPath(f.project, 'builds', 'unit-build.json');
  const common = { research_id: 'research-a', experiment_id: 'e1', kernel_ref: { kernel_id: 'add', revision: 'r1' }, environment_ref: f.project.config.environment.environment_ref, execution_backend: 'ssh', simulated: false, target: f.project.scope, source_hash: 'canonical-source' };
  writeJson(buildPath, { ...common, build_id: 'b1', draft_source_hash: frozen.source_hash, design_ref: f.input.design_ref });
  const testPath = targetPath(f.project, 'measurements', 'unit-test.json');
  writeJson(testPath, { ...common, run_id: 't1', build_ref: f.rel(buildPath), rows: [{ case_id: 'c1', median_us: 5, samples_us: [4, 5, 6] }] });
  const result = compareDesign(f.project, { ...f.input, receipt_refs: [f.rel(testPath)], analysis: { matched: [], deviations: [], unknown: ['Vector activity timing was not collected.'] } });
  assert.equal(result.status, 'COMPARED'); assert.equal(result.evidence_count, 1);
  const stored = JSON.parse(readFileSync(join(f.project.root, result.comparison_ref), 'utf8')).value;
  assert.deepEqual(stored.evidence[0].receipt.rows[0].samples_us, [4, 5, 6]);
  assert.equal('activity_times' in stored, false);
  writeJson(testPath, { ...common, run_id: 't1', target: { ...f.project.scope, dtype_id: 'f16' }, build_ref: f.rel(buildPath) });
  assert.throws(() => compareDesign(f.project, { ...f.input, receipt_refs: [f.rel(testPath)] }), /target does not match/);
  writeJson(testPath, { ...common, run_id: 't1', source_hash: 'other-source', build_ref: f.rel(buildPath) });
  assert.throws(() => compareDesign(f.project, { ...f.input, receipt_refs: [f.rel(testPath)] }), /build mapping does not match/);
});

test('design references cannot cross research or experiment and mock bypass is explicit', t => {
  const f = fixture(t); f.expected(); f.implement();
  assert.throws(() => assertDesignBuildReady(f.project, { research_id: 'research-b', design_ref: f.input.design_ref, experiment_id: 'e1', kernel_path: f.rel(f.dir) }), /another research/);
  assert.throws(() => assertDesignBuildReady(f.project, { ...f.input, experiment_id: 'e2', kernel_path: f.rel(f.dir) }), /experiment or candidate/);
  assert.throws(() => assertDesignBuildReady(f.project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: f.rel(f.dir), fixture: 'mock-fixture' }), /frozen design_ref/);
  f.project.config.execution.backend = 'mock';
  assert.throws(() => assertDesignBuildReady(f.project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: f.rel(f.dir) }), /frozen design_ref/);
  assert.equal(assertDesignBuildReady(f.project, { research_id: 'research-a', experiment_id: 'e1', kernel_path: f.rel(f.dir), fixture: 'mock-fixture' }).compatibility, 'explicit-mock-fixture');
});
