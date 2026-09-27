import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { loadExecutionModel, materializeExecutionModelEvidence, publishExecutionModel, validateExecutionModel } from '../templates/project/tools/meteor/hardware-model.ts';
import { configureAssemblyTemplate } from '../templates/project/tools/meteor/assembly-template.ts';
import { parseAnnotations } from '../templates/project/tools/meteor/design/annotations.ts';
import { createResearch } from '../templates/project/tools/meteor/research.ts';
import { hashObject, readJson, writeJson } from '../templates/project/tools/meteor/util.ts';
import { installHardwareProfile, materializeUnitCaseSuite, readyHardwareResult, writeReadyHardwareFixture } from './helpers/hardware.ts';

const canonicalProbeId = '11111111-1111-4111-8111-111111111111';

function fixture(t: TestContext, options: {
  canonicalProbe?: boolean;
  configureWorkspace?: (root: string) => void;
  selectedTarget?: { op_id: string; dtype_id: string };
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-hardware-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false }); materializeUnitCaseSuite(root);
  options.configureWorkspace?.(root);
  installHardwareProfile(t, root);
  writeReadyHardwareFixture(root, options.canonicalProbe ? {
    reportId: canonicalProbeId,
    result: readyHardwareResult({ request_id: 'hardware-' + canonicalProbeId, remote_release_confirmed: true }),
  } : {});
  const project = loadProject(root, options.selectedTarget), model = structuredClone(loadExecutionModel(project).model);
  mkdirSync(join(root, 'hardware/sources'), { recursive: true });
  writeFileSync(join(root, 'hardware/sources/document.md'), 'Local unit test source; this is not a hardware verification.');
  const request = { schema_version: 1, chief_id: 'chief-a', hardware_id: model.hardware_id, environment_ref: model.environment_ref,
    hardware_report_hash: project.config.environment.hardware_report_hash,
    remote_request_id: 'hardware-experiment-unit', payload: { commands: [{ argv: ['unit-test'] }] } };
  const receipt = { chief_id: 'chief-a', request_hash: hashObject(request), result: {
    request_id: request.remote_request_id, status: 'COMPLETED', backend: 'ssh', simulated: false, remote_release_confirmed: true,
    commands: [{ command: ['unit-test'], returncode: 0, stdout: 'Unit fixture only', stderr: '' }],
  } };
  writeJson(join(root, 'hardware/experiments/unit/request.json'), request);
  writeJson(join(root, 'hardware/experiments/unit/result.json'), { value: receipt, content_hash: hashObject(receipt) });
  model.sources[0].ref = 'hardware/sources/document.md'; model.sources[1].ref = 'hardware/experiments/unit/result.json';
  return { root, project, model, request, receipt };
}

function addCurrentProbeSource(f: ReturnType<typeof fixture>) {
  f.model.sources.push({ id: 'probe', kind: 'experiment', ref: f.project.config.environment.hardware_report_ref!,
    description: 'Current verified hardware probe report' });
}

test('fresh initialization has scoped artifacts and preparation skill, no invented hardware model or selected template', t => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-unprepared-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = initProject(root, { git: false }), project = loadProject(root);
  assert.equal(initialized.state, 'setup_required');
  for (const kind of ['kernels', 'ir', 'reports', 'versions', 'knowledge']) assert(existsSync(join(root, kind, 'qmq-v1/int8')));
  assert(existsSync(join(root, '.dsh/skills/meteor-hardware-prepare/SKILL.md')));
  assert.equal(project.config.design?.hardware_model_ref, undefined);
  assert.equal(project.target?.assembly_template_ref, undefined);
  assert.throws(() => loadExecutionModel(project), /Hardware execution model required/);
});

