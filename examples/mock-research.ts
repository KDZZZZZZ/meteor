import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { createResearch, bindResearchSession, researchPath } from '../templates/project/tools/meteor/research.ts';
import { buildKernel, buildReceiptPath, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel, testReceiptPath } from '../templates/project/tools/meteor/kernel-test.ts';
import { profileKernel, profileReceiptPath } from '../templates/project/tools/meteor/kernel-profile.ts';
import { openDesign, checkDesign, freezeDesign, compareDesign } from '../templates/project/tools/meteor/design/service.ts';
import { prepareSubmission, commitSubmission } from '../templates/project/tools/meteor/submit.ts';
import { processIntegrationEvents } from '../templates/project/tools/meteor/integration-events.ts';
import { hashObject, writeJson } from '../templates/project/tools/meteor/util.ts';
import { configureAssemblyTemplate } from '../templates/project/tools/meteor/assembly-template.ts';
import type { Experiment, Hypothesis, KernelModule, KernelSubmission, Submission } from '../templates/project/tools/meteor/contracts.ts';

const root = mkdtempSync(join(tmpdir(), 'meteor-demo-'));
initProject(root, { git: false, backend: 'mock' });
const project = loadProject(root);
// Explicit demo fixtures, never installed as real hardware capability defaults.
const mockModel = { schema_version: 1, model_id: 'mock-demo', hardware_id: 'mock-device', environment_ref: project.config.environment.environment_ref,
  sources: [{ id: 'doc', kind: 'documentation', ref: 'mock-doc', version: 'mock', description: 'Synthetic demonstration' },
    { id: 'experiment', kind: 'experiment', ref: 'mock-experiment', description: 'No device experiment' }],
  resources: ['MTE2', 'Vector', 'MTE3'].map(id => ({ id, description: 'Fictional demo resource', evidence_refs: ['doc'] })),
  primitives: [['load', 'MTE2'], ['vector', 'Vector'], ['store', 'MTE3']].map(([id, resource]) => ({ id, description: 'Demo syntax only', resources: [resource], graph_required: id === 'vector', evidence_refs: ['doc'] })),
  constraints: [], limitations: ['All activity vocabulary here is a mock fixture; no hardware claims'] };
