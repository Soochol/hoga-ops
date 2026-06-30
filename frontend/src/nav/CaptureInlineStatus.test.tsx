import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { QueueSnapshot } from '../api/types';
import { CaptureInlineStatus } from './CaptureInlineStatus';

vi.mock('../api/eventStream', () => ({
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
    ok: true,
    status: 200,
    json: async () => snap,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const empty: QueueSnapshot = { active: [], queued: [], done: [], paused: false, max_concurrent: 3 };
const item = (id: string, phase: 'queued' | 'capturing' = 'queued') => ({
  item_id: id,
  code: '005930',
  date: '20260518',
  phase,
  force_retry: false,
  pause_origin: false,
  enqueued_at_ms: 1,
  started_at_ms: null,
  progress: null,
  result: null,
  error: null,
  skip_reason: null,
  attempt: 1,
});

describe('CaptureInlineStatus', () => {
  it('renders null when no active and no queued and not paused', async () => {
    const qc = setup(empty);
    const { container } = render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
  });

  it('renders compact capturing text when items are active or queued', async () => {
    const qc = setup({ ...empty, active: [item('a1', 'capturing')], queued: [item('q1'), item('q2')] });
    render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('link', { name: /1 capturing · 2 queued/i })).toHaveAttribute('href', '/capture');
    expect(screen.queryByText(/CAPTURING/)).not.toBeInTheDocument();
  });

  it('renders compact paused text when snapshot.paused', async () => {
    const qc = setup({ ...empty, paused: true, active: [item('a1', 'capturing')] });
    render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('link', { name: /paused/i })).toHaveAttribute('href', '/capture');
    expect(screen.queryByText(/click to resume/i)).not.toBeInTheDocument();
  });
});
