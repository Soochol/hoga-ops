import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as api from '../../api/client';
import { useLiveSeries } from '../../api/liveSeries';
import { useMajorIndicesStock } from './useMajorIndicesStock';
import { regularSessionOpenMs as open } from '../liveDateTime';
import { useLiveVenueStore } from '../../state/liveVenue';

vi.mock('../../api/liveSeries', () => ({ useLiveSeries: vi.fn(() => ({ trade: [] })) }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: (_code: string | null, venue: string) => venue }));
const date = '20261015';
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(open(date) + 60_000);
  useLiveVenueStore.setState({ venue: 'UN' });
});
afterEach(() => vi.restoreAllMocks());
function setup() {
  const spy = vi.spyOn(api, 'apiCall').mockImplementation(async path => {
    const params = new URL(path, 'http://test').searchParams;
    const code = params.get('code'), from = params.get('from')!;
    return { code, from, to: from, venue: params.get('venue'), data_warnings: [], cached_dates: [], fresh_dates: [from],
      candles: [{ t_ms: open(from), open: 100, high: 100, low: 100, close: code === '005930' ? 100 : 200, volume: 10 }] };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { spy, client, wrapper };
}
describe('linked stock data', () => {
  it('shares the existing minute history query between multiple windows', async () => {
    const { spy, client, wrapper } = setup();
    const view = renderHook(() => [useMajorIndicesStock('005930', date), useMajorIndicesStock('005930', date)], { wrapper });
    await waitFor(() => expect(view.result.current[0].points).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('venue=UN&bucket_ms=60000');
    expect(view.result.current[1].points[0].close).toBe(100);
    expect(useLiveSeries).toHaveBeenCalledWith('005930', 'UN');
    view.unmount(); client.clear();
  });
  it('switches code and date without showing stale closes, and does not subscribe to historical ticks', async () => {
    const { client, wrapper } = setup();
    const view = renderHook(({ code, day }) => useMajorIndicesStock(code, day), { wrapper, initialProps: { code: '005930' as string | null, day: date } });
    await waitFor(() => expect(view.result.current.points[0]?.close).toBe(100));
    view.rerender({ code: '000660', day: '20261014' });
    expect(view.result.current.points).toEqual([]);
    await waitFor(() => expect(view.result.current.points[0]?.close).toBe(200));
    expect(view.result.current.points[0].tMs).toBe(open('20261014'));
    expect(useLiveSeries).toHaveBeenLastCalledWith('', 'UN');
    view.rerender({ code: null, day: '20261014' });
    expect(view.result.current.points).toEqual([]);
    expect(view.result.current.loading).toBe(false);
    view.unmount(); client.clear();
  });
  it('disables stock requests without a stock and reports a failed stock lookup separately', async () => {
    const { spy, client, wrapper } = setup();
    const view = renderHook(({ code }) => useMajorIndicesStock(code, date), { wrapper, initialProps: { code: null as string | null } });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRejectedValue(new Error('stock history unavailable'));
    view.rerender({ code: '005930' });
    await waitFor(() => expect(view.result.current.failed).toBe(true));
    expect(view.result.current.points).toEqual([]);
    view.unmount(); client.clear();
  });
});
