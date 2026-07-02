import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TopNav from './TopNav';

vi.mock('./CaptureInlineStatus', () => ({
  CaptureInlineStatus: () => null,
}));

vi.mock('./StatusDot', () => ({
  default: () => <span>WS · :8000</span>,
}));

function W({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TopNav', () => {
  it('renders workspace links in the approved order and Settings at the end', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    const labels = screen.getAllByRole('link').map((link) => link.textContent);

    expect(labels).toEqual(['Live', 'Study', 'Heatmap', 'Screener', 'Inventory', 'Capture']);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
  });

  it('renders only the hoga-ops brand text, without the old subtitle', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    expect(screen.getByText('hoga-ops')).toBeInTheDocument();
    expect(screen.queryByText(/orderbook replay/i)).not.toBeInTheDocument();
  });

  it('uses text-only active styling for the current route', () => {
    render(<TopNav onOpenSettings={vi.fn()} />, { wrapper: W });

    const liveLink = screen.getByRole('link', { name: 'Live' });

    expect(liveLink).toHaveClass('text-fg', 'font-bold');
    expect(liveLink.className).not.toContain('before:');
    expect(liveLink).not.toHaveClass('border-border-strong', 'bg-tint-selection');
    expect(liveLink.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('opens settings through a button instead of navigating', () => {
    const onOpenSettings = vi.fn();
    render(<TopNav onOpenSettings={onOpenSettings} />, { wrapper: W });

    const settings = screen.getByRole('button', { name: 'Settings' });

    settings.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });
});
