import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DepthHeatmapOverlay from './DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from './depthHeatmapWire';
import type { FlagLegendValueProvider } from './indicators/flagLegendValueRegistry';
import { createVirtualAxis } from '../util/virtualAxis';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';

const mocks = vi.hoisted(() => ({
  setCells: vi.fn(), register: vi.fn(), unregister: vi.fn(),
  prefs: { depthHeatmapIntraMax: false, depthHeatmapPerPriceMax: false, depthHeatmapTopLevelsOnly: false, depthHeatmapTopLevelCount: 1 },
  indicators: { depthHeatmapEnabled: true, depthHeatmapHidden: false, depthHeatmapBidColor: '#F04452', depthHeatmapAskColor: '#3485FA', depthHeatmapMaxOpacity: 1 },
}));
vi.mock('../chart/DepthHeatmapPrimitive', () => ({
  DepthHeatmapPrimitive: class { setCells = mocks.setCells; },
}));
vi.mock('../state/chartPrefs', () => ({ useActivePrefs: (selector: (p: typeof mocks.prefs) => unknown) => selector(mocks.prefs) }));
vi.mock('./workspace/windowView', () => ({
  useWindowIndicator: (selector: (p: typeof mocks.indicators) => unknown) => selector(mocks.indicators),
  useWindowScopeId: () => 'test-window',
}));
vi.mock('./indicators/flagLegendValueRegistry', () => ({
  registerFlagLegendValues: mocks.register,
  unregisterFlagLegendValues: mocks.unregister,
}));

const axis = createVirtualAxis([{ date: '20260624', sessionOpenMs: 0, sessionCloseMs: 600_000 }], 0);
const paneSeries: PaneSeriesMap = new Map([['candle', { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() } as never]]);
const point = (tMs: number, qty: number): DepthHeatmapPoint => ({
  tMs, asks: [{ price: 1010, qty }], bids: [{ price: 1000, qty }], asksMax: [], bidsMax: [],
});
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
function makeChart(initial: { from: number; to: number } | null) {
  let range = initial;
  let onRange: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const scale = {
    getVisibleRange: () => range,
    subscribeVisibleLogicalRangeChange: (callback: () => void) => { onRange = callback; },
    unsubscribeVisibleLogicalRangeChange: unsubscribe,
  };
  return {
    chart: { timeScale: () => scale } as never,
    pan(next: typeof range) { range = next; act(() => onRange?.()); },
    unsubscribe,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.indicators.depthHeatmapEnabled = true;
  mocks.indicators.depthHeatmapHidden = false;
  frames = new Map(); frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DepthHeatmapOverlay viewport lifecycle', () => {
  it('첫 프레임에는 전체 셀을 만들지 않고, 범위를 읽은 뒤 화면 안 잔량으로 정규화한다', () => {
    const points = [point(60_000, 9000), point(180_000, 600)];
    const api = makeChart({ from: 120, to: 240 });
    render(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={points} />);
    expect(mocks.setCells).toHaveBeenLastCalledWith([]);
    flushFrame();
    const cells = mocks.setCells.mock.lastCall![0];
    expect(cells).toHaveLength(2);
    expect(cells.every((c: { time: number; fillColor: string }) => c.time === 180 && c.fillColor.endsWith(', 1)'))).toBe(true);
    api.pan({ from: 0, to: 240 }); flushFrame();
    expect(mocks.setCells.mock.lastCall![0]).toHaveLength(4);
    expect(mocks.setCells.mock.lastCall![0][2].fillColor).not.toMatch(/, 1\)$/);
  });

  it('범위가 null이면 호가 레벨을 읽지 않고, 범위가 생기면 표시한다', () => {
    const p = point(180_000, 600);
    const asks = p.asks;
    const read = vi.fn(() => asks);
    Object.defineProperty(p, 'asks', { get: read });
    const api = makeChart(null);
    render(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={[p]} />);
    flushFrame();
    expect(read).not.toHaveBeenCalled();
    expect(mocks.setCells).toHaveBeenLastCalledWith([]);
    api.pan({ from: 120, to: 240 }); flushFrame();
    expect(mocks.setCells.mock.lastCall![0]).toHaveLength(2);
  });

  it.each(['depthHeatmapHidden', 'depthHeatmapEnabled'] as const)('%s 게이트가 셀 계산을 막고 복구 시 최신 데이터를 표시한다', (key) => {
    mocks.indicators[key] = key === 'depthHeatmapHidden';
    const p = point(180_000, 600);
    const asks = p.asks;
    const read = vi.fn(() => asks);
    Object.defineProperty(p, 'asks', { get: read });
    const api = makeChart({ from: 120, to: 240 });
    const view = render(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={[p]} />);
    flushFrame();
    expect(read).not.toHaveBeenCalled();
    expect(mocks.setCells).toHaveBeenLastCalledWith([]);
    // 셀 계산과 레전드는 독립: 숨긴 지표도 레전드의 최신 값 조회는 유지한다.
    const provider = mocks.register.mock.lastCall![3] as FlagLegendValueProvider;
    expect(provider(null)).toHaveLength(2);
    mocks.indicators[key] = key !== 'depthHeatmapHidden';
    view.rerender(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={[point(180_000, 900)]} />);
    expect(mocks.setCells.mock.lastCall![0]).toHaveLength(2);
    mocks.indicators[key] = key === 'depthHeatmapHidden';
    view.rerender(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={[p]} />);
    expect(mocks.setCells).toHaveBeenLastCalledWith([]);
  });

  it.each(['axis', 'chart'] as const)('%s 교체 시 새 범위를 기다리고 unmount는 대기 프레임을 취소한다', (kind) => {
    const api = makeChart({ from: 120, to: 240 });
    const points = [point(180_000, 600)];
    const view = render(<DepthHeatmapOverlay chart={api.chart} paneSeries={paneSeries} axis={axis} points={points} />);
    flushFrame();
    expect(mocks.setCells.mock.lastCall![0]).toHaveLength(2);
    const nextAxis = kind === 'axis'
      ? createVirtualAxis([{ date: '20260624', sessionOpenMs: 0, sessionCloseMs: 600_000 }], 0) : axis;
    const nextApi = kind === 'chart' ? makeChart({ from: 120, to: 240 }) : api;
    view.rerender(<DepthHeatmapOverlay chart={nextApi.chart} paneSeries={paneSeries} axis={nextAxis} points={points} />);
    expect(mocks.setCells).toHaveBeenLastCalledWith([]);
    flushFrame();
    expect(mocks.setCells.mock.lastCall![0]).toHaveLength(2);
    nextApi.pan({ from: 0, to: 60 });
    nextApi.pan({ from: 0, to: 120 });
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    expect(api.unsubscribe).toHaveBeenCalledTimes(kind === 'chart' ? 1 : 2);
    if (kind === 'chart') expect(nextApi.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.unregister).toHaveBeenCalled();
  });
});
