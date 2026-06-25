import {
  LineSeries,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanWonEok } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  line: ['--accent', '#14B8A6'],
} as const;

const { line } = resolveTokens(TOKEN_SPEC);

const lineOptions = {
  color: line,
  lineWidth: 2,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => formatKoreanWonEok(v),
    minMove: 1,
  },
  priceScaleId: 'right',
  priceLineVisible: false,
  lastValueVisible: true,
} as const;

export function projectProgramTradeNetAmount(
  bundle: RangeBundle,
  axis: VirtualAxis,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  const points = bundle.program_trade?.points ?? [];
  for (const p of points) {
    if (p.net_amount == null) continue;
    if (!axis.contains(p.t)) continue;
    out.push({
      time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
      value: p.net_amount,
    });
  }
  return out;
}

export const PROGRAM_TRADE_SPEC = {
  name: 'program-trade' as const,
  stretch: 0.35,
  series: [
    {
      type: LineSeries,
      options: lineOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) => projectProgramTradeNetAmount(bundle, axis),
    },
  ],
} satisfies PaneSpec;
