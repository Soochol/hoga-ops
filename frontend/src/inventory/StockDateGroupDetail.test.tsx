import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StockDateGroupDetail } from './StockDateGroupDetail';
import { useStockDateGroups, selectGroup } from './useStockDateGroups';
import type { StockDate, QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

// SSE stub — useCaptureQueue subscribes on mount; jsdom has no EventSource.
vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

const row = (code: string, name: string, date: string,
             disk_state: StockDate['disk_state'] = 'complete',
             overrides: Partial<StockDate> = {}): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: 1000,
  total_volume: 52_100_000, pages_collected: 1240, file_size_bytes: 13_200_000,
  today_open: 70_000, today_high: 73_000, today_low: 69_000, today_close: 72_400,
  disk_state,
  full_capture_count: null,
  fail_streak: 0,
  blocked: false,
  ...overrides,
});

const EMPTY_QUEUE: QueueSnapshot = {
  active: [], queued: [], done: [], paused: false, max_concurrent: 3,
};

function setupFetch(opts: { queue?: QueueSnapshot } = {}) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
    const s = String(url);
    if (s.includes('/api/captures/queue')) {
      return { ok: true, status: 200, json: async () => (opts.queue ?? EMPTY_QUEUE) } as Response;
    }
    if (s.includes('/api/captures/items') && !s.includes('/retry')) {
      return { ok: true, status: 201, json: async () => ({
        enqueued: [{ item_id: 'new-1' }], deduped: [],
      })} as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
}

// The page (Inventory.tsx) groups the rows and resolves the selected group;
// the detail just renders the resolved group. This harness mirrors that wiring
// via the real useStockDateGroups + selectGroup so the cases below still drive
// the detail with a (rows, selectedCode) pair.
function DetailHarness({ rows, selectedCode }: { rows: StockDate[]; selectedCode: string | null }) {
  const groups = useStockDateGroups(rows, '');
  return <StockDateGroupDetail group={selectGroup(groups, selectedCode)} />;
}

function renderDetail(rows: StockDate[], selectedCode: string | null, qc: QueryClient) {
  return render(<DetailHarness rows={rows} selectedCode={selectedCode} />, { wrapper: W(qc) });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('StockDateGroupDetail — header and existing behavior', () => {
  it('renders the selected group header (code + name + summary)', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [row('005930', '삼성전자', '20260522'), row('005930', '삼성전자', '20260521')],
      '005930', qc,
    );
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText(/2 dates/)).toBeTruthy();
  });

  it('renders one row per date sorted desc', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [row('005930', '삼성전자', '20260522'), row('005930', '삼성전자', '20260521')],
      '005930', qc,
    );
    const dateCells = screen.getAllByText(/2026-05-\d{2}/);
    expect(dateCells.map((el) => el.textContent)).toEqual(['2026-05-22', '2026-05-21']);
  });

  it('shows placeholder when selectedCode is null', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260522')], null, qc);
    expect(screen.getByText('종목을 선택하세요')).toBeTruthy();
  });
});

describe('StockDateGroupDetail — per-row re-capture', () => {
  it('complete rows render no refresh icon', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [
        row('005930', '삼성전자', '20260520', 'complete'),
        row('005930', '삼성전자', '20260521', 'source_partial'),
      ],
      '005930', qc,
    );
    const buttons = screen.queryAllByRole('button', { name: /Re-capture this Stock-Date/i });
    expect(buttons.length).toBe(1);  // only the source_partial row
  });

  it('clicking the row icon POSTs force_retry=true with that date and does NOT navigate', async () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'source_partial')], '005930', qc);
    const btn = screen.getByRole('button', { name: /Re-capture this Stock-Date/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toEqual({ code: '005930', dates: ['20260520'], force_retry: true });
    });
  });

  it('row is in-flight when its (code, date) appears in queue.queued: icon disabled + animate-spin', async () => {
    setupFetch({
      queue: {
        ...EMPTY_QUEUE,
        queued: [{ item_id: 'q1', code: '005930', date: '20260520',
                   phase: 'queued', force_retry: true, pause_origin: false,
                   enqueued_at_ms: 0, started_at_ms: null, progress: null,
                   result: null, error: null, skip_reason: null, attempt: 1 }],
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'source_partial')], '005930', qc);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Re-capturing…/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.className).toContain('animate-spin');
    });
  });

  it('header bulk button POSTs force_retry=true with all recapturable dates', async () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [
        row('005930', '삼성전자', '20260520', 'source_partial'),
        row('005930', '삼성전자', '20260521', 'complete'),
        row('005930', '삼성전자', '20260522', 'invalid'),
      ],
      '005930', qc,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete \(2\)/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.code).toBe('005930');
      expect(body.dates.sort()).toEqual(['20260520', '20260522']);
      expect(body.force_retry).toBe(true);
    });
  });

  it('does not render the header bulk button when no recapturable rows', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'complete')], '005930', qc);
    expect(screen.queryByRole('button', { name: /Re-capture all incomplete/i })).toBeNull();
  });
});

