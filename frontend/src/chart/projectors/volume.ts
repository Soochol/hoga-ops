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

type VolumeProjection = HistogramData<Time>;
type VolumeCacheEntry = {
  pastLen: number;
  pastLastTs: number;
  pastFirstRef: RangeBundle['candles'][number] | null;
  pastLastRef: RangeBundle['candles'][number] | null;
  pastData: VolumeProjection[];
};

const volumeCache = new WeakMap<VirtualAxis, VolumeCacheEntry>();

function lowerBoundCandle(candles: RangeBundle['candles'], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].ts_ms < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function projectVolumeRows(candles: RangeBundle['candles'], axis: VirtualAxis): VolumeProjection[] {
  return candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c): VolumeProjection => ({
      time: (axis.toVirtual(c.ts_ms) / 1000) as UTCTimestamp,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? up : down,
    }));
}

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  return projectVolumeRows(bundle.candles, axis);
}

export function projectVolumeCached(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  const segs = bundle.segments ?? [];
  if (segs.length < 2) return projectVolume(bundle, axis);

  const candles = bundle.candles;
  const todayOpen = segs[segs.length - 1].session_open_ms;
  const splitIdx = lowerBoundCandle(candles, todayOpen);
  const pastLen = splitIdx;
  const pastLastTs = pastLen > 0 ? candles[pastLen - 1].ts_ms : 0;
  const pastFirstRef = pastLen > 0 ? candles[0] : null;
  const pastLastRef = pastLen > 0 ? candles[pastLen - 1] : null;

  let entry = volumeCache.get(axis);
  if (
    !entry ||
    entry.pastLen !== pastLen ||
    entry.pastLastTs !== pastLastTs ||
    entry.pastFirstRef !== pastFirstRef ||
    entry.pastLastRef !== pastLastRef
  ) {
    entry = {
      pastLen,
      pastLastTs,
      pastFirstRef,
      pastLastRef,
      pastData: projectVolumeRows(candles.slice(0, splitIdx), axis),
    };
    volumeCache.set(axis, entry);
  }

  return entry.pastData.concat(projectVolumeRows(candles.slice(splitIdx), axis));
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
      data: (bundle: RangeBundle, axis: VirtualAxis, _ctx: VolumePaneContext) => projectVolumeCached(bundle, axis),
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
} satisfies PaneSpec<VolumePaneContext>;
