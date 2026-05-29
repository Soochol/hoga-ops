import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useLivePageStore, DEFAULT_LIVE_MAS } from '../../state/livePage';
import MovingAverageOverlay from './MovingAverageOverlay';

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
    useLivePageStore.setState({ movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })) });
  });

  it('mounts one LineSeries per configured slot', () => {
    const m = makeChartMock();
    render(<MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />);
    expect(m.addSeries).toHaveBeenCalledTimes(DEFAULT_LIVE_MAS.length);
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
