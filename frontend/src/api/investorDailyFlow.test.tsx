import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from './client';
import { useInvestorDailyFlow, type DailyFlowRequestScope, type InvestorDailyFlowResponse } from './investorDailyFlow';

vi.mock('../live/liveDateTime', () => ({ isKrxRegularSessionNow: () => false }));
afterEach(() => vi.restoreAllMocks());
const scope = { code: '005930', from: '20260105', to: '20260106' };
const response = (request: DailyFlowRequestScope): InvestorDailyFlowResponse => ({ ...request,
  source: 'kiwoom_ka10059', provider_scope: 'KRX', unit: 'qty_shares', trade_side: 'net', observations: [],
  pagination: 'covered', unlocated_defect: false, pages_observed: 1, can_continue: false, data_warnings: [] });
function setup(initial: DailyFlowRequestScope | null) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(({ request }: { request: DailyFlowRequestScope | null }) => {
    const first = useInvestorDailyFlow(request);
    const repeated = useInvestorDailyFlow(request);
    return { first, repeated };
  }, { initialProps: { request: initial }, wrapper: ({ children }) => <QueryClientProvider client={cache}>{children}</QueryClientProvider> });
}
it('shares repeated-pane queries while exact range keys remain independent', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async path => {
    const params = new URL(path, 'http://local').searchParams;
    return response({ code: params.get('code')!, from: params.get('from')!, to: params.get('to')! });
  });
  const { result, rerender, unmount } = setup(scope);
  await waitFor(() => expect(result.current.repeated.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  const older = { ...scope, from: '20260102' };
  rerender({ request: older });
  expect(result.current.first.data).toBeUndefined();
  await waitFor(() => expect(result.current.first.data?.from).toBe(older.from));
  expect(fetch).toHaveBeenCalledTimes(2);
  rerender({ request: scope });
  await waitFor(() => expect(result.current.first.data?.from).toBe(scope.from));
  expect(fetch).toHaveBeenCalledTimes(2);
  unmount();
});
it('late data from an abandoned Code cannot replace the current Code', async () => {
  let release: (value: InvestorDailyFlowResponse) => void = () => {};
  const held = new Promise<InvestorDailyFlowResponse>(resolve => { release = resolve; });
  vi.spyOn(client, 'apiCall').mockImplementation(async path => path.includes('005930') ? held : response({ ...scope, code: '000660' }));
  const { result, rerender, unmount } = setup(scope);
  rerender({ request: { ...scope, code: '000660' } });
  await waitFor(() => expect(result.current.first.data?.code).toBe('000660'));
  await act(async () => { release(response(scope)); await held; });
  expect(result.current.first.data?.code).toBe('000660');
  unmount();
});
it('does not request absent or invalid loaded ranges', async () => {
  const fetch = vi.spyOn(client, 'apiCall');
  const { rerender, unmount } = setup(null);
  for (const request of [{ ...scope, from: '' }, { ...scope, from: '20260230' }, { ...scope, to: '20260101' }]) rerender({ request });
  expect(fetch).not.toHaveBeenCalled();
  unmount();
});

const partial = (pages: number): InvestorDailyFlowResponse => ({ ...response(scope), pagination: 'incomplete',
  pages_observed: pages, can_continue: true,
  data_warnings: [{ reason: 'page_budget', date: null, subject: null, message: 'more pages' }] });
it('completes progress-making page budgets without another user action or duplicate pane requests', async () => {
  const fetch = vi.spyOn(client, 'apiCall')
    .mockResolvedValueOnce(partial(6)).mockResolvedValueOnce(partial(12)).mockResolvedValueOnce(response(scope));
  const { result, unmount } = setup(scope);
  await waitFor(() => expect(result.current.first.data?.pagination).toBe('covered'));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new Set(fetch.mock.calls.map(([path]) => path)).size).toBe(1);
  unmount();
});
it.each(['api_error', 'invalid_page', 'cursor_stalled', 'unavailable'] as const)('stops automatic continuation on %s', async reason => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...partial(6),
    data_warnings: [{ reason, date: null, subject: null, message: 'cannot continue automatically' }] });
  const { result, unmount } = setup(scope);
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.current.first.data?.pagination).toBe('incomplete');
  unmount();
});
it('stops when page progress stalls', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue(partial(6));
  const { result, unmount } = setup(scope);
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.first.data?.pagination).toBe('incomplete');
  unmount();
});
it('stops at a hard automatic request budget even if the source keeps making progress', async () => {
  let pages = 0;
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async () => partial(++pages));
  const { result, unmount } = setup(scope);
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(22);
  expect(result.current.first.data?.pagination).toBe('incomplete');
  unmount();
});
it('does not continue a provider page limit that cannot be advanced', async () => {
  const fetch = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...partial(128), can_continue: false });
  const { result, unmount } = setup(scope);
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  expect(fetch).toHaveBeenCalledTimes(1);
  unmount();
});
it('cancels an abandoned scope before another continuation even if transport ignores abort', async () => {
  let release: (value: InvestorDailyFlowResponse) => void = () => {};
  const pending = new Promise<InvestorDailyFlowResponse>(resolve => { release = resolve; });
  const fetch = vi.spyOn(client, 'apiCall').mockImplementation(async path => path.includes('005930')
    ? pending : response({ ...scope, code: '000660' }));
  const { result, rerender, unmount } = setup(scope);
  const signal = fetch.mock.calls[0][1]?.signal;
  rerender({ request: { ...scope, code: '000660' } });
  await waitFor(() => expect(result.current.first.data?.code).toBe('000660'));
  expect(signal?.aborted).toBe(true);
  await act(async () => { release(partial(6)); await pending; });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.first.data?.code).toBe('000660');
  unmount();
});
