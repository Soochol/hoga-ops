import {
  CandlestickSeries,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  muted: ['--fg-dim', '#94A3B8'],
} as const;

const { up, down, muted } = resolveTokens(TOKEN_SPEC);

export type CandlePaneContext = {
  muteAuctionCandles: boolean;
};

const DEFAULT_CONTEXT: CandlePaneContext = { muteAuctionCandles: true };

const priceFormat = {
  type: 'custom' as const,
  formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
  minMove: 1,
};

export function projectCandle(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: CandlePaneContext = DEFAULT_CONTEXT,
): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  for (const c of bundle.candles) {
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

export const CANDLE_SPEC = {
  name: 'candle' as const,
  stretch: 1.4,
  series: [
    {
      type: CandlestickSeries,
      options: {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat,
      },
      data: projectCandle,
    },
  ],
} satisfies PaneSpec<CandlePaneContext>;
