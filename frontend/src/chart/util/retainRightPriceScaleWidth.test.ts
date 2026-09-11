import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { retainRightPriceScaleWidth } from './retainRightPriceScaleWidth';

function harness() {
  let width = 52;
  let listener: (() => void) | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  const applyOptions = vi.fn();
  const chart = {
    options: () => ({ rightPriceScale: { minimumWidth: 0 } }),
    priceScale: () => ({ width: () => width }),
    timeScale: () => ({
      subscribeSizeChange: (cb: () => void) => { listener = cb; },
      unsubscribeSizeChange: (cb: () => void) => { if (listener === cb) listener = undefined; },
    }),
    applyOptions,
  } as unknown as IChartApi;
  return {
    chart, applyOptions,
    resize: (next: number) => { width = next; listener?.(); },
    flush: () => {
      const batch = [...frames.values()];
      frames.clear();
      for (const cb of batch) cb(0);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('retainRightPriceScaleWidth', () => {
  it('retains an intermediate peak even if another layout shrinks it before the next frame', () => {
    const h = harness();
    const cleanup = retainRightPriceScaleWidth(h.chart);
    h.resize(82);
    h.resize(74);
    h.flush();
    expect(h.applyOptions).toHaveBeenLastCalledWith({ rightPriceScale: { minimumWidth: 82 } });
    h.applyOptions.mockClear();
    h.resize(74);
    h.flush();
    expect(h.applyOptions).not.toHaveBeenCalled();
    h.resize(96);
    h.flush();
    expect(h.applyOptions).toHaveBeenCalledWith({ rightPriceScale: { minimumWidth: 96 } });
    cleanup();
  });

  it('does not write to a removed chart, and a replacement chart gets its own width budget', () => {
    const h = harness();
    const cleanup = retainRightPriceScaleWidth(h.chart);
    h.resize(96);
    cleanup();
    h.resize(100);
    h.flush();
    expect(h.applyOptions).not.toHaveBeenCalled();

    h.resize(52);
    const replacementCleanup = retainRightPriceScaleWidth(h.chart);
    h.flush();
    expect(h.applyOptions).toHaveBeenCalledWith({ rightPriceScale: { minimumWidth: 52 } });
    replacementCleanup();
  });
});
