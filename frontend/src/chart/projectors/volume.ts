import { HistogramSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
} as const;

const { up, down } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
  minMove: 1,
};

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c) => ({
      time: (axis.toVirtual(c.ts_ms) / 1000) as any,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? up : down,
    }));
}

export const VOLUME_SPEC = {
  name: 'volume' as const,
  stretch: 0.3,
  series: [
    {
      type: HistogramSeries,
      options: {
        priceFormat,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      data: projectVolume,
    },
  ],
} satisfies PaneSpec;
