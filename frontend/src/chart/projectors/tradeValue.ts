import { HistogramSeries, type HistogramData, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { candlePosition } from '../candlePosition';
import { resolveTokensThemed } from '../../util/tokens';
import { formatTradeValueSeriesValue, paneValueToSeriesValue, TRADE_VALUE_WON_PER_UNIT } from '../paneValueUnits';
import type { BoundPaneSpec } from '../paneSpecs';

const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
} as const;

export function projectTradeValue(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  const { up, down } = resolveTokensThemed(TOKEN_SPEC);
  const out: HistogramData<Time>[] = [];
  for (const candle of bundle.candles) {
    const value = candle.trade_value_won;
    // Missing turnover is not zero; use the reported amount rather than price × volume.
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    const position = candlePosition(candle, axis);
    if (!position.contained) continue;
    out.push({
      time: (position.virtual / 1000) as UTCTimestamp,
      value: paneValueToSeriesValue('trade-value', value),
      color: candle.close >= candle.open ? up : down,
    });
  }
  return out;
}

export const TRADE_VALUE_SPEC = {
  name: 'trade-value',
  bundleKind: 'candle',
  stretch: 0.3,
  legendToggleKey: 'tradeValueEnabled',
  series: [{
    type: HistogramSeries,
    legend: { label: '거래대금', format: formatTradeValueSeriesValue },
    options: {
      priceFormat: { type: 'custom', formatter: formatTradeValueSeriesValue, minMove: 1 / TRADE_VALUE_WON_PER_UNIT },
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: false,
    },
    data: projectTradeValue,
  }],
} satisfies BoundPaneSpec;
