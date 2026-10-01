import { describe, expect, it, vi } from 'vitest';
import { LineSeries, CandlestickSeries, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { createWindowedChart, flushWindowedChart, setWindowedChartTimeMapping, windowedChartDiagnostics } from './windowedChart';

/** A union-time chart model (not a candle-count time scale). Native browser
 * integration is covered separately by the backfill/viewport E2E driver. */
function fixture() {
  const series: any[] = [];
  const logicalListeners = new Set<() => void>();
  const mouseListeners = new Set<(p: any) => void>();
  let range: { from: number; to: number } | null = null;
  const times = () => [...new Set<number>(series.flatMap((s) => s.data().map((p: any) => p.time)))].sort((a, b) => a - b);
  const emit = () => { for (const cb of logicalListeners) cb(); };
  const scale = {
    getVisibleLogicalRange: () => range,
    setVisibleLogicalRange: (r: { from: number; to: number }) => { range = r; emit(); },
    options: () => ({ barSpacing: 5, rightOffset: 10 }),
    applyOptions: vi.fn(),
    width: () => 500,
    subscribeVisibleLogicalRangeChange: (cb: () => void) => logicalListeners.add(cb),
    logicalToCoordinate: (i: number) => range ? (i - range.from) * 5 : null,
    coordinateToLogical: (x: number) => range ? x / 5 + range.from : null,
    timeToIndex: (t: number) => { const i = times().indexOf(t); return i < 0 ? null : i; },
    scrollPosition: () => range ? range.to - (times().length - 1) : 0,
    scrollToPosition: (p: number) => {
      const to = times().length - 1 + p;
      scale.setVisibleLogicalRange({ from: to - (range!.to - range!.from), to });
    },
  };
  const native = {
    timeScale: () => scale,
    addSeries: (definition: any, options: any = {}) => {
      let data: any[] = [];
      const s = {
        options: () => ({ priceLineVisible: false, lastValueVisible: false, ...options }),
        seriesType: () => definition.type,
        setData: vi.fn((next: any[]) => { data = next; range ??= { from: 0, to: 100 }; emit(); }),
        update: vi.fn((point: any) => { if (data.at(-1)?.time === point.time) data[data.length - 1] = point; else data.push(point); }),
        data: () => data,
        attachPrimitive: vi.fn((p: any) => p.attached?.({ chart: native, series: s, requestUpdate: vi.fn() })),
        detachPrimitive: vi.fn(),
      };
      series.push(s);
      return s;
    },
    removeSeries: vi.fn((s) => series.splice(series.indexOf(s), 1)),
    panes: () => [{ getSeries: () => series }],
    options: () => ({ timeScale: { barSpacing: 5 } }),
    clearCrosshairPosition: vi.fn(),
    setCrosshairPosition: vi.fn(),
    subscribeCrosshairMove: (cb: (p: any) => void) => mouseListeners.add(cb),
    unsubscribeCrosshairMove: (cb: (p: any) => void) => mouseListeners.delete(cb),
    subscribeDblClick: vi.fn(),
    remove: vi.fn(),
  };
  const chart = createWindowedChart(native as unknown as IChartApi);
  const rows = Array.from({ length: 8000 }, (_, i) => ({ time: (i * 60 + 100000) as Time, value: i }));
  return { chart, native, rows, mouse: (p: any) => { for (const cb of mouseListeners) cb(p); } };
}

describe('full-history chart / bounded native renderer', () => {
  it('reports the drawn range while retaining pending pan intent across a prepend', () => {
    const { chart, native, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows.slice(-100)); flushWindowedChart(chart);
    const before = chart.timeScale().getVisibleLogicalRange();
    const scale = native.timeScale();
    const apply = scale.setVisibleLogicalRange;
    let pending: { from: number; to: number } | null = null;
    scale.setVisibleLogicalRange = r => { pending = r; };
    chart.timeScale().setVisibleLogicalRange({ from: -10.5, to: 110.5 });
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual(before);
    const older = Array.from({ length: 1000 }, (_, i) => ({ time: (40000 + i * 60) as Time, value: -i }));
    line.setData([...older, ...rows.slice(-100)]); flushWindowedChart(chart);
    expect(pending).not.toBeNull();
    apply(pending!);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 989.5, to: 1110.5 });
    chart.remove();
  });

  it('batches a commit and keeps full data, latest lookup and union indices', () => {
    const { chart, native, rows } = fixture();
    const a = chart.addSeries(LineSeries);
    const b = chart.addSeries(LineSeries);
    a.setData(rows);
    b.setData([{ time: 100030 as Time, value: 20 }]); // extra union slot
    expect(native.panes()[0].getSeries()[0].setData).not.toHaveBeenCalled();
    flushWindowedChart(chart);
    expect(a.data()).toBe(rows);
    expect(chart.timeScale().timeToIndex(rows[7000].time)).toBe(7001);
    expect(a.dataByIndex(7001)).toBe(rows[7000]);
    expect(a.dataByIndex(Number.MAX_SAFE_INTEGER, -1)).toBe(rows.at(-1));
    expect(windowedChartDiagnostics(chart)?.renderedPoints).toBeLessThan(1000);
    expect(windowedChartDiagnostics(chart)?.fullPoints).toBe(8001);
    expect(native.panes()[0].getSeries()[0].setData).toHaveBeenCalledTimes(1);
  });

  it('moves through cached history using global coordinates without a false left edge', async () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows); flushWindowedChart(chart);
    const listener = vi.fn();
    chart.timeScale().subscribeVisibleLogicalRangeChange(listener);
    chart.timeScale().setVisibleLogicalRange({ from: 1800.25, to: 1900.25 });
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 1800.25, to: 1900.25 });
    await vi.waitFor(() => expect(listener.mock.lastCall?.[0].from).toBe(1800.25));
    expect(chart.timeScale().coordinateToTime(0)).toBe(rows[1800].time);
    expect(chart.timeScale().timeToCoordinate(rows[1820].time)).toBe(98.75);
    expect(chart.timeScale().coordinateToLogical(98.75)).toBe(1820);
    expect(chart.timeScale().scrollPosition()).toBe(1900.25 - 7999);
    chart.timeScale().scrollToPosition(10, false);
    expect(chart.timeScale().getVisibleLogicalRange()?.to).toBe(8009);
    chart.timeScale().setVisibleLogicalRange({ from: -50, to: 50 });
    await vi.waitFor(() => expect(listener.mock.lastCall?.[0].from).toBe(-50));
    chart.remove();
  });

  it('keeps original MA values and sparse line neighbours on the common union window', () => {
    const { chart, native, rows } = fixture();
    chart.addSeries(LineSeries).setData(rows);
    const sparse = chart.addSeries(LineSeries);
    const knots = [rows[1500], rows[1700], rows[2200], rows[2300], rows[2500]];
    sparse.setData(knots); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 1900, to: 2000 });
    const d = windowedChartDiagnostics(chart)!;
    expect(d.offset).toBeLessThanOrEqual(1500);
    expect(d.renderedPoints).toBeLessThan(2000);
    const actual = native.panes()[0].getSeries();
    expect(actual[1].data()).toEqual(knots);
    expect(actual[0].data()[1900 - d.offset]).toBe(rows[1900]);
    expect(chart.timeScale().timeToCoordinate(rows[1900].time)).toBe(0);
  });

  it('preserves the viewed timestamp on prepend without caller repair', () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 2000.5, to: 2100.5 });
    const beforeX = chart.timeScale().timeToCoordinate(rows[2050].time);
    const extra = Array.from({ length: 1000 }, (_, i) => ({ time: (40000 + i * 60) as Time, value: -i }));
    line.setData([...extra, ...rows]); flushWindowedChart(chart);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 3000.5, to: 3100.5 });
    expect(chart.timeScale().timeToCoordinate(rows[2050].time)).toBe(beforeX);
    expect(line.dataByIndex(3050)).toBe(rows[2050]);
    chart.remove();
  });

  it('keeps the latest seed and zoom while multiple history batches arrive before a frame', () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows.slice(-26)); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: -274, to: 40 });
    const last = rows.at(-1)!.time;
    const x = chart.timeScale().timeToCoordinate(last);
    line.setData(rows.slice(-52)); flushWindowedChart(chart);
    line.setData(rows.slice(-78)); flushWindowedChart(chart);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: -222, to: 92 });
    expect(chart.timeScale().timeToCoordinate(last)).toBe(x);
    chart.remove();
  });

  it('uses the previous real-time mapping when the virtual axis rebases', () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    setWindowedChartTimeMapping(chart, { toReal: t => t * 1000, fromReal: t => t / 1000 });
    line.setData(rows); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 2000.5, to: 2100.5 });
    const x = chart.timeScale().timeToCoordinate(rows[2050].time);
    const rebase = 86400;
    setWindowedChartTimeMapping(chart, { toReal: t => (t + rebase) * 1000, fromReal: t => t / 1000 - rebase });
    const older = Array.from({ length: 100 }, (_, i) => ({ time: (40000 + i * 60 - rebase) as Time, value: -i }));
    line.setData([...older, ...rows.map(p => ({ ...p, time: (Number(p.time) - rebase) as Time }))]);
    flushWindowedChart(chart);
    expect(chart.timeScale().timeToCoordinate((Number(rows[2050].time) - rebase) as Time)).toBe(x);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 2100.5, to: 2200.5 });
    chart.remove();
  });

  it('preserves a candle anchor when only an indicator changes the union grid', async () => {
    const { chart, rows } = fixture();
    const candle = chart.addSeries(CandlestickSeries);
    candle.setData(rows.map(p => ({ time: p.time, open: p.value, high: p.value, low: p.value, close: p.value })));
    flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 2000.5, to: 2100.5 });
    const x = chart.timeScale().timeToCoordinate(rows[2050].time);
    const indicator = chart.addSeries(LineSeries);
    indicator.setData(rows.slice(0, 100).map(p => ({ ...p, time: (Number(p.time) + 30) as Time })));
    await Promise.resolve(); // child-only microtask commit, no root flush
    expect(chart.timeScale().timeToCoordinate(rows[2050].time)).toBe(x);
    chart.removeSeries(indicator);
    await Promise.resolve();
    expect(chart.timeScale().timeToCoordinate(rows[2050].time)).toBe(x);
    chart.remove();
  });

  it('follows new candles at the latest edge, and leaves historical views alone', () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 7900, to: 8010 });
    const x = chart.timeScale().timeToCoordinate(rows.at(-1)!.time);
    const next = { time: (Number(rows.at(-1)!.time) + 60) as Time, value: 8000 };
    line.update(next); flushWindowedChart(chart);
    expect(chart.timeScale().timeToCoordinate(next.time)).toBe(x);
    chart.timeScale().setVisibleLogicalRange({ from: 1900, to: 2000 });
    const historicX = chart.timeScale().timeToCoordinate(rows[1950].time);
    line.update({ time: (Number(next.time) + 60) as Time, value: 8001 }); flushWindowedChart(chart);
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 1900, to: 2000 });
    expect(chart.timeScale().timeToCoordinate(rows[1950].time)).toBe(historicX);
    chart.remove();
  });

  it('uses the last actual candle instead of an indicator or whitespace tail', () => {
    const { chart, rows } = fixture();
    const candle = chart.addSeries(CandlestickSeries);
    const bars = rows.slice(-26).map(p => ({ time: p.time, open: p.value, high: p.value, low: p.value, close: p.value }));
    candle.setData([...bars, { time: (Number(rows.at(-1)!.time) + 600) as Time }]);
    flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: -274, to: 40 });
    const x = chart.timeScale().timeToCoordinate(bars.at(-1)!.time);
    const indicator = chart.addSeries(LineSeries);
    indicator.setData(rows.slice(-52).map(p => ({ ...p, time: (Number(p.time) + 30) as Time })));
    flushWindowedChart(chart);
    expect(chart.timeScale().timeToCoordinate(bars.at(-1)!.time)).toBe(x);
    chart.remove();
  });

  it('rebases animation endpoints on new data and cancels on an explicit pan', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callbacks.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => callbacks.delete(key));
    try {
      const { chart, rows } = fixture();
      const line = chart.addSeries(LineSeries);
      line.setData(rows); flushWindowedChart(chart);
      chart.timeScale().setVisibleLogicalRange({ from: 1900, to: 2000 });
      chart.timeScale().scrollToRealTime();
      const extras = Array.from({ length: 100 }, (_, i) => ({ time: (40000 + i * 60) as Time, value: -i }));
      const last = { time: (Number(rows.at(-1)!.time) + 60) as Time, value: 8000 };
      line.setData([...extras, ...rows, last]); flushWindowedChart(chart);
      const frame = [...callbacks.values()]; callbacks.clear();
      for (const cb of frame) cb(performance.now() + 500);
      expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 8010, to: 8110 });
      chart.timeScale().setVisibleLogicalRange({ from: 2000, to: 2100 });
      chart.timeScale().scrollToRealTime();
      chart.timeScale().setVisibleLogicalRange({ from: 1800, to: 1900 });
      const canceled = [...callbacks.values()]; callbacks.clear();
      for (const cb of canceled) cb(performance.now() + 500);
      expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 1800, to: 1900 });
      chart.remove();
    } finally { vi.unstubAllGlobals(); }
  });

  it('stores offscreen live updates without corrupting projection arrays, then reveals them', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: (time: number) => void) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    const { chart, native, rows } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 1900, to: 2000 });
    const actual = native.panes()[0].getSeries()[0];
    actual.setData.mockClear(); actual.update.mockClear();
    const latest = { ...rows.at(-1)!, value: 99999 };
    line.update(latest); flushWindowedChart(chart);
    expect(rows.at(-1)!.value).toBe(7999);
    expect(line.dataByIndex(Number.MAX_SAFE_INTEGER, -1)).toBe(latest);
    expect(actual.setData).not.toHaveBeenCalled();
    expect(actual.update).not.toHaveBeenCalled();
    chart.timeScale().scrollToRealTime();
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(actual.data().at(-1)).toBe(latest);
    chart.remove();
    vi.unstubAllGlobals();
  });

  it('translates crosshair series/indices and primitive attachment; removal cancels queued work', async () => {
    const { chart, native, rows, mouse } = fixture();
    const line = chart.addSeries(LineSeries);
    line.setData(rows); flushWindowedChart(chart);
    chart.timeScale().setVisibleLogicalRange({ from: 1900, to: 2000 });
    const raw = native.panes()[0].getSeries()[0];
    const callback = vi.fn(); chart.subscribeCrosshairMove(callback);
    const offset = windowedChartDiagnostics(chart)!.offset;
    mouse({ logical: 1900 - offset, seriesData: new Map([[raw, rows[1900]]]), hoveredSeries: raw });
    expect(callback.mock.lastCall?.[0].logical).toBe(1900);
    expect(callback.mock.lastCall?.[0].seriesData.get(line)).toBe(rows[1900]);
    expect(callback.mock.lastCall?.[0].hoveredSeries).toBe(line);
    chart.setCrosshairPosition(10, rows[1900].time, line);
    expect(native.setCrosshairPosition).toHaveBeenCalledWith(10, rows[1900].time, raw);
    const primitive = { attached: vi.fn() }; line.attachPrimitive(primitive);
    expect(primitive.attached.mock.lastCall?.[0].chart).toBe(chart);
    expect(primitive.attached.mock.lastCall?.[0].series).toBe(line);
    chart.unsubscribeCrosshairMove(callback);
    line.setData(rows); chart.remove();
    await Promise.resolve();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });

  it('uses full rendering for short histories, fit-content and native latest-value labels', () => {
    const { chart, rows } = fixture();
    const line = chart.addSeries(LineSeries, { lastValueVisible: true });
    line.setData(rows); flushWindowedChart(chart);
    expect(windowedChartDiagnostics(chart)?.renderedPoints).toBe(8000);
    chart.removeSeries(line as ISeriesApi<any>); flushWindowedChart(chart);
    const candle = chart.addSeries(CandlestickSeries);
    candle.setData(rows.slice(0, 100).map((p) => ({ time: p.time, open: p.value, high: p.value, low: p.value, close: p.value })));
    flushWindowedChart(chart);
    expect(windowedChartDiagnostics(chart)?.renderedPoints).toBe(100);
    chart.timeScale().fitContent();
    expect(chart.timeScale().getVisibleLogicalRange()).toEqual({ from: 0, to: 99 });
    chart.remove();
  });
});
