import { act, renderHook } from '@testing-library/react';
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
  expect(hook.result.current.availability?.kind).toBe('registering');
});
it('keeps a reference-limit reason after its toast is dismissed', () => {
  const hook = setup();
  source.limited = true;
  act(() => { useKiwoomFullHouseStore.getState().notifyReferenceLimit('005930');
    useKiwoomFullHouseStore.getState().dismissReferenceLimit(); });
  hook.rerender({ code: '005930', venue: 'KRX', enabled: true });
  expect(hook.result.current.availability?.kind).toBe('reference_limit');
});
it('retries only the current code series query', () => {
  const hook = setup();
  const invalidate = vi.spyOn(hook.client, 'invalidateQueries');
  act(() => hook.result.current.retry());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['live', 'series', '005930'] });
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
