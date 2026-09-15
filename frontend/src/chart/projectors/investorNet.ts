import {
  HistogramSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokensThemed } from '../../util/tokens';
import { formatKoreanK } from '../../util/koreanNumber';
import type { PaneSpec } from '../RangeSeriesPane';

// Net bars use their sign. Gross buy/sell bars use the response mode: a
// positive gross sell quantity is still a sell (blue), not a net buy (red).
const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
} as const;

const priceFormat = {
  type: 'custom' as const,
  formatter: formatKoreanK,
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
  const { up, down } = resolveTokensThemed(TOKEN_SPEC);
  const points = which === 'institution' ? bundle.institutionInvestorPoints ?? bundle.investorPoints : bundle.investorPoints;
  const side = which === 'institution' ? bundle.institutionInvestorTradeSide ?? bundle.investorTradeSide : bundle.investorTradeSide;
  return points
    .filter((p) => axis.contains(p.t_ms))
    .map((p): HistogramData<Time> => {
      const value = which === 'foreign' ? p.foreign_net : p.institution_net;
      return {
        time: (axis.toVirtual(p.t_ms) / 1000) as UTCTimestamp,
        value,
        color: side === 'sell' ? down : side === 'buy' ? up : value >= 0 ? up : down,
      };
    });
}

// Per-bar colored (up/down by sign) → no swatch, label only (matches the
// pre-existing investor legend rows). Toggle keys mirror the ADR-0055 daily gate.
export const INVESTOR_FOREIGN_SPEC = {
  name: 'investor-foreign' as const,
  stretch: 0.3,
  legendToggleKey: 'foreignNetEnabled',
  series: [
    {
      type: HistogramSeries,
      options: histogramOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) =>
        projectInvestorNet(bundle, axis, 'foreign'),
      legend: { label: '외국인 순매수량', format: formatKoreanK },
    },
  ],
} satisfies PaneSpec;

export const INVESTOR_INSTITUTION_SPEC = {
  name: 'investor-institution' as const,
  stretch: 0.3,
  legendToggleKey: 'institutionNetEnabled',
  series: [
    {
      type: HistogramSeries,
      options: histogramOptions,
      data: (bundle: RangeBundle, axis: VirtualAxis) =>
        projectInvestorNet(bundle, axis, 'institution'),
      legend: { label: '기관 순매수량', format: formatKoreanK },
    },
  ],
} satisfies PaneSpec;
