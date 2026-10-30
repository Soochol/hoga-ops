import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../../../src/styles/global.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle, RangeBundle } from '../../../src/api/types';
import CandleTooltip from '../../../src/live/CandleTooltip';
import MovingAverageOverlay from '../../../src/live/indicators/MovingAverageOverlay';
import { useLivePageStore } from '../../../src/state/livePage';
import { useChartPrefsStore } from '../../../src/state/chartPrefs';
import { createVirtualAxis } from '../../../src/util/virtualAxis';

const open = Date.UTC(2026, 9, 30, 0);
const axis = createVirtualAxis([{ date: '20261030', sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open);
const candles: Candle[] = Array.from({ length: 24 }, (_, index) => ({
  ts_ms: open + index * 60_000, open: 100, high: 112, low: 98,
  close: index === 23 ? 110 : 100, vol_a: 10, vol_b: 0,
}));
let updateClose: () => void;
let currentChart: IChartApi;
let currentCandles: ISeriesApi<'Candlestick'>;

// This browser-test entry point exports mount rather than a Fast Refresh component.
// eslint-disable-next-line react-refresh/only-export-components
function Harness({ chart, candleSeries }: { chart: IChartApi; candleSeries: ISeriesApi<'Candlestick'> }) {
  const [rows, setRows] = useState(candles);
  useEffect(() => {
    updateClose = () => setRows(previous => previous.map((row, i) => i === 23 ? { ...row, close: 120, high: 122 } : row));
  }, []);
  useEffect(() => {
    candleSeries.setData(rows.map(c => ({ time: (c.ts_ms / 1000) as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close })));
  }, [rows, candleSeries]);
  const bundle = { code: '005930', candles: rows } as RangeBundle;
  return <>
    <MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />
    <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={new Map([['candle', candleSeries]])} timeframe="1m" />
  </>;
}

export function update() { updateClose(); }

export function hoverPoint() {
  const rect = currentChart.chartElement().getBoundingClientRect();
  const x = currentChart.timeScale().timeToCoordinate((candles[23].ts_ms / 1000) as UTCTimestamp);
  const y = currentCandles.priceToCoordinate(candles[23].close);
  return x === null || y === null ? null : { x: rect.left + x, y: rect.top + y };
}

export function mount(width: number, theme: string) {
  document.documentElement.dataset.theme = theme;
  useChartPrefsStore.setState({ candleTooltipEnabled: true });
  useLivePageStore.setState({
    movingAverages: [
      { id: 'ma-2', period: 2, source: 'close', enabled: true, color: '#EC4899', lineWidth: 1 },
      { id: 'ma-5', period: 5, source: 'close', enabled: true, color: '#22C55E', lineWidth: 1 },
    ], dailyMovingAverages: [], indicatorInstances: [], indicatorPrimaryHidden: [],
  });
  const container = document.createElement('div');
  container.style.cssText = `position:relative;width:${width}px;height:360px;margin:20px`;
  container.dataset.testid = 'chart-container';
  document.body.append(container);
  const style = getComputedStyle(document.documentElement);
  const chart = createChart(container, { width, height: 360,
    layout: { attributionLogo: false, background: { type: ColorType.Solid, color: style.getPropertyValue('--bg').trim() },
      textColor: style.getPropertyValue('--fg').trim() }, timeScale: { timeVisible: true } });
  const candleSeries = chart.addSeries(CandlestickSeries);
  currentChart = chart;
  currentCandles = candleSeries;
  const host = document.createElement('div');
  container.append(host);
  flushSync(() => createRoot(host).render(<Harness chart={chart} candleSeries={candleSeries} />));
  chart.timeScale().fitContent();
}
