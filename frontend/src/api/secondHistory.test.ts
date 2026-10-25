import { QueryClient } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { nextSecondPage, fetchSecondPage, SECOND_INITIAL_BARS, loadSecondHistoryAt } from './secondHistory';
import { apiCall } from './client';
vi.mock('./client', () => ({ apiCall: vi.fn() }));
describe('second history paging', () => {
  it('pages within a day before skipping weekends to the previous captured day', () => {
    const page = { fromMs: 2000, result: { date: '20260928', first_observed_ms: 1000 } } as Parameters<typeof nextSecondPage>[0];
    expect(nextSecondPage(page, ['20260925', '20260928'])).toEqual({ date: '20260928', endMs: 2000 });
    page.fromMs = 1000;
    expect(nextSecondPage(page, ['20260925', '20260928'])).toEqual({ date: '20260925', endMs: null });
    expect(nextSecondPage(page, [])).toBeUndefined();
  });
  it('finds the last observations and fetches a bounded initial window', async () => {
    const last = Date.parse('2026-09-28T15:30:00+09:00');
    vi.mocked(apiCall).mockResolvedValueOnce({ bars: [], last_observed_ms: last })
      .mockResolvedValueOnce({ bars: [{ t_ms: last }], last_observed_ms: last });
    const page = await fetchSecondPage('042700', 'KRX', 5, { date: '20260928', endMs: null }, new AbortController().signal);
    expect(page.fromMs).toBe(last + 5000 - SECOND_INITIAL_BARS * 5000);
    expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('to_ms=' + (last + 5000));
  });
});

it('a tape jump reads one bounded target slice beyond the manual page budget and installs it without losing history', async () => {
  vi.mocked(apiCall).mockReset();
  const client = new QueryClient();
  const T = Date.parse('2026-09-29T09:00:00+09:00');
  const key = ['second-history', '042700', 'KRX', '20261001', 1, false];
  const pages = Array.from({ length: 64 }, (_, i) => ({ fromMs: T + (i + 1) * 60000,
    result: { date: '20260929', bars: [{ t_ms: T + (i + 1) * 60000 }] } }));
  client.setQueryData(key, { pages, pageParams: pages.map(p => ({ date: '20260929', endMs: p.fromMs + 240000 })) });
  vi.mocked(apiCall).mockResolvedValue({ date: '20260929', bars: [{ t_ms: T }], first_observed_ms: T, last_observed_ms: T });
  await loadSecondHistoryAt(client, '042700', 'KRX', '20261001', 1, false, T);
  expect(apiCall).toHaveBeenCalledOnce();
  const params = new URL(vi.mocked(apiCall).mock.calls[0][0], 'http://test').searchParams;
  expect(params.get('date')).toBe('20260929');
  expect(Number(params.get('to_ms')) - Number(params.get('from_ms'))).toBe(240000);
  const data = client.getQueryData<{ pages: typeof pages }>(key)!;
  expect(data.pages).toHaveLength(65);
  expect(data.pages.at(-1)!.result.bars[0].t_ms).toBe(T);
  await loadSecondHistoryAt(client, '042700', 'KRX', '20261001', 1, false, T);
  expect(apiCall).toHaveBeenCalledOnce();
  expect(client.getQueryData<{ pages: typeof pages }>(key)!.pages).toHaveLength(65);
  client.clear();
});
