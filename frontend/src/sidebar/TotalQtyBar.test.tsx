import { describe, it, expect } from 'vitest';
import { computeTotals } from './TotalQtyBar';
import type { OrderbookSnapshot } from '../api/types';

function snap(totAsk: number, totBid: number): OrderbookSnapshot {
  return {
    ts_ms: 0,
    seq: 0,
    ask: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    bid: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    tot_ask: totAsk,
    tot_bid: totBid,
  };
}

describe('computeTotals', () => {
  it('returns wire totals and proportional percentages', () => {
    const r = computeTotals(snap(12_840, 18_220));
    expect(r.askTotal).toBe(12_840);
    expect(r.bidTotal).toBe(18_220);
    expect(r.askPct).toBeCloseTo(12_840 / 31_060, 5);
    expect(r.bidPct).toBeCloseTo(18_220 / 31_060, 5);
  });

  it('returns 0.5/0.5 split when both totals are zero (divide-by-zero guard)', () => {
    const r = computeTotals(snap(0, 0));
    expect(r.askTotal).toBe(0);
    expect(r.bidTotal).toBe(0);
    expect(r.askPct).toBe(0.5);
    expect(r.bidPct).toBe(0.5);
  });

  it('returns 0/1 when only bid is present', () => {
    const r = computeTotals(snap(0, 100));
    expect(r.askPct).toBe(0);
    expect(r.bidPct).toBe(1);
  });

  it('returns 1/0 when only ask is present', () => {
    const r = computeTotals(snap(100, 0));
    expect(r.askPct).toBe(1);
    expect(r.bidPct).toBe(0);
  });
});

import { render } from '@testing-library/react';
import TotalQtyBar from './TotalQtyBar';

describe('TotalQtyBar — empty states', () => {
  it('renders nothing when snapshot is undefined (loading)', () => {
    const { container } = render(<TotalQtyBar snapshot={undefined} maskRatio={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when snapshot is null (no data)', () => {
    const { container } = render(<TotalQtyBar snapshot={null} maskRatio={false} />);
    expect(container.firstChild).toBeNull();
  });
});