test('validated device probe alone cannot start research without model and target template', t => {
  const f = fixture(t), config = readJson(join(f.root, 'meteor.config.json'));
  delete config.design.hardware_model_ref; writeJson(join(f.root, 'meteor.config.json'), config);
  const start = () => createResearch(loadProject(f.root), { research_id: 'blocked', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'test' });
  assert.throws(start, /Hardware execution model required/);
  publishExecutionModel(f.project, f.model, 'chief-a');
  const selected = readJson(join(f.root, 'meteor.config.json')); delete selected.targets[0].assembly_template_ref;
  delete selected.targets[0].assembly_template; writeJson(join(f.root, 'meteor.config.json'), selected);
  assert.throws(start, /Assembly template setup required/);
});

test('published model freezes documentary and diagnostic evidence with exact device identity', t => {
  const f = fixture(t), published = publishExecutionModel(f.project, f.model, 'chief-a');
  const loaded = loadExecutionModel(f.project);
  assert.equal(loaded.model_hash, published.model_hash);
  const evidenceText = loaded.evidence[0].content;
  writeFileSync(join(f.root, 'hardware/sources/document.md'), 'Later different source text');
  assert.equal(loadExecutionModel(f.project).evidence[0].content, evidenceText);
  assert.throws(() => publishExecutionModel(f.project, { ...f.model, hardware_id: 'other-hw' }, 'chief-a'), /differs from/);
  assert.throws(() => publishExecutionModel(f.project, f.model, 'other-chief'), /author or request mismatch/);
  f.project.config.environment.environment_ref = 'other-environment';
  assert.throws(() => loadExecutionModel(f.project), /environment is stale/);
});

test('model cannot promote unknown, unreleased or foreign diagnostic results to published evidence', t => {
  const f = fixture(t), resultPath = join(f.root, 'hardware/experiments/unit/result.json');
  for (const patch of [{ status: 'UNKNOWN_REMOTE' }, { simulated: true }, { backend: 'mock' }, { remote_release_confirmed: false }, { request_id: 'wrong' }]) {
    const value = { ...f.receipt, result: { ...f.receipt.result, ...patch } };
    writeJson(resultPath, { value, content_hash: hashObject(value) });
    assert.throws(() => publishExecutionModel(f.project, f.model, 'chief-a'), /complete, released command evidence/);
  }
  assert.throws(() => validateExecutionModel({ ...f.model, sources: [f.model.sources[0]] }), /both documentation and device/);
  assert.throws(() => validateExecutionModel({ ...f.model, constraints: [{ statement: 'claim', scope: 'one case', status: 'measured', evidence_refs: ['doc'] }] }), /needs experiment evidence/);
});

test('re-probing invalidates a model and old diagnostic sources even if stable environment identity is unchanged', t => {
  const f = fixture(t); publishExecutionModel(f.project, f.model, 'chief-a');
  f.project.config.environment.hardware_report_hash = 'new-probe-with-same-stable-environment';
  assert.throws(() => loadExecutionModel(f.project), /probe is stale/);
  assert.throws(() => publishExecutionModel(f.project, f.model, 'chief-a'), /older hardware probe/);
});

test('released failures remain usable as limited evidence alongside a successful diagnostic', t => {
  const f = fixture(t), request = { ...f.request, remote_request_id: 'failed-unit' };
  const value = { ...f.receipt, request_hash: hashObject(request), result: { ...f.receipt.result,
    request_id: request.remote_request_id, status: 'FAILED', commands: [{ command: ['unit-test'], returncode: 1, stderr: 'local limitation' }] } };
  writeJson(join(f.root, 'hardware/experiments/failed/request.json'), request);
  writeJson(join(f.root, 'hardware/experiments/failed/result.json'), { value, content_hash: hashObject(value) });
  f.model.sources.push({ id: 'negative', kind: 'experiment', ref: 'hardware/experiments/failed/result.json', description: 'Limited failed observation' });
  f.model.constraints.push({ statement: 'This local diagnostic failed; mechanism unknown', scope: 'exact diagnostic only', status: 'measured', evidence_refs: ['negative'] });
  assert.equal(publishExecutionModel(f.project, f.model, 'chief-a').status, 'PUBLISHED');
  f.model.sources[1].ref = f.model.sources[2].ref;
  assert.throws(() => publishExecutionModel(f.project, f.model, 'chief-a'), /at least one successful/);
});

