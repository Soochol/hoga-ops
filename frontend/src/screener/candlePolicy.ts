import type { ConditionLeaf } from '../api/screener';

// The editor always includes the current candle. Keep the wire option for
// older API clients, but migrate saved/editor values before displaying or using them.
export function includeOpenBars(conditions: ConditionLeaf[]): ConditionLeaf[] {
  return conditions.map(leaf => leaf.params && typeof leaf.params === 'object' && 'include_open_bar' in leaf.params
    && leaf.params.include_open_bar === false
    ? { ...leaf, params: { ...leaf.params, include_open_bar: true } } as ConditionLeaf : leaf);
}
