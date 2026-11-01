import type { ConditionLeaf, ScreenerOccurrence, ScreenerRankType } from '../api/screener';

export const RANK_CONDITION_TYPES = [
  'trade_value_rank', 'change_pct_rank', 'volume_surge_rank', 'volume_rank',
  'program_net_buy_rank', 'institution_net_buy_rank', 'foreign_net_buy_rank',
] as const satisfies readonly ScreenerRankType[];
const types = new Set<string>(RANK_CONDITION_TYPES);
const fast = new Set<string>(['trade_value_rank', 'change_pct_rank', 'volume_surge_rank', 'volume_rank']);
export const isRankCondition = (leaf: ConditionLeaf) => types.has(leaf.type);
export const rankRefreshPeriod = (conditions: ConditionLeaf[]): number | null =>
  conditions.some(leaf => fast.has(leaf.type)) ? 10_000 : conditions.some(isRankCondition) ? 30_000 : null;

export const hasRankEvidence = (event: ScreenerOccurrence) =>
  !!(event.trade_value_rank_match || event.change_pct_rank_match || event.market_rank_match);

export const MARKET_RANK_LABELS = {
  surge: '거래량 급증', volume: '거래량', program: '프로그램', institution: '기관', foreign: '외국인',
} as const;
