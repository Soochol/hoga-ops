/**
 * Tests for useLiveCursor.ts — live-page cursor spot hooks (ADR-0044).
 *
 * Mock strategy: vi.mock('./client') at module scope intercepts apiGet for all
 * suites. Each describe block resets the mock in its own beforeEach.
 *
 * Cursor timestamps use 1_779_930_000_000 (2026-05-28 10:00:00 KST) so that
 * unixMsToKSTDate derives '20260528' — matching the URL assertions. The prior
 * 1_748_400_…ms values were 2025-05-28 KST, causing date mismatch after the
 * fix that derives date from cursorMs rather than accepting it as a prop.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from './useLiveCursor';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { LiveVenueOption } from '../state/liveVenue';

// Mock the low-level fetch helper used by useSpot fetchers.
vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return {
    ...actual,
    apiGet: vi.fn(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    }),
  };
});

import { apiGet } from './client';

// ─── Task 10: useLiveOrderbookAtCursor ───────────────────────────────────────

describe('useLiveOrderbookAtCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('returns undefined and does not fetch when cursorMs is null', async () => {
    const { result } = renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    expect(result.current).toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('waits for sidebarCursorMs instead of immediate cursorMs', async () => {
    renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );

    act(() => useLiveCursorStore.getState().setCursor(1_779_930_001_234));
    expect(apiGet).not.toHaveBeenCalled();

    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('date=20260528');
    expect(url).toContain('t=1779930000000');
  });

  it('fetches once when sidebarCursorMs becomes set', async () => {
    const { result, rerender } = renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => {
      useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000);  // 2026-05-28 10:00:00 KST, exact 1m boundary
    });
    rerender();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('code=005930');
    expect(url).toContain('date=20260528');
    expect(url).toContain('t=1779930000000');
    expect(url).toContain('bucket_ms=60000');
    expect(url).toContain('source_pref=kiwoom_live');
    // venue 는 백엔드 필수 파라미터다(ADR-0140) — 빠지면 라우트가 422 를 내고
    // 10호가 창이 호버 내내 "호가 데이터 없음" 으로 남는다. 실제로 그렇게
    // 깨져 있었다(이 훅만 venue 전파에서 누락).
    expect(url).toContain('venue=KRX');
    // T14b: result is LiveOrderbookSpot, assert via .snapshot
    await waitFor(() => expect(result.current?.snapshot).toBeDefined());
  });

  it('venue change reissues the query', async () => {
    const { rerender } = renderHook(
      ({ venue }: { venue: LiveVenueOption }) =>
        useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue }),
      { initialProps: { venue: 'KRX' as LiveVenueOption } },
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender({ venue: 'UN' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(url).toContain('venue=UN');
  });

  it('client-side bucket alignment collapses within-minute hover to one fetch', async () => {
    renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_001_234));  // same minute
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_029_999));  // same minute
    expect(apiGet).toHaveBeenCalledTimes(1);  // bucket-aligned: same key, LRU hit
  });

  it('hover on past-date candle uses date derived from cursorMs (regression guard)', async () => {
    // Simulates hovering on a 2026-04-15 candle in scroll-back mode.
    // cursorMs = 2026-04-15 10:30:00 KST (UTC 01:30:00) = 1776216600000
    // unixMsToKSTDate should yield '20260415', NOT today.
    const pastDayCursorMs = 1776216600000; // 2026-04-15 10:30:00 KST (exact 1m boundary)
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: null, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
    renderHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(pastDayCursorMs));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('date=20260415');
    expect(url).not.toContain('date=20260528');  // must NOT be today
  });
});

// ─── Task 12: useLiveBrokersAtCursor ─────────────────────────────────────────

describe('useLiveBrokersAtCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/brokers/series')) {
        return { date: '20260528', brokers: [], source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('does not fetch when cursorMs null', () => {
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('does not fetch on calendar timeframe (D/W/M) even with cursor set', async () => {
    // LiveChartRoot publishes cursorMs on all frames (D/W/M included), but
    // /api/brokers/series has no per-cursor parquet there (ADR-0044). The
    // timeframe gate (null on calendar frames) keeps the fetch dormant — the
    // isSpot gate in LiveSidebar only suppresses display, not the fetch.
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: null, venue: 'KRX' }));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches once when sidebarCursorMs set, key independent of sidebarCursorMs value', async () => {
    renderHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    // Moving cursor within the same day must not refetch — the day series
    // is whole-day; the sidebar projects per-row net at cursor client-side.
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_840_000));  // +14 min, same day
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('sends the required venue param and reissues when it changes', async () => {
    // venue 누락 = 백엔드 422(ADR-0140) → 거래원 창이 호버 내내 "거래원 정보
    // 없음". 회귀 가드다.
    const { rerender } = renderHook(
      ({ venue }: { venue: LiveVenueOption }) =>
        useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue }),
      { initialProps: { venue: 'KRX' as LiveVenueOption } },
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('venue=KRX');
    rerender({ venue: 'UN' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('venue=UN');
  });
});
