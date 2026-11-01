import { VOLUME_TYPES } from './volumeLabels';
import type { CalculationPolicy, ConditionLeaf } from '../api/screener';

export const calculationLabel = (policy?: CalculationPolicy) => policy === 'separate_bases_v2'
  ? '가격·거래량 분리 기준' : '기존 계산 기준';

export function separateVolumeBases(conditions: ConditionLeaf[]): ConditionLeaf[] {
  return conditions.map(leaf => VOLUME_TYPES.has(leaf.type)
    ? { ...leaf, params: { ...leaf.params, volume_basis: ('volume_basis' in leaf.params ? leaf.params.volume_basis : null) ?? (('timeframe' in leaf.params
      && leaf.params.timeframe?.endsWith('m')) ? 'raw' : 'share_adjusted') } } as ConditionLeaf : leaf);
}
