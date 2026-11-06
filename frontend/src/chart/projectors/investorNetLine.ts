import { LineSeries, type LineData, type Time, type UTCTimestamp, type WhitespaceData } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { lineVisible } from '../../state/indicatorLineVisibility';
import { useWindowIndicators } from '../../live/workspace/windowView';
import { formatKoreanK } from '../../util/koreanNumber';
import { resolveTokensThemed } from '../../util/tokens';
import type { BoundPaneSpec } from '../paneSpecs';
import { addZeroBaselineGuide, includeZeroAutoscale } from '../util/zeroBaseline';
import { LINE_HIDDEN_COLOR } from '../util/auctionHide';

type Subject = 'foreign' | 'institution';
const SUBJECTS = [
  { subject: 'foreign', label: '외국인(주)', color: 'investorNetLineForeignColor', visibility: 'investorNetLineForeign' },
  { subject: 'institution', label: '기관(주)', color: 'investorNetLineInstitutionColor', visibility: 'investorNetLineInstitution' },
] as const;

export function projectInvestorNetLine(bundle: RangeBundle, axis: VirtualAxis, subject: Subject): (LineData<Time> | WhitespaceData<Time>)[] {
  if (bundle.investorTradeSide !== 'net') return [];
  const points = new Map(bundle.investorPoints.map(point => [point.t_ms, point]));
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  let lastValueIndex: number | null = null;
  let gap = false;
  for (const candle of bundle.candles) {
    if (!axis.contains(candle.ts_ms)) continue;
    const time = (axis.toVirtual(candle.ts_ms) / 1000) as UTCTimestamp;
    const point = points.get(candle.ts_ms);
    const value = subject === 'foreign' ? point?.foreign_net : point?.institution_net;
    if (value === undefined || !Number.isFinite(value)) {
      if (!gap && lastValueIndex !== null) {
        // LWC joins across whitespace. Mask the last real point's outgoing segment without inventing a zero.
        const previous = out[lastValueIndex];
        out[lastValueIndex] = { ...previous, ...LINE_HIDDEN_COLOR };
      }
      gap = true;
      out.push({ time });
      continue;
    }
    out.push({ time, value });
    lastValueIndex = out.length - 1;
    gap = false;
  }
  return out;
}

export const INVESTOR_NET_LINE_SPEC = {
  name: 'investor-net-line',
  bundleKind: 'candle',
  stretch: 0.5,
  legendToggleKey: 'investorNetLineEnabled',
  legendTitle: '외국인·기관 순매수 라인',
  useContext: useWindowIndicators,
  series: SUBJECTS.map(({ subject, label, color, visibility }) => ({
    type: LineSeries,
    options: {
      priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: formatKoreanK, minMove: 1 },
      autoscaleInfoProvider: includeZeroAutoscale,
    },
    renderOptions: (settings: IndicatorSettings) => ({
      color: settings[color], lineWidth: settings.investorNetLineWidth,
      crosshairMarkerBackgroundColor: settings[color],
      visible: lineVisible(settings.indicatorLineVisibility, visibility),
    }),
    data: (bundle: RangeBundle, axis: VirtualAxis) => projectInvestorNetLine(bundle, axis, subject),
    legend: { label, format: formatKoreanK },
    afterAdd: series => addZeroBaselineGuide(series, resolveTokensThemed({ baseline: ['--fg-dimmer', '#64748B'] }).baseline),
  })),
} satisfies BoundPaneSpec<IndicatorSettings>;
