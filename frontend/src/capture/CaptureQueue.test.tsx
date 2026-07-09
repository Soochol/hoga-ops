import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureQueue, computeHeaderSummary } from './CaptureQueue';
import type { QueueItem, QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const item = (id: string, phase: QueueItem['phase']): QueueItem => ({
  item_id: id, code: '005930', date: '20260518', phase,
  force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
  attempt: 1,
});

const SNAPSHOT = (): QueueSnapshot => ({
  active: [item('a1', 'capturing')],
  queued: [item('q1', 'queued'), item('q2', 'queued')],
  done: [item('d1', 'done'), item('d2', 'skipped'), item('d3', 'failed')],
  paused: false,
  max_concurrent: 3,
});

beforeEach(() => { vi.restoreAllMocks(); });

function setup(snapshot: QueueSnapshot = SNAPSHOT()) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => snapshot } as Response;
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
    if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

describe('computeHeaderSummary', () => {
  it('counts done / failed / in-progress / total', () => {
    const summary = computeHeaderSummary(SNAPSHOT());
    expect(summary.done).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.capturing).toBe(1);
    expect(summary.queued).toBe(2);
    expect(summary.total).toBe(6);
  });

  it('paused exposed as a top-level flag', () => {
    expect(computeHeaderSummary({ ...SNAPSHOT(), paused: true }).paused).toBe(true);
  });
});

