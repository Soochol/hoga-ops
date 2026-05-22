import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { getCalendar } from './calendar';
import { apiUrl, __resetConfigForTests } from './client';

beforeAll(async () => {
  // Prime the apiUrl config cache so the first fetch in each test is the
  // actual API call (and f.mock.calls[0] is the endpoint, not /config.json).
  __resetConfigForTests();
  const primer = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ api_url: 'http://test.local' }),
  } as Response);
  await apiUrl('/');
  primer.mockRestore();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('getCalendar', () => {
  it('encodes code/year/month query params and returns CalendarResponse', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cells: [{ date: '20260518', status: 'complete', captured_at_ms: 1 }],
        as_of_ms: 1_700_000_000_500,
      }),
    } as Response);
    const resp = await getCalendar('005930', 2026, 5);
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain('/api/inventory/calendar?');
    expect(url).toContain('code=005930');
    expect(url).toContain('year=2026');
    expect(url).toContain('month=5');
    expect(resp.cells[0].status).toBe('complete');
    expect(resp.as_of_ms).toBe(1_700_000_000_500);
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);
    await expect(getCalendar('005930', 2026, 5)).rejects.toThrow();
  });
});