test('current verified probe report can supplement measured evidence without replacing diagnostics', t => {
  const f = fixture(t, { canonicalProbe: true });
  addCurrentProbeSource(f);
  f.model.constraints.push({ statement: 'Probe established compile launch correctness and device witness for setup only',
    scope: 'current hardware probe only', status: 'measured', evidence_refs: ['probe'] });
  const published = publishExecutionModel(f.project, f.model, 'chief-a');
  const loaded = loadExecutionModel(f.project);
  assert.equal(published.status, 'PUBLISHED');
  assert.equal(loaded.evidence.find((item: any) => item.source_id === 'probe')?.content_hash,
    hashObject(readFileSync(join(f.root, f.project.config.environment.hardware_report_ref!), 'utf8')));

  const probeOnly = fixture(t, { canonicalProbe: true });
  probeOnly.model.sources[1] = { id: 'experiment', kind: 'experiment',
    ref: probeOnly.project.config.environment.hardware_report_ref!, description: 'Current verified hardware probe report' };
  assert.throws(() => publishExecutionModel(probeOnly.project, probeOnly.model, 'chief-a'), /at least one successful/);

  const wrongKind = fixture(t, { canonicalProbe: true });
  wrongKind.model.sources.push({ id: 'probe_doc', kind: 'documentation',
    ref: wrongKind.project.config.environment.hardware_report_ref!, version: 'probe-report',
    description: 'Current verified hardware probe report' });
  assert.throws(() => publishExecutionModel(wrongKind.project, wrongKind.model, 'chief-a'), /experiment evidence, not documentation/);
});

test('old frozen model with probe report documented source remains readable', t => {
  const f = fixture(t, { canonicalProbe: true });
  f.model.sources[0] = { id: 'doc', kind: 'documentation',
    ref: f.project.config.environment.hardware_report_ref!, version: 'legacy-frozen-model',
    description: 'Legacy frozen probe source classified as documentation' };
  const value = { model: f.model, evidence: [], chief_id: 'chief-a',
    hardware_report_hash: f.project.config.environment.hardware_report_hash };
  const modelHash = hashObject(value);
  const modelRef = `hardware/execution-models/${f.model.model_id}/${modelHash}.json`;
  writeJson(join(f.root, modelRef), { value, content_hash: modelHash });
  const config = readJson(join(f.root, 'meteor.config.json'));
  config.design = { ...config.design, hardware_model_ref: modelRef };
  writeJson(join(f.root, 'meteor.config.json'), config);
  assert.equal(loadExecutionModel(loadProject(f.root)).model_ref, modelRef);
});

test('probe report evidence rejects stale tampered unreleased mock and failed witness reports', t => {
  const stale = fixture(t, { canonicalProbe: true });
  addCurrentProbeSource(stale);
  const oldReportRef = 'hardware/reports/22222222-2222-4222-8222-222222222222/report.json';
  writeJson(join(stale.root, oldReportRef), readJson(join(stale.root, stale.project.config.environment.hardware_report_ref!)));
  stale.model.sources.at(-1)!.ref = oldReportRef;
  assert.throws(() => publishExecutionModel(stale.project, stale.model, 'chief-a'), /current hardware report/);

  for (const patch of [
    { remote_release_confirmed: false },
    { request_id: 'hardware-wrong-request' },
    { backend: 'mock' },
    { simulated: true },
    { validation: { ...readyHardwareResult().validation, device_execution: { status: 'NOT_RUN', matched_tasks: [] } } },
  ]) {
    const f = fixture(t, { canonicalProbe: true });
    addCurrentProbeSource(f);
    const reportPath = join(f.root, f.project.config.environment.hardware_report_ref!);
    const report = readJson(reportPath);
    report.result = { ...report.result, ...patch };
    writeJson(reportPath, report);
    const newReportHash = hashObject(report);
    f.project.config.environment.hardware_report_hash = newReportHash;
    const requestPath = join(f.root, 'hardware/experiments/unit/request.json');
    const request = { ...readJson(requestPath), hardware_report_hash: newReportHash };
    writeJson(requestPath, request);
    const resultPath = join(f.root, 'hardware/experiments/unit/result.json');
    const value = { ...readJson(resultPath).value, request_hash: hashObject(request) };
    writeJson(resultPath, { value, content_hash: hashObject(value) });
    assert.throws(() => publishExecutionModel(f.project, f.model, 'chief-a'), /released hardware request evidence|Hardware validation is not ready|Publish real execution models/);
  }

  const tampered = fixture(t, { canonicalProbe: true });
  addCurrentProbeSource(tampered);
  const reportPath = join(tampered.root, tampered.project.config.environment.hardware_report_ref!);
  const report = readJson(reportPath);
  report.result.supported_metrics = ['changed-after-probe'];
  writeJson(reportPath, report);
  assert.throws(() => publishExecutionModel(tampered.project, tampered.model, 'chief-a'), /Hardware report changed/);
});

