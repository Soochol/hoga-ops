import { useEffect } from 'react';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = {
  bid: ['--price-up',   '#DC2626'],  // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#2563EB'],  // 매도 호가 총합 (KRX 파랑)
} as const;

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  /** Pane index for multi-pane split. Defaults to 0. */
  paneIndex?: number;
};

/**
 * QuoteTotalsPane — paints the 매수 1–10호가 / 매도 1–10호가 quantity
 * totals as two LineSeries on the shared chart. Reads from
 * bundle.quote_ratio.points (the same wire field RatioPane derives 호가비
 * from); the field's name reflects the derived view but carries the raw
 * totals too — see CONTEXT.md "Quote Totals".
 */
export default function QuoteTotalsPane({
  chart,
  bundle,
  axis,
  paneIndex = 0,
}: Props) {
  useEffect(() => {
    const { bid, ask } = resolveTokens(TOKEN_SPEC);
    const priceFormat = {
      type: 'custom' as const,
      formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
      minMove: 1,
    };
    const bidSeries = chart.addSeries(
      LineSeries,
      { color: bid, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false } as any,
      paneIndex,
    );
    const askSeries = chart.addSeries(
      LineSeries,
      { color: ask, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false } as any,
      paneIndex,
    );
    const inSession = bundle.quote_ratio.points.filter((p) => axis.contains(p.t));
    bidSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.bid_total,
      })),
    );
    askSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.ask_total,
      })),
    );
    return () => {
      try { chart.removeSeries(bidSeries); } catch {}
      try { chart.removeSeries(askSeries); } catch {}
    };
  }, [chart, bundle, axis, paneIndex]);
  return null;
}
