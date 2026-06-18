import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useLivePageStore, DEFAULT_LIVE_MAS } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import MovingAverageOverlay from './MovingAverageOverlay';
import { useMaSeriesRegistry } from './maSeriesRegistry';

// Minimal IChartApi mock — captures addSeries / removeSeries / applyOptions
// / setData calls so we can assert on series lifecycle without booting
// lightweight-charts.
function makeChartMock() {
  const seriesById = new Map<string, ReturnType<typeof makeSeriesMock>>();
  let seriesCounter = 0;
  function makeSeriesMock() {
    return {
      applyOptions: vi.fn(),
      setData: vi.fn(),
      _internalId: ++seriesCounter,
    };
  }
  const addSeries = vi.fn((_type: unknown, options: { color: string }) => {
    const s = makeSeriesMock();
    seriesById.set(String(s._internalId), s);
    (s as unknown as { _color: string })._color = options.color;
    return s;
  });
  const removeSeries = vi.fn((s: ReturnType<typeof makeSeriesMock>) => {
    seriesById.delete(String(s._internalId));
  });
  return { chart: { addSeries, removeSeries } as unknown, addSeries, removeSeries, seriesById };
}

// 5 trivial in-session candles, ts_ms ascending.
const candles = [1, 2, 3, 4, 5].map((i) => ({
  ts_ms: i * 1000, open: i, close: i, high: i, low: i, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
// axis.contains true for all (in-session); toVirtual identity.
const axis = { contains: () => true, toVirtual: (m: number) => m } as never;

describe('MovingAverageOverlay', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      movingAverageEnabled: true,
      movingAverageHidden: false,
    });
    useChartPrefsStore.getState().resetToDefaults();
    useMaSeriesRegistry.setState({ series: new Map() });
  });

  it('mounts one LineSeries per configured slot', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries).toHaveBeenCalledTimes(DEFAULT_LIVE_MAS.length);
  });

  it('기본값에서는 MA series가 autoscale에 참여한다', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const options = m.addSeries.mock.calls[0][1] as { autoscaleInfoProvider?: unknown };
    expect(options.autoscaleInfoProvider).toBeUndefined();
  });

  it('캔들 기준 Y축이 켜지면 MA series autoscale 기여를 제외한다', () => {
    const m = makeChartMock();
    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', true);
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const options = m.addSeries.mock.calls[0][1] as { autoscaleInfoProvider?: () => null };
    expect(options.autoscaleInfoProvider).toBeDefined();
    expect(options.autoscaleInfoProvider?.()).toBeNull();
  });

  it('캔들 기준 Y축을 끄면 기존 MA series autoscale을 기본 동작으로 되돌린다', () => {
    const m = makeChartMock();
    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', true);
    const { rerender } = render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const first = m.addSeries.mock.results[0].value as { applyOptions: ReturnType<typeof vi.fn> };
    first.applyOptions.mockClear();

    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', false);
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);

    const scaleCall = first.applyOptions.mock.calls.find((c) => 'autoscaleInfoProvider' in (c[0] as object));
    const provider = (scaleCall?.[0] as { autoscaleInfoProvider?: (original: () => string) => string }).autoscaleInfoProvider;
    expect(provider?.(() => 'default-autoscale')).toBe('default-autoscale');
  });

  it('calls setData on each mounted series', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    for (const [, s] of m.seriesById) {
      expect(s.setData).toHaveBeenCalled();
    }
  });

  it('addMovingAverage triggers one addSeries (no churn on existing slots)', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const callsBefore = m.addSeries.mock.calls.length;
    useLivePageStore.getState().addMovingAverage();
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries.mock.calls.length).toBe(callsBefore + 1);
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('setMovingAverage(period) does NOT call addSeries/removeSeries', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[0].id;
    m.addSeries.mockClear();
    m.removeSeries.mockClear();
    useLivePageStore.getState().setMovingAverage(id, { period: 7 });
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries).not.toHaveBeenCalled();
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('setMovingAverage(color) calls applyOptions with new color', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { color: '#06B6D4' });
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const lastApply = Array.from(m.seriesById.values()).flatMap(
      (s) => s.applyOptions.mock.calls,
    );
    expect(lastApply.some((c) => (c[0] as { color: string }).color === '#06B6D4')).toBe(true);
  });

  it('removeMovingAverage calls removeSeries once', () => {
    const m = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const id = useLivePageStore.getState().movingAverages[1].id;
    useLivePageStore.getState().removeMovingAverage(id);
    rerender(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.removeSeries).toHaveBeenCalledTimes(1);
  });

  it('disabled slot setData receives empty array', () => {
    const m = makeChartMock();
    const id = useLivePageStore.getState().movingAverages[0].id;
    useLivePageStore.getState().setMovingAverage(id, { enabled: false });
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    // First-added series corresponds to the first config (id matched).
    const first = m.addSeries.mock.results[0].value as ReturnType<typeof Object> & { setData: ReturnType<typeof vi.fn> };
    const lastSetData = (first.setData as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastSetData?.[0]).toEqual([]);
  });

  it('out-of-session candles are excluded from SMA input', () => {
    const m = makeChartMock();
    // Mark middle candle as out-of-session.
    const customAxis = {
      contains: (ms: number) => ms !== 3000,
      toVirtual: (ms: number) => ms,
    } as never;
    // Force a single slot with period=2 for an easy assertion.
    useLivePageStore.setState({
      movingAverages: [{
        id: 's', enabled: true, period: 2, color: '#fff', lineWidth: 1, source: 'close',
      }],
    });
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={customAxis} />);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    // In-session: [1, 2, 4, 5]; SMA(2) = [null, 1.5, 3, 4.5]
    // Time is in seconds (UTCTimestamp = ms / 1000 per codebase convention).
    expect(data).toHaveLength(4);
    expect(data[0]).toEqual({ time: 1 });
    expect(data[1]).toEqual({ time: 2, value: 1.5 });
    expect(data[2]).toEqual({ time: 4, value: 3 });
    expect(data[3]).toEqual({ time: 5, value: 4.5 });
  });

  it('movingAverageHidden=true hides via visible:false but keeps SMA data (legend reads it)', () => {
    const m = makeChartMock();
    useLivePageStore.setState({ movingAverageEnabled: true, movingAverageHidden: true });
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    const first = m.addSeries.mock.results[0].value as {
      applyOptions: ReturnType<typeof vi.fn>; setData: ReturnType<typeof vi.fn>;
    };
    const visibleCalls = first.applyOptions.mock.calls.filter((c) => 'visible' in (c[0] as object));
    expect(visibleCalls.some((c) => (c[0] as { visible: boolean }).visible === false)).toBe(true);
    const lastSetData = first.setData.mock.calls.at(-1)?.[0] as unknown[];
    expect(lastSetData.length).toBeGreaterThan(0); // data NOT cleared — only hidden
  });

  it('registers each MA series in maSeriesRegistry by slot id', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(useMaSeriesRegistry.getState().series.size).toBe(DEFAULT_LIVE_MAS.length);
  });

  it('re-pushes SMA data into the new chart\'s series on a chart instance swap', () => {
    // Regression: /live remounts the lwc chart per (code, timeframe) view.
    // The reconcile + cleanup effects already re-create the series on the new
    // chart (both keyed on `chart`), but the fresh series start EMPTY — the
    // data-push effect must also have `chart` in its deps or nothing calls
    // setData until an unrelated bundle/config change (blank MA lines).
    const m1 = makeChartMock();
    const { rerender } = render(
      <MovingAverageOverlay chart={m1.chart as never} bundle={bundle} axis={axis} />,
    );
    const m2 = makeChartMock();
    rerender(<MovingAverageOverlay chart={m2.chart as never} bundle={bundle} axis={axis} />);
    // Series re-created on the new chart…
    expect(m2.addSeries).toHaveBeenCalledTimes(DEFAULT_LIVE_MAS.length);
    // …and each one received its data in the same commit (the shipped fix —
    // without `chart` in the data-push deps these stay empty).
    for (const [, s] of m2.seriesById) {
      expect(s.setData).toHaveBeenCalled();
    }
  });

  it('unmount removes all series', () => {
    const m = makeChartMock();
    const { unmount } = render(
      <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />,
    );
    const addedCount = m.addSeries.mock.calls.length;
    unmount();
    expect(m.removeSeries).toHaveBeenCalledTimes(addedCount);
  });
});
