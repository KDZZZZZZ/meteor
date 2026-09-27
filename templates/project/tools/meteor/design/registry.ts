import { assert } from '../util.ts';
import { parseAnnotations } from './annotations.ts';
import type { SourceText } from './annotations.ts';
import type { HardwareExecutionModel } from '../hardware-model.ts';

export interface DesignStrategy {
  id: string;
  check(sources: SourceText[], formulaRef: string, contract: Record<string, any>): void;
}

const strategies = new Map<string, DesignStrategy>([['layered-ir@1', { id: 'layered-ir@1', check() {} }]]);

/** Trusted runtime registration only. Source comments cannot load executable modules. */
export function registerDesignStrategy(strategy: DesignStrategy): () => void {
  assert(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(strategy.id), 'Invalid strategy identifier');
  assert(strategy.id !== 'direct-code@1' && !strategies.has(strategy.id), 'Duplicate or legacy-only design strategy');
  strategies.set(strategy.id, strategy);
  return () => { if (strategies.get(strategy.id) === strategy) strategies.delete(strategy.id); };
}

export function requireDesignStrategy(id: string): DesignStrategy {
  const strategy = strategies.get(id); assert(strategy, 'Unknown design strategy: ' + id); return strategy;
}

export function checkWithStrategy(id: string, sources: SourceText[], formulaRef: string, contract: Record<string, any>, model: HardwareExecutionModel) {
  const strategy = requireDesignStrategy(id);
  // Replaceable methods cannot bypass the shared annotation and graph contract.
  const result = parseAnnotations(sources, formulaRef, contract, model);
  strategy.check(sources, formulaRef, contract);
  return result;
}
