import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../src/init.ts';
import { loadProject } from '../src/project.ts';
import type { KernelModule, Submission } from '../templates/project/tools/meteor/contracts.ts';
import { buildKernel, buildReceiptPath, computeSourceHash, experimentDir, receiptRef } from '../templates/project/tools/meteor/kernel-build.ts';
import { testKernel } from '../templates/project/tools/meteor/kernel-test.ts';
import { bindResearchSession, createResearch } from '../templates/project/tools/meteor/research.ts';
import { commitSubmission, prepareSubmission, SubmissionValidationError } from '../templates/project/tools/meteor/submit.ts';
import { storePaths } from '../templates/project/tools/meteor/store.ts';
import { writeJson } from '../templates/project/tools/meteor/util.ts';
import { spawnSync } from 'node:child_process';

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'meteor-submission-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initProject(root, { git: false, backend: 'mock' } as any);
  const project = loadProject(root);
  const researchId = 'research_contract';
  const sessionId = 'session_contract';
  createResearch(project, { research_id: researchId, agent_session_id: 'pending', chief_id: 'chief', goal: 'Validate submission contracts' });
  bindResearchSession(project, researchId, sessionId);

  const kernelPath = 'kernels/contract/r1';
  const module: KernelModule = {
    kernel_id: 'contract', revision: 'r1', operator_abi: project.suite.operator_abi,
    symbol_prefix: 'contract_', launcher: 'contract_launch',
    device_file: kernelPath + '/device.asc', host_file: kernelPath + '/host.asc',
    supported_case_ids: project.suite.cases.map(item => item.case_id), dependencies: [],
    hardware_scope: project.config.environment.hardware, resource_constraints: [],
  };
  writeJson(join(root, kernelPath, 'kernel.json'), module);
  writeFileSync(join(root, module.device_file), '// contract test kernel\n');
  writeFileSync(join(root, module.host_file), 'MeteorStatus contract_launch(const MeteorCall&, const MeteorShape&, const MeteorResources&) { return MeteorStatus::Success; }\n');
  const build = await buildKernel(project, { research_id: researchId, experiment_id: 'experiment_contract', kernel_path: kernelPath });
  const buildRef = receiptRef(project, buildReceiptPath(project, build));
  const receipt = await testKernel(project, { build_ref: buildRef, mode: 'full' });
  const receiptPath = join(experimentDir(project, researchId, receipt.experiment_id), 'full-tests', receipt.run_id + '.json');
  const receiptRefValue = receiptRef(project, receiptPath);
  const passCases = receipt.rows.filter(row => row.status === 'PASS').map(row => row.case_id);

  function submission(kernels = true): Submission {
    return {
      research_id: researchId, agent_session_id: sessionId, execution_backend: 'mock', termination_reason: 'contract test complete',
      hypothesis: {
        hypothesis_id: 'hyp_contract', revision: 'h1', statement: '中文假设可以安全入库',
        scope: 'mock contract suite', mechanism: '契约校验不由性能排名决定',
        intervention: '记录一次完整全尺寸测试', controls: ['固定输入'], predictions: ['提交链路保持一致'],
        support_criteria: ['字段完整'], refutation_criteria: ['字段缺失'], confounders: ['mock 不能证明真实硬件'],
        measurement_plan: 'full suite', verdict: 'INCONCLUSIVE', supporting_evidence: [], counterevidence: [],
        limitations: ['mock only'],
      },
      hypothesis_history: [],
      experiments: [{
        experiment_id: 'experiment_contract', hypothesis_revision: 'h1', question: '中文内容是否能通过 prepare 和入库?',
        intervention: '提交中文报告', controls: ['mock'], kernel_revisions: kernels ? [receipt.kernel_ref] : [],
        environment_ref: project.config.environment.environment_ref, full_size_test_refs: kernels ? [receiptRefValue] : [],
        profile_refs: [], analysis: '科学判断仍由 agent 基于证据分析，不能由 kernel 排名自动决定', next_experiment: 'real hardware',
      }],
      submitted_kernels: kernels ? [{
        ...receipt.kernel_ref, source_hash: receipt.source_hash, artifact_refs: [build.module_ref],
        supported_domain: 'measured mock suite', verified_case_ids: passCases, recommended_domain: 'measured mock cases',
        recommended_case_ids: passCases, hardware_scope: project.config.environment.hardware, resource_constraints: [],
        unsupported_cases: receipt.rows.filter(row => row.status === 'UNSUPPORTED').map(row => row.case_id),
        case_suite_revision: receipt.case_suite_revision, environment_ref: receipt.environment_ref,
        measurement_protocol_ref: receipt.measurement_protocol_ref, full_size_test_ref: receiptRefValue,
        test_status: 'COMPLETED', performance_data_ref: receiptRefValue, data_hash: receipt.data_hash,
        measured_tradeoffs: 'mock timing only', limitations: ['mock cannot prove hardware performance'],
      }] : [],
      knowledge_updates: [{
        claim_id: 'claim_utf8', kind: 'observation', statement: '中文知识可以通过 UTF-8 stdin 入库',
        scope: '提交契约', evidence_refs: kernels ? [receiptRefValue] : ['experiment_contract'], related_material_ids: [],
      }],
      chief_report: { summary: '中文报告摘要', findings: ['假设结论和 kernel 排名分离'], unresolved: ['真实硬件未验证'], next_steps: ['配置真实后端复测'] },
    };
  }

  return { project, build, buildRef, receiptRefValue, sessionId, submission };
}

function hasIssue(path: string, code: string) {
  return (error: unknown) => error instanceof SubmissionValidationError
    && error.issues.some(issue => issue.path === path && issue.code === code);
}

test('prepare rejects missing experiment hypothesis_revision before freezing', async t => {
  const env = await setup(t);
  const submission = env.submission(false) as any;
  delete submission.experiments[0].hypothesis_revision;
  assert.throws(() => prepareSubmission(env.project, submission), hasIssue('experiments.0.hypothesis_revision', 'REQUIRED'));
});

test('UTF-8 Chinese submission prepares, commits, and imports into knowledge store', async t => {
  const env = await setup(t);
  const submission = env.submission(false);
  const prepared = prepareSubmission(env.project, submission);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, env.sessionId);
  assert.equal(report.report.summary, '中文报告摘要');

  const sqlite = [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'print(db.execute("SELECT statement FROM knowledge_claims WHERE claim_id = ?", ("claim_utf8",)).fetchone()[0])',
  ].join('; ');
  const result = spawnSync('python', ['-c', sqlite, join(storePaths(env.project).knowledgeRoot, 'catalog.sqlite')], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '中文知识可以通过 UTF-8 stdin 入库');
});

test('commit report exposes authoritative tested receipt and module chain', async t => {
  const env = await setup(t);
  const submission = env.submission(true);
  const prepared = prepareSubmission(env.project, submission);
  const report = commitSubmission(env.project, prepared.prepared_submission_id, env.sessionId);
  const evidence = report.submitted_kernel_evidence[0];
  assert.equal(evidence.full_size_test_ref, env.receiptRefValue);
  assert.equal(evidence.build_ref, env.buildRef);
  assert.equal(evidence.module_ref, env.build.module_ref);
  assert.equal(evidence.module_path, join(env.project.root, env.build.module_ref));
  assert.equal(evidence.source_hash, submission.submitted_kernels[0].source_hash);
  assert.equal(evidence.artifact_hash, env.build.artifact_hash);
});
