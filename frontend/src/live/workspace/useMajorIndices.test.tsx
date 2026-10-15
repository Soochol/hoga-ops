import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as api from '../../api/client';
import { regularSessionOpenMs as open } from '../liveDateTime';
import { useMajorIndices } from './useMajorIndices';
const bar = (date: string, value: number) => ({ t_ms: open(date), open: value, high: value, low: value, close: value, volume: 1 });
afterEach(() => vi.restoreAllMocks());
function setup(today: string, hasToday: boolean) {
  vi.spyOn(Date, 'now').mockReturnValue(open(today) + 3 * 3600_000);
  const spy = vi.spyOn(api, 'apiCall').mockImplementation(async path => {
    if (path === '/api/live/index-quotes') return { quotes: [] };
    const url = new URL(path, 'http://test'), daily = url.searchParams.get('timeframe') === 'D', date = url.searchParams.get('from');
    return { index_id: url.searchParams.get('index_id'), from: date, to: url.searchParams.get('to'), timeframe: daily ? 'D' : '1m', data_warnings: [],
      candles: daily ? [bar('20261014', 100), bar('20261015', 101)] : date === today ? hasToday ? [bar(today, 102)] : [] : [bar('20261015', 101)] };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { spy, client, ...renderHook(() => useMajorIndices(), { wrapper }) };
}
describe('major index queries', () => {
  it('requests the current session and preceding daily closes', async () => {
    const { result, unmount, client, spy } = setup('20261016', true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.date).toBe('20261016');
    expect(result.current.series).toHaveLength(3);
    expect(result.current.series[0].percent).toBeCloseTo((102 / 101 - 1) * 100);
    expect(spy.mock.calls.filter(([path]) => path.includes('timeframe=1m'))).toHaveLength(3);
    unmount(); client.clear();
  });
  it('shows the latest actual trading session on a weekend', async () => {
    const { result, unmount, client, spy } = setup('20261018', false);
    await waitFor(() => expect(result.current.label).toBe('10/15 종가'));
    expect(result.current.series[0].value).toBe(101);
    expect(result.current.series[0].percent).toBeCloseTo(1);
    expect(spy.mock.calls.some(([path]) => path.includes('timeframe=1m&from=20261015&to=20261015'))).toBe(true);
    unmount(); client.clear();
  });
});
