import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useKstDay } from './useKstDay';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shares one timer and changes only at the KST day boundary', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-05T14:59:00Z'));
  let renders = 0;
  const a = renderHook(() => { renders++; return useKstDay(); });
  const b = renderHook(() => useKstDay());
  expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(59_000));
  expect(a.result.current).toBe('20260905');
  expect(renders).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1010));
  expect(a.result.current).toBe('20260906');
  expect(b.result.current).toBe('20260906');
  a.unmount();
  expect(vi.getTimerCount()).toBe(1);
  b.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('resynchronizes the day on return from a suspended tab', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
  const { result } = renderHook(() => useKstDay());
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  act(() => window.dispatchEvent(new Event('pageshow')));
  expect(result.current).toBe('20260906');
});
