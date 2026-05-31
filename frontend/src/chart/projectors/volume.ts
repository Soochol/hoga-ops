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
} as const;

const { up, down } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => formatKoreanInt(v),
  minMove: 1,
};

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c): HistogramData<Time> => ({
      time: (axis.toVirtual(c.ts_ms) / 1000) as UTCTimestamp,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? up : down,
    }));
}

// volumeEnabled gating lives in `paneSpecsForTimeframe` (the pane is removed
// when off, like the investor panes), so the spec is unconditional — when this
// pane is mounted, volume is on.
export const VOLUME_SPEC = {
  name: 'volume' as const,
  stretch: 0.3,
  series: [
    {
      type: HistogramSeries,
      options: {
        priceFormat,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      data: (bundle: RangeBundle, axis: VirtualAxis) => projectVolume(bundle, axis),
    },
  ],
} satisfies PaneSpec;
