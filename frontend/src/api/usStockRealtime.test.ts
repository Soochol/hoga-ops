import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPriceBundle } from '../live/buildIndexBundle';
import { mergeUsObservations, overlayUsBundle, type UsStockCandleEvent } from './usStockRealtime';

const day = '20261023';
const minute = Date.UTC(2026, 9, 23, 15, 25);
function event(sequence = 1): UsStockCandleEvent {
  return { type: 'us_stock_candles', instrument_key: 'us-stock:NASDAQ:AAPL', generation: 'one', sequence,
    status: 'streaming', checked_at_ms: minute + 30_000,
    daily: { trading_date: day, t_ms: Date.UTC(2026, 9, 23), open: 100, high: 110, low: 90, close: 108, volume: 0 },
    minutes: [{ trading_date: day, t_ms: minute, open: 103, high: 110, low: 98, close: 108, volume: 0, observed_at_ms: minute + 30_000 }] };
}
function base(bucketMs = 60_000) {
  return buildPriceBundle({ code: 'us-stock:NASDAQ:AAPL', from: '20261022', to: day, bucketMs,
    observedSessions: bucketMs < 86400_000, candles: [
      { trading_date: day, t_ms: minute - 60_000, open: 99, high: 105, low: 95, close: 100, volume: 500 },
    ] });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(minute + 30_000)); });
afterEach(() => vi.useRealTimers());

describe('US observation overlay', () => {
  it('adds an observed minute while retaining historical object references and layout', () => {
    const original = base();
    const next = overlayUsBundle(original, event(), '1m', minute, day)!;
    expect(next.candles).toHaveLength(2);
    expect(next.candles[0]).toBe(original.candles[0]);
    expect(next.candles[1]).toMatchObject({ close: 108, high: 110, low: 98 });
    expect(next.segments.at(-1)?.session_close_ms).toBe(minute + 60_000);
    const newer = event(2);
    newer.minutes[0].close = 109;
    expect(overlayUsBundle(original, newer, '1m', minute, day)?.segments).toBe(next.segments);
  });
  it('uses the native minute grid and preserves REST open and volume', () => {
    const original = base(180_000);
    const next = overlayUsBundle(original, event(), '3m', minute, day)!;
    expect(next.candles).toHaveLength(1);
    expect(next.candles[0]).toMatchObject({ open: 99, high: 110, low: 95, close: 108, vol_a: 500 });
  });
  it('adds a full current daily candle without deriving its open from observed minutes', () => {
    const original = buildPriceBundle({ code: 'us-stock:NASDAQ:AAPL', from: '20261022', to: day,
      bucketMs: 86400_000, candles: [] });
    const next = overlayUsBundle(original, event(), 'D', minute, day)!;
    expect(next.candles[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 108 });
  });
  it('rejects foreign instruments, old days and historical-only requested ranges', () => {
    const original = base();
    expect(overlayUsBundle(original, event(), '1m', minute, '20261022')).toBe(original);
    expect(overlayUsBundle({ ...original, code: 'us-stock:NYSE:AAPL' }, event(), '1m', minute, day)?.candles).toBe(original.candles);
    vi.setSystemTime(new Date('2026-10-24T15:25:00Z'));
    expect(overlayUsBundle(original, event(), '1m', minute, day)).toBe(original);
  });
  it('does not overwrite a later REST correction with an old observation', () => {
    const original = base(180_000);
    expect(overlayUsBundle(original, event(), '3m', minute + 31_000, day)).toBe(original);
  });
  it('keeps more recent observations on top of a REST response that arrived late', () => {
    const next = overlayUsBundle(base(180_000), event(), '3m', minute + 20_000, day)!;
    expect(next.candles[0].close).toBe(108);
  });
  it('does not revive a corrected earlier minute when a new minute shares its native bucket', () => {
    const live = event();
    live.minutes.unshift({ ...live.minutes[0], t_ms: minute - 60_000,
      high: 120, low: 80, observed_at_ms: minute - 10_000 });
    const next = overlayUsBundle(base(180_000), live, '3m', minute, day)!;
    expect(next.candles[0]).toMatchObject({ open: 99, high: 110, low: 95, close: 108 });
  });
  it('shares and folds patches without confusing equal vendor timestamps with duplicates', () => {
    const first = event();
    const second = event(2);
    second.minutes[0].close = 109;
    expect(mergeUsObservations(first, second).minutes[0].close).toBe(109);
    expect(mergeUsObservations(second, first)).toBe(second);
    expect(mergeUsObservations(second, { ...second })).toBe(second);
    const error = { ...second, sequence: 3, status: 'error', minutes: [], daily: null };
    expect(mergeUsObservations(second, error).daily).toEqual(second.daily);
    expect(mergeUsObservations(second, error).minutes).toHaveLength(1);
  });
});
