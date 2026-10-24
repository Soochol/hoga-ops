import type { CalculationPolicy, ConditionLeaf } from '../api/screener';

export const calculationLabel = (policy?: CalculationPolicy) => policy === 'separate_bases_v2'
  ? '가격·거래량 분리 기준' : '기존 계산 기준';

export function separateVolumeBases(conditions: ConditionLeaf[]): ConditionLeaf[] {
  return conditions.map(leaf => leaf.type === 'new_high_vol' || leaf.type === 'new_high_vol_today'
    ? { ...leaf, params: { ...leaf.params, volume_basis: leaf.params.volume_basis ?? (('timeframe' in leaf.params
      && leaf.params.timeframe?.endsWith('m')) ? 'raw' : 'share_adjusted') } } as ConditionLeaf : leaf);
}
