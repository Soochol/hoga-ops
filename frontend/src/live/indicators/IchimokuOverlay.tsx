import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneSeriesMap } from '../../chart/drawing/chartCoordinates';
import { IchimokuPrimitive } from '../../chart/IchimokuPrimitive';
import { drawnCandleIndex } from '../../chart/drawnCandleIndex';
import { intradayCaptureBreaks } from '../../chart/intradayWhitespace';
import { ICHIMOKU_LINES, projectIchimoku, valuesAtDisplayBar } from '../../chart/projectors/ichimoku';
import { useActivePrefs } from '../../state/chartPrefs';
import { useWindowIndicator, useWindowIndicators, useWindowScopeId } from '../workspace/windowView';
import { formatInstrumentPrice } from '../instrumentPriceFormat';
import { registerFlagLegendValues, unregisterFlagLegendValues, type FlagLegendValueProvider } from './flagLegendValueRegistry';
import { ICHIMOKU_PRESENTATION, ichimokuStyle } from './ichimokuPresentation';

type Props = { bundle: RangeBundle; axis: VirtualAxis; paneSeries: PaneSeriesMap };
function IchimokuOverlay(props: Props) {
  const settings = useWindowIndicators();
  if (!settings.ichimokuEnabled) return null;
  return <ActiveIchimoku {...props} />;
}
function ActiveIchimoku({ bundle, axis, paneSeries }: Props) {
  const settings = useWindowIndicators();
  const hidden = useWindowIndicator(s => s.ichimokuHidden);
  const scope = useWindowScopeId();
  const candleOnlyScale = useActivePrefs(s => s.candlePaneCandleOnlyScale);
  const candleAlwaysOnTop = useActivePrefs(s => s.candleAlwaysOnTop);
  const series = paneSeries.get('candle') as ISeriesApi<SeriesType> | undefined;
  const primitive = useRef<IchimokuPrimitive | null>(null);
  const { ichimokuConversionPeriod: conversion, ichimokuBasePeriod: base, ichimokuLeadingBPeriod: leadingB, ichimokuDisplacement: displacement } = settings;
  const projection = useMemo(() => {
    const grid = drawnCandleIndex(bundle.candles, axis);
    if (grid.virtualSeconds.some((time, i) => !Number.isFinite(time) || (i > 0 && time <= grid.virtualSeconds[i - 1])))
      return { model: projectIchimoku([], { conversion, base, leadingB, displacement }), grid };
    const breaks = intradayCaptureBreaks(grid.virtualSeconds, bundle, axis);
    const bars = grid.drawn.map((c, i) => ({ virtualSecond: grid.virtualSeconds[i], high: c.high, low: c.low, close: c.close, breakBefore: breaks[i] }));
    return { model: projectIchimoku(bars, { conversion, base, leadingB, displacement }), grid };
  }, [bundle, axis, conversion, base, leadingB, displacement]);
  useEffect(() => {
    if (!series) return;
    const next = new IchimokuPrimitive(); primitive.current = next; series.attachPrimitive(next);
    return () => { primitive.current = null; next.setSnapshot(null); try { series.detachPrimitive(next); } catch { /* chart already removed */ } };
  }, [series]);
  useEffect(() => {
    primitive.current?.setSnapshot(hidden ? null : { model: projection.model, style: ichimokuStyle(settings), candleOnlyScale, candleAlwaysOnTop });
  }, [series, projection, settings, hidden, candleOnlyScale, candleAlwaysOnTop]);
  useEffect(() => {
    const style = ichimokuStyle(settings);
    const provider: FlagLegendValueProvider = time => {
      const index = time === null ? projection.model.bars.length - 1 : projection.grid.vsecToIndex.get(time);
      if (index === undefined || index < 0 || hidden) return [];
      const values = valuesAtDisplayBar(projection.model, index);
      return ICHIMOKU_LINES.filter(line => style.lines[line].visible).map((line, cellIndex) => ({ key: line,
        label: `${time === null && cellIndex === 0 ? '최근봉 위치 · ' : ''}${ICHIMOKU_PRESENTATION[line].label}`, color: style.lines[line].color,
        value: values[line] === null ? '—' : formatInstrumentPrice(values[line], bundle.code) }));
    };
    registerFlagLegendValues(scope, 'ichimoku', 'main', provider);
    return () => unregisterFlagLegendValues(scope, 'ichimoku', 'main', provider);
  }, [scope, projection, settings, hidden, bundle.code]);
  return null;
}
export default memo(IchimokuOverlay);
