import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { OrderbookSnapshot } from '../../api/types';
import * as client from '../../api/client';
import { useBookSessionDisplay } from './useBookSessionDisplay';

vi.mock('../useEffectiveVenue', () => ({
  useNxtEnabledResolver: () => () => false,
  useKrxAftermarketExcluded: () => false,
  useEffectiveVenue: (_code: string, venue: string) => venue === 'UN' ? 'KRX' : venue,
}));
vi.mock('../../api/liveAfterHoursBook', async original => ({
  ...await original<typeof import('../../api/liveAfterHoursBook')>(),
  useAfterHoursBook: () => ({ data: undefined }),
}));

const at = (hour: number, minute = 0, second = 0) => Date.UTC(2026, 9, 14, hour - 9, minute, second);
const book = (time: number, price = 33350): OrderbookSnapshot => ({
  ts_ms: time, seq: 0, ask: [{ price: price + 50, qty: 2 }], bid: [{ price, qty: 3 }], tot_ask: 2, tot_bid: 3,
});
const empty = { ...book(at(15, 40)), ask: [{ price: 0, qty: 0 }], bid: [{ price: 0, qty: 0 }] };
const saved = book(at(15, 19, 50));

function setup(venue: 'KRX' | 'NXT' | 'UN' = 'KRX', isSpot = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const props = { nowMs: at(15, 40), latest: empty, retained: null as OrderbookSnapshot | null,
    preAuction: null as OrderbookSnapshot | null };
  const hook = renderHook(({ nowMs, latest, retained, preAuction }) => useBookSessionDisplay({
    code: '036930', venue, nowMs, todayKst: '20261014', isSpot,
    latestSnapshot: latest, regularSnapshot: latest, lastValidSnapshot: retained, preAuctionSnapshot: preAuction,
    afterHours: [{ t_ms: at(15, 41), total_ask_qty: 999, total_bid_qty: 888, venue: 'KRX' }],
  }), { wrapper, initialProps: props });
  return { ...hook, props, queryClient };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('recovers pre-auction data after an empty reset and replaces it at 15:59:50 without a clock gate', async () => {
  const api = vi.spyOn(client, 'apiCall').mockResolvedValue({ snapshot: saved });
  const { result, rerender, props } = setup('UN');
  await waitFor(() => expect(result.current.snapshot).toEqual(saved));
  expect(result.current.storedLadder).toBe(true);
  expect(result.current.afterHoursTotals).toBeNull();
  expect(result.current.sessionControl).toEqual({ kind: 'label', label: '정규장 마지막 · 15:19:50' });
  const url = new URL(api.mock.calls[0][0], 'http://test');
  expect(url.searchParams.get('venue')).toBe('KRX');
  expect(Number(url.searchParams.get('t'))).toBe(at(15, 20) - 1);
  const early = book(at(15, 59, 50), 33400);
  rerender({ ...props, nowMs: at(15, 59, 50), latest: early, retained: early });
  expect(result.current.snapshot).toEqual(early);
  expect(result.current.storedLadder).toBe(false);
  expect(result.current.sessionControl).toEqual({ kind: 'label', label: '실시간 호가 · 15:59:50' });
  rerender({ ...props, nowMs: at(16), latest: early, retained: early });
  expect(result.current.snapshot).toEqual(early);
  expect(api).toHaveBeenCalledTimes(1);
});

it('keeps the saved ladder past 16:00 until data arrives, and resumes updates past 20:00', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ snapshot: saved });
  const { result, rerender, props } = setup();
  await waitFor(() => expect(result.current.snapshot).toEqual(saved));
  rerender({ ...props, nowMs: at(16, 0, 3) });
  expect(result.current.snapshot).toEqual(saved);
  expect(result.current.sessionControl).toEqual({ kind: 'label', label: '정규장 마지막 · 15:19:50 · 수신 대기' });
  const live = book(at(16, 0, 3), 33450);
  rerender({ ...props, nowMs: at(16, 0, 3), latest: live, retained: live });
  expect(result.current.snapshot).toEqual(live);
  expect(result.current.storedLadder).toBe(false);
  rerender({ ...props, nowMs: at(20, 0, 2), latest: live, retained: live });
  expect(result.current.snapshot).toEqual(live);
  const late = book(at(20, 0, 2), 33500);
  rerender({ ...props, nowMs: at(20, 0, 2), latest: late, retained: late });
  expect(result.current.snapshot).toEqual(late);
});

it('keeps same-day usable data across empty frames outside KRX, including before the opening time', () => {
  const api = vi.spyOn(client, 'apiCall');
  const retained = book(at(7, 59, 50));
  const { result, rerender, props } = setup('NXT');
  rerender({ ...props, nowMs: at(7, 59, 50), latest: retained, retained });
  expect(result.current.snapshot).toEqual(retained);
  rerender({ ...props, nowMs: at(8), latest: empty, retained });
  expect(result.current.snapshot).toEqual(retained);
  expect(result.current.storedLadder).toBe(true);
  expect(api).not.toHaveBeenCalled();
});

it('does not substitute live or saved fallback data into a historical cursor', () => {
  const api = vi.spyOn(client, 'apiCall');
  const { result } = setup('KRX', true);
  expect(result.current.snapshot).toEqual(empty);
  expect(result.current.storedLadder).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

it.each([at(15, 25), at(15, 19) - 86_400_000])('rejects an auction or another day from recovery (%s)', async timestamp => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ snapshot: book(timestamp) });
  const { result, queryClient } = setup();
  await waitFor(() => expect(queryClient.getQueryData(['live', 'pre-auction-book', '036930', '20261014', 'KRX'])).toBeNull());
  expect(result.current.snapshot).toBeNull();
  expect(result.current.afterHoursTotals).toEqual({ ask: 999, bid: 888 });
  expect(result.current.sessionControl).toEqual({ kind: 'label', label: '시간외종가' });
});

it('does not replace a newer received pre-auction frame with an older disk snapshot', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ snapshot: book(at(15, 19, 30)) });
  const { result, rerender, props, queryClient } = setup();
  rerender({ ...props, retained: saved });
  await waitFor(() => expect(queryClient.getQueryData(['live', 'pre-auction-book', '036930', '20261014', 'KRX'])).toBeDefined());
  expect(result.current.snapshot).toEqual(saved);
});

it('uses the separately retained WS book when the last usable frame is an auction and disk data is absent', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ snapshot: null });
  const { result, rerender, props, queryClient } = setup();
  const exact = book(at(15, 19, 59));
  rerender({ ...props, retained: book(at(15, 25)), preAuction: exact });
  expect(result.current.snapshot).toEqual(exact);
  await waitFor(() => expect(queryClient.getQueryData(['live', 'pre-auction-book', '036930', '20261014', 'KRX'])).toBeNull());
  expect(result.current.snapshot).toEqual(exact);
  expect(result.current.storedLadder).toBe(true);
});

it('retries a missing promoted book without losing a pre-auction frame already received', async () => {
  const api = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({ snapshot: null }).mockResolvedValue({ snapshot: saved });
  const { result, rerender, props, queryClient } = setup();
  rerender({ ...props, retained: saved });
  expect(result.current.snapshot).toEqual(saved);
  await waitFor(() => expect(api).toHaveBeenCalledOnce());
  await act(() => queryClient.invalidateQueries({ queryKey: ['live', 'pre-auction-book'] }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(result.current.snapshot).toEqual(saved);
});
