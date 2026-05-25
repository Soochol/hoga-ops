import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureStatusPill } from './CaptureStatusPill';
import type { QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function setup(snap: QueueSnapshot) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => snap,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

const empty: QueueSnapshot = { active: [], queued: [], done: [], paused: false, max_concurrent: 3 };
const item = (id: string, phase: 'queued' | 'capturing' = 'queued') => ({
  item_id: id, code: '005930', date: '20260518', phase,
  force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
  attempt: 1,
});

describe('CaptureStatusPill', () => {
  it('renders null when no active and no queued and not paused', async () => {
    const qc = setup(empty);
    const { container } = render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
  });

  it('renders CAPTURING with stats when items are active or queued', async () => {
    const qc = setup({ ...empty, active: [item('a1', 'capturing')], queued: [item('q1'), item('q2')] });
    render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/CAPTURING/)).toBeTruthy();
    expect(screen.getByText(/1 capturing · 2 queued/)).toBeTruthy();
  });

  it('renders PAUSED label when snapshot.paused (amber dot)', async () => {
    const qc = setup({ ...empty, paused: true, active: [item('a1', 'capturing')] });
    render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/PAUSED/)).toBeTruthy();
    expect(screen.getByText(/click to resume/i)).toBeTruthy();
  });

  it('wraps the pill in a Link to /capture', async () => {
    const qc = setup({ ...empty, queued: [item('q1')] });
    const { container } = render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('a[href="/capture"]')).toBeTruthy();
  });
});
