import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RangeBundle } from '../api/types';
import { clearCurrentStudySaveSource, setCurrentStudySaveSource, useCurrentStudySaveSource } from './studySaveSource';

function rangeBundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [],
    candles: [{ ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    quote_ratio: { bucket_ms: 300_000, points: [] },
    fill_strength: { bucket_ms: 300_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

afterEach(() => {
  setCurrentStudySaveSource(null);
});

it('publishes one current save source regardless of route adapter', () => {
  const { result } = renderHook(() => useCurrentStudySaveSource());
  expect(result.current).toBeNull();

  const source = {
    origin: 'live' as const,
    code: '005930',
    label: '삼성전자',
    timeframe: '5m' as const,
    bundle: rangeBundle(),
    captureViewport: vi.fn(() => ({ rightEdgeMs: 1_000, barSpan: 1, atLiveEdge: true })),
  };

  act(() => setCurrentStudySaveSource(source));

  expect(result.current).toBe(source);
  expect(result.current?.origin).toBe('live');
});

it('does not clear a newer source from a stale route adapter cleanup', () => {
  const { result } = renderHook(() => useCurrentStudySaveSource());
  const first = {
    origin: 'live' as const,
    code: '005930',
    label: '삼성전자',
    timeframe: '5m' as const,
    bundle: rangeBundle(),
    captureViewport: vi.fn(() => null),
  };
  const next = {
    ...first,
    code: '000660',
    label: 'SK하이닉스',
  };

  act(() => setCurrentStudySaveSource(first));
  act(() => setCurrentStudySaveSource(next));
  act(() => clearCurrentStudySaveSource(first));

  expect(result.current).toBe(next);
});