const modelValue = { model: mockModel, evidence: [], chief_id: 'demo-chief' }, modelHash = hashObject(modelValue);
const modelRef = `hardware/execution-models/mock-demo/${modelHash}.json`;
writeJson(join(root, modelRef), { value: modelValue, content_hash: modelHash });
writeJson(join(root, 'hardware/target.json'), { state: 'bound', hardware_id: 'mock-device' });
project.config.design!.hardware_model_ref = modelRef;
writeJson(join(root, 'meteor.config.json'), project.config);
configureAssemblyTemplate(project, { source_path: project.target!.template_ref + '/version.asc.tmpl', template_id: 'explicit-demo-template' });
const research = createResearch(project, { research_id: 'mock-demonstration', chief_id: 'demo-chief', agent_session_id: 'pending', goal: 'Exercise two controlled experiments and the evidence contract' });
bindResearchSession(project, research.research_id, 'demo-one-continuous-session');
const hypothesis: Hypothesis = {
  hypothesis_id: 'mock-loop', revision: 'r1', statement: 'Reusing a loaded tile reduces repeated memory traffic.',
  scope: 'Mock protocol demonstration; no hardware conclusion', mechanism: 'Reuse versus repeated loads',
  intervention: 'Compare two independent mock implementations', controls: ['Same fixed suite and environment'],
  predictions: ['Fewer load transactions for the reuse implementation'], support_criteria: ['Real controlled profile confirms required prediction'],
  refutation_criteria: ['Valid controlled real profile contradicts the required prediction'], confounders: ['No real device execution'],
  measurement_plan: 'Full independent test of both revisions and selected profile', verdict: 'INCONCLUSIVE',
  supporting_evidence: [], counterevidence: [], limitations: ['All measurements are simulated'], simulated_verdict: 'SUPPORTED',
};
writeJson(join(researchPath(project, research.research_id), 'hypothesis.json'), hypothesis);
const submitted: KernelSubmission[] = [], experiments: Experiment[] = [];
for (let iteration = 0; iteration < 2; iteration++) {
  const kernelId = `demo-${iteration}`, experimentId = `experiment-${iteration}`;
  const kernelPath = receiptRef(project, join(researchPath(project, research.research_id), 'drafts', kernelId, 'r1')), prefix = `demo_${iteration}_`;
  mkdirSync(join(root, kernelPath), { recursive: true });
  const module: KernelModule = {
    kernel_id: kernelId, revision: 'r1', operator_abi: 'qmq-v1', symbol_prefix: prefix, launcher: `${prefix}launch`,
    device_file: `${kernelPath}/device.asc`, host_file: `${kernelPath}/host.asc`, dependencies: [],
    supported_case_ids: project.suite.cases.map(c => c.case_id), hardware_scope: 'mock-only', resource_constraints: [],
  };
  writeJson(join(root, kernelPath, 'kernel.json'), module);
  writeFileSync(join(root, module.device_file), '');
  writeFileSync(join(root, module.host_file), '');
  const design = openDesign(project, { research_id: research.research_id, experiment_id: experimentId, kernel_path: kernelPath });
  const node = (id: string, op: string, args: string[], dtype = 'f32', extra = {}) => ({ id, op, args, dtype, ...extra });
  const nodes = [
    node('lhs', 'cast', ['x1[m,k]'], 'i32'), node('rhs', 'cast', ['x2[n,k]'], 'i32'),
    node('product', 'mul', ['lhs', 'rhs'], 'i32'),
    node('acc', 'add', ['product[m,n,k]'], 'i32', { reduce: { axis: 'k', extent: 'K', tree: 'balanced' } }),
    node('v0', 'cast', ['acc']), node('v1', 'mul', ['v0', 'x1Scale[m]']),
    node('v2', 'mul', ['v1', 'x2Scale[n]']), node('activation', 'max', ['v2', 'zero']),
    node('row', 'max', ['activation[m,n]'], 'f32', { reduce: { axis: 'n', extent: 'N', tree: 'balanced' } }),
    node('scaled', 'div', ['row', 'maxq']), node('active', 'gt', ['row', 'zero'], 'bool'),
    node('scale', 'select', ['active', 'scaled', 'one']), node('ratio', 'div', ['activation', 'scale']),
    node('rounded', 'round', ['ratio'], 'f32', { mode: 'rne' }), node('lower', 'max', ['rounded', 'minq']),
    node('clamped', 'min', ['lower', 'maxq']), node('output', 'cast', ['clamped'], 'i8'),
  ];
  const ir = {
    graph: { formula_ref: design.formula_ref, inputs: { x1: 'i8', x2: 'i8', x1Scale: 'f32', x2Scale: 'f32' },
      constants: Object.fromEntries(Object.entries({ zero: 0, one: 1, maxq: 127, minq: -128 }).map(([id, value]) => [id, { dtype: 'f32', value }])),
      nodes, outputs: { y: 'output', yScale: 'scale' } },
    execution: { semantics: 'Int32 accumulation; staged FP32 scaling; finite ReLU, row scale and nearest-even quantization. Mock protocol only; this design has no hardware implementation.',
      activities: [
        { id: 'load', kind: 'load', operation: 'GM to UB', resource: 'MTE2', implements: [], after: [], description: 'Expected tile inputs and scales become available before compute; hardware mapping remains unverified.' },
        { id: 'compute', kind: 'vector', operation: 'QMQ primitive sequence', resource: 'Vector', implements: nodes.map(n => n.id), after: ['load'], description: 'Expected complete formula with staged FP32 rounding; each row reduces its valid N elements. Demo does not implement these activities.' },
        { id: 'store', kind: 'store', operation: 'UB to GM', resource: 'MTE3', implements: [], after: ['compute'], description: 'Expected y and yScale writes after row quantization. No real device observation.' },
      ] },
  };
  const comment = '/* meteor-ir:v1\n' + JSON.stringify(ir, null, 2) + '\n*/\n';
  writeFileSync(join(root, module.device_file), comment);
  const designInput = { research_id: research.research_id, design_ref: design.design_ref };
  checkDesign(project, { ...designInput, stage: 'expected' });
  // The mock runner does not compile this placeholder. The design gate still checks order and identity.
  writeFileSync(join(root, module.device_file), comment + '// meteor-activity: load\n// meteor-activity: compute\n// meteor-activity: store\nvoid mock_protocol_only() {}\n');
  writeFileSync(join(root, module.host_file), `MeteorStatus ${module.launcher}(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Unsupported; }\n`);
  freezeDesign(project, designInput);
  const build = await buildKernel(project, { research_id: research.research_id, experiment_id: experimentId, kernel_path: kernelPath, design_ref: design.design_ref });
  const buildRef = receiptRef(project, buildReceiptPath(project, build));
  const cases = Object.fromEntries(project.suite.cases.map((c, index) => [c.case_id, { samples_us: Array(5).fill((index < 2) === (iteration === 0) ? 10 : 20) }]));
  const full = await testKernel(project, { build_ref: buildRef, mode: 'full', fixture: { fixture_id: `split-${iteration}`, cases } });
  const fullRef = receiptRef(project, testReceiptPath(project, full));
  const profile = await profileKernel(project, { build_ref: buildRef, case_ids: [project.suite.cases[0].case_id], metrics: ['load_transactions'] });
  const profileRef = receiptRef(project, profileReceiptPath(project, profile));
  const comparison = compareDesign(project, { ...designInput, receipt_refs: [fullRef, profileRef],
    analysis: { matched: [], deviations: [], unknown: ['All timing and activity observations are simulated; expected activities are unverified.'] } });
  assert.equal(comparison.simulated, true);
  experiments.push({ experiment_id: experimentId, hypothesis_revision: 'r1', question: 'Does the predicted mechanism change?', intervention: module.kernel_id,
    controls: ['Fixed suite and protocol'], kernel_revisions: [{ kernel_id: kernelId, revision: 'r1' }], environment_ref: full.environment_ref,
    full_size_test_refs: [fullRef], profile_refs: [profileRef], analysis: 'Simulated observations exercise records only; causality remains untested.', next_experiment: iteration === 0 ? 'Compare the second implementation' : 'Repeat on configured real hardware' });
  submitted.push({ kernel_id: kernelId, revision: 'r1', source_hash: build.source_hash, artifact_refs: [build.module_ref],
    supported_domain: 'Only the fixed mock suite shapes', verified_case_ids: module.supported_case_ids,
    recommended_domain: 'Mock selection exercise only', recommended_case_ids: module.supported_case_ids,
    hardware_scope: 'mock-only', resource_constraints: [], unsupported_cases: [],
    case_suite_revision: full.case_suite_revision, environment_ref: full.environment_ref, measurement_protocol_ref: full.measurement_protocol_ref,
    full_size_test_ref: fullRef, test_status: 'COMPLETED', performance_data_ref: fullRef, data_hash: full.data_hash,
    measured_tradeoffs: 'Simulated local strengths differ between shapes', limitations: ['Not a real device kernel'] });
}
const submission: Submission = { research_id: research.research_id, agent_session_id: 'demo-one-continuous-session', execution_backend: 'mock', termination_reason: 'mock demonstration complete',
  hypothesis, hypothesis_history: [], experiments, submitted_kernels: submitted,
  knowledge_updates: [{ claim_id: 'mock-diversity-observation', kind: 'observation', statement: 'The fixture demonstrates complementary case selections.', scope: 'mock-only', evidence_refs: experiments.flatMap(e => e.full_size_test_refs), related_material_ids: [] }],
  chief_report: { summary: 'Two simulated experiments completed; real hypothesis is inconclusive.', findings: ['Each exact revision has a separate full matrix.'], unresolved: ['No hardware evidence'], next_steps: ['Run the same controlled hypothesis on the configured Ascend backend.'] } };
