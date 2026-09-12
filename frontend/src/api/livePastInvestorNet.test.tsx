import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from './client';
import { useLivePastInvestorNet, type InvestorNetAxis } from './livePastInvestorNet';
import type { InvestorTradeSide } from './types';

vi.mock('../live/liveDateTime', () => ({ isKrxRegularSessionNow: () => false }));
afterEach(() => vi.restoreAllMocks());

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(({ axis, side }: { axis: InvestorNetAxis; side: InvestorTradeSide }) =>
    ({ ...useLivePastInvestorNet('005930', '20260801', '20260803', axis, side) }), {
    initialProps: { axis: 'qty', side: 'net' },
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
}

it('caches the six unit/trade combinations independently', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => {
    const params = new URL(url, 'http://localhost').searchParams;
    return { code: '005930', unit: params.get('axis') === 'qty' ? 'qty_shares' : 'amt_mwon',
      trade_side: params.get('trade_side'), points: [] };
  });
  const { result, rerender } = setup();
  for (const axis of ['qty', 'amount'] as const) {
    for (const side of ['net', 'buy', 'sell'] as const) {
      rerender({ axis, side });
      await waitFor(() => {
        expect(result.current.data?.trade_side).toBe(side);
        expect(result.current.data?.unit).toBe(axis === 'qty' ? 'qty_shares' : 'amt_mwon');
        expect(result.current.isPlaceholderData).toBe(false);
      });
    }
  }
  rerender({ axis: 'qty', side: 'net' });
  expect(result.current.data?.trade_side).toBe('net');
  expect(result.current.data?.unit).toBe('qty_shares');
  expect(spy).toHaveBeenCalledTimes(6);
});

it('accepts legacy net responses but rejects them for a gross request', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ code: '005930', points: [] });
  const { result, rerender } = setup();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  rerender({ axis: 'qty', side: 'buy' });
  await waitFor(() => expect(result.current.isError).toBe(true));
});
