import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./client', () => ({ apiCall: vi.fn(async () => ({ status: 'ok', rows: [], warnings: [] })) }));
import { runScan } from './screener';
import { apiCall } from './client';

describe('runScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs the scan body to /api/screener/scan', async () => {
    await runScan({
      conditions: [{ id: 'a', type: 'new_high', params: { lookback: 200, period: 500 } }],
      universe: { markets: ['KOSPI'] },
      limit: 20,
    });
    const [path, init] = (apiCall as any).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/screener/scan');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.conditions[0]).toMatchObject({ id: 'a', type: 'new_high', params: { lookback: 200, period: 500 } });
    expect(body.universe).toEqual({ markets: ['KOSPI'] });
    expect(body.limit).toBe(20);
  });
});