const prepared = prepareSubmission(project, submission);
assert.equal(prepareSubmission(project, submission).prepared_submission_id, prepared.prepared_submission_id);
// This is the native host's accepted-final boundary, not a chief integration tool.
const report = commitSubmission(project, prepared.prepared_submission_id, submission.agent_session_id);
const integration = await processIntegrationEvents(project);
assert.equal(report.research_goal_met, false);
assert.equal(integration.failed, 0);
assert.equal(integration.assembled, 1);
const assembled = integration.results.find(r => r.status === 'ASSEMBLED')!;
assert.equal(assembled.integration_validation, 'NOT_RUN');
const source = readFileSync(assembled.version_asc_ref!, 'utf8');
assert.match(source, /extern "C" void run_kernel/);
assert.match(source, /demo_0_launch/);
assert.match(source, /demo_1_launch/);
assert.doesNotMatch(source, /\{\{|placeholder/);
assert.equal((await processIntegrationEvents(project)).processed, 0);
console.log(JSON.stringify({ root, simulated: true, experiments: experiments.length, submitted_kernels: submitted.length,
  verdict: report.verdict, research_goal_met: report.research_goal_met, integration: assembled.status,
  integration_validation: assembled.integration_validation, version_asc_ref: assembled.version_asc_ref }, null, 2));
