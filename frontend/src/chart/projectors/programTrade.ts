import {
  HistogramSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  gap: ['--fg-dim', '#94A3B8'],
} as const;

const { up, down, gap } = resolveTokens(TOKEN_SPEC);

const histogramOptions = {
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => formatKoreanInt(v),
    minMove: 1,
  },
  priceScaleId: 'right',
  priceLineVisible: false,
  lastValueVisible: false,
} as const;

export function projectProgramTradeNetAmount(
  bundle: RangeBundle,
  axis: VirtualAxis,
): HistogramData<Time>[] {
  const out: HistogramData<Time>[] = [];
  const points = bundle.program_trade?.points ?? [];
  for (const p of points) {
    if (p.net_amount == null) continue;
    if (!axis.contains(p.t)) continue;
    out.push({
      time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
      value: p.net_amount,
      color: p.gap_risk ? gap : p.net_amount >= 0 ? up : down,
    });
  }
  return out;
}

export const PROGRAM_TRADE_SPEC = {
  name: 'program-trade' as const,
  stretch: 0.35,
  series: [
    {
      type: HistogramSeries,
      options: histogramOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) => projectProgramTradeNetAmount(bundle, axis),
    },
  ],
} satisfies PaneSpec;