describe('StockDateGroupDetail full_capture_count column', () => {
  beforeEach(() => { setupFetch(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders faint "×1" when full_capture_count is null (legacy treated as ×1)', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: null };
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr');
    expect(tr).not.toBeNull();
    const cell = within(tr!).getByTestId('full-capture-count-cell');
    expect(cell.textContent).toBe('×1');
    // Tooltip stays honest about the legacy lower-bound nature.
    expect(cell.querySelector('span')?.getAttribute('title')).toBe(
      'Full Capture 횟수 미기록 (≥1로 간주)'
    );
  });

  it('renders faint "×1" when full_capture_count is 1', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: 1 };
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('full-capture-count-cell');
    expect(cell.textContent).toBe('×1');
  });

  it('renders "×3" when full_capture_count is 3', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: 3 };
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('full-capture-count-cell');
    expect(cell.textContent).toBe('×3');
  });

  // ADR-0042: fail_streak / blocked surfacing.

  it('renders 재시도 N/5 indicator when fail_streak > 0 and !blocked', async () => {
    setupFetch();
    const r = row('005930', '삼성전자', '20260522', 'source_partial', { fail_streak: 3 });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    expect(within(tr).getByText('재시도 3/5')).toBeTruthy();
    // The existing ↻ Re-capture button is still rendered (not blocked yet).
    expect(within(tr).getByRole('button', { name: /Re-capture/i })).toBeTruthy();
  });

  it('renders 차단됨 (5/5) badge + 잠금 해제 button when blocked', async () => {
    setupFetch();
    const r = row('005930', '삼성전자', '20260522', 'source_partial', {
      fail_streak: 5, blocked: true,
    });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    expect(within(tr).getByText('차단됨 (5/5)')).toBeTruthy();
    expect(within(tr).getByRole('button', { name: /잠금 해제/ })).toBeTruthy();
    // The normal Re-capture button should be replaced.
    expect(within(tr).queryByRole('button', { name: /Re-capture this/i })).toBeNull();
  });

  it('blocked row does not show 재시도 N/5 indicator (badge takes over)', async () => {
    setupFetch();
    const r = row('005930', '삼성전자', '20260522', 'source_partial', {
      fail_streak: 5, blocked: true,
    });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    expect(within(tr).queryByText(/재시도/)).toBeNull();
  });

  it('clicking 잠금 해제 POSTs to the unblock endpoint', async () => {
    const fetchMock = setupFetch();
    const r = row('005930', '삼성전자', '20260522', 'source_partial', {
      fail_streak: 5, blocked: true,
    });
    renderDetail([r], '005930', new QueryClient());
    const button = await screen.findByRole('button', { name: /잠금 해제/ });
    fireEvent.click(button);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('/api/captures/items/005930/20260522/unblock'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect((calls[0][1] as RequestInit).method).toBe('POST');
    });
  });

  it('normal row (fail_streak=0, !blocked) shows neither badge nor indicator', async () => {
    setupFetch();
    const r = row('005930', '삼성전자', '20260522', 'source_partial');
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    expect(within(tr).queryByText(/재시도/)).toBeNull();
    expect(within(tr).queryByText(/차단됨/)).toBeNull();
  });
});
