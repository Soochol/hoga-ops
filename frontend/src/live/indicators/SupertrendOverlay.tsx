import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type AutoscaleInfoProvider, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useActivePrefs, useChartPrefsStore } from '../../state/chartPrefs';
import { keepCandlesOnTop } from '../../chart/candleSeriesOrder';
import { drawnCandleIndex } from '../../chart/drawnCandleIndex';
import { computeSupertrend, supertrendLineData } from '../../chart/projectors/supertrend';
import { syncChartSeriesData } from '../../chart/replaceSeriesData';
import type { SeriesDataSink } from '../../chart/seriesDataDiff';
import { useWindowIndicator, useWindowScopeId } from '../workspace/windowView';
import { registerFlagLegendValues, unregisterFlagLegendValues, type FlagLegendValueProvider } from './flagLegendValueRegistry';

const excludeFromAutoscale: AutoscaleInfoProvider = () => null;
const includeInAutoscale: AutoscaleInfoProvider = (original) => original();

function SupertrendOverlay({ chart, bundle, axis }: { chart: IChartApi; bundle: RangeBundle; axis: VirtualAxis }) {
  const enabled = useWindowIndicator((s) => s.supertrendEnabled);
  const hidden = useWindowIndicator((s) => s.supertrendHidden);
  const period = useWindowIndicator((s) => s.supertrendPeriod);
  const multiplier = useWindowIndicator((s) => s.supertrendMultiplier);
  const upColor = useWindowIndicator((s) => s.supertrendUpColor);
  const downColor = useWindowIndicator((s) => s.supertrendDownColor);
  const lineWidth = useWindowIndicator((s) => s.supertrendLineWidth);
  const candleOnlyScale = useChartPrefsStore((s) => s.candlePaneCandleOnlyScale);
  const candleAlwaysOnTop = useActivePrefs((s) => s.candleAlwaysOnTop);
  const scope = useWindowScopeId();
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const pushedRef = useRef<ReturnType<typeof syncChartSeriesData>>(null);
  const projection = useMemo(() => {
    if (!enabled) return null;
    const grid = drawnCandleIndex(bundle.candles, axis);
    return { grid, values: computeSupertrend(grid.drawn, period, multiplier) };
  }, [bundle.candles, axis, enabled, period, multiplier]);
  const data = useMemo(() => projection
    ? supertrendLineData(projection.values, projection.grid.virtualSeconds, upColor, downColor) : [],
  [projection, upColor, downColor]);

  useEffect(() => {
    if (!enabled) return;
    const series = chart.addSeries(LineSeries, {
      title: '슈퍼트렌드', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'), minMove: 1 },
    }, 0);
    seriesRef.current = series;
    pushedRef.current = null;
    return () => {
      seriesRef.current = null;
      pushedRef.current = null;
      try { chart.removeSeries(series); } catch { /* chart torn down */ }
    };
  }, [chart, enabled]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.applyOptions({ color: upColor, lineWidth, visible: !hidden,
      autoscaleInfoProvider: candleOnlyScale ? excludeFromAutoscale : includeInAutoscale });
    pushedRef.current = syncChartSeriesData(chart, series as unknown as SeriesDataSink, pushedRef.current, data);
    if (candleAlwaysOnTop) keepCandlesOnTop(chart);
  }, [chart, enabled, data, hidden, upColor, lineWidth, candleOnlyScale, candleAlwaysOnTop]);

  useEffect(() => {
    if (!projection) return;
    const provider: FlagLegendValueProvider = (time) => {
      const index = time === null ? projection.values.length - 1 : projection.grid.vsecToIndex.get(time);
      const point = index === undefined ? null : projection.values[index];
      return point == null ? [] : [{
        key: 'trend', label: point.direction === 'up' ? '상승' : '하락',
        color: point.direction === 'up' ? upColor : downColor,
        value: Math.round(point.value).toLocaleString('ko-KR'),
      }];
    };
    registerFlagLegendValues(scope, 'supertrend', 'main', provider);
    return () => unregisterFlagLegendValues(scope, 'supertrend', 'main', provider);
  }, [scope, projection, upColor, downColor]);
  return null;
}

export default memo(SupertrendOverlay);
