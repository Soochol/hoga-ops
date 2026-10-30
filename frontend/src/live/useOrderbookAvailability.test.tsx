import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { LiveStatus } from '../api/liveStatus';
import type { LiveSeriesData } from '../api/liveSeries';
import { useKiwoomFullHouseStore } from '../state/kiwoomFullHouse';
import { useOrderbookAvailability } from './useOrderbookAvailability';
const source = vi.hoisted(() => ({ connected: true, connectedAt: 0, limited: false, query: {
  data: undefined as LiveStatus | undefined, dataUpdatedAt: 100_000, isError: false,
} }));
vi.mock('../api/liveStatus', () => ({ useLiveStatus: () => source.query }));
vi.mock('../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => source.connected }));
vi.mock('../api/ws', () => ({ wsConnectedAt: () => source.connectedAt,
  liveSubscriptionLimited: () => source.limited, subscribeLiveAdmissionStatus: () => () => {}, }));
const live: LiveSeriesData = { initial: undefined, isLoading: false, error: null,
  ob: [], trade: [], broker: [], program: [], afterHours: [], expected: [] };
beforeEach(() => {
  source.connected = true; source.connectedAt = 0; source.limited = false; source.query.dataUpdatedAt = 100_000;
  source.query.data = { kiwoom: { ready_registrations: ['005930'], observed_at_ms: 100_000 } } as LiveStatus;
  source.query.isError = false; useKiwoomFullHouseStore.getState().clear();
});
function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook((props: { code: string; venue: 'KRX' | 'NXT'; enabled: boolean }) =>
    useOrderbookAvailability({ ...props, live, nowMs: 100_000 }), { wrapper,
    initialProps: { code: '005930', venue: 'KRX', enabled: true } }) };
}
it('shares status but resets interpretation on code and venue changes', () => {
  const hook = setup();
  expect(hook.result.current.availability?.kind).toBe('awaiting_book');
  hook.rerender({ code: '005930', venue: 'NXT', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('registering');
  hook.rerender({ code: '000660', venue: 'KRX', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('registering');
  hook.rerender({ code: '000660', venue: 'KRX', enabled: false });
  expect(hook.result.current.availability).toBeNull();
});
it('ignores pre-reconnect and stale status observations', () => {
  source.connectedAt = 99_000;
  source.query.data!.kiwoom!.observed_at_ms = 98_000;
  const hook = setup();
  expect(hook.result.current.availability?.kind).toBe('registering');
  source.query.data!.kiwoom!.observed_at_ms = 100_000;
  hook.rerender({ code: '005930', venue: 'KRX', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('awaiting_book');
  source.query.isError = true;
  hook.rerender({ code: '005930', venue: 'KRX', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('status_error');
});
it('keeps a reference-limit reason after its toast is dismissed', () => {
  const hook = setup();
  source.limited = true;
  act(() => { useKiwoomFullHouseStore.getState().notifyReferenceLimit('005930');
    useKiwoomFullHouseStore.getState().dismissReferenceLimit(); });
  hook.rerender({ code: '005930', venue: 'KRX', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('reference_limit');
});
it('distinguishes an expired observation from a failed status request for an existing book', () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  source.query.data!.kiwoom!.observed_at_ms = 50_000;
  const hook = renderHook(() => useOrderbookAvailability({ code: '005930', venue: 'KRX',
    live, nowMs: 100_000, bookMs: 67_000, enabled: true }), { wrapper });
  expect(hook.result.current.availability).toMatchObject({ kind: 'stale', quiet: true, lastBookMs: 67_000 });
  source.query.isError = true;
  hook.rerender();
  expect(hook.result.current.availability).toMatchObject({ kind: 'status_error', retryTarget: 'status' });
  hook.unmount(); client.clear();
});
it('retries only the current code series query', () => {
  const hook = setup();
  const invalidate = vi.spyOn(hook.client, 'invalidateQueries');
  act(() => hook.result.current.retry());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['live', 'series', '005930', '19700101', 'KRX'], exact: true }, { cancelRefetch: false });
});

it('joins recovery across two books and never treats stale status or trades as a reason to refetch', async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  source.query.data!.kiwoom!.data_received_ms = { '005930:KRX:ob': 99_900 };
  const render = () => renderHook((enabled: boolean) => useOrderbookAvailability({
    code: '005930', venue: 'KRX', live, nowMs: 100_000, bookMs: 67_000, enabled,
  }), { wrapper, initialProps: true });
  const first = render();
  const second = render();
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  expect(first.result.current.availability?.kind).toBe('display_delayed');
  expect(first.result.current.availability?.diagnostics?.serverReceivedMs).toBe(99_900);
  expect(second.result.current.availability?.kind).toBe('display_delayed');
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['live', 'series', '005930', '19700101', 'KRX'], exact: true }, { cancelRefetch: false });
  source.query.data!.kiwoom!.data_received_ms = { '005930:KRX:trade': 99_900 };
  first.rerender(true);
  expect(first.result.current.availability?.kind).toBe('stale');
  source.query.data!.kiwoom!.data_received_ms = { '005930:KRX:ob': 99_900 };
  source.query.data!.kiwoom!.observed_at_ms = 50_000;
  second.rerender(true);
  expect(second.result.current.availability?.kind).toBe('stale');
  expect(second.result.current.availability?.diagnostics?.serverReceivedMs).toBeUndefined();
  expect(invalidate).toHaveBeenCalledTimes(1);
  first.unmount(); second.unmount(); client.clear();
});

it('explains exclusion even while a stored ladder disables live-delay reporting', () => {
  const now = Date.parse('2026-10-22T19:30:00+09:00');
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useOrderbookAvailability({
    code: '079650', venue: 'KRX', live, nowMs: now, enabled: false,
    bookMs: Date.parse('2026-10-22T15:30:02+09:00'),
    exclusion: { code: '079650', date: '20261022', status: 'checked', reasons: ['investment_warning'],
      checked_at_ms: now, source: 'kiwoom_ka10100' },
  }), { wrapper });
  expect(result.current.availability).toMatchObject({ kind: 'aftermarket_excluded',
    message: 'KRX 장후 거래 제외 · 투자경고종목' });
});

it('retries a failed status observation without fetching series or reconnecting', () => {
  source.query.isError = true;
  const hook = setup();
  const invalidate = vi.spyOn(hook.client, 'invalidateQueries');
  expect(hook.result.current.availability?.kind).toBe('status_error');
  act(() => hook.result.current.retry());
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['live', 'status'], exact: true }, { cancelRefetch: false });
  hook.unmount(); hook.client.clear();
});

it('retries only the failed selected REST or saved source, retaining its flags until recovery', () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const retryRest = vi.fn();
  const retrySaved = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook((enabled: boolean) => useOrderbookAvailability({
    code: '005930', venue: 'KRX', live, nowMs: 100_000, enabled: false, hasBook: true,
    rest: { enabled, loading: false, isError: true, retry: retryRest },
    bookQuery: { target: 'saved_regular', loading: false, error: !enabled, retry: retrySaved },
  }), { wrapper, initialProps: true });
  expect(hook.result.current.availability?.kind).toBe('rest_error');
  act(() => hook.result.current.retry());
  expect(retryRest).toHaveBeenCalledOnce();
  expect(retrySaved).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(hook.result.current.availability?.kind).toBe('rest_error');
  hook.rerender(false);
  expect(hook.result.current.availability?.kind).toBe('saved_error');
  act(() => hook.result.current.retry());
  expect(retrySaved).toHaveBeenCalledOnce();
  expect(retryRest).toHaveBeenCalledOnce();
  hook.unmount(); client.clear();
});
