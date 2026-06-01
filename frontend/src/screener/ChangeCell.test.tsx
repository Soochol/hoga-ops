import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChangeCell } from './ChangeCell';

describe('ChangeCell', () => {
  it('renders "—" for null', () => {
    render(<ChangeCell pct={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders a red up cell with ▲ and + sign for positive', () => {
    render(<ChangeCell pct={2.1} />);
    const el = screen.getByText(/▲ \+2\.10%/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-price-up');
  });

  it('renders a blue down cell with ▼ for negative', () => {
    render(<ChangeCell pct={-1.2} />);
    const el = screen.getByText(/▼ -1\.20%/);
    expect(el).toBeInTheDocument();
    expect(el.className).toContain('text-price-down');
  });
});
