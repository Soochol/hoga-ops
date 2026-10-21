import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiCall } from '../api/client';
import { readContinuousResult, type ScanRequest } from '../api/screener';
import { ContinuousClient, hasContinuousVolume } from './continuousClient';

vi.mock('../api/client', () => ({ apiCall: vi.fn() }));
vi.mock('../api/screener', () => ({ readContinuousResult: vi.fn() }));
const request: ScanRequest = { conditions: [{ id: 'v', type: 'new_high_vol',
  params: { timeframe: '1m', period: 100, lookback: 5 } }], universe: { scopes: ['watchlist'] }, basis: 'auto' };
afterEach(() => vi.resetAllMocks());

describe('continuous monitor ownership', () => {
  it('creates once, reuses result reads, heartbeats, and releases ownership', async () => {
    vi.mocked(apiCall).mockResolvedValue({ id: 'm1' });
    vi.mocked(readContinuousResult).mockResolvedValue({ status: 'ok', rows: [], warnings: [] });
    const owner = new ContinuousClient();
    await owner.scan(request);
    expect(owner.acceptsEvent('m1')).toBe(true);
    expect(owner.acceptsEvent('other')).toBe(false);
    await owner.scan(request);
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(readContinuousResult).toHaveBeenCalledTimes(2);
    await owner.heartbeat();
    await owner.stop();
    expect(apiCall).toHaveBeenLastCalledWith('/api/screener/monitors/m1', { method: 'DELETE' });
  });

  it('releases a monitor whose creation completes after its owner stopped', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(apiCall).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    vi.mocked(apiCall).mockResolvedValue(undefined);
    const owner = new ContinuousClient();
    const pending = owner.scan(request);
    await Promise.resolve();
    const failure = expect(pending).rejects.toThrow('변경');
    await owner.stop();
    resolve({ id: 'late' });
    await failure;
    expect(apiCall).toHaveBeenLastCalledWith('/api/screener/monitors/late', { method: 'DELETE' });
    expect(readContinuousResult).not.toHaveBeenCalled();
  });

  it('selects only the supported minute-volume family', () => {
    expect(hasContinuousVolume(request)).toBe(true);
    expect(hasContinuousVolume({ ...request, conditions: [] })).toBe(false);
    expect(hasContinuousVolume({ ...request, conditions: [{ id: 'x', type: 'new_high_vol',
      params: { timeframe: '5m', period: 100, lookback: 5 } }] })).toBe(false);
  });
});
