import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import OrderbookTable from '../../src/sidebar/OrderbookTable';

const mkSnap = (asks: number[], bids: number[]) => ({
  ts_ms: 1779062400000,
  levels: [
    ...asks.map((qty, i) => ({ side: 'ask' as const, rank: i + 1, price: 70000 + i * 10, qty })),
    ...bids.map((qty, i) => ({ side: 'bid' as const, rank: i + 1, price: 70000 - (i + 1) * 10, qty })),
  ],
});

describe('OrderbookTable', () => {
  it('renders loading state when snapshot is null', () => {
    render(<OrderbookTable snapshot={undefined} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('renders 10 ask + spread + 10 bid rows', () => {
    const snap = mkSnap(
      [100, 200, 150, 80, 60, 40, 30, 25, 20, 15],
      [120, 90, 70, 60, 50, 40, 30, 20, 10, 5],
    );
    render(<OrderbookTable snapshot={snap as any} />);
    expect(screen.getByText('Spread')).toBeInTheDocument();
    // Best ask price is shown (rank=1)
    expect(screen.getByText('70,000')).toBeInTheDocument();
    // Best bid (price 70,000 - 10 = 69,990)
    expect(screen.getByText('69,990')).toBeInTheDocument();
  });
});
