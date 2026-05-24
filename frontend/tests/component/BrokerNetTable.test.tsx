import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BrokerNetTable from '../../src/sidebar/BrokerNetTable';
import type { BrokerEntry } from '../../src/api/types';

describe('BrokerNetTable', () => {
  it('shows loading state when undefined', () => {
    render(<BrokerNetTable brokers={undefined} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('shows empty state when null', () => {
    render(<BrokerNetTable brokers={null} />);
    expect(screen.getByText('거래원 정보 없음')).toBeInTheDocument();
  });

  it('aggregates buy minus sell per broker using qty_today, sorts by |net| DESC, caps at 10', () => {
    // Mirrors the wire shape returned by /api/brokers — see hoga/tables/brokers.py::ApiBrokerEntry.
    // Fields: side, rank, broker (name), qty_today (cumulative), qty_delta (last-tick increment).
    const brokers: BrokerEntry[] = [
      { broker: '키움증권', side: 'buy', rank: 1, qty_today: 1000, qty_delta: 10 },
      { broker: '키움증권', side: 'sell', rank: 1, qty_today: 300, qty_delta: 5 }, // net +700
      { broker: 'NH투자증권', side: 'buy', rank: 2, qty_today: 500, qty_delta: 0 }, // net +500
      { broker: '미래에셋', side: 'sell', rank: 1, qty_today: 800, qty_delta: 20 }, // net -800
    ];
    render(<BrokerNetTable brokers={brokers} />);
    // Order should be by absolute magnitude: |−800| > |+700| > |+500|.
    const rendered = screen.getAllByText(/^[+-]?\d/);
    const netTexts = rendered.map((el) => el.textContent);
    expect(netTexts).toEqual(['-800', '+700', '+500']);
  });

  it('truncates broker names longer than 4 characters', () => {
    const brokers: BrokerEntry[] = [
      { broker: 'NH투자증권', side: 'buy', rank: 1, qty_today: 100, qty_delta: 0 },
    ];
    render(<BrokerNetTable brokers={brokers} />);
    expect(screen.getByText('NH투자')).toBeInTheDocument();
  });

  it('renders 거래원 정보 없음 for an empty entries array', () => {
    render(<BrokerNetTable brokers={[]} />);
    expect(screen.getByText('거래원 정보 없음')).toBeInTheDocument();
  });
});
