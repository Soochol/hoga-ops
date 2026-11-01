import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from './client';
import type { ScanRequest, ScreenerResponse } from './screener';
import { activeRunId, needsPreparation, runPreparedScan, type ScreenerRun } from './screenerRuns';

vi.mock('./client', () => ({ apiCall: vi.fn() }));
const body: ScanRequest = { calculation_policy: 'separate_bases_v2', universe: {},
  conditions: [{ id: 'high', type: 'new_high_today', params: { period: 3 } }] };
const result: ScreenerResponse = { status: 'ok', rows: [], warnings: [] };
const run = (status: ScreenerRun['status'], response: ScreenerResponse | null = null): ScreenerRun => ({
  id: 'run1', status, request: body, total: 2, evaluated: 0, preparing: 2, waiting: 0, failed: 0, next_retry_at_ms: null,
  errors: {}, revision: 1, result_revision: 1, result: response, started_at_ms: 1, updated_at_ms: 1,
});

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('server-owned screener preparation', () => {
  it('starts with JSON, shows partial progress, and polls without redownloading unchanged results', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce(run('preparing', result))
      .mockResolvedValueOnce(run('preparing'))
      .mockResolvedValueOnce(run('complete', result));
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const done = runPreparedScan(body, signal, progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(activeRunId(body)).toBe('run1');
    expect(apiCall).toHaveBeenCalledWith('/api/screener/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toEqual(result);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(apiCall).toHaveBeenCalledWith('/api/screener/runs/run1?after_revision=1', { signal });
    expect(activeRunId(body)).toBeUndefined();
  });

  it('detaches on abort, preserves the run id, and resumes with GET after a reload', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce(run('preparing', result));
    const controller = new AbortController();
    const done = runPreparedScan(body, controller.signal, vi.fn());
    const rejected = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(activeRunId(body)).toBe('run1');
    vi.mocked(apiCall).mockResolvedValueOnce(run('complete', result));
    await expect(runPreparedScan(body, new AbortController().signal, vi.fn(), activeRunId(body))).resolves.toEqual(result);
    expect(apiCall).toHaveBeenLastCalledWith('/api/screener/runs/run1', expect.objectContaining({ signal: expect.anything() }));
  });

  it('restarts an interrupted server run once and never loops on an unrecoverable interruption', async () => {
    const interrupted = { ...run('interrupted'), errors: { run: '입력 변경' } };
    vi.mocked(apiCall).mockResolvedValueOnce(interrupted).mockResolvedValueOnce(interrupted);
    await expect(runPreparedScan(body, new AbortController().signal, vi.fn(), 'run1')).rejects.toThrow('입력 변경');
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it('starts again if a persisted run id no longer exists on the selected server', async () => {
    vi.mocked(apiCall).mockRejectedValueOnce(Object.assign(new Error('missing run'), { status: 404 }))
      .mockResolvedValueOnce(run('complete', result));
    await expect(runPreparedScan(body, new AbortController().signal, vi.fn(), 'old-run')).resolves.toEqual(result);
    expect(apiCall).toHaveBeenLastCalledWith('/api/screener/runs', expect.objectContaining({ method: 'POST' }));
  });

  it('polls slowly while all remaining work waits for a scheduled retry', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ ...run('preparing', result), next_retry_at_ms: Date.now() + 60_000 })
      .mockResolvedValueOnce(run('complete', result));
    const done = runPreparedScan(body, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(apiCall).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual(result);
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it('keeps fixed snapshots and minute/rank-only requests on their read-only paths', () => {
    expect(needsPreparation(body)).toBe(true);
    expect(needsPreparation({ ...body, snapshot_id: 'snapshot' })).toBe(false);
    expect(needsPreparation({ ...body, conditions: [{ id: 'minute', type: 'new_high_today',
      params: { period: 3, timeframe: '1m' } }] })).toBe(false);
    expect(needsPreparation({ ...body, conditions: [{ id: 'rank', type: 'trade_value_rank',
      params: { top_n: 50 } }] })).toBe(false);
  });
});
