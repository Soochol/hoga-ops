import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from './client';
import { investorDailyFlowForScope, useLivePastInvestorNet, type LivePastInvestorNetResponse } from './livePastInvestorNet';
import type { DailyFlowRequestScope, InvestorDailyFlowResponse } from './investorDailyFlow';
vi.mock('../live/liveDateTime', () => ({ isKrxRegularSessionNow: () => false }));
afterEach(() => vi.restoreAllMocks());
const scope = { code: '005930', from: '20260105', to: '20260106' };
const key = ['live', 'past-investor-net', scope.code, scope.from, scope.to, 'qty', 'net'];
function envelope(pages = 1, partial = false, request: DailyFlowRequestScope = scope): LivePastInvestorNetResponse {
  const daily_flow: InvestorDailyFlowResponse = { ...request, source: 'kiwoom_ka10059', provider_scope: 'KRX',
    unit: 'qty_shares', trade_side: 'net', observations: [{ date: request.from,
      t_ms: Date.parse(`${request.from.slice(0, 4)}-${request.from.slice(4, 6)}-${request.from.slice(6)}T00:00:00Z`),
      institution_net_shares: 0, foreign_net_shares: 17 }], pagination: partial ? 'incomplete' : 'covered',
    unlocated_defect: false, pages_observed: pages, can_continue: partial,
    data_warnings: partial ? [{ reason: 'page_budget', date: null, subject: null, message: 'continue' }] : [] };
  return { ...request, unit: 'qty_shares', trade_side: 'net', daily_flow, points: [], cached_batches: [], fresh_batches: [], data_warnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const hook = renderHook(({ request }: { request: DailyFlowRequestScope | null }) => useLivePastInvestorNet(
    request?.code ?? null, request?.from ?? null, request?.to ?? null, 'qty', 'net'), {
    initialProps: { request: scope }, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  });
  return { ...hook, cache };
}
it('publishes page one to simultaneous and staggered observers while page two is held, with one continuation chain', async () => {
  const next = deferred<LivePastInvestorNetResponse>();
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(envelope(1, true)).mockImplementationOnce(() => next.promise);
  const first = setup();
  const second = setup(first.cache);
  await waitFor(() => expect(second.result.current.data?.daily_flow?.pages_observed).toBe(1));
  expect(first.result.current.isFetching).toBe(true);
  expect(second.result.current.data?.daily_flow?.observations[0].foreign_net_shares).toBe(17);
  const late = setup(first.cache);
  await waitFor(() => expect(late.result.current.data?.daily_flow?.pages_observed).toBe(1));
  expect(fetch).toHaveBeenCalledTimes(2);
  first.unmount();
  expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(false);
  await act(async () => next.resolve(envelope(7)));
  await waitFor(() => expect(second.result.current.isFetching).toBe(false));
  expect(second.result.current.data?.daily_flow?.pagination).toBe('covered');
  expect(late.result.current.data).toEqual(second.result.current.data);
  expect(fetch).toHaveBeenCalledTimes(2);
  second.unmount(); late.unmount();
});
it('aborts after the last observer leaves and retains published data without accepting a late transport response', async () => {
  const next = deferred<LivePastInvestorNetResponse>();
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(envelope(1, true)).mockImplementationOnce(() => next.promise);
  const hook = setup();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  hook.unmount();
  expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
  await act(async () => { next.resolve(envelope(7, true)); await next.promise; });
  expect(hook.cache.getQueryData<LivePastInvestorNetResponse>(key)?.daily_flow?.pages_observed).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('ignores an abandoned code even when its transport ignores abort', async () => {
  const old = deferred<LivePastInvestorNetResponse>();
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async path => path.includes('005930')
    ? old.promise : envelope(1, false, { ...scope, code: '000660' }));
  const hook = setup();
  hook.rerender({ request: { ...scope, code: '000660' } });
  await waitFor(() => expect(hook.result.current.data?.code).toBe('000660'));
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => { old.resolve(envelope(1, true)); await old.promise; });
  expect(hook.result.current.data?.code).toBe('000660');
  expect(hook.cache.getQueryData(key)).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
});
it('keeps exact request ranges independent and uses their warm cache', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async path => {
    const params = new URL(path, 'http://local').searchParams;
    return envelope(1, false, { ...scope, from: params.get('from')! });
  });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  const older = { ...scope, from: '20260102' };
  hook.rerender({ request: older });
  expect(investorDailyFlowForScope(hook.result.current.data, older)).toBeNull();
  await waitFor(() => expect(hook.result.current.data?.from).toBe(older.from));
  hook.rerender({ request: scope });
  expect(hook.result.current.data?.from).toBe(scope.from);
  expect(fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
});
it.each(['api_error', 'invalid_page', 'cursor_stalled', 'unavailable'] as const)('stops on fatal %s even with page_budget present', async reason => {
  const response = envelope(1, true);
  response.daily_flow!.data_warnings.push({ reason, date: null, subject: null, message: 'stop' });
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue(response);
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});
it('stops when page progress stalls', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue(envelope(1, true));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
});
it('reaches the 128 page cap with cold one-page then six-page collections', async () => {
  let requests = 0;
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async () => envelope(Math.min(128, 1 + requests++ * 6), true));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(23);
  expect(hook.result.current.data?.daily_flow?.pages_observed).toBe(128);
  hook.unmount();
});
it('stops at 23 HTTP requests if pages advance less than the expected batch size', async () => {
  let pages = 0;
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async () => envelope(++pages, true));
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(23);
  expect(hook.result.current.data?.daily_flow?.pages_observed).toBe(23);
  hook.unmount();
});
it('does not request absent or invalid ranges', () => {
  const fetch = vi.spyOn(client, 'apiCall');
  const cache = new QueryClient();
  const initialProps: { request: DailyFlowRequestScope | null } = { request: null };
  const hook = renderHook(({ request }: { request: DailyFlowRequestScope | null }) => useLivePastInvestorNet(
    request?.code ?? null, request?.from ?? null, request?.to ?? null), {
    initialProps, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider>,
  });
  for (const request of [{ ...scope, from: '' }, { ...scope, from: '20260230' }, { ...scope, to: '20260101' }]) hook.rerender({ request });
  expect(fetch).not.toHaveBeenCalled();
  hook.unmount();
});
it.each([{ unit: 'amt_mwon' }, { trade_side: 'buy' }, { code: '000660' }, { from: '20260102' }])('does not publish mismatched canonical envelope %j', async overrides => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...envelope(), ...overrides });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.cache.getQueryData(key)).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});
it.each([{ from: '20260102' }, { unit: 'amt_mwon' }, { trade_side: 'buy' }, { provider_scope: 'other' }])('does not publish mismatched nested strict source %j', async overrides => {
  const response = envelope();
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...response, daily_flow: { ...response.daily_flow, ...overrides } });
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.cache.getQueryData(key)).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});

it('stops an incomplete requested range without treating it as terminal coverage', async () => {
  const response = envelope(1, true);
  response.daily_flow!.can_continue = false;
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue(response);
  const hook = setup();
  await waitFor(() => expect(hook.result.current.isFetching).toBe(false));
  expect(hook.result.current.data?.daily_flow).toMatchObject({ pagination: 'incomplete', can_continue: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  hook.unmount();
});
