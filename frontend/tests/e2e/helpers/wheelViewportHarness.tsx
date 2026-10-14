// Isolated real-library wheel regression harness: real chart library and production wheel hook.
import { createRoot } from 'react-dom/client';
import { createChart, CandlestickSeries, type UTCTimestamp } from 'lightweight-charts';
import { createWindowedChart, flushWindowedChart, windowedChartDiagnostics } from '../../../src/chart/windowedChart';
import type { RangeBundle } from '../../../src/api/types';
import { createVirtualAxis } from '../../../src/util/virtualAxis';
import { useWheelInteractions } from '../../../src/live/useWheelInteractions';
import { retainRightPriceScaleWidth } from '../../../src/chart/util/retainRightPriceScaleWidth';

export async function mount(windowed: boolean, count = 8000, interval = 60) {
  const host = document.createElement('div');
  const container = document.createElement('div');
  host.append(container); document.body.append(host);
  const native = createChart(container, { width: 1000, height: 500,
    handleScale: { mouseWheel: false },
    timeScale: { minBarSpacing: .5, rightOffset: 12 } });
  const chart = windowed ? createWindowedChart(native) : native;
  retainRightPriceScaleWidth(chart);
  const series = chart.addSeries(CandlestickSeries, { priceLineVisible: false, lastValueVisible: false });
  const base = Date.UTC(2026, 8, 1) / 1000;
  const rows = Array.from({ length: count }, (_, i) => ({ time: (base + i * interval) as UTCTimestamp,
    open: 100 + i / 100, high: 101 + i / 100, low: 99 + i / 100, close: 100 + i / 100 }));
  series.setData(rows); flushWindowedChart(chart);
  const axis = createVirtualAxis([{ date: '20260901', sessionOpenMs: base * 1000,
    sessionCloseMs: Number(rows.at(-1)!.time) * 1000 }], base * 1000);
  const bundle = { candles: [{ ts_ms: Number(rows.at(-1)!.time) * 1000 }] } as unknown as RangeBundle;
  const ref = { current: container };
  const changes: { from: number; to: number }[] = [];
  const onChanged = (range: { from: number; to: number }) => changes.push({ ...range });
  function Hook() { useWheelInteractions(chart, ref, bundle, axis, onChanged); return null; }
  const rootHost = document.createElement('div'); document.body.append(rootHost);
  const root = createRoot(rootHost); root.render(<Hook />);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await frame();
  const snap = () => {
    const ts = chart.timeScale(); const d = windowedChartDiagnostics(chart);
    return { range: ts.getVisibleLogicalRange(), nativeRange: native.timeScale().getVisibleLogicalRange(),
      offset: d?.offset ?? 0, rendered: d?.renderedPoints ?? count,
      mouseIndex: ts.coordinateToLogical(450), x: ts.timeToCoordinate(rows[1850].time),
      spacing: ts.options().barSpacing, changes: [...changes] };
  };
  const wheel = (deltaY: number, ctrlKey: boolean, deltaX = 0, shiftKey = false, mouseX = 450) => {
    const rect = container.getBoundingClientRect();
    container.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY, deltaX, ctrlKey, shiftKey,
      clientX: rect.left + mouseX, clientY: rect.top + 200 }));
  };
  return { chart, rows, series, snap, wheel, frame, changes };
}
