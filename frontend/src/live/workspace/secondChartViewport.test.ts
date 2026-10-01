import { describe, expect, it } from 'vitest';
import { captureSecondViewport, restoreSecondViewport } from './secondChartViewport';

const bars = (times: number[]) => times.map(t_ms => ({ t_ms }));

describe('second chart viewport preservation', () => {
  it('removes outside-session candles without increasing zoom or losing fractional right padding', () => {
    const viewport = captureSecondViewport(bars([0, 1, 2, 3, 4, 5]), { from: 1.25, to: 5.25 }, 12)!;
    expect(restoreSecondViewport(bars([1, 2, 3, 4]), viewport)).toEqual({ from: -0.75, to: 3.25 });
    expect(viewport.barSpacing).toBe(12);
  });

  it('keeps the chosen zoom when the whole viewed interval is outside the new data', () => {
    const viewport = captureSecondViewport(bars([100, 200, 300]), { from: 1, to: 2 }, 25)!;
    expect(restoreSecondViewport(bars([1, 2, 3]), viewport)).toEqual({ from: 1, to: 2 });
  });

  it('preserves the time anchor when older candles are prepended', () => {
    const viewport = captureSecondViewport(bars([30, 40, 50]), { from: 0.5, to: 2.5 }, 8)!;
    expect(restoreSecondViewport(bars([10, 20, 30, 40, 50]), viewport)).toEqual({ from: 2.5, to: 4.5 });
  });

  it('does not create a viewport from a transient empty series', () => {
    expect(captureSecondViewport([], null, 8)).toBeNull();
  });
});
