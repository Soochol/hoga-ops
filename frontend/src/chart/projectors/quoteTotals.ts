import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
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

export function projectBid(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.bid_total }));
}

export function projectAsk(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.ask_total }));
}

export const QUOTE_TOTALS_SPEC: PaneSpec = {
  name: 'quote-totals',
  stretch: 0.4,
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
