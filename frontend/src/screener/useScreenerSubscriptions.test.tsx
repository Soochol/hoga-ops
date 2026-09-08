import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import * as ws from '../api/ws';
import { useLiveQuoteOverlay, type LiveQuote } from '../api/liveQuotes';
import type { ScreenerRow } from '../api/screener';
import type { LiveSnapshotEntry } from '../api/types';
import { seedSymbolMaster, symbolHit } from '../live/seedSymbolMaster';
import { useLiveVenueStore } from '../state/liveVenue';
import { useScreenerRowsLive } from './useScreenerRowsLive';
import { useScreenerMonitor } from './useScreenerMonitor';

// 선택 종목을 종전 '코드순 300개' 상한 밖에 둔다.
const ROWS: ScreenerRow[] = Array.from({ length: 350 }, (_, i) => ({
  code: String(100000 + i), name: `종목${i}`, market: 'KOSPI',
  price: 10000, change_pct: 0, trade_value_won: 1e10,
}));
const CODES = ROWS.map((r) => r.code);
const SELECTED = CODES[349];
const handlers = new Map<string, (entry: LiveSnapshotEntry) => void>();
const released = vi.fn();
let quotes: LiveQuote[];
let qc: QueryClient;

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  handlers.clear();
  released.mockClear();
  useLiveVenueStore.setState({ venue: 'KRX' });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc, CODES.map((c) => symbolHit(c, false)));
  quotes = CODES.map((code) => ({ code, price: 10000, change_pct: 0, change_won: 0 }));
  vi.spyOn(client, 'apiCall').mockImplementation(async () => ({ phase: 'open', quotes }));
  vi.spyOn(ws, 'subscribeLive').mockImplementation((code, handler) => {
    handlers.set(code, handler);
    return () => { handlers.delete(code); released(code); };
  });
});

afterEach(() => {
  cleanup();
  qc.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// 드로어의 실제 두 소비 경로를 함께 실행한다. 행만 제한하고 phase 확인 경로를
// 남겨두면 여전히 수백 개를 subscribeLive 하므로 훅을 서로 모킹하지 않는다.
function useRowsAndMonitor(rows: ScreenerRow[], selectedCode: string | null) {
  const liveRows = useScreenerRowsLive(rows, selectedCode);
  useScreenerMonitor({
    active: true, selectedId: 'saved', periodMs: 30_000, disabled: false,
    resultCodes: rows.map((r) => r.code), hasResults: true,
    scanOnce: async () => true, onAutoStop: () => {},
  });
  return liveRows;
}

describe('스크리너 선택 종목 WS 구독', () => {
  it('조회만 하면 WS는 0개이고 모니터링과 공유하는 전체 결과 REST는 계속 갱신한다', async () => {
    const { result } = renderHook(() => useRowsAndMonitor(ROWS, null), { wrapper: Wrapper });
    await waitFor(() => expect(result.current[0].price).toBe(10000));
    expect(ws.subscribeLive).not.toHaveBeenCalled();
    expect(client.apiCall).toHaveBeenCalledTimes(1);
    expect(client.apiCall).toHaveBeenCalledWith(`/api/live/quotes?codes=${CODES.join(',')}&venue=KRX`);

    quotes = quotes.map((q) => ({ ...q, price: 11000, change_pct: 10, change_won: 1000 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
    await waitFor(() => expect(result.current.every((r) => r.price === 11000)).toBe(true));
    expect(ws.subscribeLive).not.toHaveBeenCalled();
  });

  it('선택한 1개만 틱을 받고 선택 전환·결과 제외·언마운트 시 이전 구독을 반환한다', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ rows, selectedCode }: { rows: ScreenerRow[]; selectedCode: string | null }) =>
        useRowsAndMonitor(rows, selectedCode),
      { wrapper: Wrapper, initialProps: { rows: ROWS, selectedCode: SELECTED } },
    );
    await waitFor(() => expect(result.current[349].price).toBe(10000));
    expect([...handlers.keys()]).toEqual([SELECTED]);
    expect(ws.subscribeLive).toHaveBeenCalledTimes(1);

    await act(async () => {
      handlers.get(SELECTED)?.({
        t_ms: 1, kind: 'trade', trades: [{ t_ms: 1, price: 12000, qty: 1 }],
      });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current[349].price).toBe(12000);
    expect(result.current[0].price).toBe(10000);

    rerender({ rows: ROWS, selectedCode: CODES[0] });
    expect(released).toHaveBeenCalledWith(SELECTED);
    expect([...handlers.keys()]).toEqual([CODES[0]]);
    expect(client.apiCall).toHaveBeenCalledTimes(1);

    rerender({ rows: ROWS.slice(1), selectedCode: CODES[0] });
    expect(released).toHaveBeenCalledWith(CODES[0]);
    expect(handlers.size).toBe(0);
    rerender({ rows: ROWS, selectedCode: SELECTED });
    expect([...handlers.keys()]).toEqual([SELECTED]);
    unmount();
    expect(handlers.size).toBe(0);
  });

  it('NXT 미상장 종목은 REST와 선택 종목 WS 모두 KRX 해석을 유지한다', async () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    const { result } = renderHook(() => useRowsAndMonitor(ROWS, SELECTED), { wrapper: Wrapper });
    await waitFor(() => expect(result.current[349].price).toBe(10000));
    expect([...handlers.keys()]).toEqual([SELECTED]);
    expect(client.apiCall).toHaveBeenCalledTimes(1);
    expect(client.apiCall).toHaveBeenCalledWith(`/api/live/quotes?codes=${CODES.join(',')}&venue=KRX`);
  });

  it('일반 시세 소비자는 기존 전체 코드 WS 구독을 유지한다', async () => {
    renderHook(() => useLiveQuoteOverlay(CODES.slice(0, 2)), { wrapper: Wrapper });
    expect([...handlers.keys()]).toEqual(CODES.slice(0, 2));
  });
});
