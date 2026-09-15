import type { Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

export type NumericRange = { from: number; to: number };

const RANGE_PADDING_RATIO = 0.06;

/**
 * 두 investor pane이 공유할 가시값 범위. 두 계열의 현재 X축 구간을 합치고 0을
 * 반드시 포함한다. 같은 범위를 같은 높이의 pane에 적용하면 0부터 막대 끝까지의
 * 픽셀 길이가 수량에 정확히 비례한다.
 */
export function linkedInvestorPriceRange(
  bundle: RangeBundle,
  axis: VirtualAxis,
  visibleTimeRange: { from: Time; to: Time } | null,
): NumericRange | null {
  const from = typeof visibleTimeRange?.from === 'number' ? visibleTimeRange.from : -Infinity;
  const to = typeof visibleTimeRange?.to === 'number' ? visibleTimeRange.to : Infinity;
  let min = 0;
  let max = 0;
  let found = false;

  const collect = (
    points: RangeBundle['investorPoints'],
    field: 'foreign_net' | 'institution_net',
  ): void => {
    for (const point of points) {
      if (!axis.contains(point.t_ms)) continue;
      const time = axis.toVirtual(point.t_ms) / 1000;
      if (time < from || time > to) continue;
      const value = point[field];
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      found = true;
    }
  };

  collect(bundle.investorPoints, 'foreign_net');
  collect(bundle.institutionInvestorPoints ?? bundle.investorPoints, 'institution_net');
  if (!found) return null;

  const span = max - min;
  const padding = span > 0
    ? span * RANGE_PADDING_RATIO
    : Math.max(1, Math.abs(max) * RANGE_PADDING_RATIO);
  return { from: min - padding, to: max + padding };
}

