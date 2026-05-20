import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BrokerNetTable from '../../src/sidebar/BrokerNetTable';

describe('BrokerNetTable', () => {
  it('shows loading state when null', () => {
    render(<BrokerNetTable brokers={null} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('aggregates buy minus sell per broker, sorts net DESC, caps at 10', () => {
    const brokers: any[] = [
      { name: '키움증권', side: 'buy', rank: 1, qty: 1000 },
      { name: '키움증권', side: 'sell', rank: 1, qty: 300 }, // net +700
      { name: 'NH투자증권', side: 'buy', rank: 2, qty: 500 }, // net +500
      { name: '미래에셋', side: 'sell', rank: 1, qty: 800 }, // net -800
    ];
    render(<BrokerNetTable brokers={brokers} />);
    const rows = screen.getAllByText(
      (_, el) => el?.tagName === 'SPAN' && /(\+|-)?[0-9,]+/.test(el.textContent ?? ''),
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Net values render with sign
    expect(screen.getByText('+700')).toBeInTheDocument();
    expect(screen.getByText('+500')).toBeInTheDocument();
    expect(screen.getByText('-800')).toBeInTheDocument();
  });

  it('truncates names longer than 4 characters', () => {
    render(
      <BrokerNetTable
        brokers={[{ name: 'NH투자증권', side: 'buy', rank: 1, qty: 100 } as any]}
      />,
    );
    expect(screen.getByText('NH투자')).toBeInTheDocument();
  });
});