test('execution annotation vocabulary comes only from the supplied model, including novel primitives', t => {
  const f = fixture(t), graph = { formula_ref: 'formula', inputs: { a: 'f32', b: 'f32' },
    nodes: [{ id: 'sum', op: 'add', args: ['a', 'b'], dtype: 'f32' }], outputs: { y: 'sum' } };
  const activity = { id: 'a', kind: 'device_specific_v23', resource: 'custom_engine', operation: 'observed add', description: 'test', implements: ['sum'], after: [] };
  f.model.resources = [{ id: 'custom_engine', description: 'Unit resource', evidence_refs: ['doc'] }];
  f.model.primitives = [{ id: activity.kind, resources: ['custom_engine'], description: 'Unit primitive', graph_required: true, evidence_refs: ['doc'] }];
  const parse = () => parseAnnotations([{ path: 'unit.cc', text: '/* meteor-ir:v1\n' + JSON.stringify({ graph, execution: { semantics: 'unit semantics', activities: [activity] } }) + '\n*/' }],
    'formula', { inputs: { a: 'f32', b: 'f32' }, outputs: { y: 'f32' } }, f.model);
  assert.doesNotThrow(parse);
  activity.kind = 'vector'; assert.throws(parse, /Unknown activity primitive/);
  activity.kind = 'device_specific_v23'; activity.resource = 'Vector'; assert.throws(parse, /resource is not allowed/);
});

test('research snapshot retains original model and hardware when future preparation changes', t => {
  const f = fixture(t), published = publishExecutionModel(f.project, f.model, 'chief-a');
  createResearch(f.project, { research_id: 'frozen', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'test snapshot' });
  const prior = readFileSync(join(f.project.snapshotRoot!, published.model_ref), 'utf8');
  const later = loadProject(f.root); f.model.model_id = 'later-model';
  publishExecutionModel(later, f.model, 'chief-a');
  assert.notEqual(later.config.design?.hardware_model_ref, published.model_ref);
  assert.equal(loadExecutionModel(f.project).model_ref, published.model_ref);
  assert.equal(readFileSync(join(f.project.snapshotRoot!, published.model_ref), 'utf8'), prior);
  const path = join(f.project.snapshotRoot!, published.model_ref), tampered = readJson(path);
  tampered.value.model.primitives[0].id = 'changed'; writeJson(path, tampered);
  assert.throws(() => loadExecutionModel(f.project), /integrity mismatch/);
});

