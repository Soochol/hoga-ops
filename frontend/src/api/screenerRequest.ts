import type { ConditionLeaf, ScanRequest } from './screener';

function candleDefaults<T extends object>(input: T) {
  const { timeframe, include_open_bar, ...params } = input as T & { timeframe?: string; include_open_bar?: boolean };
  return { ...params, ...(timeframe && timeframe !== 'D' ? { timeframe } : {}),
    ...(include_open_bar === false ? { include_open_bar } : {}) };
}

// Backend models reorder keys and materialize omitted defaults on a round trip.
// Normalize those differences before associating a server job with the editor.
function conditionParams(leaf: ConditionLeaf) {
  switch (leaf.type) {
    case 'new_high_vol': {
      if ('mode' in leaf.params && leaf.params.record_period.unit !== 'bars') return leaf.params;
      return candleDefaults(leaf.params);
    }
    case 'trade_value_period':
      return 'mode' in leaf.params ? ('timeframe' in leaf.params
        ? { ...candleDefaults(leaf.params), timeframe: leaf.params.timeframe } : leaf.params) : candleDefaults(leaf.params);
    case 'change_pct': {
      const { change_reference, ...params } = leaf.params;
      return candleDefaults({ ...params, ...(change_reference && change_reference !== 'previous_day' ? { change_reference } : {}) });
    }
    case 'trade_value': case 'new_high': case 'new_high_today': case 'new_high_vol_today': return candleDefaults(leaf.params);
    case 'ma': return candleDefaults({ ...leaf.params, source: leaf.params.source ?? 'close' });
    case 'high_off_peak': return candleDefaults({ ...leaf.params, side: leaf.params.side ?? 'within' });
    case 'ask_depth_new_high': case 'bid_depth_new_high':
    case 'ask_depth_new_high_period': case 'bid_depth_new_high_period':
      return { ...leaf.params, threshold_pct: leaf.params.threshold_pct ?? 100 };
    case 'ask_depth_renewal': case 'bid_depth_renewal':
      return { ...leaf.params, start_hhmm: leaf.params.start_hhmm ?? 1200, threshold_pct: leaf.params.threshold_pct ?? 100 };
    default: return leaf.params;
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item != null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export const screenerRequestKey = (request: ScanRequest) => JSON.stringify(canonical({
  conditions: request.conditions.map(leaf => ({ ...leaf, params: conditionParams(leaf) })),
  universe: { markets: request.universe?.markets ?? [], exclude_etf: request.universe?.exclude_etf ?? true,
    exclude_halted: request.universe?.exclude_halted ?? false, scopes: request.universe?.scopes ?? [] },
  basis: request.basis ?? 'eod', limit: request.limit ?? 1000 }));

export function isHistoricalCondition(leaf: ConditionLeaf): boolean {
  return (leaf.type === 'new_high_vol' && 'mode' in leaf.params && leaf.params.record_period.unit !== 'bars')
    || (leaf.type === 'trade_value_period' && 'mode' in leaf.params && !('timeframe' in leaf.params));
}
