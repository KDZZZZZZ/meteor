import type { KnowledgeScope, KnowledgeScopeLevel, KnowledgeShapeRange, TargetRef } from './contracts.ts';
import { safeId } from './util.ts';

export interface NormalizedKnowledgeScope {
  scope_level: KnowledgeScopeLevel;
  shape_range?: KnowledgeShapeRange;
}

export function normalizeKnowledgeScope(value: KnowledgeScope & { applicability?: 'target' | 'hardware' }): NormalizedKnowledgeScope {
  const level = value.scope_level ?? (value.applicability === 'hardware' ? 'hardware' : 'dtype');
  if (!['hardware', 'op', 'dtype', 'shape'].includes(level)) throw new Error('scope_level must be hardware, op, dtype or shape');
  if (value.scope_level && value.applicability === 'hardware' && level !== 'hardware') throw new Error('hardware applicability conflicts with scope_level');
  if (level !== 'shape') {
    if (value.shape_range !== undefined) throw new Error('shape_range is only allowed for shape knowledge');
    return { scope_level: level };
  }
  const range = value.shape_range;
  if (!range || typeof range !== 'object' || Array.isArray(range)) throw new Error('shape knowledge requires an explicit shape_range');
  safeId(range.shape_id);
  if (Object.keys(range).some(key => !['shape_id', 'dimensions'].includes(key))) throw new Error('Unknown shape_range field');
  if (!range.dimensions || typeof range.dimensions !== 'object' || Array.isArray(range.dimensions) || !Object.keys(range.dimensions).length) {
    throw new Error('shape_range.dimensions must contain explicit min/max bounds');
  }
  const dimensions: KnowledgeShapeRange['dimensions'] = {};
  for (const [key, bounds] of Object.entries(range.dimensions)) {
    safeId(key);
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds) || Object.keys(bounds).some(field => !['min', 'max'].includes(field))
      || !Number.isSafeInteger(bounds.min) || !Number.isSafeInteger(bounds.max) || bounds.min < 1 || bounds.max < bounds.min) {
      throw new Error(`shape_range.dimensions.${key} requires positive integer min <= max`);
    }
    dimensions[key] = { min: bounds.min, max: bounds.max };
  }
  return { scope_level: level, shape_range: { shape_id: range.shape_id, dimensions } };
}

export function normalizeKnowledgeShape(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('shape must contain concrete positive integer dimensions');
  const shape: Record<string, number> = {};
  for (const [key, size] of Object.entries(value)) {
    safeId(key);
    if (!Number.isSafeInteger(size) || (size as number) < 1) throw new Error(`shape.${key} must be a positive safe integer`);
    shape[key] = size as number;
  }
  return shape;
}

export function knowledgeScopeMatches(
  material: KnowledgeScope & { target?: TargetRef; applicability?: 'target' | 'hardware' },
  target?: TargetRef,
  shape?: Record<string, number>,
): boolean {
  const scope = normalizeKnowledgeScope(material);
  const origin = material.target;
  if (!target || !origin) return !target && !origin && scope.scope_level !== 'shape';
  if (origin.workspace_id !== target.workspace_id) return false;
  if (scope.scope_level === 'hardware') return true;
  if (origin.op_id !== target.op_id) return false;
  if (scope.scope_level === 'op') return true;
  if (origin.dtype_id !== target.dtype_id) return false;
  if (scope.scope_level === 'dtype') return true;
  return !!shape && Object.entries(scope.shape_range!.dimensions).every(([dimension, bounds]) =>
    Number.isSafeInteger(shape[dimension]) && shape[dimension] >= bounds.min && shape[dimension] <= bounds.max);
}