test('distinct research sessions reuse one frozen hardware preparation with independent child assignments', t => {
  const f = fixture(t, { canonicalProbe: true });
  addCurrentProbeSource(f);
  const published = publishExecutionModel(f.project, f.model, 'chief-a');
  const modelBytes = readFileSync(join(f.root, published.model_ref), 'utf8');
  const hardwareBytes = readFileSync(join(f.root, f.project.config.workspace!.hardware_ref), 'utf8');
  const frozenDoc = readFileSync(join(f.root, 'hardware/sources/document.md'), 'utf8');
  const frozenExperiment = readFileSync(join(f.root, 'hardware/experiments/unit/result.json'), 'utf8');
  const reportCount = readdirSync(join(f.root, 'hardware/reports')).length;
  const modelCount = readdirSync(join(f.root, 'hardware/execution-models', f.model.model_id)).length;
  writeFileSync(join(f.root, 'hardware/sources/document.md'), 'Mutable workspace source changed after model publish');
  rmSync(join(f.root, 'hardware/experiments/unit/result.json'));

  const first = loadProject(f.root);
  createResearch(first, { research_id: 'child_a', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'first child expression',
    assigned_hypothesis: { statement: 'Child A specializes expression A' } });
  const second = loadProject(f.root);
  createResearch(second, { research_id: 'child_b', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'second child expression',
    assigned_hypothesis: { statement: 'Child B specializes expression B' } });

  assert.notEqual(first.snapshotRoot, second.snapshotRoot);
  for (const project of [first, second]) {
    const loaded = loadExecutionModel(project);
    assert.equal(loaded.model_ref, published.model_ref);
    assert.equal(loaded.model_hash, published.model_hash);
    assert.equal(loaded.model.hardware_id, published.hardware_id);
    assert.equal(loaded.model.environment_ref, published.environment_ref);
    assert.equal(readFileSync(join(project.snapshotRoot!, published.model_ref), 'utf8'), modelBytes);
    assert.equal(readFileSync(join(project.snapshotRoot!, project.config.workspace!.hardware_ref), 'utf8'), hardwareBytes);
    assert.equal(readFileSync(join(project.snapshotRoot!, 'hardware/sources/document.md'), 'utf8'), frozenDoc);
    assert.equal(readFileSync(join(project.snapshotRoot!, 'hardware/experiments/unit/result.json'), 'utf8'), frozenExperiment);
    assert.equal(loaded.evidence.find((item: any) => item.source_id === 'probe')?.content,
      readFileSync(join(f.root, f.project.config.environment.hardware_report_ref!), 'utf8'));
  }
  assert.notDeepEqual(readJson(join(first.snapshotRoot!, '..', 'manifest.json')).assigned_hypothesis,
    readJson(join(second.snapshotRoot!, '..', 'manifest.json')).assigned_hypothesis);
  assert.equal(readdirSync(join(f.root, 'hardware/reports')).length, reportCount);
  assert.equal(readdirSync(join(f.root, 'hardware/execution-models', f.model.model_id)).length, modelCount);

  const firstModelPath = join(first.snapshotRoot!, published.model_ref);
  const tampered = readJson(firstModelPath);
  tampered.value.model.primitives[0].id = 'changed'; writeJson(firstModelPath, tampered);
  assert.throws(() => loadExecutionModel(first), /integrity mismatch/);
  assert.equal(loadExecutionModel(second).model_hash, published.model_hash);
  writeFileSync(join(first.snapshotRoot!, 'hardware/sources/document.md'), 'changed in first snapshot only');
  assert.equal(readFileSync(join(second.snapshotRoot!, 'hardware/sources/document.md'), 'utf8'), frozenDoc);
});

