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
  return vi.spyOn(globalThis, 'fetch' as const).mockImplementation(async (url) => {
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
    const root = screen.getByTestId('stock-date-group-detail-root');
    expect(root).not.toHaveClass('bg-bg-card');
    expect(root).not.toHaveClass('border');
    expect(root).not.toHaveClass('rounded-lg');
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

  it('clicking the row icon POSTs a plain recapture request with that date and does NOT navigate', async () => {
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
      expect(body).toEqual({ code: '005930', dates: ['20260520'], force_retry: false });
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

  it('header bulk button POSTs a plain recapture request with all recapturable dates', async () => {
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
      expect(body.force_retry).toBe(false);
    });
  });

  it('does not render the header bulk button when no recapturable rows', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'complete')], '005930', qc);
    expect(screen.queryByRole('button', { name: /Re-capture all incomplete/i })).toBeNull();
  });
});

describe('StockDateGroupDetail 재시도 column (fail_streak)', () => {
  beforeEach(() => { setupFetch(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('removes the old Captures/×N column entirely', async () => {
    const r = { ...row('005930', '삼성전자', '20260522'), full_capture_count: 39 };
    renderDetail([r], '005930', new QueryClient());
    await screen.findByText('2026-05-22');
    // The ×N full_capture_count cell no longer exists in the inventory table.
    expect(screen.queryByTestId('full-capture-count-cell')).toBeNull();
    expect(screen.queryByText('×39')).toBeNull();
  });

  it('renders a quiet — in the 재시도 column when fail_streak is 0', async () => {
    const r = row('005930', '삼성전자', '20260522', 'complete', { fail_streak: 0 });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('fail-streak-cell');
    expect(cell.textContent).toBe('—');
  });

  it('renders N/5 inside the 재시도 column when fail_streak is 1–4', async () => {
    const r = row('005930', '삼성전자', '20260522', 'source_partial', { fail_streak: 2 });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('fail-streak-cell');
    expect(cell.textContent).toBe('2/5');
  });

  it('renders only 차단됨 (no N/5) in the 재시도 column when blocked', async () => {
    const r = row('005930', '삼성전자', '20260522', 'source_partial', {
      fail_streak: 5, blocked: true,
    });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('fail-streak-cell');
    expect(cell.textContent).toBe('차단됨');
    // blocked takes precedence over the failStreak>0 warn branch — no "N/5".
    expect(cell.textContent).not.toMatch(/\/5/);
  });

  // ADR-0042: fail_streak / blocked surfacing (badge content + action cell).

  it('renders 차단됨 badge + 잠금 해제 button when blocked', async () => {
    const r = row('005930', '삼성전자', '20260522', 'source_partial', {
      fail_streak: 5, blocked: true,
    });
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    expect(within(tr).getByText('차단됨')).toBeTruthy();
    expect(within(tr).getByRole('button', { name: /잠금 해제/ })).toBeTruthy();
    // The normal Re-capture button should be replaced.
    expect(within(tr).queryByRole('button', { name: /Re-capture this/i })).toBeNull();
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

  it('normal row (fail_streak=0, !blocked) shows a quiet — in the 재시도 column', async () => {
    const r = row('005930', '삼성전자', '20260522', 'source_partial');
    renderDetail([r], '005930', new QueryClient());
    const dateEl = await screen.findByText('2026-05-22');
    const tr = dateEl.closest('tr')!;
    const cell = within(tr).getByTestId('fail-streak-cell');
    expect(cell.textContent).toBe('—');
    // No warn "N/5" and no 차단됨 badge for a healthy row.
    expect(cell.textContent).not.toMatch(/\/5/);
    expect(within(tr).queryByText(/차단됨/)).toBeNull();
  });
});

describe('StockDateGroupDetail — WS1 upstream-gap panel', () => {
  function setupFetchWithGaps(gapsBody: unknown) {
    return vi.spyOn(globalThis, 'fetch' as const).mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('/api/captures/queue')) {
        return { ok: true, status: 200, json: async () => EMPTY_QUEUE } as Response;
      }
      if (s.includes('/api/gaps')) {
        return { ok: true, status: 200, json: async () => gapsBody } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
  }

  const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  it('shows a 결손 toggle only for source_partial rows', () => {
    setupFetch();
    renderDetail(
      [
        row('003490', '대한항공', '20260707', 'source_partial'),
        row('003490', '대한항공', '20260706', 'complete'),
      ],
      '003490', qc(),
    );
    // exactly one 결손 toggle (the source_partial row)
    expect(screen.getAllByRole('button', { name: /결손 구간 보기/ })).toHaveLength(1);
  });

  it('expands and renders gap ranges from /api/gaps', async () => {
    // 13:52 → 14:11 KST on 2026-07-07 (unix ms).
    const start = Date.UTC(2026, 6, 7, 4, 52); // 13:52 KST = 04:52 UTC
    const end = Date.UTC(2026, 6, 7, 5, 11);   // 14:11 KST = 05:11 UTC
    setupFetchWithGaps({
      code: '003490', date: '20260707', source: 'hogaplay',
      gap_ranges: [{ start_ms: start, end_ms: end }],
      sparse: false, origin: 'computed',
    });
    renderDetail([row('003490', '대한항공', '20260707', 'source_partial')], '003490', qc());
    fireEvent.click(screen.getByRole('button', { name: /결손 구간 보기/ }));
    await waitFor(() => expect(screen.getByTestId('gap-panel')).toBeTruthy());
    expect(screen.getByText(/업스트림 결손 1구간/)).toBeTruthy();
    expect(screen.getByText(/13:52 ~ 14:11/)).toBeTruthy();
    expect(screen.getByText(/재캡처해도 복구되지 않을 수 있습니다/)).toBeTruthy();
  });

  it('renders the sparse message when the window is too sparse', async () => {
    setupFetchWithGaps({
      code: '003490', date: '20260707', source: 'hogaplay',
      gap_ranges: [], sparse: true, origin: 'computed',
    });
    renderDetail([row('003490', '대한항공', '20260707', 'source_partial')], '003490', qc());
    fireEvent.click(screen.getByRole('button', { name: /결손 구간 보기/ }));
    await waitFor(() => expect(screen.getByTestId('gap-panel-sparse')).toBeTruthy());
  });

  // ADR-0093 — confirmed upstream gap
  const GAP_BODY = {
    code: '003490', date: '20260707', source: 'hogaplay',
    gap_ranges: [{ start_ms: Date.UTC(2026, 6, 7, 4, 52), end_ms: Date.UTC(2026, 6, 7, 5, 11) }],
    sparse: false, origin: 'computed',
  };

  it('shows the confirmed message + force-recapture button when identical_capture_count>=2', async () => {
    setupFetchWithGaps(GAP_BODY);
    renderDetail(
      [row('003490', '대한항공', '20260707', 'source_partial', { identical_capture_count: 2 })],
      '003490', qc(),
    );
    fireEvent.click(screen.getByRole('button', { name: /결손 구간 보기/ }));
    await waitFor(() => expect(screen.getByTestId('gap-panel')).toBeTruthy());
    expect(screen.getByTestId('gap-panel-confirmed').textContent).toMatch(/2회 재캡처 동일 결과/);
    expect(screen.getByTestId('force-recapture-button')).toBeTruthy();
  });

  it('hides the confirmed message + force button when identical_capture_count<2', async () => {
    setupFetchWithGaps(GAP_BODY);
    renderDetail(
      [row('003490', '대한항공', '20260707', 'source_partial', { identical_capture_count: 1 })],
      '003490', qc(),
    );
    fireEvent.click(screen.getByRole('button', { name: /결손 구간 보기/ }));
    await waitFor(() => expect(screen.getByTestId('gap-panel')).toBeTruthy());
    expect(screen.queryByTestId('gap-panel-confirmed')).toBeNull();
    expect(screen.queryByTestId('force-recapture-button')).toBeNull();
  });

  it('force-recapture button POSTs force_retry: true', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch' as const).mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.includes('/api/captures/queue')) {
        return { ok: true, status: 200, json: async () => EMPTY_QUEUE } as Response;
      }
      if (s.includes('/api/gaps')) {
        return { ok: true, status: 200, json: async () => GAP_BODY } as Response;
      }
      if (s.includes('/api/captures/items')) {
        calls.push({ url: s, body: JSON.parse(String(init?.body ?? '{}')) });
        return { ok: true, status: 201, json: async () => ({ enqueued: [{ item_id: 'x' }], deduped: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    renderDetail(
      [row('003490', '대한항공', '20260707', 'source_partial', { identical_capture_count: 3 })],
      '003490', qc(),
    );
    fireEvent.click(screen.getByRole('button', { name: /결손 구간 보기/ }));
    await waitFor(() => expect(screen.getByTestId('force-recapture-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('force-recapture-button'));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].body).toMatchObject({ code: '003490', dates: ['20260707'], force_retry: true });
  });
});
