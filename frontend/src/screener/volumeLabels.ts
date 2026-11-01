import type { ConditionType } from '../api/screener';

export const VOLUME_CONDITION_TYPES = new Set<ConditionType>([
  'volume_range', 'volume_range_period', 'volume_compare', 'volume_compare_period',
  'volume_ratio', 'volume_ratio_period',
]);
export const VOLUME_TYPES = new Set<ConditionType>([...VOLUME_CONDITION_TYPES, 'new_high_vol', 'new_high_vol_today']);

// Preserve exact share quantities. A converted fractional share is shown as a fraction.
export function volumeValueLabel(value: string): string {
  return value.split('/').map(part => BigInt(part).toLocaleString('ko-KR')).join('/');
}
