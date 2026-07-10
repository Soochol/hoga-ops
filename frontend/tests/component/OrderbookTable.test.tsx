import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import OrderbookTable from '../../src/sidebar/OrderbookTable';
import type { OrderbookSnapshot } from '../../src/api/types';

const mkSnap = (asks: number[], bids: number[]): OrderbookSnapshot => ({
  ts_ms: 1779062400000,
  seq: 1,
  ask: asks.map((qty, i) => ({ price: 70000 + i * 10, qty })),
  bid: bids.map((qty, i) => ({ price: 70000 - (i + 1) * 10, qty })),
  tot_ask: asks.reduce((a, b) => a + b, 0),
  tot_bid: bids.reduce((a, b) => a + b, 0),
});

describe('OrderbookTable', () => {
  it('renders loading state when snapshot is undefined', () => {
    render(<OrderbookTable snapshot={undefined} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('renders ask + bid rows from the ADR-0004 wire shape', () => {
    // SPREAD 구분선 행은 10호가 지표에서 제거됨(#551) — ask/bid 가격 행만 검증한다.
    const snap = mkSnap(
      [100, 200, 150, 80, 60, 40, 30, 25, 20, 15],
      [120, 90, 70, 60, 50, 40, 30, 20, 10, 5],
    );
    render(<OrderbookTable snapshot={snap} />);
    // Best ask price (ask[0])
    expect(screen.getByText('70,000')).toBeInTheDocument();
    // Best bid (bid[0] at 70_000 - 10)
    expect(screen.getByText('69,990')).toBeInTheDocument();
  });
});
