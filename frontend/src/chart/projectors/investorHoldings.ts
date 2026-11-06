import { LineSeries, type LineData, type WhitespaceData, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { HoldingsObservation } from '../../api/investorHoldings';
import type { RangeBundle } from '../../api/types';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { BoundPaneSpec } from '../paneSpecs';
import { lineVisible } from '../../state/indicatorLineVisibility';
import { formatKoreanK } from '../../util/koreanNumber';
import { LINE_HIDDEN_COLOR } from '../util/auctionHide';

export type HoldingsMetric = 'quantity' | 'ratio';
export interface HoldingsPaneContext { settings: IndicatorSettings; metric: HoldingsMetric; points: readonly HoldingsObservation[] }
export function projectInvestorHoldings(bundle: RangeBundle, axis: VirtualAxis, context: HoldingsPaneContext): (LineData<Time> | WhitespaceData<Time>)[] {
  const byTime = new Map(context.points.map(point => [point.t_ms, point]));
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  let previous: number | null = null;
  for (const candle of bundle.candles) {
    if (!axis.contains(candle.ts_ms)) continue;
    const time = axis.toVirtual(candle.ts_ms) / 1000 as UTCTimestamp;
    const point = byTime.get(candle.ts_ms);
    const value = context.metric === 'quantity' ? point?.quantity_shares : point?.ratio_pct;
    const valid = value !== undefined && value !== null && Number.isFinite(value) && value >= 0
      && (context.metric === 'quantity' ? Number.isSafeInteger(value) : value <= 100);
    if (!valid) {
      if (previous !== null) out[previous] = { ...out[previous], ...LINE_HIDDEN_COLOR };
      out.push({ time });
      previous = null;
    } else {
      out.push({ time, value });
      previous = out.length - 1;
    }
  }
  return out;
}
const formatQuantity = (value: number) => `${formatKoreanK(value)}주`;
const formatRatio = (value: number) => `${value.toFixed(2)}%`;
export const INVESTOR_HOLDINGS_SPEC: BoundPaneSpec<HoldingsPaneContext> = {
  name: 'investor-holdings', bundleKind: 'candle', stretch: 0.5,
  legendTitle: '외국인·기관 보유', legendToggleKey: 'investorHoldingsEnabled',
  series: [{
    type: LineSeries,
    options: { priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false },
    renderOptions: ({ settings, metric }) => ({
      priceFormat: { type: 'custom', formatter: metric === 'quantity' ? formatQuantity : formatRatio,
        minMove: metric === 'quantity' ? 1 : .01 },
      color: settings.investorHoldingsForeignColor,
      crosshairMarkerBackgroundColor: settings.investorHoldingsForeignColor, lineWidth: settings.investorHoldingsWidth,
      visible: lineVisible(settings.indicatorLineVisibility, 'investorHoldingsForeign'),
    }),
    data: projectInvestorHoldings,
    legend: { label: '외국인(주)', format: formatQuantity },
  }],
};
