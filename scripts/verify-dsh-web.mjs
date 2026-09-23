// Full official Web composition smoke. No credentials or model requests required.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const presets = ctx.get('agentPresets');
  assert(presets, 'Native preset registry must be mounted');
  const preset = await presets.resolve('standard');
  console.log('WEB_PRESET', JSON.stringify(preset));
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
  await call('meteor_init', {});
  const chiefSkill = await chiefSkills.get('meteor-kernel-test', skillOptions);
  assert.equal(chiefSkill?.path, join(project, '.dsh/skills/meteor-kernel-test/SKILL.md'));
  assert(chiefSkill.content.includes('initial_context'), 'Chief must discover the nested project skill after initialization');
  assert(!chiefSkill.content.includes('PARENT_SKILL_ONLY'), 'The current Meteor project must beat the parent Git root');
  assert(tools.schemas(chief).some(tool => tool.name === 'meteor_start'), 'Chief must receive the native start tool schema');
  let childResolve;
  const childReady = new Promise(resolveChild => { childResolve = resolveChild; });
  const stepGate = new Promise(resolveGate => { releaseStep = resolveGate; });
  const chiefMessages = [];
  ctx.on('agent/pre-step', async payload => {
    if (payload.agent.session.header.origin === 'subagent') {
      childResolve(payload.agent);
      await stepGate;
    } else chiefMessages.push(...payload.messages ?? []);
    // Reject all steps so this contract test cannot call an LLM, including chief wakeups.
    return { kind: 'reject' };
  });
  const initialContext = { mode: 'specified', knowledge_refs: ['asc/operator.json'] };
  const hypothesis = { statement: 'Chief-assigned context remains available in the original research session' };
  const started = await call('meteor_start', {
    research_id: 'web-contract', goal: 'Check native context and cancellation without a model',
    initial_context: initialContext, hypothesis,
  });
  const startupWait = new AbortController();
  let child;
  try {
    child = await Promise.race([childReady, ctx.get('jobs').wait(started.job_id, 15000, chief.id, startupWait.signal).then(job => {
      throw new Error(`Child never reached native pre-step: ${JSON.stringify(job)} ${JSON.stringify(ctx.get('jobs').read(started.job_id, chief.id))}`);
    })]);
  } finally { startupWait.abort(); }
  // start() may publish before its first step; the host must bind the same native child.
  const status = await call('meteor_status', { research_id: 'web-contract' });
  assert.equal(status.agent_session_id, child.id);
  assert.deepEqual(status.initial_context, initialContext);
  assert.deepEqual(status.assigned_hypothesis, hypothesis);
  const seed = JSON.parse(readFileSync(join(project, 'reports/meteor/mock/research/web-contract/seed.json'), 'utf8'));
  assert.equal(seed.mode, 'specified');
  assert.equal(seed.selected.length, 1);
  const material = await call('meteor_read_file', { path: seed.selected[0].source_refs[0] }, child);
  assert.equal(material.text, readFileSync(join(project, 'asc/operator.json'), 'utf8'));
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
  console.log(JSON.stringify({ version, verified: ['web-preset', 'chief-skill-discovery', 'init-catalog-refresh', 'nested-project-overrides', 'chief-assigned-context', 'scoped-skills', 'frozen-prompt-snapshot', 'native-compaction', 'same-session-subagent', 'structured-output', 'job-cancel', 'job-result'], model_requests: 0 }));
} finally {
  releaseStep?.();
  await handle?.dispose();
  await shutdown.shutdown(0);
}
