import {
  LineSeries,
  type LineData,
  type UTCTimestamp,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useActivePrefs } from '../../state/chartPrefs';
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

// Closing Auction Window hide (ADR-0029): in-window points are emitted as
// WhitespaceData (no value) so the line breaks cleanly AND the time scale
// keeps a mappable bar position at each in-window minute. Dropping the
// points entirely would shrink the chart's visible range past the auction
// band, hiding the AuctionWindowOverlay highlight band as a side effect.
export function projectBid(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (auctionWindowMask && axis.inClosingAuctionWindow(p.t)) {
      out.push({ time });
      continue;
    }
    out.push({ time, value: p.bid_total });
  }
  return out;
}

export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (auctionWindowMask && axis.inClosingAuctionWindow(p.t)) {
      out.push({ time });
      continue;
    }
    out.push({ time, value: p.ask_total });
  }
  return out;
}

const useQuoteTotalsContext = (): boolean => useActivePrefs((p) => p.auctionWindowMask);

export const QUOTE_TOTALS_SPEC = {
  name: 'quote-totals' as const,
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
} satisfies PaneSpec<boolean>;
