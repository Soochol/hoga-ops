import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WatchlistHeartButton } from './WatchlistHeartButton';

function renderHeartInInteractiveParent(onPointerDown = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    folders: [],
    entries: [],
    next_run_at_ms: 0,
  });
  render(
    <QueryClientProvider client={qc}>
      <div data-testid="parent" onPointerDown={onPointerDown}>
        <WatchlistHeartButton code="005930" name="삼성전자" variant="row" />
      </div>
    </QueryClientProvider>,
  );
  return { onPointerDown };
}

describe('WatchlistHeartButton', () => {
  it('does not bubble pointer down to an interactive row parent', () => {
    const { onPointerDown } = renderHeartInInteractiveParent();

    fireEvent.pointerDown(screen.getByRole('button', { name: '관심 그룹 편집' }));

    expect(onPointerDown).not.toHaveBeenCalled();
  });
});
