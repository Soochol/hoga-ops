import { HistogramSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],   // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#2563EB'], // 체결 매도 (KRX 파랑)
} as const;

const { buy, sell } = resolveTokens(TOKEN_SPEC);

const histOpts = {
  base: 0,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => Math.round(Math.abs(v)).toLocaleString('ko-KR'),
    minMove: 1,
  },
  priceLineVisible: false,
  lastValueVisible: false,
};

export function projectBuy(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.buy_qty }));
}

export function projectSell(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: -p.sell_qty }));
}

export const FILL_STRENGTH_SPEC: PaneSpec = {
  name: 'fill-strength',
  stretch: 0.4,
  series: [
    { type: HistogramSeries, options: { color: buy, ...histOpts }, data: projectBuy },
    { type: HistogramSeries, options: { color: sell, ...histOpts }, data: projectSell },
  ],
};
