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

  expect(labels.slice(0, 3)).toEqual(['Live', 'Study', 'Heatmap']);
  expect(screen.getByRole('link', { name: 'Study' })).toHaveAttribute('href', '/study');
  expect(screen.getByRole('link', { name: 'Live' })).toHaveClass('text-fg');
});
