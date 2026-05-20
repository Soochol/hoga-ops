import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import FillTape from '../../src/sidebar/FillTape';

const trade = (overrides: Partial<Record<string, number>>) => ({
  ts_ms: 1779062400000,
  seq: 1,
  price: 70000,
  change_pct: 0,
  qty: 100,
  side: 1,
  cum_vol: 0,
  cum_trades: 0,
  low_so_far: 0,
  high_so_far: 0,
  net_pressure: 0,
  ...overrides,
});

describe('FillTape', () => {
  it('shows loading when null', () => {
    render(<FillTape trades={null} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('shows "체결 없음" when empty', () => {
    render(<FillTape trades={[]} />);
    expect(screen.getByText(/체결 없음/)).toBeInTheDocument();
  });

  it('renders ▲/▼/◆ icons per side and sorts newest first', () => {
    render(
      <FillTape
        trades={[
          trade({ ts_ms: 100, seq: 1, side: 1, price: 70000 }),
          trade({ ts_ms: 200, seq: 2, side: -1, price: 69990 }),
          trade({ ts_ms: 300, seq: 3, side: 0, price: 70010 }),
        ]}
      />,
    );
    expect(screen.getByText('▲')).toBeInTheDocument();
    expect(screen.getByText('▼')).toBeInTheDocument();
    expect(screen.getByText('◆')).toBeInTheDocument();

    // Newest at top — first rendered icon should be ◆ (ts_ms=300).
    const icons = screen.getAllByText((_, el) => {
      if (el?.tagName !== 'SPAN') return false;
      const t = el.textContent ?? '';
      return t === '▲' || t === '▼' || t === '◆';
    });
    expect(icons[0].textContent).toBe('◆');
  });
});
