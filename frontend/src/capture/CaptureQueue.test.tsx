import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureQueue, computeHeaderSummary } from './CaptureQueue';
import type { QueueItem, QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

vi.mock('../api/sse', () => ({
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

  it('Cancel All first click arms confirmation; second click POSTs cancel-all', async () => {
    const qc = setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => SNAPSHOT() } as Response;
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
