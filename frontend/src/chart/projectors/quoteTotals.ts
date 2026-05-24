import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useChartPrefs } from '../ChartPrefsContext';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  bid: ['--price-up', '#DC2626'],   // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#2563EB'], // 매도 호가 총합 (KRX 파랑)
} as const;

const { bid, ask } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
  minMove: 1,
};

// CONTEXT.md "Auction Window" — same rationale as RATIO_SPEC: during the
// 15:20–15:30 closing auction, posted totals are dominated by one-sided
// accumulation and don't represent continuous-session order book pressure.
// axis.inClosingAuctionWindow owns the threshold so this stays aligned with
// the ratio pane automatically.
export function projectBid(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({
      time: (axis.toVirtual(p.t) / 1000) as any,
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : p.bid_total,
    }));
}

export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({
      time: (axis.toVirtual(p.t) / 1000) as any,
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : p.ask_total,
    }));
}

const useQuoteTotalsContext = (): boolean => useChartPrefs().auctionWindowMask;

export const QUOTE_TOTALS_SPEC: PaneSpec<boolean> = {
  name: 'quote-totals',
  stretch: 0.4,
  useContext: useQuoteTotalsContext,
  series: [
    {
      type: LineSeries,
      options: { color: bid, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false },
      data: projectBid,
    },
    {
      type: LineSeries,
      options: { color: ask, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false },
      data: projectAsk,
    },
  ],
};
