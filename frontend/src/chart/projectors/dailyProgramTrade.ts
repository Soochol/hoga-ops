import { HistogramSeries, type HistogramData, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';

export function projectDailyProgramTrade(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  const { up, down } = resolveTokensThemed({
    up: ['--price-up', '#F04452'], down: ['--price-down', '#3485FA'],
  });
  const side = bundle.dailyProgramTradeSide ?? 'net';
  return (bundle.dailyProgramPoints ?? []).flatMap((point) => {
    const value = point[`${side}_qty`];
    if (value == null || !Number.isFinite(value) || !axis.contains(point.t_ms)) return [];
    return [{ time: (axis.toVirtual(point.t_ms) / 1000) as UTCTimestamp, value,
      color: side === 'sell' ? down : side === 'buy' || value >= 0 ? up : down }];
  });
}

export const DAILY_PROGRAM_TRADE_SPEC = {
  name: 'program-daily' as const,
  stretch: 0.3,
  legendToggleKey: 'dailyProgramEnabled',
  series: [{
    type: HistogramSeries,
    options: { priceFormat: { type: 'custom', formatter: formatKoreanInt, minMove: 1 },
      priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false },
    data: projectDailyProgramTrade,
    legend: { label: '프로그램 순매수량' },
  }],
} satisfies PaneSpec;
