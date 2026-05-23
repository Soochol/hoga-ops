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

describe('TotalQtyBar — normal render', () => {
  it('shows formatted ask total on the left and bid total on the right with KRX colors', () => {
    const { getByText, getByRole } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    const ask = getByText('12,840');
    const bid = getByText('18,220');
    expect(ask.className).toMatch(/text-price-down/);
    expect(bid.className).toMatch(/text-price-up/);
    const group = getByRole('group', { name: '총잔량' });
    expect(group).toContainElement(ask);
    expect(group).toContainElement(bid);
  });

  it('sets the bar fill grid-template-columns to the computed ratio', () => {
    const { container } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    const fill = container.querySelector('[data-testid="total-qty-bar-fill"]') as HTMLElement;
    expect(fill.style.gridTemplateColumns).toBe('12840fr 18220fr');
  });

  it('aria-labels each flank with its semantic meaning', () => {
    const { getByLabelText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    expect(getByLabelText('매도총잔량 12,840')).toBeInTheDocument();
    expect(getByLabelText('매수총잔량 18,220')).toBeInTheDocument();
  });
});

describe('TotalQtyBar — masking', () => {
  it('shows bar fill when maskRatio=false', () => {
    const { queryByTestId } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={false} />,
    );
    expect(queryByTestId('total-qty-bar-fill')).not.toBeNull();
    expect(queryByTestId('total-qty-bar-masked')).toBeNull();
  });

  it('hides bar fill and shows "Auction" annotation when maskRatio=true', () => {
    const { queryByTestId, getByText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={true} />,
    );
    expect(queryByTestId('total-qty-bar-fill')).toBeNull();
    expect(queryByTestId('total-qty-bar-masked')).not.toBeNull();
    expect(getByText('Auction')).toBeInTheDocument();
  });

  it('keeps flank numbers visible when maskRatio=true', () => {
    const { getByText } = render(
      <TotalQtyBar snapshot={snap(12_840, 18_220)} maskRatio={true} />,
    );
    expect(getByText('12,840')).toBeInTheDocument();
    expect(getByText('18,220')).toBeInTheDocument();
  });
});
