import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock the wire call; the hook owns the accumulation/today-split policy.
const fetchSpy = vi.fn();
vi.mock('../api/livePastDailyCandles', () => ({
  fetchPastDailyCandles: (...a: unknown[]) => fetchSpy(...a),
}));

import { useDailyCandlesAccumulated } from './useDailyCandlesAccumulated';
import { subtractDaysKst, initialHistoricalDaysFor } from './liveDateTime';

const TODAY = '20260527';
const YESTERDAY = '20260526';
const INITIAL_FROM = subtractDaysKst(TODAY, initialHistoricalDaysFor('D'));

const candle = (t_ms: number) => ({ t_ms, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const resp = (from: string, to: string, candles: ReturnType<typeof candle>[]) => ({
  code: '005930', from, to, candles, cached_batches: [], fresh_batches: [], data_warnings: [],
});
const isToday = (from: string, to: string) => from === TODAY && to === TODAY;

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  fetchSpy.mockReset();
});

describe('useDailyCandlesAccumulated', () => {
  it('splits the live today bar from immutable history and merges sorted ascending', async () => {
    fetchSpy.mockImplementation((_c: string, from: string, to: string) =>
      Promise.resolve(resp(from, to, [candle(isToday(from, to) ? 2_000_000 : 1_000_000)])),
    );
    const { result } = renderHook(
      () => useDailyCandlesAccumulated('005930', 'D', TODAY, null, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.candles).toHaveLength(2));
    const ranges = fetchSpy.mock.calls.map((c) => [c[1], c[2]]);
    expect(ranges).toContainEqual([INITIAL_FROM, YESTERDAY]); // history seed ends at YESTERDAY (immutable)
    expect(ranges).toContainEqual([TODAY, TODAY]);            // live today bar — separate query
    expect(result.current.candles.map((c) => c.t_ms)).toEqual([1_000_000, 2_000_000]);
  });

  it('extends with a DISJOINT older slice (no re-download of [cursor, today]) and accumulates', async () => {
    const older = '20250101'; // strictly older than INITIAL_FROM
    fetchSpy.mockImplementation((_c: string, from: string, to: string) => {
      if (isToday(from, to)) return Promise.resolve(resp(from, to, [candle(2_000_000)]));
      if (from === older) return Promise.resolve(resp(from, to, [candle(500_000)]));
      return Promise.resolve(resp(from, to, [candle(1_000_000)]));
    });
    const { result, rerender } = renderHook(
      ({ hfd }: { hfd: string | null }) => useDailyCandlesAccumulated('005930', 'D', TODAY, hfd, true),
      { wrapper, initialProps: { hfd: null as string | null } },
    );
    await waitFor(() => expect(result.current.candles).toHaveLength(2));
    fetchSpy.mockClear();

    // Settle-loop drops the cursor below the loaded floor → one disjoint slice.
    rerender({ hfd: older });
    await waitFor(() => expect(result.current.candles).toHaveLength(3));

    const histCalls = fetchSpy.mock.calls.filter((c) => !isToday(c[1] as string, c[2] as string));
    expect(histCalls).toHaveLength(1);                         // exactly ONE new fetch
    expect(histCalls[0][1]).toBe(older);                       // from = cursor
    expect(histCalls[0][2]).toBe(subtractDaysKst(INITIAL_FROM, 1)); // to = just below prior from → NO overlap
    expect(result.current.candles.map((c) => c.t_ms)).toEqual([500_000, 1_000_000, 2_000_000]);
  });

  it('is disabled (no fetch) when enabled=false (minute timeframes)', async () => {
    fetchSpy.mockResolvedValue(resp(TODAY, TODAY, [candle(1)]));
    renderHook(() => useDailyCandlesAccumulated('005930', '1m', TODAY, null, false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still extends when historicalFromDate is set BEFORE the (slow) seed lands (seed-load race)', async () => {
    // historicalFromDate older than the seed from the very first render → the
    // bridge wants to extend immediately, but fetchNextPage is a no-op until the
    // seed page exists. With a SLOW seed the bridge fires early; without the
    // seedLoaded gate it would never retry → the extension is lost forever. Here
    // the gate must defer until the seed lands, then pull the disjoint slice.
    const older = '20250101';
    fetchSpy.mockImplementation((_c: string, from: string, to: string) => {
      if (isToday(from, to)) return Promise.resolve(resp(from, to, [candle(2_000_000)]));
      if (from === older) return Promise.resolve(resp(from, to, [candle(500_000)]));
      // Seed [INITIAL_FROM, YESTERDAY] — delayed so the bridge fires before it lands.
      return new Promise((r) => setTimeout(() => r(resp(from, to, [candle(1_000_000)])), 40));
    });
    const { result } = renderHook(
      () => useDailyCandlesAccumulated('005930', 'D', TODAY, older, true), // hfd set at MOUNT
      { wrapper },
    );
    // seed (1M) + extension (500k) + today (2M) — extension survives the race.
    await waitFor(() => expect(result.current.candles).toHaveLength(3), { timeout: 2000 });
    const histFroms = fetchSpy.mock.calls
      .filter((c) => !isToday(c[1] as string, c[2] as string))
      .map((c) => c[1]);
    expect(histFroms).toContain(older); // the disjoint extension slice WAS fetched
  });
});
