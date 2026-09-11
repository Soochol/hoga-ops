import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQuoteByCode } from './liveQuotes';
import { EXPECTED_FILL_TTL_MS } from './liveTickOverlay';
import * as client from './client';
import * as ws from './ws';
import { seedSymbolMaster } from '../live/seedSymbolMaster';

const code = '005930';
const now = Date.UTC(2026, 8, 14, 6, 30);
let receive: Parameters<typeof ws.subscribeLiveLatest>[1];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(now);
  vi.spyOn(ws, 'subscribeLiveLatest').mockImplementation((_code, handler) => {
    receive = handler;
    return () => {};
  });
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'closed', quotes: [{ code, price: 100, change_pct: 0, change_won: 0 }],
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useQuoteByCode([code]), { wrapper });
  await waitFor(() => expect(hook.result.current.get(code)?.price).toBe(100));
  return hook;
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function expected(tMs = now - 1000, price = 120) {
  act(() => receive({ kind: 'ob', venue: 'KRX', t_ms: tMs, expected_price: price, expected_qty: 10 }));
  await advance(200);
}

it('expires without new frames or a REST poll during the closed phase', async () => {
  const { result } = await setup();
  await expected();
  expect(result.current.get(code)?.expected_price).toBe(120);
  const requests = vi.mocked(client.apiCall).mock.calls.length;
  await advance(EXPECTED_FILL_TTL_MS + 200);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
  expect(result.current.get(code)?.price).toBe(100);
  expect(client.apiCall).toHaveBeenCalledTimes(requests);
});

it('same-price updates renew expiry, and unmount cancels the expiry work', async () => {
  const { result, unmount } = await setup();
  await expected();
  await advance(20_000);
  await expected(now);
  await advance(15_000);
  expect(result.current.get(code)?.expected_price).toBe(120);
  await advance(16_000);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
  await expected(now + 1000);
  unmount();
  const requests = vi.mocked(client.apiCall).mock.calls.length;
  await advance(EXPECTED_FILL_TTL_MS + 200);
  expect(client.apiCall).toHaveBeenCalledTimes(requests);
});

it.each([now - 3 * 86400_000, now + 86400_000, Number.NaN])('rejects expected frames from another day or invalid time: %s', async tMs => {
  const { result } = await setup();
  await expected(tMs);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
  await expected();
  expect(result.current.get(code)?.expected_price).toBe(120);
});

it('rejects older expected quotes even after the newer quote expires', async () => {
  const { result } = await setup();
  await expected(now - 1000, 120);
  await expected(now - 2000, 130);
  expect(result.current.get(code)?.expected_price).toBe(120);
  await advance(EXPECTED_FILL_TTL_MS + 200);
  await expected(now - 2000, 130);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
});

it('an executed trade clears the expected quote and blocks its delayed resurrection', async () => {
  const { result } = await setup();
  await expected();
  act(() => receive({ kind: 'trade', venue: 'KRX', t_ms: now, prev_close: 100,
    trades: [{ price: 110, qty: 1, side: 1 }] }));
  await advance(200);
  expect(result.current.get(code)?.price).toBe(110);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
  await expected(now - 1000);
  await expected(now);
  expect(result.current.get(code)?.expected_price).toBeUndefined();
  await expected(now + 1000);
  expect(result.current.get(code)?.expected_price).toBe(120);
});
