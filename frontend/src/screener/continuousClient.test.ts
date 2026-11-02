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

  it.each(['1m', '3m', '5m', '10m'] as const)('uses a shared monitor for %s and never falls back to scan', async timeframe => {
    const selected: ScanRequest = { ...request, conditions: [{ id: 'v', type: 'new_high_vol',
      params: { timeframe, period: 12, lookback: 3 } }] };
    expect(hasContinuousVolume(selected)).toBe(true);
    vi.mocked(apiCall).mockResolvedValue({ id: 'multi' });
    vi.mocked(readContinuousResult).mockResolvedValue({ status: 'ok', rows: [], warnings: [] });
    await new ContinuousClient().scan(selected);
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall).toHaveBeenCalledWith('/api/screener/monitors', expect.objectContaining({ method: 'POST' }));
    expect(readContinuousResult).toHaveBeenCalledWith('multi');
  });

  it('selects only the supported minute-volume family', () => {
    expect(hasContinuousVolume(request)).toBe(true);
    expect(hasContinuousVolume({ ...request, conditions: [] })).toBe(false);
    expect(hasContinuousVolume({ ...request, conditions: [{ id: 'x', type: 'new_high_vol',
      params: { timeframe: '15m', period: 100, lookback: 5 } }] })).toBe(false);
  });

  it('an expired monitor does not prevent releasing ownership for a manual query', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ id: 'expired' });
    vi.mocked(readContinuousResult).mockResolvedValue({ status: 'ok', rows: [], warnings: [] });
    const owner = new ContinuousClient();
    await owner.scan(request);
    vi.mocked(apiCall).mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 404 }));
    await expect(owner.stop()).resolves.toBeUndefined();
    expect(owner.acceptsEvent('expired')).toBe(false);
  });

  it('does not publish an old in-flight result after monitoring stops', async () => {
    vi.mocked(apiCall).mockResolvedValue({ id: 'stopped' });
    let finish!: (value: Awaited<ReturnType<typeof readContinuousResult>>) => void;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    vi.mocked(readContinuousResult).mockImplementationOnce(() => new Promise(resolve => {
      finish = resolve;
      reading();
    }));
    const owner = new ContinuousClient();
    const pending = owner.scan(request);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    await owner.stop();
    finish({ status: 'ok', rows: [], warnings: [] });
    await rejected;
  });
});
