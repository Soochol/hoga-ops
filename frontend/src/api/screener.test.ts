import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./client', () => ({ apiCall: vi.fn(async () => ({ status: 'ok', rows: [], warnings: [] })), apiAction: vi.fn(async () => undefined) }));
import { runScan, restoreScreenerOccurrence, type ScreenerResponse } from './screener';
import { apiCall, apiAction } from './client';

describe('runScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs the scan body to /api/screener/scan', async () => {
    await runScan({
      conditions: [{ id: 'a', type: 'new_high', params: { lookback: 200, period: 500 } }],
      universe: { markets: ['KOSPI'] },
      limit: 20,
      basis: 'intraday',
    });
    const [path, init] = (apiCall as any).mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/screener/scan');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.conditions[0]).toMatchObject({ id: 'a', type: 'new_high', params: { lookback: 200, period: 500 } });
    expect(body.universe).toEqual({ markets: ['KOSPI'] });
    expect(body.limit).toBe(20);
    expect(body.basis).toBe('intraday');
  });
});

describe('scan responses across exclusion mutations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries a held scan after restoration before exposing its response', async () => {
    let release!: (response: ScreenerResponse) => void;
    const oldResponse = { status: 'ok', rows: [], warnings: [] } as ScreenerResponse;
    const freshResponse = { ...oldResponse, warnings: ['fresh'] };
    vi.mocked(apiCall).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    vi.mocked(apiCall).mockResolvedValueOnce(freshResponse);
    const pending = runScan({ conditions: [], universe: { markets: ['KOSPI'] } });
    await restoreScreenerOccurrence('restored');
    release(oldResponse);
    expect(await pending).toBe(freshResponse);
    expect(apiCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiCall).mock.calls[1]).toEqual(vi.mocked(apiCall).mock.calls[0]);
  });

  it('keeps a pending scan when restoration fails', async () => {
    let release!: (response: ScreenerResponse) => void;
    const response = { status: 'ok', rows: [], warnings: [] } as ScreenerResponse;
    vi.mocked(apiCall).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = runScan({ conditions: [], universe: { markets: ['KOSPI'] } });
    vi.mocked(apiAction).mockRejectedValueOnce(new Error('write failed'));
    await expect(restoreScreenerOccurrence('failed')).rejects.toThrow('write failed');
    release(response);
    expect(await pending).toBe(response);
    expect(apiCall).toHaveBeenCalledTimes(1);
  });

  it('fails instead of returning stale data when mutations keep racing', async () => {
    for (const id of ['first', 'second', 'third']) {
      vi.mocked(apiCall).mockImplementationOnce(async () => {
        await restoreScreenerOccurrence(id);
        return { status: 'ok', rows: [], warnings: [] };
      });
    }
    await expect(runScan({ conditions: [], universe: { markets: ['KOSPI'] } })).rejects.toThrow('다시 조회');
    expect(apiCall).toHaveBeenCalledTimes(3);
  });
});
