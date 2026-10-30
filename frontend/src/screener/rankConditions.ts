import type { ConditionLeaf, ScreenerOccurrence } from '../api/screener';

export const isRankCondition = (leaf: ConditionLeaf) =>
  leaf.type === 'trade_value_rank' || leaf.type === 'change_pct_rank';

export const hasRankEvidence = (event: ScreenerOccurrence) =>
  !!(event.trade_value_rank_match || event.change_pct_rank_match);
