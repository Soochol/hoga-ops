import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TopNav from '../../src/nav/TopNav';

vi.mock('../../src/api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
  lastHeartbeat: () => Date.now(),
  useEventStream: () => {},
}));

vi.mock('../../src/nav/StatusDot', () => ({
  default: () => <span>WS · :8000</span>,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
  } as Response);
});

function W({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

it('renders the approved minimal top menu items', () => {
  render(<TopNav />, { wrapper: W });

  expect(screen.getByText('hoga-ops')).toBeInTheDocument();
  expect(screen.getByText('Live')).toBeInTheDocument();
  expect(screen.getByText('Inventory')).toBeInTheDocument();
  expect(screen.getByText('Capture')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
  expect(screen.queryByText(/orderbook replay/i)).not.toBeInTheDocument();
  expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
});