test('frozen evidence materialization only writes canonical hardware source paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'meteor-materialize-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const loaded: ReturnType<typeof loadExecutionModel> = {
    model_ref: 'hardware/execution-models/unit/hash.json',
    model_hash: 'hash',
    model: {
      schema_version: 1, model_id: 'unit', hardware_id: 'hw', environment_ref: 'env',
      sources: [
        { id: 'nested', kind: 'documentation', ref: 'hardware/sources/cann/ascendc/apis.md', version: 'unit', description: 'nested source' },
        { id: 'traversal', kind: 'documentation', ref: 'hardware/sources/../../tools/new.js', version: 'unit', description: 'bad source' },
        { id: 'plain', kind: 'documentation', ref: 'docs/vendor.md', version: 'unit', description: 'ordinary source' },
      ],
      resources: [{ id: 'r', description: 'resource', evidence_refs: ['nested'] }],
      primitives: [{ id: 'p', description: 'primitive', resources: ['r'], graph_required: true, evidence_refs: ['nested'] }],
      constraints: [], limitations: ['unit'],
    },
    evidence: [
      { source_id: 'nested', content_hash: hashObject('frozen nested docs'), content: 'frozen nested docs' },
      { source_id: 'traversal', content_hash: hashObject('do not write'), content: 'do not write' },
      { source_id: 'plain', content_hash: hashObject('plain package content'), content: 'plain package content' },
    ],
  };
  materializeExecutionModelEvidence(root, loaded);
  assert.equal(readFileSync(join(root, 'hardware/sources/cann/ascendc/apis.md'), 'utf8'), 'frozen nested docs');
  assert.equal(existsSync(join(root, 'tools/new.js')), false);
  assert.equal(existsSync(join(root, 'docs/vendor.md')), false);
  assert.equal(loaded.evidence.find((item: any) => item.source_id === 'plain')?.content, 'plain package content');

  loaded.evidence[0].content_hash = hashObject('different bytes');
  assert.throws(() => materializeExecutionModelEvidence(root, loaded), /content hash mismatch/);
});

test('targets share the hardware model while freezing independent target templates', t => {
  const firstTarget = { op_id: 'qmq-v1', dtype_id: 'int8' };
  const secondTarget = { op_id: 'other-op', dtype_id: 'int8' };
  const f = fixture(t, { canonicalProbe: true, selectedTarget: firstTarget, configureWorkspace(root) {
    const config = readJson<any>(join(root, 'meteor.config.json'));
    config.targets = [config.targets[0], { ...config.targets[0], ...secondTarget }];
    writeJson(join(root, 'meteor.config.json'), config);
  } });
  addCurrentProbeSource(f);
  const published = publishExecutionModel(f.project, f.model, 'chief-a');
  const secondTemplate = join(f.root, 'second-template.asc.tmpl');
  writeFileSync(secondTemplate, readFileSync(join(f.root, 'templates/qmq-v1/int8/version.asc.tmpl'), 'utf8') + '\n// second target template\n');
  configureAssemblyTemplate(loadProject(f.root, secondTarget), { source_path: secondTemplate, template_id: 'second-target', now: '2026-09-27T00:00:00.000Z' });

  const first = loadProject(f.root, firstTarget);
  const second = loadProject(f.root, secondTarget);
  createResearch(first, { research_id: 'shared_model_first_target', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'first target' });
  createResearch(second, { research_id: 'shared_model_second_target', chief_id: 'chief-a', agent_session_id: 'pending', goal: 'second target' });

  assert.equal(loadExecutionModel(first).model_ref, published.model_ref);
  assert.equal(loadExecutionModel(second).model_ref, published.model_ref);
  assert.equal(readFileSync(join(first.snapshotRoot!, published.model_ref), 'utf8'),
    readFileSync(join(second.snapshotRoot!, published.model_ref), 'utf8'));
  assert.notEqual(first.target!.assembly_template_ref, second.target!.assembly_template_ref);
  assert.equal(readJson(join(first.snapshotRoot!, 'target.json')).op_id, firstTarget.op_id);
  assert.equal(readJson(join(second.snapshotRoot!, 'target.json')).op_id, secondTarget.op_id);
  assert.equal(readJson(join(first.snapshotRoot!, 'meteor.config.json')).targets.find((target: any) => target.op_id === firstTarget.op_id).assembly_template.template_id,
    'explicit-test-template');
  assert.equal(readJson(join(second.snapshotRoot!, 'meteor.config.json')).targets.find((target: any) => target.op_id === secondTarget.op_id).assembly_template.template_id,
    'second-target');
});
