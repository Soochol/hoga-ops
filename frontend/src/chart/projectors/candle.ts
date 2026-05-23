import { CandlestickSeries } from 'lightweight-charts';
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

const priceFormat = {
  type: 'custom' as const,
  formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
  minMove: 1,
};

export function projectCandle(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c) => {
      const inClosingAuction = axis.inClosingAuctionWindow(c.ts_ms);
      const color = inClosingAuction ? muted : c.close >= c.open ? up : down;
      return {
        time: (axis.toVirtual(c.ts_ms) / 1000) as any,
        open: c.open,
        close: c.close,
        high: c.high,
        low: c.low,
        color,
        borderColor: color,
        wickColor: color,
      };
    });
}

export const CANDLE_SPEC: PaneSpec = {
  name: 'candle',
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
};
