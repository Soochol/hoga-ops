import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureForm } from './CaptureForm';
import type { ReactNode } from 'react';

// jsdom has no EventSource; useCaptureQueue subscribes to SSE on mount.
// Stub the SSE module so the hook's useEffect is a no-op in this test file.
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const SYMBOLS = {
  symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0,
              captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
  status: 'fresh' as const, fetched_at_ms: 1,
};
const CALENDAR = { cells: [], as_of_ms: 1 };

function setup(addItemsResp: unknown = { enqueued: [{}], deduped: [] }) {
  const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
    if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
    if (s.includes('/api/captures/items')) return { ok: true, status: 201, json: async () => addItemsResp } as Response;
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { qc, fetchMock };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CaptureForm', () => {
  it('disables Start when no symbol selected', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    const btn = screen.getByRole('button', { name: /Start/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Start when no range', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    const btn = screen.getByRole('button', { name: /Start/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Start POSTs addItems with force_retry sourced from the Settings default', async () => {
    // The per-capture checkbox is gone — force_retry comes exclusively from
    // the persisted Settings default. Pre-seed localStorage to assert that
    // the form reads it at submit time.
    localStorage.setItem('capture.force_retry_default', 'true');
    const { qc, fetchMock } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 30));
    const itemsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/captures/items'));
    expect(itemsCall).toBeDefined();
    const body = JSON.parse(itemsCall![1]!.body as string);
    expect(body).toEqual({
      code: '005930', start_date: '20260518', end_date: '20260520', force_retry: true,
    });
  });

  it('Start POSTs force_retry: false when the Settings default is unset', async () => {
    const { qc, fetchMock } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 30));
    const itemsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/captures/items'));
    expect(itemsCall).toBeDefined();
    const body = JSON.parse(itemsCall![1]!.body as string);
    expect(body.force_retry).toBe(false);
  });

  it('preserves symbol and date range after a successful Start', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    // SymbolSearch puts "name code" in the input when a SymbolHit is selected
    // (SymbolSearch.tsx:75). Match a substring so we don't couple to the format.
    expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toContain('삼성전자');
    // valid = symbol && range.end — both surviving means Start is still enabled.
    expect(screen.getByRole('button', { name: /Start/i })).not.toBeDisabled();
    expect(screen.getByTestId('calendar-cell-20260518').getAttribute('style')).toContain('var(--accent)');
    expect(screen.getByTestId('calendar-cell-20260520').getAttribute('style')).toContain('var(--accent)');
  });

  it('does not render the per-capture Force re-capture checkbox (moved to Settings)', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByLabelText(/Force re-capture/i)).toBeNull();
  });

  it('shows today_too_early error inline when backend rejects', async () => {
    const { qc, fetchMock } = setup({ detail: { code: 'today_too_early', message: 'pre-18' } });
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
      if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
      if (s.includes('/api/captures/items')) return { ok: false, status: 400, json: async () => ({ detail: { code: 'today_too_early', message: 'pre-18 KST' } }) } as Response;
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText(/pre-18 KST/)).toBeTruthy();
  });
});

describe('CaptureForm enqueue 503 reason surfacing', () => {
  it('shows enqueueErrorHints copy when 503 returns krx_credentials_missing', async () => {
    const { qc, fetchMock } = setup();
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
      if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
      if (s.includes('/api/captures/items')) return { ok: false, status: 503, json: async () => ({ detail: { code: 'krx_credentials_missing', message: 'KRX credentials not set' } }) } as Response;
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText(/범위 캡처 시작 실패 — KRX 자격증명/)).toBeTruthy();
  });

  it('shows generic error when 503 code is unknown', async () => {
    const { qc, fetchMock } = setup();
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
      if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
      if (s.includes('/api/captures/items')) return { ok: false, status: 503, json: async () => ({ detail: { code: 'unrecognized_code', message: 'KRX is down' } }) } as Response;
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    // Unknown code falls back to the server message, not an UpstreamCode hint
    expect(screen.getByText(/KRX is down/)).toBeTruthy();
  });
});
