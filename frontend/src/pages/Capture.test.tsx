import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Capture from './Capture';
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
});

describe('Capture page', () => {
  it('renders both the form panel (left) and the queue panel (right)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start/i })).toBeTruthy();
    // Queue side hidden by empty-state when no rows. Check that empty state
    // marker renders — this confirms CaptureQueue mounted on the right.
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
  });
});