describe('CaptureQueue', () => {
  it('renders header + Cancel All + Dismiss Done', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('button', { name: /Cancel All/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dismiss Done/i })).toBeTruthy();
  });

  it('renders one row per item across all buckets', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-row-a1')).toBeTruthy();
    expect(screen.getByTestId('queue-row-q1')).toBeTruthy();
    expect(screen.getByTestId('queue-row-d1')).toBeTruthy();
  });

  it('lets the queue list shrink inside the capture panel so it can scroll', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const queueList = screen.getByTestId('queue-list');
    expect(queueList).toHaveClass('min-h-0');
    expect(queueList.parentElement).toHaveClass('min-h-0');
  });

  it('Cancel All first click arms confirmation; second click POSTs cancel-all', async () => {
    const qc = setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => SNAPSHOT() } as Response;
      if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByRole('button', { name: /Cancel All/i }));
    const callsAfterFirstClick = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/captures/cancel-all')).length;
    expect(callsAfterFirstClick).toBe(0);
    expect(screen.getByText(/Click again to confirm/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Click again to confirm/i }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/captures/cancel-all'))).toBe(true);
  });

  it('shows paused banner with Refresh & Resume + Cancel All when snapshot.paused', async () => {
    const qc = setup({ ...SNAPSHOT(), paused: true });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Cookie expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resume/i })).toBeTruthy();
  });

  it('renders only first 200 rows when queue length > 200 (virtualized window)', async () => {
    const big = Array.from({ length: 250 }, (_, i) => item(`q${i}`, 'queued'));
    const qc = setup({ active: [], queued: big, done: [], paused: false, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-list').getAttribute('data-virtualized')).toBe('true');
  });

  it('shows the "큐가 비어 있습니다" empty state on first-load with no rows', async () => {
    const qc = setup({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(screen.getByText(/큐가 비어 있습니다/)).toBeTruthy();
  });

  it('does NOT show empty state when paused even if rows are empty (banner takes priority)', async () => {
    const qc = setup({ active: [], queued: [], done: [], paused: true, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('queue-empty')).toBeNull();
    expect(screen.getByText(/Cookie expired/i)).toBeTruthy();
  });
});

describe('CaptureQueue Retry Failed (ADR-0031)', () => {
  it('renders Retry Failed button disabled when failed count is 0', async () => {
    const snap = { ...SNAPSHOT(), done: [item('d1', 'done')] };  // 0 failed
    const qc = setup(snap);
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    const btn = screen.getByRole('button', { name: /Retry Failed/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('Retry Failed enabled when failed > 0, POSTs all failed item_ids', async () => {
    let postedBody: any = null;
    const failed1 = { ...item('f1', 'failed'), date: '20260518' };
    const failed2 = { ...item('f2', 'failed'), date: '20260519' };
    const snap: QueueSnapshot = {
      active: [], queued: [], done: [failed1, failed2],
      paused: false, max_concurrent: 3,
    };
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.includes('/queue')) return { ok: true, status: 200, json: async () => snap } as Response;
      if (s.includes('/items/retry')) {
        postedBody = JSON.parse(String(init?.body));
        return { ok: true, status: 201, json: async () => ({ enqueued: [], skipped: [] }) } as Response;
      }
      if (s.includes('/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
      if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const btn = screen.getByRole('button', { name: /Retry Failed/i });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 30));

    expect(postedBody).toEqual({ item_ids: ['f1', 'f2'] });
  });

  it('per-row ↻ click routes through retryItems mutation (not addItems)', async () => {
    const calls: string[] = [];
    const failed = { ...item('f1', 'failed'), date: '20260518' };
    const snap: QueueSnapshot = {
      active: [], queued: [], done: [failed],
      paused: false, max_concurrent: 3,
    };
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('/items/retry')) { calls.push('retry'); return { ok: true, status: 201, json: async () => ({ enqueued: [], skipped: [] }) } as Response; }
      if (s.includes('/items')) { calls.push('items'); return { ok: true, status: 201, json: async () => ({ enqueued: [], deduped: [] }) } as Response; }
      if (s.includes('/queue')) return { ok: true, status: 200, json: async () => snap } as Response;
      if (s.includes('/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
      if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toContain('retry');
    expect(calls).not.toContain('items');
  });
});

describe('CaptureQueue dedupe banner', () => {
  it('summarizeDedupeReasons groups counts in display order', async () => {
    const { summarizeDedupeReasons } = await import('./CaptureQueue');
    expect(summarizeDedupeReasons([
      { code: '005930', date: '20260518', reason: 'already_complete' },
      { code: '005930', date: '20260519', reason: 'already_complete' },
      { code: '005930', date: '20260520', reason: 'already_running' },
    ])).toBe('1 already running · 2 already complete');
  });

  it('summarizeDedupeReasons omits reasons with zero count', async () => {
    const { summarizeDedupeReasons } = await import('./CaptureQueue');
    expect(summarizeDedupeReasons([
      { code: '005930', date: '20260518', reason: 'already_skipped' },
    ])).toBe('1 already skipped');
  });

  it('renders banner when an addItems mutation in the shared cache has deduped rows', async () => {
    const { ADD_ITEMS_MUTATION_KEY } = await import('./useCaptureQueue');
    const qc = setup();
    // Simulate a CaptureForm-issued addItems mutation by pushing into the cache.
    qc.getMutationCache().build(qc, {
      mutationKey: ADD_ITEMS_MUTATION_KEY,
      mutationFn: async () => ({}),
    }).setOptions({ mutationKey: ADD_ITEMS_MUTATION_KEY });
    const m = qc.getMutationCache().build(qc, {
      mutationKey: ADD_ITEMS_MUTATION_KEY,
      mutationFn: async () => ({
        enqueued: [], deduped: [
          { code: '005930', date: '20260518', reason: 'already_complete' },
          { code: '005930', date: '20260519', reason: 'already_running' },
        ],
      }),
    });
    await m.execute({ code: '005930', dates: ['20260518', '20260519'], force_retry: false });

    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const banner = screen.getByTestId('deduped-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('1 already running');
    expect(banner.textContent).toContain('1 already complete');
  });

  it('does not render banner when deduped is empty', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('deduped-banner')).toBeNull();
  });

  it('Dismiss button hides the banner', async () => {
    const { ADD_ITEMS_MUTATION_KEY } = await import('./useCaptureQueue');
    const qc = setup();
    const m = qc.getMutationCache().build(qc, {
      mutationKey: ADD_ITEMS_MUTATION_KEY,
      mutationFn: async () => ({
        enqueued: [], deduped: [
          { code: '005930', date: '20260518', reason: 'already_complete' },
        ],
      }),
    });
    await m.execute({ code: '005930', dates: ['20260518'], force_retry: false });

    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('deduped-banner')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Dismiss dedupe notice/i }));
    expect(screen.queryByTestId('deduped-banner')).toBeNull();
  });

  it('shows the not-owned banner when queue_owned is false (populated queue)', async () => {
    const qc = setup({ ...SNAPSHOT(), queue_owned: false });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-not-owned-banner')).toBeTruthy();
  });

  it('shows the not-owned banner even when the queue is empty', async () => {
    const empty: QueueSnapshot = {
      active: [], queued: [], done: [], paused: false, max_concurrent: 3, queue_owned: false,
    };
    const qc = setup(empty);
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-not-owned-banner')).toBeTruthy();
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
  });

  it('hides the not-owned banner when queue_owned is true/absent', async () => {
    const qc = setup(SNAPSHOT());  // no queue_owned → treated as owned
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('queue-not-owned-banner')).toBeNull();
  });
});
