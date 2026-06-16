import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from './client';
import {
  liveInvestorTrendEstimateQueryOptions,
  useLiveInvestorTrendEstimate,
  type LiveInvestorTrendEstimateResponse,
} from './liveInvestorTrendEstimate';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

vi.mock('../live/liveDateTime', () => ({
  isKrxRegularSessionNow: vi.fn(),
}));

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE_005930: LiveInvestorTrendEstimateResponse = {
  code: '005930',
  trading_day: '20260616',
  fetched_at_ms: 1,
  rows: [
    { slot: '09:00', foreign_qty: 10, institution_qty: 20, sum_qty: 30 },
  ],
  latest: { slot: '09:00', foreign_qty: 10, institution_qty: 20, sum_qty: 30 },
  source: 'kis',
  status: 'ok',
  data_warning: null,
};

const RESPONSE_000660: LiveInvestorTrendEstimateResponse = {
  ...RESPONSE_005930,
  code: '000660',
  rows: [
    { slot: '09:00', foreign_qty: 100, institution_qty: 200, sum_qty: 300 },
  ],
  latest: { slot: '09:00', foreign_qty: 100, institution_qty: 200, sum_qty: 300 },
};

describe('useLiveInvestorTrendEstimate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(isKrxRegularSessionNow).mockReturnValue(false);
  });

  it('fetches immediately for a code and passes an AbortSignal to apiCall', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE_005930);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useLiveInvestorTrendEstimate('005930'), {
      wrapper: wrap(qc),
    });

    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    expect(spy).toHaveBeenCalledWith(
      '/api/live/investor-trend-estimate?code=005930',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE_005930);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useLiveInvestorTrendEstimate(null), { wrapper: wrap(qc) });

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('query key changes split cache entries for different codes', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('code=005930') ? RESPONSE_005930 : RESPONSE_000660),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useLiveInvestorTrendEstimate(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );

    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ code: '000660' });
    await waitFor(() => expect(result.current.data?.code).toBe('000660'));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(qc.getQueryData(['live', 'investor-trend-estimate', '005930'])).toEqual(RESPONSE_005930);
    expect(qc.getQueryData(['live', 'investor-trend-estimate', '000660'])).toEqual(RESPONSE_000660);
  });

  it('drops placeholder data when code changes', async () => {
    vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce(RESPONSE_005930)
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) => useLiveInvestorTrendEstimate(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );

    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ code: '000660' });

    expect(result.current.data?.code).not.toBe('005930');
  });

  it('keeps placeholder data only when previous data code matches the current code', () => {
    const sameCodeOptions = liveInvestorTrendEstimateQueryOptions('005930');
    const differentCodeOptions = liveInvestorTrendEstimateQueryOptions('000660');

    expect(sameCodeOptions.placeholderData(RESPONSE_005930)).toBe(RESPONSE_005930);
    expect(differentCodeOptions.placeholderData(RESPONSE_005930)).toBeUndefined();
  });
});

describe('liveInvestorTrendEstimateQueryOptions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fails locally and does not call apiCall when queryFn is invoked with null code', () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE_005930);
    const options = liveInvestorTrendEstimateQueryOptions(null);

    expect(() => options.queryFn({ signal: new AbortController().signal })).toThrow(
      'live investor trend estimate requires a code',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('polls every minute during regular session and disables polling outside it', () => {
    const options = liveInvestorTrendEstimateQueryOptions('005930');

    vi.mocked(isKrxRegularSessionNow).mockReturnValue(true);
    expect(options.refetchInterval()).toBe(60_000);

    vi.mocked(isKrxRegularSessionNow).mockReturnValue(false);
    expect(options.refetchInterval()).toBe(false);
  });
});
