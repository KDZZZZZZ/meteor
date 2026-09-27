import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { KernelModule, Project, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { configureAssemblyTemplate } from '../templates/project/tools/meteor/assembly-template.ts';
import { renderVersion } from '../templates/project/tools/meteor/assemble.ts';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import { buildKernel, buildReceiptPath, computeSourceHash, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel, testReceiptPath } from '../templates/project/tools/meteor/kernel-test.ts';
import { bindResearchSession, createResearch, researchPath } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission } from '../templates/project/tools/meteor/submit.ts';
import { integrateSubmission } from '../templates/project/tools/meteor/integrate.ts';
import { readJson, sha256, writeJson } from '../templates/project/tools/meteor/util.ts';
import { targetPath, targetRef } from '../templates/project/tools/meteor/workspace.ts';

function write(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function slash(path: string): string { return path.replace(/\\/g, '/'); }
function template(marker: string): string {
  return readFileSync(join(process.cwd(), 'templates/project/templates/qmq-v1/int8/version.asc.tmpl'), 'utf8') + `\n// ${marker}\n`;
}
function macroOnlyTemplate(marker: string): string {
  return [`// ${marker}`, '{{ASSEMBLY_KEY}}', '{{DEPENDENCY_PREAMBLE}}', '{{SHARED_CODE}}', '{{HOST_CONTEXT_HELPERS}}', '{{KERNEL_DEVICE_CODE}}', '{{KERNEL_HOST_LAUNCHERS}}', '#define METEOR_IMPLEMENTATION(ID, LAUNCHER, LABEL) REGISTER_IMPL(ID, LAUNCHER, LABEL)', '{{IMPLEMENTATION_TABLE}}', '#undef METEOR_IMPLEMENTATION', '#define METEOR_BUCKET(RULE_ID, IMPLEMENTATION_ID, CASES) REGISTER_BUCKET(RULE_ID, IMPLEMENTATION_ID, CASES)', '{{BUCKET_TABLE}}', '#undef METEOR_BUCKET', 'static MeteorChoice custom_route(const MeteorShape& shape) {', '  {{ROUTE_FUNCTION_BODY}}', '  return {0U, 0U};', '}'].join('\n');
}
function smallSuite() {
  return { revision: 'suite-small', operator_abi: 'qmq-v1', cases: [
    { case_id: 'case_a', shape: { m: 16, n: 16, k: 64 }, dtype: 'int8', layout: 'qmq-v1', input_hash: 'input-a', oracle_hash: 'oracle-a' },
    { case_id: 'case_b', shape: { m: 32, n: 16, k: 64 }, dtype: 'int8', layout: 'qmq-v1', input_hash: 'input-b', oracle_hash: 'oracle-b' },
  ] };
}
function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-assembly-template-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' });
  const config = readJson<any>(join(root, 'meteor.config.json'));
  config.targets[0].case_suite_ref = 'cases/qmq-v1/int8/small/suite.json';
  writeJson(join(root, config.targets[0].case_suite_ref), smallSuite());
  writeJson(join(root, 'meteor.config.json'), config);
  return root;
}
function moduleFor(project: Project, kernelId = 'same-kernel', revision = 'r1'): KernelModule {
  const base = slash(relative(project.root, join(targetPath(project, 'kernels', kernelId, revision))));
  const module: KernelModule = { target: targetRef(project), kernel_id: kernelId, revision, operator_abi: project.suite.operator_abi,
    symbol_prefix: 'same_', launcher: 'same_launch', device_file: `${base}/device.asc`, host_file: `${base}/host.asc`,
    dependencies: [], supported_case_ids: project.suite.cases.map(c => c.case_id), hardware_scope: 'mock', resource_constraints: [] };
  write(join(project.root, module.device_file), `// device ${project.scope?.op_id}/${project.scope?.dtype_id}\n`);
  write(join(project.root, module.host_file), 'MeteorStatus same_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  writeJson(join(project.root, base, 'kernel.json'), module);
  return module;
}
function configure(project: Project, marker: string, id = marker) {
  const source = join(project.root, 'user-templates', `${id}.asc.tmpl`);
  write(source, template(marker));
  return configureAssemblyTemplate(project, { source_path: source, template_id: id, now: '2026-09-27T00:00:00.000Z' });
}

test('schema v2 version assembly requires a Chief-selected frozen template', t => {
  const root = setup(t);
  let project = loadProject(root);
  const module = moduleFor(project);
  assert.throws(() => renderVersion(project, { assembly_key: 'missing', implementations: [{ implementation_id: 1, module }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] }), /Assembly template setup required/);

  const configured = configure(project, 'selected-template', 'selected');
  project = loadProject(root);
  const output = renderVersion(project, { assembly_key: 'configured', implementations: [{ implementation_id: 1, module }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] });
  assert.equal(configured.assembly_template_ref, 'templates/qmq-v1/int8/assembly/selected.version.asc.tmpl');
  assert.match(output, /selected-template/);
  assert.match(output, /METEOR_BUCKET\(1U, 1U, \"case_a\"\)/);
  assert.match(output, /METEOR_IMPLEMENTATION\(1U, same_launch, \"same-kernel@r1\"\)/);
});

test('configured template is frozen and validated before use', t => {
  const root = setup(t);
  let project = loadProject(root);
  const source = join(root, 'source.asc.tmpl');
  write(source, template('frozen-v1'));
  const result = configureAssemblyTemplate(project, { source_path: source, template_id: 'frozen', source_label: 'human-example', now: '2026-09-27T00:00:00.000Z' });
  assert.equal(result.source_ref, 'human-example');
  assert.equal(result.assembly_template_hash, sha256(template('frozen-v1')));
  write(source, template('changed-source'));
  project = loadProject(root);
  const module = moduleFor(project);
  const output = renderVersion(project, { assembly_key: 'frozen', implementations: [{ implementation_id: 1, module }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] });
  assert.match(output, /frozen-v1/);
  assert.doesNotMatch(output, /changed-source/);

  const bad = join(root, 'bad.asc.tmpl');
  write(bad, '{{ASSEMBLY_KEY}} {{UNKNOWN_SLOT}}');
  assert.throws(() => configureAssemblyTemplate(project, { source_path: bad, template_id: 'bad' }), /Unknown assembly template slot: UNKNOWN_SLOT/);
  const missing = join(root, 'missing.asc.tmpl');
  write(missing, template('missing').replace('{{ROUTE_FUNCTION_BODY}}', ''));
  assert.throws(() => configureAssemblyTemplate(project, { source_path: missing, template_id: 'missing' }), /Assembly template slot ROUTE_FUNCTION_BODY must appear exactly once/);
});



test('Chief template controls outer dispatch signature through macro slots', t => {
  const root = setup(t);
  let project = loadProject(root);
  const source = join(root, 'macro-only.asc.tmpl');
  write(source, macroOnlyTemplate('macro-only'));
  configureAssemblyTemplate(project, { source_path: source, template_id: 'macro-only', now: '2026-09-27T00:00:00.000Z' });
  project = loadProject(root);
  const module = moduleFor(project);
  const output = renderVersion(project, { assembly_key: 'macro', implementations: [{ implementation_id: 1, module }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] });
  assert.match(output, /METEOR_IMPLEMENTATION\(1U, same_launch, "same-kernel@r1"\)/);
  assert.match(output, /METEOR_BUCKET\(1U, 1U, "case_a"\)/);
  assert.doesNotMatch(output, /status = same_launch\(call, shape, resources\);/);
});

test('two op or dtype targets keep independent assembly templates and reject foreign modules', t => {
  const root = setup(t);
  const config = readJson<any>(join(root, 'meteor.config.json'));
  const base = config.targets[0];
  config.targets = [base, { ...base, op_id: 'other-op', case_suite_ref: 'cases/other-op/int8/small/suite.json' }];
  writeJson(join(root, config.targets[1].case_suite_ref), smallSuite());
  writeJson(join(root, 'meteor.config.json'), config);

  let first = loadProject(root, { op_id: 'qmq-v1', dtype_id: 'int8' });
  let second = loadProject(root, { op_id: 'other-op', dtype_id: 'int8' });
  const firstModule = moduleFor(first);
  const secondModule = moduleFor(second);
  configure(first, 'first-template', 'first');
  configure(second, 'second-template', 'second');
  first = loadProject(root, { op_id: 'qmq-v1', dtype_id: 'int8' });
  second = loadProject(root, { op_id: 'other-op', dtype_id: 'int8' });
  assert.match(renderVersion(first, { assembly_key: 'a', implementations: [{ implementation_id: 1, module: firstModule }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] }), /first-template/);
  assert.match(renderVersion(second, { assembly_key: 'b', implementations: [{ implementation_id: 1, module: secondModule }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] }), /second-template/);
  assert.throws(() => renderVersion(first, { assembly_key: 'foreign', implementations: [{ implementation_id: 1, module: secondModule }], routes: [{ rule_id: 1, implementation_id: 1, case_ids: ['case_a'] }] }), /Assembly module target does not match/);
});

test('integration setup and routing use only recommended PASS cases', async t => {
  const root = setup(t);
  let project = loadProject(root);
  createResearch(project, { research_id: 'r1', chief_id: 'chief', agent_session_id: 'pending', goal: 'test routing' });
  bindResearchSession(project, 'r1', 'agent');
  const module = moduleFor(project, 'candidate', 'r1');
  const kernelPath = slash(relative(project.root, dirname(join(project.root, module.host_file))));
  const build = await buildKernel(project, { research_id: 'r1', experiment_id: 'e1', kernel_path: kernelPath, fixture: { fixture_id: 'assembly-route' } });
  const full = await testKernel(project, { build_ref: receiptRef(project, buildReceiptPath(project, build)), mode: 'full', fixture: { fixture_id: 'assembly-route' } });
  const fullRef = receiptRef(project, testReceiptPath(project, full));
  const submission: Submission = { target: targetRef(project), research_id: 'r1', agent_session_id: 'agent', execution_backend: 'mock', termination_reason: 'done',
    hypothesis: { hypothesis_id: 'h', revision: 'h1', statement: 'route recommended', scope: 'mock', mechanism: 'selection', intervention: 'candidate', controls: [], predictions: ['one route'], support_criteria: ['one route'], refutation_criteria: ['two routes'], confounders: [], measurement_plan: 'mock', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [], limitations: ['mock only'] },
    hypothesis_history: [], experiments: [{ experiment_id: 'e1', hypothesis_revision: 'h1', question: 'route?', intervention: 'candidate', controls: [], kernel_revisions: [build.kernel_ref], environment_ref: full.environment_ref, full_size_test_refs: [fullRef], profile_refs: [], analysis: 'mock', next_experiment: 'none' }],
    submitted_kernels: [{ ...build.kernel_ref, source_hash: build.source_hash, artifact_refs: [build.module_ref], supported_domain: 'both cases', verified_case_ids: ['case_a', 'case_b'], recommended_domain: 'only case_a', recommended_case_ids: ['case_a'], hardware_scope: 'mock', resource_constraints: [], unsupported_cases: [], case_suite_revision: full.case_suite_revision, environment_ref: full.environment_ref, measurement_protocol_ref: full.measurement_protocol_ref, full_size_test_ref: fullRef, test_status: 'COMPLETED', performance_data_ref: fullRef, data_hash: full.data_hash, measured_tradeoffs: 'mock', limitations: [] }],
    knowledge_updates: [], chief_report: { summary: 'done', findings: ['done'], unresolved: [], next_steps: ['none'] } };
  const prepared = prepareSubmission(project, submission);
  const committed = commitSubmission(project, prepared.prepared_submission_id, 'agent');
  let skipped = await integrateSubmission(project, committed.submission_id, 'no-template');
  assert.equal(skipped.status, 'SKIPPED');
  assert.match(skipped.reason!, /assembly template setup required/);
  configure(project, 'integration-template', 'integration');
  project = loadProject(root);
  const assembled = await integrateSubmission(project, committed.submission_id, 'with-template');
  assert.equal(assembled.status, 'ASSEMBLED');
  const spec = readJson<any>(assembled.version_spec_ref!);
  assert.deepEqual(spec.route_rules.map((rule: any) => rule.case_id), ['case_a']);
  assert.deepEqual(spec.version_spec.routes.map((rule: any) => rule.case_ids), [['case_a']]);
});
