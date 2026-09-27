// Full official Web composition smoke. No credentials or model requests required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashObject, writeJson } from '../dist/templates/project/tools/meteor/util.js';

const modules = resolve(process.argv[2] ?? process.env.METEOR_DSH_MODULE_ROOT ?? '');
const version = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
assert.equal(version, '0.1.7-alpha.2');
const scratch = mkdtempSync(join(tmpdir(), 'meteor-web-contract-'));
const project = join(scratch, 'project');
// Native filesystem discovery stops at the nearest Git root, which may be an
// ancestor of a Meteor project. The plugin must still advertise its two skills.
const git = spawnSync('git', ['init', '-b', 'main', scratch], { encoding: 'utf8', windowsHide: true });
assert.equal(git.status, 0, git.stderr);
mkdirSync(project);
process.env.DSH_HOME = join(scratch, 'dsh-home');
process.env.DSH_TELEMETRY_DISABLED = '1';
process.chdir(project);
const module = async path => import(pathToFileURL(join(modules, '@deepseek-ai', path, 'lib/index.js')).href);
const { runProfile } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh/lib/profile-boot.js')).href);
const { createLaunchEnvironmentSnapshot } = await module('dsh-launch-environment');
const patch = join(scratch, 'web.patch.yml');
writeFileSync(patch, JSON.stringify([
  { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
  { insert: [{ id: 'meteor', name: new URL('../dist/src/index.js', import.meta.url).href }] },
]));
const originalLog = console.log;
console.log = (...args) => originalLog(...args.map(value => typeof value === 'string' ? value.replace(/([?&]token=)[^\s]+/g, '$1[redacted]') : value));
const { ctx, shutdown } = await runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
  profile: 'web', patchFiles: [patch], args: ['--no-open'],
});
let handle;
let releaseStep;
try {
  let childResolve;
  let childStartupPrompt;
  const childReady = new Promise(resolveChild => { childResolve = resolveChild; });
  const stepGate = new Promise(resolveGate => { releaseStep = resolveGate; });
  const chiefMessages = [];
  // Install the gate before creating either Agent, including any chief wakeup.
  ctx.on('agent/pre-step', async payload => {
    if (payload.agent.session.header.origin === 'subagent') {
      childStartupPrompt ??= (payload.messages ?? []).flatMap(message => message.content ?? [])
        .find(block => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('METEOR_RESEARCH '))?.text;
      childResolve(payload.agent);
      await stepGate;
    } else chiefMessages.push(...payload.messages ?? []);
    return { kind: 'reject' };
  });
  const presets = ctx.get('agentPresets');
  assert(presets, 'Native preset registry must be mounted');
  const preset = await presets.resolve('standard');
  console.log('WEB_PRESET', JSON.stringify({ id: preset.id }));
  handle = await ctx.get('agents').create({
    sessionId: 'meteor-contract-chief', meta: { cwd: project, agentPreset: preset.id },
    setup: agentCtx => presets.mount(agentCtx, preset.id).then(() => undefined),
  });
  const chief = handle.agent;
  const tools = ctx.get('tools');
  const signal = new AbortController().signal;
  const chiefSkills = chief.ctx.get('skills');
  const skillOptions = { scope: chief, cwd: project, signal };
  const bundledSkill = await chiefSkills.get('meteor-kernel-test', skillOptions);
  assert.equal(bundledSkill?.source, 'bundled', 'An uninitialized project must expose the plugin skill');
  assert(bundledSkill.content.includes('meteor_init'), 'The entry skill must explain project initialization');
  const call = async (name, args, agent = chief) => {
    const result = await tools.execute({ name, arguments: args, agent, signal, callId: `contract-${name}` });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value ?? JSON.parse(result.content.filter(b => b.type === 'text').map(b => b.text).join(''));
  };
  const parentSkills = join(scratch, '.dsh/skills/meteor-kernel-test');
  mkdirSync(parentSkills, { recursive: true });
  writeFileSync(join(parentSkills, 'SKILL.md'), '---\nname: meteor-kernel-test\ndescription: Parent project skill\n---\nPARENT_SKILL_ONLY\n');
  const initialized = await call('meteor_init', {});
  assert.equal(initialized.state, 'setup_required');
  assert(initialized.workspace_id, 'Initialization must identify the single-hardware workspace');
  assert(tools.schemas(chief).some(tool => tool.name === 'meteor_hardware_probe'));
  // This isolated project is an explicit mock protocol fixture. This smoke
  // performs no build, measurements, device probe, or hardware hypothesis test.
  const configPath = join(project, 'meteor.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.schema_version, 2);
  assert(config.targets?.length, 'The workspace must register operator/dtype targets');
  const target = config.targets[0];
  const targetSelection = { op_id: target.op_id, dtype_id: target.dtype_id };
  assert.deepEqual(initialized.targets, config.targets);
  config.execution = { backend: 'mock', profile_ref: 'mock-qmq-v1' };
  config.environment = { environment_ref: 'mock-ascend-qmq-v1', hardware: 'simulated-ascend',
    toolchain: 'mock-no-compiler', measurement_protocol_ref: 'mock-median-5-v1', simulated: true };
  // Synthetic shared preparation for this mock-only protocol test. Real model
  // publication remains restricted to Chief-authored SSH device evidence.
  const modelValue = { chief_id: chief.id, evidence: [], model: {
    schema_version: 1, model_id: 'web-contract', hardware_id: 'mock-web-device',
    environment_ref: config.environment.environment_ref,
    sources: [
      { id: 'doc', kind: 'documentation', ref: 'mock-doc', version: 'mock', description: 'Synthetic protocol documentation' },
      { id: 'experiment', kind: 'experiment', ref: 'mock-experiment', description: 'Synthetic fixture; no device experiment' },
    ],
    resources: [{ id: 'protocol', description: 'Fictional protocol resource', evidence_refs: ['doc'] }],
    primitives: [{ id: 'protocol', description: 'Fictional protocol primitive', resources: ['protocol'], graph_required: true, evidence_refs: ['doc'] }],
    constraints: [], limitations: ['Mock fixture only; no hardware capability claims'],
  } };
  const modelHash = hashObject(modelValue);
  const modelRef = `hardware/execution-models/web-contract/${modelHash}.json`;
  writeJson(join(project, modelRef), { value: modelValue, content_hash: modelHash });
  writeJson(join(project, config.workspace.hardware_ref), { state: 'bound', hardware_id: 'mock-web-device' });
  config.design = { ...config.design, hardware_model_ref: modelRef };
  writeFileSync(configPath, JSON.stringify(config));
  const chiefSkill = await chiefSkills.get('meteor-kernel-test', skillOptions);
  assert.equal(chiefSkill?.path, join(project, '.dsh/skills/meteor-kernel-test/SKILL.md'));
  assert(chiefSkill.content.includes('initial_context'), 'Chief must discover the nested project skill after initialization');
  assert(!chiefSkill.content.includes('PARENT_SKILL_ONLY'), 'The current Meteor project must beat the parent Git root');
  assert(tools.schemas(chief).some(tool => tool.name === 'meteor_start'), 'Chief must receive the native start tool schema');
  const initialContext = { mode: 'specified', knowledge_refs: [target.contract_ref] };
  const hypothesis = { statement: 'Chief-assigned context remains available in the original research session' };
  const started = await call('meteor_start', {
    research_id: 'web-contract', goal: 'Check native context and cancellation without a model',
    target: targetSelection, initial_context: initialContext, hypothesis,
  });
  const startupWait = new AbortController();
  let child;
  try {
    child = await Promise.race([childReady, ctx.get('jobs').wait(started.job_id, 15000, chief.id, startupWait.signal).then(job => {
      throw new Error(`Child never reached native pre-step: ${JSON.stringify(job)} ${JSON.stringify(ctx.get('jobs').read(started.job_id, chief.id))}`);
    })]);
  } finally { startupWait.abort(); }
  // start() may publish before its first step; the host must bind the same native child.
  const status = await call('meteor_status', { research_id: 'web-contract', target: targetSelection });
  assert.equal(status.agent_session_id, child.id);
  assert.deepEqual(status.target, { workspace_id: config.workspace.workspace_id, ...targetSelection });
  assert.deepEqual(started.target, status.target);
  assert.deepEqual(status.initial_context, initialContext);
  assert.deepEqual(status.assigned_hypothesis, hypothesis);
  assert(childStartupPrompt, 'Child startup package must include the METEOR_RESEARCH contract block');
  const startup = JSON.parse(childStartupPrompt.split('\n').slice(1).join('\n'));
  const researchDirectory = join(project, '.meteor/mock/research', target.op_id, target.dtype_id, 'web-contract');
  assert.equal(readFileSync(join(researchDirectory, 'snapshot', modelRef), 'utf8'),
    readFileSync(join(project, modelRef), 'utf8'), 'Child must reuse the exact shared preparation snapshot');
  assert(!tools.schemas(child).some(tool => ['meteor_hardware_probe', 'meteor_hardware_experiment', 'meteor_hardware_model'].includes(tool.name)),
    'Child must not repeat Chief hardware preparation');
  assert.equal(startup.research_directory, researchDirectory);
  assert.deepEqual(startup.target, status.target);
  const seed = JSON.parse(readFileSync(startup.seed_ref, 'utf8'));
  assert.equal(seed.mode, 'specified');
  assert.equal(seed.selected.length, 1);
  assert.equal(startup.contracts_ref, join(researchDirectory, 'kernel-contracts.md'));
  assert(readFileSync(startup.contracts_ref, 'utf8').includes('KernelModule JSON'), 'Child contracts_ref must point to generated readable KernelModule contract');
  assert(!startup.contracts_ref.includes('snapshot'), 'Child must not depend on optional bundled snapshot contract files');
  assert.equal(startup.formula_ref, join(researchDirectory, 'snapshot', target.contract_ref));
  assert.equal(startup.operator_contract_ref, startup.formula_ref);
  assert.equal(startup.kernel_template_ref, join(researchDirectory, 'snapshot', target.template_ref, 'kernel_test.asc.tmpl'));
  for (const key of ['formula_ref', 'kernel_template_ref', 'operator_adapter_ref', 'oracle_ref', 'design_guide_ref', 'activity_primitives_ref']) {
    assert(existsSync(startup[key]), `${key} must resolve inside the pinned research snapshot`);
    assert(relative(join(researchDirectory, 'snapshot'), startup[key]).split(/[\\/]/)[0] !== '..', `${key} must use the research snapshot`);
  }
  const material = await call('meteor_read_file', { path: seed.selected[0].source_refs[0] }, child);
  assert.equal(material.text, readFileSync(join(project, target.contract_ref), 'utf8'));
  const designTool = tools.schemas(child).find(tool => tool.name === 'meteor_design');
  assert(designTool, 'The same child must receive the design tool');
  const draft = join(researchDirectory, 'drafts/web-protocol/r1');
  const sourceRef = path => relative(project, path).replaceAll('\\', '/');
  await call('meteor_write_file', { path: join(draft, 'kernel.json'), content: JSON.stringify({
    kernel_id: 'web-protocol', revision: 'r1', target: startup.target, operator_abi: startup.case_suite.operator_abi,
    symbol_prefix: 'web_protocol_', launcher: 'web_protocol_launch',
    device_file: sourceRef(join(draft, 'device.asc')), host_file: sourceRef(join(draft, 'host.asc')),
    supported_case_ids: startup.case_suite.cases.map(item => item.case_id), dependencies: [],
    hardware_scope: 'Explicit mock protocol fixture only', resource_constraints: ['No kernel implementation or hardware measurement'],
  }) }, child);
  for (const file of ['device.asc', 'host.asc']) await call('meteor_write_file', {
    path: join(draft, file), content: '// Protocol-only design setup; implementation and hardware measurements are absent.\n',
  }, child);
  const design = await call('meteor_design', { action: 'open', experiment_id: 'protocol-open', kernel_path: sourceRef(draft) }, child);
  assert.equal(design.status, 'OPEN');
  assert.equal(resolve(project, design.formula_ref), startup.formula_ref);
  assert.equal(resolve(project, design.guide_ref), startup.design_guide_ref);
  assert(existsSync(resolve(project, design.design_ref)), 'Native design open must produce a target-scoped artifact');
  assert.equal((await call('meteor_status', { research_id: 'web-contract', target: targetSelection })).agent_session_id, child.id);
  const skill = await child.ctx.get('skills').get('meteor-kernel-test', { scope: child, cwd: project, signal });
  assert(skill?.path?.includes('snapshot'), 'Child must load its frozen runtime skill');
  writeFileSync(chiefSkill.path, readFileSync(chiefSkill.path, 'utf8') + '\nFUTURE_RESEARCH_INSTRUCTION\n');
  assert((await chiefSkills.get('meteor-kernel-test', skillOptions)).content.includes('FUTURE_RESEARCH_INSTRUCTION'));
  assert(!(await child.ctx.get('skills').get('meteor-kernel-test', { scope: child, cwd: project, signal })).content.includes('FUTURE_RESEARCH_INSTRUCTION'), 'Prompt updates must preserve the active research snapshot');
  assert(presets.serviceFor(child, 'compaction'), 'Native child compaction must remain available');
  assert(tools.get('structured_output', child), 'Native structured final output must be available');
  const denied = await tools.execute({ name: 'subagent', arguments: { description: 'Blocked recursive delegation', prompt: 'Must never run' }, agent: child, signal, callId: 'contract-denied-delegation' });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /original agent|UNKNOWN_TOOL/);
  assert(!tools.get('bash', child), 'Research cannot bypass evidence tools with shell');
  assert(!tools.get('pwsh', child), 'Research cannot bypass evidence tools with PowerShell');
  await call('meteor_control', { research_id: 'web-contract', action: 'cancel' });
  releaseStep();
  const job = await ctx.get('jobs').wait(started.job_id, 15000, chief.id);
  assert.equal(job.status, 'killed');
  const result = ctx.get('jobs').read(started.job_id, chief.id);
  await new Promise(resolveTick => setImmediate(resolveTick));
  await chief.whenIdle();
  // Native completion notices may consume the result first and deliver it to chief.
  const delivered = result.result ?? JSON.stringify(chiefMessages);
  assert.match(delivered, /hypothesis_verdict/);
  assert(delivered.includes(child.id));
  console.log(JSON.stringify({ version, verified: ['web-preset', 'chief-skill-discovery', 'init-catalog-refresh', 'single-hardware-workspace', 'selected-target', 'nested-project-overrides', 'chief-assigned-context', 'generated-kernel-contracts', 'snapshot-design-references', 'same-session-design-open', 'scoped-skills', 'frozen-prompt-snapshot', 'native-compaction', 'same-session-subagent', 'structured-output', 'job-cancel', 'job-result'], execution_backend: 'mock', model_requests: 0, hardware_measurements: 0 }));
} finally {
  releaseStep?.();
  await handle?.dispose();
  await shutdown.shutdown(0);
}
