import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  beforeEach(() => { vi.clearAllMocks(); __resetConfigForTests(); });

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
