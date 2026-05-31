import {
  HistogramSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';

// Bar color is fixed by SIGN, not by investor — net buy = 매수(red), net
// sell = 매도(blue), mirroring the volume pane. Foreign vs institution is
// disambiguated by the pane, so the color axis is free to carry buy/sell.
const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
} as const;

const { up, down } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => formatKoreanInt(v),
  minMove: 1,
};

const histogramOptions = {
  priceFormat,
  priceScaleId: 'right',
  priceLineVisible: false,
  lastValueVisible: false,
} as const;

export function projectInvestorNet(
  bundle: RangeBundle,
  axis: VirtualAxis,
  which: 'foreign' | 'institution',
): HistogramData<Time>[] {
  return bundle.investorPoints
    .filter((p) => axis.contains(p.t_ms))
    .map((p): HistogramData<Time> => {
      const value = which === 'foreign' ? p.foreign_net : p.institution_net;
      return {
        time: (axis.toVirtual(p.t_ms) / 1000) as UTCTimestamp,
        value,
        color: value >= 0 ? up : down,
      };
    });
}

export const INVESTOR_FOREIGN_SPEC = {
  name: 'investor-foreign' as const,
  stretch: 0.3,
  series: [
    {
      type: HistogramSeries,
      options: histogramOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) =>
        projectInvestorNet(bundle, axis, 'foreign'),
    },
  ],
} satisfies PaneSpec;

export const INVESTOR_INSTITUTION_SPEC = {
  name: 'investor-institution' as const,
  stretch: 0.3,
  series: [
    {
      type: HistogramSeries,
      options: histogramOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) =>
        projectInvestorNet(bundle, axis, 'institution'),
    },
  ],
} satisfies PaneSpec;
