import {
  HistogramSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { candlePosition } from '../candlePosition';
import { useActivePrefs } from '../../state/chartPrefs';
import { resolveTokensThemed, currentThemeKey } from '../../util/tokens';
import { formatKoreanK } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';
import type { VolumeOverlayStyle } from '../../state/chartDisplayPrefs';
import { useMemo } from 'react';
import { useWindowIndicator } from '../../live/workspace/windowView';
import type { VolumeColorMode } from '../../state/liveIndicatorsPersistence';

const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
} as const;

type VolumePaneContext = { swapColors?: boolean; colorMode?: VolumeColorMode };
const useVolumeContext = (): VolumePaneContext => {
  const swapColors = useActivePrefs(p => p.candleInvertScale && p.candleInvertColors);
  const colorMode = useWindowIndicator(s => s.volumeColorMode);
  return useMemo(() => ({ swapColors, colorMode }), [swapColors, colorMode]);
};

const priceFormat = {
  type: 'custom' as const,
  formatter: formatKoreanK,
  minMove: 1,
};

type VolumeProjection = HistogramData<Time>;
type VolumeCacheEntry = {
  theme: string;
  swapColors: boolean;
  styleKey: string;
  colorMode: VolumeColorMode;
  pastLen: number;
  pastLastTs: number;
  pastFirstRef: RangeBundle['candles'][number] | null;
  pastLastRef: RangeBundle['candles'][number] | null;
  pastData: VolumeProjection[];
};

// Independent volume instances can use both modes on the same axis without
// invalidating each other's historical projection on every live tick.
const volumeCache = new WeakMap<VirtualAxis, Map<VolumeColorMode, VolumeCacheEntry>>();

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

function projectVolumeRows(
  candles: RangeBundle['candles'], axis: VirtualAxis, swapColors: boolean,
  style: VolumeOverlayStyle | undefined, colorMode: VolumeColorMode, previousVolume?: number,
): VolumeProjection[] {
  const tokens = resolveTokensThemed(TOKEN_SPEC);
  const alpha = (color: string) => style
    ? `${color}${Math.round(255 * (1 - style.volumeOverlayTransparency / 100)).toString(16).padStart(2, '0')}` : color;
  const up = alpha(style?.volumeOverlayUpColor || tokens.up);
  const down = alpha(style?.volumeOverlayDownColor || tokens.down);
  const out: VolumeProjection[] = [];
  for (const c of candles) {
    const volume = c.vol_a + c.vol_b;
    const isUp = colorMode === 'previous-volume' && previousVolume !== undefined
      ? volume > previousVolume : c.close >= c.open;
    // Keep the actual preceding bar even when it is outside the visible axis.
    previousVolume = volume;
    const projected = candlePosition(c, axis);
    if (!projected.contained) continue;
    out.push({
      time: (projected.virtual / 1000) as UTCTimestamp,
      value: volume,
      color: isUp !== swapColors ? up : down,
    });
  }
  return out;
}

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis, swapColors = false, style?: VolumeOverlayStyle, colorMode: VolumeColorMode = 'candle'): HistogramData<Time>[] {
  return projectVolumeRows(bundle.candles, axis, swapColors, style, colorMode);
}

export function projectVolumeCached(bundle: RangeBundle, axis: VirtualAxis, swapColors = false, style?: VolumeOverlayStyle, colorMode: VolumeColorMode = 'candle'): HistogramData<Time>[] {
  const segs = bundle.segments ?? [];
  if (segs.length < 2) return projectVolume(bundle, axis, swapColors, style, colorMode);

  const candles = bundle.candles;
  const todayOpen = segs[segs.length - 1].session_open_ms;
  const splitIdx = lowerBoundCandle(candles, todayOpen);
  const pastLen = splitIdx;
  const pastLastTs = pastLen > 0 ? candles[pastLen - 1].ts_ms : 0;
  const pastFirstRef = pastLen > 0 ? candles[0] : null;
  const pastLastRef = pastLen > 0 ? candles[pastLen - 1] : null;

  const styleKey = style ? `${style.volumeOverlayUpColor}|${style.volumeOverlayDownColor}|${style.volumeOverlayTransparency}` : '';
  const theme = currentThemeKey();
  let modes = volumeCache.get(axis);
  if (!modes) {
    modes = new Map();
    volumeCache.set(axis, modes);
  }
  let entry = modes.get(colorMode);
  if (
    !entry ||
    entry.theme !== theme ||
    entry.swapColors !== swapColors ||
    entry.styleKey !== styleKey ||
    entry.colorMode !== colorMode ||
    entry.pastLen !== pastLen ||
    entry.pastLastTs !== pastLastTs ||
    entry.pastFirstRef !== pastFirstRef ||
    entry.pastLastRef !== pastLastRef
  ) {
    entry = {
      theme,
      swapColors,
      styleKey,
      colorMode,
      pastLen,
      pastLastTs,
      pastFirstRef,
      pastLastRef,
      pastData: projectVolumeRows(candles.slice(0, splitIdx), axis, swapColors, style, colorMode),
    };
    modes.set(colorMode, entry);
  }

  const previous = candles[splitIdx - 1];
  const previousVolume = previous ? previous.vol_a + previous.vol_b : undefined;
  return entry.pastData.concat(projectVolumeRows(candles.slice(splitIdx), axis, swapColors, style, colorMode, previousVolume));
}

// volumeEnabled gating lives in `paneSpecsForTimeframe` (the pane is removed
// when off, like the investor panes), so the spec is unconditional — when this
// pane is mounted, volume is on.
export const VOLUME_SPEC = {
  name: 'volume' as const,
  stretch: 0.3,
  legendToggleKey: 'volumeEnabled',
  useContext: useVolumeContext,
  series: [
    {
      type: HistogramSeries,
      // No swatch: bars are per-candle colored (up/down), so a single color
      // would mislead — matches the pre-existing volume legend (label only).
      legend: { label: '거래량' },
      options: {
        priceFormat,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      data: (bundle: RangeBundle, axis: VirtualAxis, ctx: VolumePaneContext) => projectVolumeCached(bundle, axis, ctx.swapColors, undefined, ctx.colorMode),
    },
  ],
} satisfies PaneSpec<VolumePaneContext>;
