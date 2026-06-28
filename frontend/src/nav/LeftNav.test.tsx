import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import LeftNav from './LeftNav';

it('renders Study directly below Live in the workspace nav', () => {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>
        <LeftNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const labels = screen.getAllByRole('link').map((link) => link.textContent);
  const liveLink = screen.getByRole('link', { name: 'Live' });

  expect(labels.slice(0, 3)).toEqual(['Live', 'Study', 'Heatmap']);
  expect(screen.getByRole('link', { name: 'Study' })).toHaveAttribute('href', '/study');
  expect(liveLink).toHaveClass(
    'relative',
    'grid',
    'border-border-strong',
    'bg-tint-selection',
    'text-fg',
    'before:absolute',
    'before:left-[-1px]',
    'before:top-2',
    'before:bottom-2',
    'before:w-[2px]',
    'before:rounded',
    'before:bg-accent',
  );
});
