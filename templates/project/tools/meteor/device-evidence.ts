const DEVICE_TASK_TYPES = new Set(['AI_CORE', 'AICORE', 'AI_VECTOR_CORE', 'AI_VECTOR', 'AIV', 'MIX_AIC', 'MIX_AICORE', 'MIX_AIV']);

/** Validate a parsed task witness, not merely the presence of a profiler file. */
export function hasDeviceExecution(proof: any, deviceId?: number, kernelPrefix?: string): boolean {
  if (proof?.status !== 'CONFIRMED' || !Array.isArray(proof.matched_tasks) || proof.matched_tasks.length === 0) return false;
  return proof.matched_tasks.every((task: any) => {
    if (!task || typeof task !== 'object' || !Number.isSafeInteger(task.device_id) || task.device_id < 0) return false;
    const name = task.op_name ?? task.kernel_name;
    const type = String(task.task_type ?? '').trim().toUpperCase().replaceAll(' ', '_');
    return DEVICE_TASK_TYPES.has(type) && typeof name === 'string' && name.length > 0
      && (deviceId === undefined || task.device_id === deviceId)
      && (kernelPrefix === undefined || name.toLowerCase().includes(kernelPrefix.toLowerCase()));
  });
}
