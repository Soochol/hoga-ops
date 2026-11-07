import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from './client';
import { useLivePastInvestorNet, type LivePastInvestorNetResponse } from './livePastInvestorNet';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const today = '20260106';
function response(to: string): LivePastInvestorNetResponse {
  return { code: '005930', from: '20260105', to, unit: 'qty_shares', trade_side: 'net', points: [],
    cached_batches: [], fresh_batches: [], data_warnings: [], daily_flow: { code: '005930', from: '20260105', to,
      source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net', observations: [],
      pagination: 'incomplete', can_continue: false, unlocated_defect: false, pages_observed: 1, data_warnings: [] } };
}
function setup(to: string) {
  const cache = new QueryClient();
  return renderHook(() => ({ ...useLivePastInvestorNet('005930', '20260105', to) }), {
    wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  });
}
it('refreshes today after a provisional range stop and waits for the in-flight refresh', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 0, 6, 1));
  let release!: (value: LivePastInvestorNetResponse) => void;
  const pending = new Promise<LivePastInvestorNetResponse>(resolve => { release = resolve; });
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(response(today)).mockImplementationOnce(() => pending)
    .mockResolvedValue(response(today));
  const hook = setup(today);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(hook.result.current.data?.daily_flow?.pagination).toBe('incomplete');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(hook.result.current.isFetching).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => { release(response(today)); await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetch).toHaveBeenCalledTimes(3);
  hook.unmount();
});
it('does not poll historical canonical ranges merely because the market is open', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 0, 6, 1));
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue(response('20260105'));
  const hook = setup('20260105');
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});
