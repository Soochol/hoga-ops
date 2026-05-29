import { vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeftNav from '../../src/nav/LeftNav';
import type { ReactNode } from 'react';

vi.mock('../../src/api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
  lastHeartbeat: () => Date.now(),
  useEventStream: () => {},
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
  } as Response);
});

function W({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

it('renders the current nav items', () => {
  render(<LeftNav />, { wrapper: W });
  expect(screen.getByText('Live')).toBeInTheDocument();
  expect(screen.getByText('Inventory')).toBeInTheDocument();
  expect(screen.getByText('Capture')).toBeInTheDocument();
  expect(screen.getByText('Watchlist')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
});
