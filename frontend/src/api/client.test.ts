import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  loadConfig: vi.fn(async () => ({ api_url: 'http://test' })),
  DEFAULT_CONFIG: { api_url: 'http://test' },
  resolveApiUrl: (config: { api_url: string }, path: string) =>
    `${config.api_url}${path.startsWith('/') ? path : `/${path}`}`,
  resolveWsUrl: (config: { api_url: string }, path: string) =>
    `${config.api_url.replace(/^http/, 'ws')}${path.startsWith('/') ? path : `/${path}`}`,
}));
import { apiCall, __resetConfigForTests } from './client';

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch' as const).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

describe('buildApiError (via apiCall)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  beforeEach(() => { vi.clearAllMocks(); __resetConfigForTests(); });

  it('reports historical cache provenance in opt-in logs without logging numeric rows', async () => {
    vi.stubEnv('VITE_HOGA_PERF_DEBUG', '1');
    const body = { cached_batches: ['20261001__20261016'], fresh_batches: ['20261019__20261019'],
      points: [{ foreign_net: 987654321 }], data_warnings: [] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await apiCall('/api/live/past-investor-net?code=005930')).toEqual(body);
    const message = String(log.mock.calls.at(-1)?.[0]);
    const event = JSON.parse(message.slice(message.indexOf('{')));
    expect(event.history).toEqual({ cached_batches: body.cached_batches, fresh_batches: body.fresh_batches,
      points_count: 1, data_warnings_count: 0 });
    expect(message).not.toContain('987654321');
  });

  it('surfaces a FastAPI 422 validation reason instead of "<status> <path>"', async () => {
    mockFetch(422, { detail: [
      { type: 'value_error', loc: ['body', 'conditions', 0, 'change_pct', 'params'], msg: 'Value error, gte/lte requires pct' },
    ] });
    await expect(apiCall('/api/screener/scan', { method: 'POST' }))
      .rejects.toThrow(/gte\/lte requires pct/);
  });

  it('joins multiple 422 errors, stripping the "Value error," prefix only where present', async () => {
    mockFetch(422, { detail: [
      { msg: 'Value error, lo must be <= hi' },
      { msg: 'Input should be greater than or equal to 1' }, // ge constraint: no Pydantic prefix
    ] });
    let caught: Error | undefined;
    await apiCall('/x', {}).catch((e) => { caught = e as Error; });
    expect(caught?.message).toBe('lo must be <= hi; Input should be greater than or equal to 1');
  });

  it('leaves the {detail:{code,message}} object shape untouched (non-validation errors)', async () => {
    mockFetch(404, { detail: { code: 'save_not_found', message: 'No saved screener x' } });
    let caught: { message: string; code?: string; status?: number } | undefined;
    await apiCall('/x', {}).catch((e) => { caught = e; });
    expect(caught?.message).toBe('No saved screener x');
    expect(caught?.code).toBe('save_not_found');
    expect(caught?.status).toBe(404);
  });

  it('falls back to "<status> <path>" when a validation array has no usable msgs', async () => {
    mockFetch(422, { detail: [] });
    await expect(apiCall('/api/x', {})).rejects.toThrow('422 /api/x');
  });
});
