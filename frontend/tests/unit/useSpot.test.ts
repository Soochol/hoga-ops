import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSpot } from '../../src/api/useSpot';

// Flush queued microtasks (promise continuations) under fake timers.
// `vi.advanceTimersByTimeAsync` runs *timer* callbacks; we still need to let
// resolved promises' `.then` handlers run before assertions.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useSpot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns {data: undefined, isFetching: false} when key is null', () => {
    const fetcher = vi.fn(() => Promise.resolve('payload'));
    const { result } = renderHook(() => useSpot<string>(null, fetcher, 30));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('first-time key: fetcher fires after debounce and populates data', async () => {
    const fetcher = vi.fn(() => Promise.resolve(42));
    const { result } = renderHook(() => useSpot<number>('k1', fetcher, 30));

    // Immediately after first render: debounce timer pending, fetch not yet issued.
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();

    // Advance through the debounce window — fires the setTimeout, which calls fetcher().
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);

    // Flush the .then handler that writes to state.
    await flushMicrotasks();

    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toBe(42);
  });

  it('re-rendering with same key after data populated: no new fetch (cache hit)', async () => {
    const fetcher = vi.fn(() => Promise.resolve(7));
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useSpot<number>(k, fetcher, 30),
      { initialProps: { k: 'cached-key' } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flushMicrotasks();
    expect(result.current.data).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Rerender with the same key — should hit the cache, no new fetch.
    rerender({ k: 'cached-key' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe(7);
    expect(result.current.isFetching).toBe(false);
  });

  it('rapid key change (A→B→C within debounce): only the trailing fetch lands', async () => {
    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useSpot<string>(k, () => Promise.resolve(k), 30),
      { initialProps: { k: 'A' } },
    );

    // Within the debounce window, switch keys rapidly (under 30ms each).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender({ k: 'B' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender({ k: 'C' });

    // Now let the debounce fire and the resolved promise settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flushMicrotasks();

    expect(result.current.data).toBe('C');
    expect(result.current.isFetching).toBe(false);
  });

  it('cache hit on previously-fetched key returns immediately without isFetching=true', async () => {
    const fetcher = vi.fn(() => Promise.resolve('payload'));
    const { result, rerender } = renderHook(
      ({ k }: { k: string | null }) => useSpot<string>(k, fetcher, 30),
      { initialProps: { k: 'X' as string | null } },
    );

    // First fetch populates the cache.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flushMicrotasks();
    expect(result.current.data).toBe('payload');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Switch to null to clear state.
    rerender({ k: null });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);

    // Back to X — cache hit must be synchronous: no debounce, no isFetching flash.
    rerender({ k: 'X' });
    expect(result.current.data).toBe('payload');
    expect(result.current.isFetching).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1); // no new fetch
  });

  it('stale resolves are discarded (token-based)', async () => {
    // Slow fetch for A, then switch to B before A resolves. A's late resolve
    // must not overwrite B's data.
    let resolveA: (v: string) => void = () => {};
    const promiseA = new Promise<string>((res) => {
      resolveA = res;
    });

    const fetcherFor = (k: string) => {
      if (k === 'A') return () => promiseA;
      return () => Promise.resolve(k);
    };

    const { result, rerender } = renderHook(
      ({ k }: { k: string }) => useSpot<string>(k, fetcherFor(k), 30),
      { initialProps: { k: 'A' } },
    );

    // Let A's debounce fire (fetcher invoked; promiseA pending).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(result.current.isFetching).toBe(true);

    // Switch to B before A resolves.
    rerender({ k: 'B' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flushMicrotasks();
    expect(result.current.data).toBe('B');

    // Now resolve A (stale) — it must NOT overwrite B.
    await act(async () => {
      resolveA('A-late');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data).toBe('B');
  });

  it('fetch failure surfaces via console.error and leaves data undefined', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn(() => Promise.reject(new Error('boom')));
    const { result } = renderHook(() => useSpot<string>('k', fetcher, 30));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
    });
    await flushMicrotasks();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(false);
    // The diagnostic exists so a future "card stuck on loading" regression
    // is not silently masked — the message must include the failing key.
    expect(consoleSpy).toHaveBeenCalledOnce();
    const [msg, errArg] = consoleSpy.mock.calls[0];
    expect(String(msg)).toContain('k');
    expect((errArg as Error).message).toBe('boom');
    consoleSpy.mockRestore();
  });
});
