import {
  HistogramSeries,
  LineSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { useActivePrefs } from '../../state/chartPrefs';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
import { useShallow } from 'zustand/react/shallow';
import { addZeroBaselineGuide } from '../util/zeroBaseline';
import { cumulativeCachedData, cumulativePriceFormat } from './fillStrength';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  cumulative: ['--fg-dim', '#94A3B8'],
  cumulativeBaseline: ['--fg-dimmer', '#64748B'],
} as const;

const { up, down, cumulative, cumulativeBaseline } = resolveTokens(TOKEN_SPEC);

type VolumePaneContext = {
  cumulativeEnabled: boolean;
  auctionWindowMask: boolean;
};

const useVolumeContext = (): VolumePaneContext =>
  useActivePrefs(
    useShallow((p): VolumePaneContext => ({
      cumulativeEnabled: p.volumeFillStrengthCumulative,
      auctionWindowMask: p.auctionWindowMask,
    })),
  );

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
  live: true,
  stretch: 0.3,
  useContext: useVolumeContext,
  series: [
    {
      type: HistogramSeries,
      options: {
        priceFormat,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      data: (bundle: RangeBundle, axis: VirtualAxis, _ctx: VolumePaneContext) => projectVolume(bundle, axis),
    },
    {
      type: LineSeries,
      options: {
        color: cumulative,
        lineWidth: 2,
        lineStyle: 0,
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: cumulativePriceFormat,
      },
      data: (bundle: RangeBundle, axis: VirtualAxis, ctx: VolumePaneContext) =>
        ctx.cumulativeEnabled ? cumulativeCachedData(bundle, axis, ctx.auctionWindowMask) : [],
      afterAdd: (series) => addZeroBaselineGuide(series, cumulativeBaseline),
    },
  ],
} satisfies PaneSpec;
