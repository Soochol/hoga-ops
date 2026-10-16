import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from './client';
import { useLiveSeries } from './liveSeries';
import { useRegularSessionLiveSeries } from '../live/useRegularSessionLiveSeries';
import { fakeSockets, installFakeWebSocket } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

vi.mock('../util/useKstDay', () => ({ useKstDay: () => '20261016' }));
beforeEach(() => {
  installFakeWebSocket(); resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8000/api/ws');
});
afterEach(() => { cleanup(); resetWs(); vi.restoreAllMocks(); });

it.each(['KRX', 'NXT', 'UN'] as const)(
  '%s badge keeps the WS subscription and receives evening frames while hidden', async venue => {
    const api = vi.spyOn(client, 'apiCall').mockImplementation(async path =>
      path.startsWith('/api/live/series') ? {
        code: '005930', date: '20261016', session_open_ms: 0, session_close_ms: null,
        snapshots: [], trades: [], programs: [], brokers: [], after_hours: [], expected: [],
      } : { symbols: [{ code: '005930', nxt_enabled: true }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result, rerender, unmount } = renderHook(({ regular }) => {
      const raw = useLiveSeries('005930', venue);
      return { raw, view: useRegularSessionLiveSeries(raw, regular) };
    }, { wrapper, initialProps: { regular: false } });
    await waitFor(() => expect(result.current.raw.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets).toHaveLength(1));
    const sock = fakeSockets[0];
    act(() => sock.open());
    const sent = sock.parsedSent();
    expect(sent.filter(f => f.action === 'subscribe')).toEqual([
      { action: 'subscribe', code: '005930', protocol: 2 },
    ]);
    const frame = (second: string) => ({ ch: 'live', code: '005930', data: {
      t_ms: Date.parse(`2026-10-16T19:59:${second}+09:00`), venue, kind: 'ob',
      total_bid_qty: 100, total_ask_qty: 200,
      asks: [{ price: 101, qty: 200 }], bids: [{ price: 100, qty: 100 }],
    } });
    act(() => sock.message(frame('30')));
    await waitFor(() => expect(result.current.raw.ob).toHaveLength(1));
    expect(result.current.view.ob).toBe(result.current.raw.ob);
    rerender({ regular: true });
    expect(result.current.view.ob).toHaveLength(0);
    expect(result.current.raw.ob).toHaveLength(1);
    act(() => sock.message(frame('40')));
    await waitFor(() => expect(result.current.raw.ob).toHaveLength(2));
    expect(result.current.view.ob).toHaveLength(0);
    rerender({ regular: false });
    expect(result.current.view.ob).toBe(result.current.raw.ob);
    expect(result.current.view.ob).toHaveLength(2);
    rerender({ regular: true });
    expect(result.current.view.ob).toHaveLength(0);
    expect(sock.parsedSent()).toEqual(sent);
    expect(fakeSockets).toHaveLength(1);
    expect(api.mock.calls.filter(([p]) => p.startsWith('/api/live/series'))).toHaveLength(1);
    expect(api.mock.calls.some(([p]) => p.includes('regular_session_only'))).toBe(false);
    unmount(); qc.clear();
  },
);
