import { lineVisible } from '../../state/indicatorLineVisibility';
import { memo, useEffect, useMemo, useRef } from 'react';
import { LineSeries, type AutoscaleInfoProvider, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useActivePrefs, useChartPrefsStore } from '../../state/chartPrefs';
import { keepCandlesOnTop } from '../../chart/candleSeriesOrder';
import { drawnCandleIndex } from '../../chart/drawnCandleIndex';
import { maskIntradayLineGaps } from '../../chart/intradayWhitespace';
import { computeBollingerBands } from '../../chart/projectors/bollingerBands';
import { selectSource } from '../../chart/projectors/movingAverage';
import { syncChartSeriesData } from '../../chart/replaceSeriesData';
import type { SeriesDataSink } from '../../chart/seriesDataDiff';
import { useWindowIndicator, useWindowScopeId } from '../workspace/windowView';
import { registerFlagLegendValues, unregisterFlagLegendValues, type FlagLegendValueProvider } from './flagLegendValueRegistry';

const LINE_KEYS = ['bollingerUpper', 'bollingerMiddle', 'bollingerLower'] as const;
const BANDS = ['upper', 'middle', 'lower'] as const;
const LABELS = { upper: '상단', middle: '중심', lower: '하단' };
const excludeFromAutoscale: AutoscaleInfoProvider = () => null;
const includeInAutoscale: AutoscaleInfoProvider = (original) => original();

function BollingerOverlay({ chart, bundle, axis }: { chart: IChartApi; bundle: RangeBundle; axis: VirtualAxis }) {
  const enabled = useWindowIndicator((s) => s.bollingerEnabled);
  const visibility = useWindowIndicator(s => s.indicatorLineVisibility);
  const hidden = useWindowIndicator((s) => s.bollingerHidden);
  const period = useWindowIndicator((s) => s.bollingerPeriod);
  const multiplier = useWindowIndicator((s) => s.bollingerMultiplier);
  const source = useWindowIndicator((s) => s.bollingerSource);
  const upper = useWindowIndicator((s) => s.bollingerUpperColor);
  const middle = useWindowIndicator((s) => s.bollingerMiddleColor);
  const lower = useWindowIndicator((s) => s.bollingerLowerColor);
  const lineWidth = useWindowIndicator((s) => s.bollingerLineWidth);
  const candleOnlyScale = useChartPrefsStore((s) => s.candlePaneCandleOnlyScale);
  const candleAlwaysOnTop = useActivePrefs((s) => s.candleAlwaysOnTop);
  const scope = useWindowScopeId();
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const pushedRef = useRef(new WeakMap<ISeriesApi<'Line'>, ReturnType<typeof syncChartSeriesData>>());
  const projection = useMemo(() => {
    if (!enabled) return null;
    const grid = drawnCandleIndex(bundle.candles, axis);
    const values = computeBollingerBands(grid.drawn.map((c) => selectSource(c, source)), period, multiplier);
    return { grid, values, data: BANDS.map((band) => values.map((v, i) => v === null
      ? { time: grid.virtualSeconds[i] as Time }
      : { time: grid.virtualSeconds[i] as Time, value: v[band] })).map(data => maskIntradayLineGaps(data, bundle, axis)) };
  }, [bundle, axis, enabled, period, multiplier, source]);

  useEffect(() => {
    if (!enabled) return;
    const series = BANDS.map(() => chart.addSeries(LineSeries, {
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'), minMove: 1 },
    }, 0));
    seriesRef.current = series;
    return () => {
      seriesRef.current = [];
      for (const s of series) { try { chart.removeSeries(s); } catch { /* chart torn down */ } }
    };
  }, [chart, enabled]);

  useEffect(() => {
    const colors = { upper, middle, lower };
    for (let i = 0; i < seriesRef.current.length; i++) {
      const s = seriesRef.current[i];
      s.applyOptions({ color: colors[BANDS[i]], lineWidth, visible: !hidden && lineVisible(visibility, LINE_KEYS[i]),
        autoscaleInfoProvider: candleOnlyScale ? excludeFromAutoscale : includeInAutoscale });
      pushedRef.current.set(s, syncChartSeriesData(chart, s as unknown as SeriesDataSink,
        pushedRef.current.get(s) ?? null, projection?.data[i] ?? []));
    }
    if (enabled && candleAlwaysOnTop) keepCandlesOnTop(chart);
  }, [chart, enabled, projection, hidden, visibility, upper, middle, lower, lineWidth, candleOnlyScale, candleAlwaysOnTop]);

  useEffect(() => {
    if (!projection) return;
    const colors = { upper, middle, lower };
    const provider: FlagLegendValueProvider = (time) => {
      const index = time === null ? projection.values.length - 1 : projection.grid.vsecToIndex.get(time);
      const value = index === undefined ? null : projection.values[index];
      return value == null ? [] : BANDS.filter((_, i) => lineVisible(visibility, LINE_KEYS[i])).map((band) => ({
        key: band, label: LABELS[band], color: colors[band], value: Math.round(value[band]).toLocaleString('ko-KR'),
      }));
    };
    registerFlagLegendValues(scope, 'bollinger', 'main', provider);
    return () => unregisterFlagLegendValues(scope, 'bollinger', 'main', provider);
  }, [scope, projection, upper, middle, lower, visibility]);
  return null;
}

export default memo(BollingerOverlay);
