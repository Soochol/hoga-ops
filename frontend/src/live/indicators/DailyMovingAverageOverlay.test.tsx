import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useLivePageStore } from '../../state/livePage';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';

vi.mock('../../api/livePastDailyCandles', () => ({ useLivePastDailyCandles: vi.fn() }));
const mockUseDaily = vi.mocked(useLivePastDailyCandles);

function makeChartMock() {
  const seriesById = new Map<string, ReturnType<typeof makeSeriesMock>>();
  let seriesCounter = 0;
  function makeSeriesMock() {
    return { applyOptions: vi.fn(), setData: vi.fn(), _internalId: ++seriesCounter };
  }
  const addSeries = vi.fn((...args: unknown[]) => {
    void args;
    const s = makeSeriesMock();
    seriesById.set(String(s._internalId), s);
    return s;
  });
  const removeSeries = vi.fn((s: ReturnType<typeof makeSeriesMock>) => { seriesById.delete(String(s._internalId)); });
  return { chart: { addSeries, removeSeries } as unknown, addSeries, removeSeries, seriesById };
}

const D_0612 = 1781222400000; // 2026-06-12 09:00 KST
const dailyCandles = [{ t_ms: D_0612, open: 100, high: 100, low: 100, close: 100, volume: 0 }];
const candles = [0, 1, 2].map((i) => ({
  ts_ms: D_0612 + i * 60_000, open: 1, close: 1, high: 1, low: 1, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
const axis = {
  contains: () => true,
  toVirtual: (m: number) => m,
  findByReal: () => 0,
  segments: [{ date: '20260612' }],
} as never;
const oneSlot = [{ id: 'dma-1', enabled: true, period: 1, color: '#EAB308', lineWidth: 2, source: 'close' }];

function renderOverlay(m: ReturnType<typeof makeChartMock>, over: Record<string, unknown> = {}) {
  return render(
    <DailyMovingAverageOverlay
      chart={m.chart as never}
      bundle={bundle}
      axis={axis}
      code="005930"
      timeframe="1m"
      todayKst="20260613"
      {...over}
    />,
  );
}

describe('DailyMovingAverageOverlay', () => {
  beforeEach(() => {
    cleanup();
    mockUseDaily.mockReturnValue({ data: { candles: dailyCandles } } as never);
    useLivePageStore.setState({
      dailyMovingAverages: oneSlot.map((m) => ({ ...m })) as never,
      dailyMovingAverageEnabled: true,
      dailyMovingAverageHidden: false,
    });
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('projects the daily MA value onto every in-session candle (day-anchored step)', () => {
    const m = makeChartMock();
    renderOverlay(m);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
    expect(data).toHaveLength(3);
    expect(data.every((d) => d.value === 100)).toBe(true);
  });

  it('기본값에서는 일봉 MA series가 autoscale에 참여한다', () => {
    const m = makeChartMock();
    renderOverlay(m);
    const options = m.addSeries.mock.calls[0][1] as { autoscaleInfoProvider?: unknown };
    expect(options.autoscaleInfoProvider).toBeUndefined();
  });

  it('캔들 기준 Y축이 켜지면 일봉 MA series autoscale 기여를 제외한다', () => {
    const m = makeChartMock();
    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', true);
    renderOverlay(m);
    const options = m.addSeries.mock.calls[0][1] as { autoscaleInfoProvider?: () => null };
    expect(options.autoscaleInfoProvider).toBeDefined();
    expect(options.autoscaleInfoProvider?.()).toBeNull();
  });

  it('캔들 기준 Y축을 끄면 기존 일봉 MA series autoscale을 기본 동작으로 되돌린다', () => {
    const m = makeChartMock();
    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', true);
    const { rerender } = renderOverlay(m);
    const first = m.addSeries.mock.results[0].value as { applyOptions: ReturnType<typeof vi.fn> };
    first.applyOptions.mockClear();

    useChartPrefsStore.getState().setToggle('candlePaneCandleOnlyScale', false);
    rerender(
      <DailyMovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} code="005930" timeframe="1m" todayKst="20260613" />,
    );

    const scaleCall = first.applyOptions.mock.calls.find((c) => 'autoscaleInfoProvider' in (c[0] as object));
    const provider = (scaleCall?.[0] as { autoscaleInfoProvider?: (original: () => string) => string }).autoscaleInfoProvider;
    expect(provider?.(() => 'default-autoscale')).toBe('default-autoscale');
  });

  it('reconciles add by id without churning existing slots', () => {
    const m = makeChartMock();
    const { rerender } = renderOverlay(m);
    expect(m.addSeries).toHaveBeenCalledTimes(1);
    useLivePageStore.getState().addDailyMovingAverage();
    rerender(
      <DailyMovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} code="005930" timeframe="1m" todayKst="20260613" />,
    );
    expect(m.addSeries).toHaveBeenCalledTimes(2);
    expect(m.removeSeries).not.toHaveBeenCalled();
  });

  it('master off → setData([])', () => {
    useLivePageStore.setState({ dailyMovingAverageEnabled: false });
    const m = makeChartMock();
    renderOverlay(m);
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    expect(first.setData.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('non-minute timeframe (D) → setData([]) (not drawn)', () => {
    const m = makeChartMock();
    renderOverlay(m, { timeframe: 'D' });
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    expect(first.setData.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('today live close overrides today value when last candle is on todayKst', () => {
    const liveCandles = [0, 1].map((i) => ({
      ts_ms: D_0612 + i * 60_000, open: 1, close: i === 1 ? 200 : 1, high: 1, low: 1, vol_a: 0, vol_b: 0,
    }));
    const m = makeChartMock();
    render(
      <DailyMovingAverageOverlay chart={m.chart as never} bundle={{ candles: liveCandles } as never} axis={axis} code="005930" timeframe="1m" todayKst="20260612" />,
    );
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number }>;
    expect(data.every((d) => d.value === 200)).toBe(true);
  });

  it('empty daily response → no values, no throw', () => {
    mockUseDaily.mockReturnValue({ data: { candles: [] } } as never);
    const m = makeChartMock();
    expect(() => renderOverlay(m)).not.toThrow();
    const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
    const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number }>;
    expect(data.every((d) => d.value === undefined)).toBe(true);
  });

  it('unmount removes all series', () => {
    const m = makeChartMock();
    const { unmount } = renderOverlay(m);
    const added = m.addSeries.mock.calls.length;
    unmount();
    expect(m.removeSeries).toHaveBeenCalledTimes(added);
  });
});
