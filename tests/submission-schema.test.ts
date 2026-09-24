import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionSchema } from '../src/submission-schema.ts';

type JsonSchema = Record<string, any>;

function validate(schema: JsonSchema, value: any, path = '$', issues: string[] = []): string[] {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path} must be object`);
      return issues;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties || !(key in schema.properties)) issues.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) validate(childSchema as JsonSchema, value[key], `${path}.${key}`, issues);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path} must be array`);
      return issues;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} must have at least ${schema.minItems} items`);
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, issues));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      issues.push(`${path} must be string`);
      return issues;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} must not be empty`);
  }
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${path} must be one of ${schema.enum.join(', ')}`);
  return issues;
}

function validSubmission() {
  const hypothesis = {
    hypothesis_id: 'hyp_1',
    revision: 'h1',
    statement: 'Tile shape changes memory behavior',
    scope: 'fixed suite',
    mechanism: 'better reuse',
    intervention: 'change tile',
    controls: ['same inputs'],
    predictions: ['latency ratio changes'],
    support_criteria: ['measured evidence supports prediction'],
    refutation_criteria: ['measured evidence refutes prediction'],
    confounders: ['timing noise'],
    measurement_plan: 'run full suite',
    verdict: 'INCONCLUSIVE',
    supporting_evidence: [],
    counterevidence: [],
    limitations: [''],
  };
  return {
    termination_reason: 'analysis complete',
    hypothesis,
    hypothesis_history: [{ hypothesis, reason: 'initial' }],
    experiments: [{
      experiment_id: 'exp_1',
      hypothesis_revision: 'h1',
      question: 'Does it improve reuse?',
      intervention: 'change tile',
      controls: ['same inputs'],
      kernel_revisions: [{ kernel_id: 'k1', revision: 'r1' }],
      environment_ref: 'mock-env',
      full_size_test_refs: ['reports/meteor/mock/research/r/experiments/e/full-tests/run.json'],
      profile_refs: [],
      analysis: 'Rank does not decide hypothesis truth',
      next_experiment: 'real hardware',
    }],
    submitted_kernels: [{
      kernel_id: 'k1',
      revision: 'r1',
      source_hash: 'source-hash',
      artifact_refs: ['kernels/k1/r1/kernel.json'],
      supported_domain: 'measured cases',
      verified_case_ids: ['case_1'],
      recommended_domain: 'measured cases',
      recommended_case_ids: ['case_1'],
      hardware_scope: 'mock',
      resource_constraints: [],
      unsupported_cases: [],
      case_suite_revision: 'suite-v1',
      environment_ref: 'mock-env',
      measurement_protocol_ref: 'median-v1',
      full_size_test_ref: 'reports/meteor/mock/research/r/experiments/e/full-tests/run.json',
      test_status: 'COMPLETED',
      performance_data_ref: 'reports/meteor/mock/research/r/experiments/e/full-tests/run.json',
      data_hash: 'data-hash',
      measured_tradeoffs: 'mock only',
      limitations: [''],
    }],
    knowledge_updates: [{
      claim_id: 'claim_1',
      kind: 'observation',
      statement: 'Shape scaling and absolute latency are separate claims',
      scope: 'fixed suite',
      evidence_refs: ['reports/meteor/mock/research/r/experiments/e/full-tests/run.json'],
      related_material_ids: [],
    }],
    chief_report: {
      summary: 'Research finished',
      findings: ['hypothesis judgment is separate from kernel rank'],
      unresolved: [],
      next_steps: ['try real hardware'],
    },
  };
}

test('submissionSchema accepts tool-bound root fields as optional', () => {
  assert.deepEqual(validate(submissionSchema, validSubmission()), []);
  const withBoundFields = {
    ...validSubmission(),
    research_id: 'research_1',
    agent_session_id: 'session_1',
    execution_backend: 'mock',
  };
  assert.deepEqual(validate(submissionSchema, withBoundFields), []);
});

test('submissionSchema requires experiment hypothesis_revision before prepare', () => {
  const submission = validSubmission() as any;
  delete submission.experiments[0].hypothesis_revision;
  assert.ok(validate(submissionSchema, submission).includes('$.experiments[0].hypothesis_revision is required'));
});

test('submissionSchema rejects unknown fields and invalid enums', () => {
  const submission = { ...validSubmission(), execution_backend: 'cuda', extra: true };
  const issues = validate(submissionSchema, submission);
  assert.ok(issues.includes('$.extra is not allowed'));
  assert.ok(issues.includes('$.execution_backend must be one of mock, ssh'));
});

test('submissionSchema follows submit validator string and array shape', () => {
  const submission = validSubmission();
  submission.chief_report.summary = '';
  submission.knowledge_updates[0].evidence_refs = [];
  const issues = validate(submissionSchema, submission);
  assert.ok(issues.includes('$.chief_report.summary must not be empty'));
  assert.ok(issues.includes('$.knowledge_updates[0].evidence_refs must have at least 1 items'));
  submission.chief_report.summary = 'ok';
  submission.knowledge_updates[0].evidence_refs = ['evidence.json'];
  submission.submitted_kernels[0].limitations = [''];
  assert.deepEqual(validate(submissionSchema, submission), []);
});
