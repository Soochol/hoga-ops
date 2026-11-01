import type { BarMaValue, ConditionType, MaOperand, MaThresholdParams } from '../api/screener';
import { PRICE_LABELS } from './priceCompareLabels';

export const MA_CONDITION_TYPES = new Set<ConditionType>([
  'ma_compare', 'ma_compare_period', 'ma_cross', 'ma_cross_period',
  'ma_gap', 'ma_gap_period', 'ma_slope', 'ma_slope_period',
]);
export function maOperandLabel(p: MaOperand | BarMaValue): string {
  return `${p.offset}봉 전 ${p.kind === 'price' ? PRICE_LABELS[p.source] : `SMA${p.period}(${PRICE_LABELS[p.source]})`}`;
}
export function maThresholdLabel(p: MaThresholdParams): string {
  return p.op === 'between' ? `${p.lo ?? ''}~${p.hi ?? ''}%` : `${p.op === 'gte' ? '≥' : '≤'} ${p.pct ?? ''}%`;
}
