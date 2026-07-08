import {
  CandlestickSeries,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed, currentThemeKey } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
  muted: ['--fg-dim', '#9A9AA8'],
} as const;

export type CandlePaneContext = {
  muteAuctionCandles: boolean;
};

const DEFAULT_CONTEXT: CandlePaneContext = { muteAuctionCandles: true };

const priceFormat = {
  type: 'custom' as const,
  formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
  minMove: 1,
};

type CandleProjection = CandlestickData<Time>;
type CandleCacheEntry = {
  ctx: CandlePaneContext;
  theme: string;
  pastLen: number;
  pastLastTs: number;
  pastFirstRef: Candle | null;
  pastLastRef: Candle | null;
  pastData: CandleProjection[];
};

const candleCache = new WeakMap<VirtualAxis, CandleCacheEntry>();

function lowerBoundCandle(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].ts_ms < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function projectCandleRows(
  candles: readonly Candle[],
  axis: VirtualAxis,
  ctx: CandlePaneContext,
): CandleProjection[] {
  const { up, down, muted } = resolveTokensThemed(TOKEN_SPEC);
  const out: CandleProjection[] = [];
  for (const c of candles) {
    const { contained, inAuction, virtual } = axis.classifyAndProject(c.ts_ms);
    if (!contained) continue;
    const color = ctx.muteAuctionCandles && inAuction ? muted : c.close >= c.open ? up : down;
    out.push({
      time: (virtual / 1000) as UTCTimestamp,
      open: c.open,
      close: c.close,
      high: c.high,
      low: c.low,
      color,
      borderColor: color,
      wickColor: color,
    });
  }
  return out;
}

export function projectCandle(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: CandlePaneContext = DEFAULT_CONTEXT,
): CandlestickData<Time>[] {
  return projectCandleRows(bundle.candles, axis, ctx);
}

export function projectCandleCached(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: CandlePaneContext = DEFAULT_CONTEXT,
): CandlestickData<Time>[] {
  const segs = bundle.segments ?? [];
  if (segs.length < 2) return projectCandle(bundle, axis, ctx);

  const candles = bundle.candles;
  const todayOpen = segs[segs.length - 1].session_open_ms;
  const splitIdx = lowerBoundCandle(candles, todayOpen);
  const pastLen = splitIdx;
  const pastLastTs = pastLen > 0 ? candles[pastLen - 1].ts_ms : 0;
  const pastFirstRef = pastLen > 0 ? candles[0] : null;
  const pastLastRef = pastLen > 0 ? candles[pastLen - 1] : null;

  const theme = currentThemeKey();
  let entry = candleCache.get(axis);
  if (
    !entry ||
    entry.ctx !== ctx ||
    entry.theme !== theme ||
    entry.pastLen !== pastLen ||
    entry.pastLastTs !== pastLastTs ||
    entry.pastFirstRef !== pastFirstRef ||
    entry.pastLastRef !== pastLastRef
  ) {
    entry = {
      ctx,
      theme,
      pastLen,
      pastLastTs,
      pastFirstRef,
      pastLastRef,
      pastData: projectCandleRows(candles.slice(0, splitIdx), axis, ctx),
    };
    candleCache.set(axis, entry);
  }

  return entry.pastData.concat(projectCandleRows(candles.slice(splitIdx), axis, ctx));
}

export const CANDLE_SPEC = {
  name: 'candle' as const,
  stretch: 1.4,
  series: [
    {
      type: CandlestickSeries,
      options: () => {
        const { up, down } = resolveTokensThemed(TOKEN_SPEC);
        return {
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat,
        };
      },
      data: projectCandleCached,
    },
  ],
} satisfies PaneSpec<CandlePaneContext>;
