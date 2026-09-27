import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDeviceExecution } from '../templates/project/tools/meteor/device-evidence.ts';
import { hardwareReady } from '../templates/project/tools/meteor/hardware.ts';

test('device witness rejects runtime-only, wrong-device, wrong-kernel and malformed evidence', () => {
  const task = { device_id: 0, op_name: 'candidate_add', task_type: 'AI_CORE' };
  const proof = { status: 'CONFIRMED', matched_tasks: [task] };
  assert.equal(hasDeviceExecution(proof, 0, 'candidate_'), true);
  for (const change of [{ task_type: 'ACL_RUNTIME' }, { task_type: 'AI_CPU' }, { task_type: 'DMA' },
    { device_id: 1 }, { device_id: null }, { op_name: 'another_kernel' }]) {
    assert.equal(hasDeviceExecution({ ...proof, matched_tasks: [{ ...task, ...change }] }, 0, 'candidate_'), false);
  }
  assert.equal(hasDeviceExecution({ ...proof, matched_tasks: 'not an array' }), false);
  assert.equal(hasDeviceExecution({ ...proof, matched_tasks: [] }), false);
  assert.equal(hasDeviceExecution({ ...proof, status: 'SIMULATED' }), false);
});

test('hardware readiness requires an actual device computation witness', () => {
  const result = { status: 'COMPLETED', backend: 'ssh', simulated: false, readiness: 'READY',
    selected_device: { device_id: 0, soc_version: 'unit-fixture', npu_arch: 'dav-2201' },
    validation: { compile: true, launch: true, correctness: true,
      device_execution: { status: 'CONFIRMED', matched_tasks: [{ device_id: 0, kernel_name: 'probe', task_type: 'ACL_RUNTIME' }] } } };
  assert.equal(hardwareReady(result), false);
  result.validation.device_execution.matched_tasks[0].task_type = 'AI_VECTOR_CORE';
  assert.equal(hardwareReady(result), true);
});
