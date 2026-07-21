import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as client from '../api/client';
import { liveQuotesQueryKey } from '../api/liveQuotes';
import { useDocumentTitle, useStaticDocumentTitle } from './useDocumentTitle';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';

const HITS: SymbolHit[] = [
  {
    code: '005930',
    name: '삼성전자',
    market: 'KOSPI',
    captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
  },
];

function seedQuote(
  qc: QueryClient,
  code: string,
  quote: { price: number; change_pct: number | null; change_won: number | null; stale?: boolean; stale_reason?: string | null },
  venue: 'KRX' | 'UN' = 'KRX',
) {
  qc.setQueryData(liveQuotesQueryKey([code], venue), {
    phase: 'open',
    quotes: [{ code, ...quote }],
  });
}

function makeQc(seedSymbols: SymbolsAllResponse | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedSymbols) {
    // Seed the cache so useSymbols() returns synchronously without hitting fetch.
    qc.setQueryData(SYMBOLS_QUERY_KEY, seedSymbols);
  }
  return qc;
}

function wrap(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  document.title = 'before-test';
  // Block accidental network resolution. Most tests seed symbols/quotes in
  // React Query; unseeded queries stay pending so the hook exercises fallback
  // states without mixing Symbols and Live Quote response shapes.
  vi.spyOn(client, 'apiCall').mockReturnValue(new Promise<never>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDocumentTitle', () => {
  it('sets document.title to "hoga-ops" when code is null', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle(null), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('sets document.title to "hoga-ops" for whitespace-only code', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('   '), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('resolves a known code to its Symbol Master name', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
  });

  it('includes live price and positive change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 71,200 +1.23%');
  });

  it('includes live price and negative change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70500, change_pct: -0.8, change_won: -570 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,500 -0.80%');
  });

  it('includes live price and zero change percent without a plus sign', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: 0, change_won: 0 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000 0.00%');
  });

  it('omits change percent when the live quote has null change_pct', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: null, change_won: null });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000');
  });

  it('keeps stale live quote values in the title (last-good, 깜빡임 방지)', () => {
    // stale 은 장중 일시 타임아웃의 last-good 값 — 숨기면 stale 배치마다 제목이 깜빡인다.
    // 정렬/집계와 동일하게 그대로 표시한다.
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', {
      price: 70000,
      change_pct: 2.34,
      change_won: 1600,
      stale: true,
      stale_reason: 'kis_capacity_timeout',
    });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000 +2.34%');
  });

  it('falls back to the raw code when Symbol Master has no match', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999');
  });

  it('falls back to the raw code while Symbol Master is still loading', () => {
    const qc = makeQc(undefined);
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('005930');
  });

  it('updates document.title when code changes', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { rerender } = renderHook(
      ({ code }: { code: string | null }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: null } as { code: string | null } },
    );
    expect(document.title).toBe('hoga-ops');
    rerender({ code: '005930' });
    expect(document.title).toBe('삼성전자');
  });

  it('updates the title when the live quote arrives after the initial render', async () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');

    qc.setQueryData(liveQuotesQueryKey(['005930'], 'KRX'), {
      phase: 'open',
      quotes: [{ code: '005930', price: 71200, change_pct: 1.23, change_won: 860 }],
    });

    await waitFor(() => {
      expect(document.title).toBe('삼성전자 71,200 +1.23%');
    });
  });

  it('does not attach the previous code quote while the new code quote is loading', () => {
    const qc = makeQc({
      symbols: [
        ...HITS,
        {
          code: '000660',
          name: 'SK하이닉스',
          market: 'KOSPI',
          captured_count: 0,
          captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
        },
      ],
      status: 'fresh',
      fetched_at_ms: 1,
    });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });

    const { rerender } = renderHook(
      ({ code }: { code: string }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    rerender({ code: '000660' });
    expect(document.title).toBe('SK하이닉스');
  });

  it('uses the raw Code as the title base when Symbol Master has no match but quote exists', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '999999', { price: 12345, change_pct: 4.56, change_won: 540 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999 12,345 +4.56%');
  });

  it('restores "hoga-ops" on unmount', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { unmount } = renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});

describe('useDocumentTitle quote throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // React Query v5 notifyManager 는 setQueryData 구독 알림을 setTimeout(0)으로
  // 배칭한다 — fake timer 에서는 0ms 를 흘려야 훅이 새 quote 를 보고 렌더된다.
  // 이 플러시 없이는 "제목이 안 바뀜" 단언이 스로틀이 아니라 알림 미도착을 재는
  // 거짓 통과가 된다.
  function flushQueryNotify() {
    act(() => {
      vi.advanceTimersByTime(0);
    });
  }

  it('coalesces price-to-price updates and writes only the latest value', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    // 스로틀 창 안의 가격 갱신은 지연된다 — 체결마다 제목이 바뀌면 탭이 깜빡인다.
    act(() => {
      seedQuote(qc, '005930', { price: 71300, change_pct: 1.37, change_won: 960 });
    });
    flushQueryNotify();
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    // 창 안에서 또 갱신되면 이전 대기분은 버려지고 최신값만 남는다(latest wins).
    act(() => {
      seedQuote(qc, '005930', { price: 71400, change_pct: 1.51, change_won: 1060 });
    });
    flushQueryNotify();
    expect(document.title).toBe('삼성전자 71,200 +1.23%');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(document.title).toBe('삼성전자 71,400 +1.51%');
  });

  it('writes immediately when the code changes inside the throttle window', () => {
    const qc = makeQc({
      symbols: [
        ...HITS,
        {
          code: '000660',
          name: 'SK하이닉스',
          market: 'KOSPI',
          captured_count: 0,
          captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
        },
      ],
      status: 'fresh',
      fetched_at_ms: 1,
    });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    seedQuote(qc, '000660', { price: 250000, change_pct: 2.5, change_won: 6100 });

    const { rerender } = renderHook(
      ({ code }: { code: string }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    // 종목 전환은 스로틀 창 안이어도 즉시 — 이전 종목명이 남으면 그게 더 어긋난다.
    rerender({ code: '000660' });
    expect(document.title).toBe('SK하이닉스 250,000 +2.50%');
  });

  it('attaches the first quote immediately after a bare-name title', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');

    // 무시세→시세 부착은 즉시 — 가격이 처음 뜨는 걸 2초 늦출 이유가 없다.
    act(() => {
      seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    });
    flushQueryNotify();
    expect(document.title).toBe('삼성전자 71,200 +1.23%');
  });

  it('clears the pending throttled write on unmount', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    const { unmount } = renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    act(() => {
      seedQuote(qc, '005930', { price: 71300, change_pct: 1.37, change_won: 960 });
    });
    flushQueryNotify(); // 대기 쓰기 타이머가 실제로 걸린 상태에서 unmount 해야 의미가 있다
    unmount();
    expect(document.title).toBe('hoga-ops');

    // 대기 중이던 쓰기가 unmount 뒤에 발화해 제목을 덮으면 안 된다.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(document.title).toBe('hoga-ops');
  });
});

describe('useStaticDocumentTitle', () => {
  it('sets document.title to a static page label', () => {
    renderHook(() => useStaticDocumentTitle('Heatmap'));
    expect(document.title).toBe('Heatmap');
  });

  it('sets document.title to "hoga-ops" when title is null', () => {
    renderHook(() => useStaticDocumentTitle(null));
    expect(document.title).toBe('hoga-ops');
  });

  it('restores "hoga-ops" on unmount', () => {
    const { unmount } = renderHook(() => useStaticDocumentTitle('Capture'));
    expect(document.title).toBe('Capture');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});
