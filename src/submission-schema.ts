const nonEmptyString = { type: 'string', minLength: 1 };
const stringValue = { type: 'string' };
const stringList = { type: 'array', items: stringValue };
const nonEmptyStringList = { type: 'array', minItems: 1, items: stringValue };
const measuredEvidenceRefs = {
  ...stringList,
  description: 'Include exact receipt paths returned as test_ref, performance_data_ref or profile_ref, or an exact experiment_id from experiments with its receipt references populated. Both probe and full test receipts can support a hypothesis verdict. Paths embedded in narrative sentences are not resolved; put explanations in experiments[].analysis or chief_report. Build and design-comparison artifacts do not replace measurements.',
};
const kernelRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kernel_id', 'revision'],
  properties: {
    kernel_id: nonEmptyString,
    revision: nonEmptyString,
  },
};

const hypothesisSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'hypothesis_id', 'revision', 'statement', 'scope', 'mechanism',
    'intervention', 'controls', 'predictions', 'support_criteria',
    'refutation_criteria', 'confounders', 'measurement_plan', 'verdict',
    'supporting_evidence', 'counterevidence', 'limitations',
  ],
  properties: {
    hypothesis_id: nonEmptyString,
    revision: nonEmptyString,
    statement: nonEmptyString,
    scope: nonEmptyString,
    mechanism: nonEmptyString,
    intervention: nonEmptyString,
    controls: stringList,
    predictions: nonEmptyStringList,
    support_criteria: nonEmptyStringList,
    refutation_criteria: nonEmptyStringList,
    confounders: stringList,
    measurement_plan: nonEmptyString,
    verdict: { type: 'string', enum: ['SUPPORTED', 'REFUTED', 'INCONCLUSIVE'] },
    supporting_evidence: measuredEvidenceRefs,
    counterevidence: measuredEvidenceRefs,
    limitations: stringList,
    simulated_verdict: { type: 'string', enum: ['SUPPORTED', 'REFUTED', 'INCONCLUSIVE'] },
  },
};

const experimentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'experiment_id', 'hypothesis_revision', 'question', 'intervention',
    'controls', 'kernel_revisions', 'environment_ref', 'full_size_test_refs',
    'profile_refs', 'analysis', 'next_experiment',
  ],
  properties: {
    experiment_id: nonEmptyString,
    hypothesis_revision: nonEmptyString,
    question: nonEmptyString,
    intervention: nonEmptyString,
    controls: stringList,
    kernel_revisions: { type: 'array', items: kernelRefSchema },
    environment_ref: nonEmptyString,
    full_size_test_refs: { ...stringList, description: 'Exact test receipt paths for this experiment. Despite this legacy field name, probe receipts are also accepted here for hypothesis evidence. Formal submitted kernels separately require mode:full.' },
    profile_refs: { ...stringList, description: 'Exact profile receipt paths, or [] when no independent profile was run. A probe test remains test evidence and does not need a profile to make its reference valid.' },
    analysis: nonEmptyString,
    next_experiment: nonEmptyString,
  },
};

const kernelSubmissionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kernel_id', 'revision', 'source_hash', 'artifact_refs', 'supported_domain',
    'verified_case_ids', 'recommended_domain', 'recommended_case_ids',
    'hardware_scope', 'resource_constraints', 'unsupported_cases',
    'case_suite_revision', 'environment_ref', 'measurement_protocol_ref',
    'full_size_test_ref', 'test_status', 'performance_data_ref', 'data_hash',
    'measured_tradeoffs', 'limitations',
  ],
  properties: {
    kernel_id: nonEmptyString,
    revision: nonEmptyString,
    source_hash: nonEmptyString,
    artifact_refs: { ...nonEmptyStringList, description: 'Include the measured kernel module manifest (kernel.json) returned by the build, in addition to any other artifact references.' },
    supported_domain: nonEmptyString,
    verified_case_ids: nonEmptyStringList,
    recommended_domain: { ...nonEmptyString, description: 'Describe the same applicability scope explicitly enumerated in recommended_case_ids; prose does not extend that set.' },
    recommended_case_ids: {
      ...nonEmptyStringList,
      description: 'The exact allowlist for automatic integration: only these verified PASS cases are eligible. If all verified cases are recommended, enumerate all of them; do not substitute the smaller profile or hypothesis comparison sample. recommended_domain prose cannot add omitted cases. This is applicability, not a claim of speedup or a supported hypothesis. A correct baseline may be submitted with explicit performance limitations.',
    },
    hardware_scope: nonEmptyString,
    resource_constraints: stringList,
    unsupported_cases: stringList,
    case_suite_revision: nonEmptyString,
    environment_ref: nonEmptyString,
    measurement_protocol_ref: nonEmptyString,
    full_size_test_ref: nonEmptyString,
    test_status: { type: 'string', enum: ['COMPLETED'] },
    performance_data_ref: nonEmptyString,
    data_hash: nonEmptyString,
    measured_tradeoffs: nonEmptyString,
    limitations: stringList,
  },
};

const knowledgeUpdateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['claim_id', 'kind', 'statement', 'scope', 'evidence_refs', 'related_material_ids'],
  properties: {
    claim_id: nonEmptyString,
    kind: { type: 'string', enum: ['observation', 'mechanism', 'hypothesis', 'counterexample'] },
    category: { type: 'string', enum: ['research', 'prediction_rule', 'ir_technique'], description: 'Research findings, reusable HW prediction rules, or IR authoring techniques. Defaults to research.' },
    applicability: { type: 'string', enum: ['target', 'hardware'], description: 'Legacy scope field: hardware maps to hardware, target or omission maps to dtype. Prefer scope_level; declarations do not independently prove scope-wide validity.' },
    scope_level: { type: 'string', enum: ['hardware', 'op', 'dtype', 'shape'], description: 'Declared knowledge scope in this HW workspace. Legacy hardware applicability maps to hardware; otherwise the default is dtype. A scope declaration is not independent proof of every point in that scope.' },
    shape_range: {
      type: 'object', additionalProperties: false, required: ['shape_id', 'dimensions'],
      description: 'Required only for shape scope. Stable range ID and explicit inclusive dimension bounds; never infer whole-range validation from one measured case.',
      properties: {
        shape_id: nonEmptyString,
        dimensions: {
          type: 'object', minProperties: 1,
          additionalProperties: { type: 'object', additionalProperties: false, required: ['min', 'max'],
            properties: { min: { type: 'integer', minimum: 1 }, max: { type: 'integer', minimum: 1 } } },
        },
      },
    },
    statement: nonEmptyString,
    scope: nonEmptyString,
    evidence_refs: nonEmptyStringList,
    related_material_ids: stringList,
  },
};

const chiefReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'unresolved', 'next_steps'],
  properties: {
    summary: nonEmptyString,
    findings: stringList,
    unresolved: stringList,
    next_steps: nonEmptyStringList,
  },
};

export const submissionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://meteor.local/schemas/submission.schema.json',
  title: 'Meteor Submission',
  type: 'object',
  additionalProperties: false,
  required: [
    'termination_reason', 'hypothesis', 'hypothesis_history', 'experiments',
    'submitted_kernels', 'knowledge_updates', 'chief_report',
  ],
  properties: {
    research_id: nonEmptyString,
    agent_session_id: nonEmptyString,
    execution_backend: { type: 'string', enum: ['mock', 'ssh'] },
    termination_reason: { ...nonEmptyString, description: 'Why this research can end now: criteria and requested deliverables met, actual budget exhausted, investigated external blocker, or cancellation. An inconclusive verdict or a repairable source error alone is not a stopping condition while feasible work and budget remain.' },
    hypothesis: hypothesisSchema,
    hypothesis_history: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hypothesis', 'reason'],
        properties: {
          hypothesis: hypothesisSchema,
          reason: nonEmptyString,
        },
      },
    },
    experiments: { type: 'array', minItems: 1, items: experimentSchema },
    submitted_kernels: { type: 'array', items: kernelSubmissionSchema },
    knowledge_updates: { type: 'array', items: knowledgeUpdateSchema },
    chief_report: chiefReportSchema,
  },
};
