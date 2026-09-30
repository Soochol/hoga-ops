import { describe, it, expect, vi } from 'vitest';
import { nextSecondPage, fetchSecondPage, SECOND_INITIAL_BARS } from './secondHistory';
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
