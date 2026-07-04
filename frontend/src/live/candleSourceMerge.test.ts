import { describe, expect, it } from 'vitest';
import { mergeCandlesByPriority } from './candleSourceMerge';
import type { Candle } from '../api/types';

const c = (ts_ms: number, close = ts_ms): Candle => ({
  ts_ms,
  open: close,
  high: close,
  low: close,
  close,
  vol_a: 0,
  vol_b: 0,
});

describe('mergeCandlesByPriority', () => {
  it('keeps primary candles and fills missing timestamps from fallback', () => {
    const primary = [c(2, 20)];
    const fallback = [c(1, 10), c(2, 200), c(3, 30)];

    expect(mergeCandlesByPriority(primary, fallback)).toEqual([
      c(1, 10),
      c(2, 20),
      c(3, 30),
    ]);
  });

  it('does not let one primary row suppress a fuller fallback range', () => {
    const primary = [c(1000, 1)];
    const fallback = Array.from({ length: 100 }, (_, idx) => c((idx + 1) * 1000, idx + 1));

    const merged = mergeCandlesByPriority(primary, fallback);

    expect(merged).toHaveLength(100);
    expect(merged.find((row) => row.ts_ms === 1000)?.close).toBe(1);
    expect(merged.at(-1)?.ts_ms).toBe(100_000);
  });
});
