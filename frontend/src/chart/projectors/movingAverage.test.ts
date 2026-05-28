import { describe, it, expect } from 'vitest';
import { computeSMA, MOVING_AVERAGE_SPEC, selectSource, type MAContext, type MASource } from './movingAverage';
import type { MAConfig } from '../../state/tabs';

describe('selectSource', () => {
  const c = { ts_ms: 1000, open: 10, high: 14, low: 6, close: 12, vol_a: 0, vol_b: 0 };

  it('returns close for source="close"', () => {
    expect(selectSource(c, 'close')).toBe(12);
  });
  it('returns open for source="open"', () => {
    expect(selectSource(c, 'open')).toBe(10);
  });
  it('returns high for source="high"', () => {
    expect(selectSource(c, 'high')).toBe(14);
  });
  it('returns low for source="low"', () => {
    expect(selectSource(c, 'low')).toBe(6);
  });
  it('returns (high+low)/2 for source="hl2"', () => {
    expect(selectSource(c, 'hl2')).toBe(10);
  });
  it('returns (high+low+close)/3 for source="hlc3"', () => {
    // (14 + 6 + 12) / 3 = 32 / 3
    expect(selectSource(c, 'hlc3')).toBeCloseTo(32 / 3, 10);
  });
  it('returns (open+high+low+close)/4 for source="ohlc4"', () => {
    // (10 + 14 + 6 + 12) / 4 = 10.5
    expect(selectSource(c, 'ohlc4')).toBe(10.5);
  });
});

describe('computeSMA', () => {
  it('returns sliding-window means with leading nulls for [1..5], period=3', () => {
    expect(computeSMA([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns empty array for empty input', () => {
    expect(computeSMA([], 5)).toEqual([]);
  });

  it('returns all-null when period exceeds input length', () => {
    expect(computeSMA([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('returns closes verbatim when period === 1', () => {
    expect(computeSMA([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it('returns all-null when period === 0', () => {
    expect(computeSMA([1, 2, 3], 0)).toEqual([null, null, null]);
  });
});

describe('MOVING_AVERAGE_SPEC series[0].data', () => {
  const series0 = MOVING_AVERAGE_SPEC.series[0];

  const candles = [
    { ts_ms: 1000, open: 1, close: 1, high: 1, low: 1 },
    { ts_ms: 2000, open: 2, close: 2, high: 2, low: 2 },
    { ts_ms: 3000, open: 3, close: 3, high: 3, low: 3 },
    { ts_ms: 4000, open: 4, close: 4, high: 4, low: 4 },
    { ts_ms: 5000, open: 5, close: 5, high: 5, low: 5 },
  ];
  const bundle: any = { candles };
  const axis: any = {
    contains: () => true,
    toVirtual: (ms: number) => ms,
  };

  const makeCtx = (configs: MAConfig[]): MAContext => configs;

  it('emits whitespace for warm-up slots and {time,value} for filled SMA slots', () => {
    const ctx = makeCtx([
      { period: 3, enabled: true },
      { period: 5, enabled: true },
      { period: 10, enabled: true },
      { period: 20, enabled: true },
      { period: 60, enabled: true },
    ]);
    const data = series0.data(bundle, axis, ctx);
    expect(data).toHaveLength(5);
    // First two: whitespace (no `value` key) — SMA(3) needs 3 closes.
    expect(data[0]).toEqual({ time: 1 });
    expect(data[1]).toEqual({ time: 2 });
    // Next three: SMA values.
    expect(data[2]).toEqual({ time: 3, value: 2 });
    expect(data[3]).toEqual({ time: 4, value: 3 });
    expect(data[4]).toEqual({ time: 5, value: 4 });
  });

  it('returns [] when slot is disabled', () => {
    const ctx = makeCtx([
      { period: 3, enabled: false },
      { period: 5, enabled: true },
      { period: 10, enabled: true },
      { period: 20, enabled: true },
      { period: 60, enabled: true },
    ]);
    expect(series0.data(bundle, axis, ctx)).toEqual([]);
  });

  it('excludes pre-open auction closes from the SMA computation', () => {
    // Mirrors volume.test.ts: bundle.candles can contain pre-open auction bars
    // (8:30–9:00 KST) before the regular session opens. The projector must
    // exclude them from BOTH the emission AND the SMA window — otherwise the
    // first ~period regular-session values get averaged with stale auction
    // prices instead of starting from in-session closes.
    const preOpenAuction = [
      { ts_ms: 100, open: 99, close: 99, high: 99, low: 99 }, // pre-open
      { ts_ms: 200, open: 99, close: 99, high: 99, low: 99 }, // pre-open
    ];
    const regularSession = [
      { ts_ms: 1000, open: 1, close: 1, high: 1, low: 1 },
      { ts_ms: 2000, open: 2, close: 2, high: 2, low: 2 },
      { ts_ms: 3000, open: 3, close: 3, high: 3, low: 3 },
    ];
    const mixed: any = { candles: [...preOpenAuction, ...regularSession] };
    // axis.contains rejects pre-open timestamps.
    const sessionAxis: any = {
      contains: (ms: number) => ms >= 1000,
      toVirtual: (ms: number) => ms,
    };
    const ctx = makeCtx([
      { period: 3, enabled: true },
      { period: 5, enabled: true },
      { period: 10, enabled: true },
      { period: 20, enabled: true },
      { period: 60, enabled: true },
    ]);
    const data = series0.data(mixed, sessionAxis, ctx);
    // 3 regular-session candles only. SMA(3) over [1,2,3] = [null, null, 2].
    // If pre-open closes (99, 99) leaked in, the first emitted point would be
    // an SMA of [99, 99, 1] = 66.33 — the regression this test guards against.
    expect(data).toHaveLength(3);
    expect(data[0]).toEqual({ time: 1 });          // whitespace, warm-up
    expect(data[1]).toEqual({ time: 2 });          // whitespace, warm-up
    expect(data[2]).toEqual({ time: 3, value: 2 }); // (1+2+3)/3 = 2
  });

  it('drops candles for which axis.contains returns false', () => {
    const droppedTs = candles[1].ts_ms;
    const filteredAxis: any = {
      contains: (ms: number) => ms !== droppedTs,
      toVirtual: (ms: number) => ms,
    };
    const ctx = makeCtx([
      { period: 3, enabled: true },
      { period: 5, enabled: true },
      { period: 10, enabled: true },
      { period: 20, enabled: true },
      { period: 60, enabled: true },
    ]);
    const data = series0.data(bundle, filteredAxis, ctx);
    expect(data).toHaveLength(4);
    // The dropped candle's time should not appear.
    for (const p of data) expect(p.time).not.toBe(droppedTs / 1000);
  });
});
