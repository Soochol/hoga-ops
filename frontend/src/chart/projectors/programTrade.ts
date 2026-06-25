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
  const byBucket = new Map<number, number>();
  const points = bundle.program_trade?.points ?? [];
  for (const p of points) {
    if (p.net_amount == null) continue;
    const t = bucketTime(bundle, p.t);
    if (t == null || !axis.contains(t)) continue;
    byBucket.set(t, p.net_amount);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, value]) => ({
      time: (axis.toVirtual(t) / 1000) as UTCTimestamp,
      value,
    }));
}

function bucketTime(bundle: RangeBundle, t: number): number | null {
  const segment = bundle.segments.find((s) => s.session_open_ms <= t && t <= s.session_close_ms);
  if (!segment) return null;
  const bucketMs = Math.max(1, bundle.bucket_ms || 1);
  return segment.session_open_ms + Math.floor((t - segment.session_open_ms) / bucketMs) * bucketMs;
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
