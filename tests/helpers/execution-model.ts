import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HardwareExecutionModel } from '../../templates/project/tools/meteor/hardware-model.ts';
import { hashObject, readJson, writeJson } from '../../templates/project/tools/meteor/util.ts';

/** Explicit local test fixture. Never shipped as a hardware capability default. */
export function writeExecutionModelFixture(root: string, environmentRef: string, changes: Partial<HardwareExecutionModel> = {}) {
  const bindingPath = join(root, 'hardware/target.json');
  const existing = existsSync(bindingPath) ? readJson(bindingPath) : {};
  const hardwareId = existing.state === 'bound' ? existing.hardware_id : 'hw-unit-fixture';
  writeJson(bindingPath, { ...existing, state: 'bound', hardware_id: hardwareId });
  const model: HardwareExecutionModel = { schema_version: 1, model_id: 'unit-model-only', hardware_id: hardwareId, environment_ref: environmentRef,
    sources: [{ id: 'doc', kind: 'documentation', ref: 'unit-document', version: 'test-only', description: 'Synthetic unit contract' },
      { id: 'experiment', kind: 'experiment', ref: 'unit-experiment', description: 'Synthetic test observation, not device evidence' }],
    resources: [{ id: 'UnitLane', description: 'Fictional test resource', evidence_refs: ['doc'] }],
    primitives: [{ id: 'unit_add', description: 'Fictional test compute primitive', resources: ['UnitLane'], graph_required: true, evidence_refs: ['doc', 'experiment'] }],
    constraints: [], limitations: ['Synthetic test model; no hardware claims'], ...changes };
  const localPath = join(root, '.meteor.local.json');
  const reportHash = existsSync(localPath) ? readJson(localPath).environment?.hardware_report_hash : undefined;
  const value = { model, evidence: [], chief_id: 'unit-fixture', ...(reportHash ? { hardware_report_hash: reportHash } : {}) }, modelHash = hashObject(value);
  const modelRef = `hardware/execution-models/${model.model_id}/${modelHash}.json`;
  writeJson(join(root, modelRef), { value, content_hash: modelHash });
  const configPath = join(root, 'meteor.config.json');
  if (existsSync(configPath)) {
    const config = readJson(configPath); config.design = { ...config.design, hardware_model_ref: modelRef }; writeJson(configPath, config);
  }
  return { model, modelRef, modelHash };
}
