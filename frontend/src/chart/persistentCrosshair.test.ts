import { afterEach, expect, it, vi } from 'vitest';
import type { IChartApi, MouseEventParams, Time } from 'lightweight-charts';
import { createPersistentCrosshairChart, preserveCrosshairDuringDataChange } from './persistentCrosshair';

afterEach(() => {
  Reflect.deleteProperty(document, 'elementsFromPoint');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const draw = () => {
    const callbacks = [...frames.values()]; frames.clear();
    for (const cb of callbacks) cb(performance.now());
  };
  const element = document.createElement('div');
  const canvas = document.createElement('canvas'); element.append(canvas);
  const find = vi.fn(() => [canvas]);
  Object.defineProperty(document, 'elementsFromPoint', { value: find, configurable: true });
  const move = vi.fn(); canvas.addEventListener('mousemove', move);
  const enter = vi.fn(); canvas.addEventListener('mouseenter', enter);
  const listeners = new Set<(param: MouseEventParams) => void>();
  const emit = (param: Partial<MouseEventParams> = {}) => {
    for (const cb of listeners) cb({ seriesData: new Map(), ...param });
  };
  const pointer = (x = 550, y = 280) => emit({ point: { x: 450, y: 80 } as MouseEventParams['point'],
    sourceEvent: { clientX: x, clientY: y } as MouseEventParams['sourceEvent'] });
  const native = {
    chartElement: () => element,
    timeScale: () => ({ timeToIndex: vi.fn(() => 1) }),
    subscribeCrosshairMove: (cb: (param: MouseEventParams) => void) => listeners.add(cb),
    unsubscribeCrosshairMove: vi.fn((cb: (param: MouseEventParams) => void) => listeners.delete(cb)),
    clearCrosshairPosition: vi.fn(), setCrosshairPosition: vi.fn(), remove: vi.fn(), removeSeries: vi.fn(),
  };
  const chart = createPersistentCrosshairChart(native as unknown as IChartApi);
  const series = { priceToCoordinate: vi.fn((): number | null => 10) } as unknown as Parameters<IChartApi['setCrosshairPosition']>[2];
  return { chart, native, element, find, move, enter, frames, draw, emit, pointer, series };
}

it('restores stationary pointer pixels in whitespace despite an empty intermediate native hover', () => {
  const h = fixture();
  h.pointer();
  const write = vi.fn(() => h.emit());
  preserveCrosshairDuringDataChange(h.chart, write);
  expect(h.native.clearCrosshairPosition).toHaveBeenCalledBefore(write);
  h.emit(); // Native range settlement after setData, before the scheduled replay.
  h.draw();
  expect(h.find).toHaveBeenCalledWith(550, 280);
  expect(h.enter).toHaveBeenCalledOnce();
  expect(h.move.mock.lastCall?.[0]).toMatchObject({ clientX: 550, clientY: 280 });
  h.chart.remove();
});

it('coalesces replacements after the latest draw and honors a newer physical pointer', () => {
  const h = fixture(); h.pointer();
  preserveCrosshairDuringDataChange(h.chart, () => {});
  const previousFrame = [...h.frames.keys()][0];
  h.pointer(600, 300);
  preserveCrosshairDuringDataChange(h.chart, () => {});
  expect(h.frames.has(previousFrame)).toBe(false);
  expect(h.frames.size).toBe(1);
  h.draw();
  expect(h.move).toHaveBeenCalledOnce();
  expect(h.move.mock.lastCall?.[0]).toMatchObject({ clientX: 600, clientY: 300 });
  h.chart.remove();
});

for (const action of ['leave', 'clear', 'remove'] as const) {
  it(`does not resurrect pointer hover after a real ${action} during a pending replacement`, () => {
    const h = fixture(); h.pointer();
    preserveCrosshairDuringDataChange(h.chart, () => {});
    if (action === 'leave') h.element.dispatchEvent(new MouseEvent('mouseleave'));
    if (action === 'clear') h.chart.clearCrosshairPosition();
    if (action === 'remove') h.chart.remove();
    h.draw();
    expect(h.move).not.toHaveBeenCalled();
    if (action !== 'remove') h.chart.remove();
    expect(h.native.unsubscribeCrosshairMove).toHaveBeenCalledOnce();
  });
}

it('preserves a synchronized crosshair, including a newer sync position during the draw', () => {
  const h = fixture();
  h.chart.setCrosshairPosition(10, 100 as Time, h.series);
  preserveCrosshairDuringDataChange(h.chart, () => {});
  h.chart.setCrosshairPosition(20, 200 as Time, h.series);
  h.native.setCrosshairPosition.mockClear();
  h.draw();
  expect(h.native.setCrosshairPosition).toHaveBeenCalledWith(20, 200, h.series);
  expect(h.move).not.toHaveBeenCalled();
  h.chart.remove();
});

it('does not restore a removed or unprojectable synchronized series', () => {
  const h = fixture();
  h.chart.setCrosshairPosition(10, 100 as Time, h.series);
  preserveCrosshairDuringDataChange(h.chart, () => {});
  h.chart.removeSeries(h.series);
  h.native.setCrosshairPosition.mockClear();
  h.draw();
  expect(h.native.setCrosshairPosition).not.toHaveBeenCalled();
  h.chart.setCrosshairPosition(10, 100 as Time, h.series);
  vi.mocked(h.series.priceToCoordinate).mockReturnValue(null);
  preserveCrosshairDuringDataChange(h.chart, () => {});
  h.native.setCrosshairPosition.mockClear();
  h.draw();
  expect(h.native.setCrosshairPosition).not.toHaveBeenCalled();
  h.chart.remove();
});

it('keeps chart method receivers and reuses an already installed controller', () => {
  const h = fixture();
  expect(createPersistentCrosshairChart(h.chart)).toBe(h.chart);
  expect(createPersistentCrosshairChart(h.native as unknown as IChartApi)).toBe(h.chart);
  h.pointer();
  h.emit(); // An empty hover with no data update is an ordinary clear.
  preserveCrosshairDuringDataChange(h.chart, () => {});
  expect(h.frames.size).toBe(0);
  h.chart.remove();
});

it('bridges the blank native draw with hover layers only and removes them after replay paints', () => {
  const h = fixture();
  const base = document.createElement('canvas'); base.style.zIndex = '1';
  const top = h.element.querySelector('canvas')!; top.style.zIndex = '2';
  h.element.prepend(base);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 500, height: 300 } as DOMRect);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  h.pointer();
  preserveCrosshairDuringDataChange(h.chart, () => {});
  const overlay = h.element.querySelector('[data-persistent-crosshair]') as HTMLElement;
  expect(overlay.style.pointerEvents).toBe('none');
  expect(overlay.querySelectorAll('canvas')).toHaveLength(1);
  expect(drawImage).toHaveBeenCalledWith(top, 0, 0);
  h.draw(); // Restore native hover after the cleared draw.
  expect(h.element.contains(overlay)).toBe(true);
  h.draw(); // Native replay paint precedes releasing its saved layers.
  expect(h.element.contains(overlay)).toBe(false);
  preserveCrosshairDuringDataChange(h.chart, () => {});
  h.element.dispatchEvent(new MouseEvent('mouseleave'));
  expect(h.element.querySelector('[data-persistent-crosshair]')).toBeNull();
  expect(h.frames.size).toBe(0);
  h.chart.remove();
});
